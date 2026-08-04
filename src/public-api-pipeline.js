import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { discoverApiServices, fetchPublicApiCatalogEntries } from "./openapi-import.js";
import {
  listPersistentPublicApiCandidates,
  listPersistentPublicApiPipelineRuns,
  writePersistentPublicApiCandidates,
  writePersistentPublicApiPipelineRun
} from "./persistence.js";

const RETRYABLE_STATUSES = new Set(["queued", "retryable_failure"]);
const DEFAULT_SOURCE_CATALOG = "github:public-apis/public-apis";

// Blanket conversion is not worth it: most public-apis rows are just a homepage
// link with no machine-readable spec, so ~87% of attempts die on endpoint
// discovery. Work the categories that actually carry agent-useful, key-free,
// well-specified APIs first instead of walking the list alphabetically.
export const PUBLIC_API_PRIORITY_TIERS = {
  P0: ["Government", "Open Data", "Science & Math"],
  P1: ["Geocoding", "Cryptocurrency"],
  P2: ["Health", "Transportation"]
};

const TIER_RANK = new Map(
  Object.entries(PUBLIC_API_PRIORITY_TIERS)
    .flatMap(([tier, categories], index) => categories.map((category) => [category.toLowerCase(), index]))
);

export function resolvePriorityCategories(tier) {
  const requested = String(tier || "").trim().toUpperCase();
  if (!requested || requested === "ALL") {
    return Object.values(PUBLIC_API_PRIORITY_TIERS).flat();
  }
  const tiers = requested.split(/[,\s]+/).filter(Boolean);
  const unknown = tiers.filter((name) => !PUBLIC_API_PRIORITY_TIERS[name]);
  if (unknown.length) throw new Error(`Unknown priority tier: ${unknown.join(", ")}`);
  return tiers.flatMap((name) => PUBLIC_API_PRIORITY_TIERS[name]);
}

function categoryRank(category) {
  const rank = TIER_RANK.get(String(category || "").toLowerCase());
  return rank === undefined ? TIER_RANK.size : rank;
}
const FINAL_STATUSES = new Set([
  "validated_ready",
  "credential_required",
  "manual_review",
  "blocked_insecure_transport"
]);

export async function syncPublicApiCoverage(store, options = {}) {
  ensurePipelineStore(store);
  const now = timestamp(options);
  const fetchEntries = options.fetchCatalogEntries || fetchPublicApiCatalogEntries;
  const entries = await fetchEntries({ fetchImpl: options.fetchImpl });
  const seen = new Set();

  for (const entry of entries) {
    const candidateId = catalogCandidateId(entry);
    seen.add(candidateId);
    const existing = store.publicApiCatalog.get(candidateId);
    const transportBlocked = entry.https !== true || !isHttpsUrl(entry.documentation_url);
    const credentialBlockCleared = existing?.status === "credential_required"
      && requiresProviderCredential(existing.auth)
      && !requiresProviderCredential(entry.auth);
    const preserveStatus = existing && FINAL_STATUSES.has(existing.status) && !credentialBlockCleared;
    store.publicApiCatalog.set(candidateId, {
      ...existing,
      ...entry,
      candidate_id: candidateId,
      catalog_presence: "active",
      source_catalog: entry.source_catalog || DEFAULT_SOURCE_CATALOG,
      status: preserveStatus
        ? existing.status
        : transportBlocked
          ? "blocked_insecure_transport"
          : credentialBlockCleared
            ? "queued"
            : existing?.status || "queued",
      blocking_reason: preserveStatus
        ? existing.blocking_reason || null
        : transportBlocked
          ? "https_required"
          : credentialBlockCleared
            ? null
            : existing?.blocking_reason || null,
      attempt_count: existing?.attempt_count || 0,
      discovered_at: existing?.discovered_at || now,
      updated_at: now
    });
  }

  // "Removed" means the upstream catalog dropped the row. Several catalogs now
  // share this store, so a sync of one source must not retire another source's
  // rows — scope the sweep to the sources this run actually fetched.
  const syncedSources = new Set(entries.map((entry) => entry.source_catalog || DEFAULT_SOURCE_CATALOG));
  for (const [candidateId, candidate] of store.publicApiCatalog) {
    if (seen.has(candidateId)) continue;
    if (!syncedSources.has(candidate.source_catalog || DEFAULT_SOURCE_CATALOG)) continue;
    store.publicApiCatalog.set(candidateId, {
      ...candidate,
      catalog_presence: "removed",
      updated_at: now
    });
  }

  const run = {
    run_id: randomUUID(),
    type: "catalog_sync",
    ok: true,
    catalog_entries: entries.length,
    created_at: now
  };
  store.publicApiPipelineRuns.push(run);
  await persistCandidates(store, options);
  await (options.persistRun || writePersistentPublicApiPipelineRun)(run);
  return {
    ok: true,
    total: entries.length,
    coverage: publicApiCoverageReport(store),
    run
  };
}

export async function runPublicApiConversionBatch(store, options = {}) {
  ensurePipelineStore(store);
  const limit = clamp(options.limit, 1, 100, 25);
  const concurrency = clamp(options.concurrency, 1, 5, 3);
  const categoryFilter = normalizeCategoryFilter(options.categories);
  const sourceFilter = normalizeCategoryFilter(options.sources);
  const selected = [...store.publicApiCatalog.values()]
    .filter((candidate) => candidate.catalog_presence !== "removed" && RETRYABLE_STATUSES.has(candidate.status))
    .filter((candidate) => !categoryFilter || categoryFilter.has(String(candidate.category || "").toLowerCase()))
    .filter((candidate) => !sourceFilter || sourceFilter.has(String(candidate.source_catalog || DEFAULT_SOURCE_CATALOG).toLowerCase()))
    .sort((left, right) =>
      Number(right.retry_priority === true) - Number(left.retry_priority === true)
      || categoryRank(left.category) - categoryRank(right.category)
      || retryPriority(left.status) - retryPriority(right.status)
      || Number(left.attempt_count || 0) - Number(right.attempt_count || 0)
      || String(left.last_attempt_at || "").localeCompare(String(right.last_attempt_at || ""))
    )
    .slice(0, limit);
  const discover = options.discoverApiServices || discoverApiServices;
  const probe = options.probeDraft || defaultProbeDraft;
  const safeFetch = createSafePublicFetch({
    ...options,
    rawFetch: options.rawFetch || options.fetchImpl || globalThis.fetch
  });

  await mapConcurrent(selected, concurrency, async (candidate) => {
    const now = timestamp(options);
    candidate.attempt_count = (candidate.attempt_count || 0) + 1;
    candidate.retry_priority = false;
    candidate.last_attempt_at = now;
    candidate.updated_at = now;
    candidate.last_error = null;
    candidate.blocking_reason = null;
    try {
      // The catalog already states this one needs a credential, and that
      // cannot change during discovery — settle it without spending a document
      // fetch. This must stay inside the try so it still reaches the finally
      // block that persists the candidate.
      if (requiresProviderCredential(candidate.auth)) {
        candidate.status = "credential_required";
        candidate.blocking_reason = "provider_credential_required";
        return;
      }
      await assertSafePublicUrl(candidate.documentation_url, options);
      const discovery = await discover({
        api_url: candidate.documentation_url,
        provider_name: candidate.title,
        default_method: "GET",
        default_price: "0",
        catalog_candidate_id: candidate.candidate_id
      }, options.baseUrl || candidate.documentation_url, {
        fetchImpl: safeFetch,
        allowDirectJsonEndpoint: true,
        allowDocsFallback: true
      });
      const drafts = (discovery.drafts || [])
        .filter((draft) => String(draft.method || "GET").toUpperCase() === "GET")
        .filter(isCatalogDataDraft)
        .map(publicDraft);
      if (!drafts.length) {
        candidate.status = "manual_review";
        candidate.blocking_reason = "no_read_only_endpoint_discovered";
        return;
      }
      candidate.discovery_mode = discovery.mode || null;
      candidate.drafts = drafts;
      candidate.discovered_endpoint_count = drafts.length;
      const testedDrafts = [];
      for (const draft of drafts) {
        let probeResult;
        try {
          probeResult = await probe(draft, { fetchImpl: safeFetch, candidate });
        } catch (error) {
          probeResult = {
            ok: false,
            status: error.statusCode || null,
            result_shape: null,
            reason: error.code || "probe_failed",
            error: String(error.message || error)
          };
        }
        const usable = Boolean(probeResult?.ok && probeResult.result_shape !== "non_json");
        testedDrafts.push({
          ...draft,
          validation: {
            ok: usable,
            status: probeResult?.status || null,
            result_shape: probeResult?.result_shape || null,
            reason: usable ? null : probeResult?.reason || validationFailureReason(probeResult),
            error: usable ? null : probeResult?.error || null,
            tested_at: now
          }
        });
      }
      candidate.usable_drafts = testedDrafts.filter((draft) => draft.validation.ok);
      candidate.unusable_drafts = testedDrafts.filter((draft) => !draft.validation.ok);
      candidate.endpoint_tests = testedDrafts.map(({ service_id, title, method, upstream_url, validation }) => ({
        service_id,
        title,
        method,
        upstream_url,
        validation
      }));
      const firstUsable = candidate.usable_drafts[0];
      if (!firstUsable) {
        const failedStatus = candidate.unusable_drafts.find((draft) => draft.validation.status)?.validation.status;
        const error = new Error(`Live validation failed${failedStatus ? ` with HTTP ${failedStatus}` : ""}.`);
        error.code = "PUBLIC_API_VALIDATION_FAILED";
        throw error;
      }
      candidate.status = "validated_ready";
      candidate.validated_at = now;
      candidate.validation = {
        ok: true,
        status: firstUsable.validation.status,
        result_shape: firstUsable.validation.result_shape,
        tested_endpoint_count: testedDrafts.length,
        usable_endpoint_count: candidate.usable_drafts.length,
        unusable_endpoint_count: candidate.unusable_drafts.length
      };
    } catch (error) {
      candidate.status = error.code === "UNSAFE_CATALOG_TARGET" ? "manual_review" : "retryable_failure";
      candidate.blocking_reason = error.code === "UNSAFE_CATALOG_TARGET" ? "unsafe_network_target" : null;
      candidate.last_error = {
        code: error.code || "PUBLIC_API_CONVERSION_FAILED",
        message: String(error.message || error)
      };
    } finally {
      await persistCandidate(candidate, options);
    }
  });

  const run = {
    run_id: randomUUID(),
    type: "conversion_batch",
    ok: true,
    processed: selected.length,
    limit,
    concurrency,
    created_at: timestamp(options)
  };
  store.publicApiPipelineRuns.push(run);
  await persistCandidates(store, options);
  await (options.persistRun || writePersistentPublicApiPipelineRun)(run);
  return {
    ok: true,
    processed: selected.length,
    coverage: publicApiCoverageReport(store),
    run
  };
}

export function startPublicApiConversionJob(store, options = {}) {
  ensurePipelineStore(store);
  if (store.publicApiPipelineJob?.status === "running") {
    return {
      accepted: false,
      job: store.publicApiPipelineJob,
      completion: store.publicApiPipelineJobCompletion
    };
  }
  const job = {
    job_id: randomUUID(),
    status: "running",
    started_at: timestamp(options),
    completed_at: null,
    result: null,
    error: null
  };
  store.publicApiPipelineJob = job;
  const completion = Promise.resolve()
    .then(() => runPublicApiConversionBatch(store, options))
    .then((result) => {
      job.status = "completed";
      job.completed_at = timestamp(options);
      job.result = result;
      return job;
    })
    .catch((error) => {
      job.status = "failed";
      job.completed_at = timestamp(options);
      job.error = {
        code: error.code || "PUBLIC_API_PIPELINE_JOB_FAILED",
        message: String(error.message || error)
      };
      return job;
    });
  store.publicApiPipelineJobCompletion = completion;
  return { accepted: true, job, completion };
}

export function publicApiCoverageReport(store) {
  ensurePipelineStore(store);
  const report = {
    total: store.publicApiCatalog.size,
    active: 0,
    removed: 0,
    by_status: {},
    by_category: {}
  };
  for (const candidate of store.publicApiCatalog.values()) {
    if (candidate.catalog_presence === "removed") report.removed += 1;
    else report.active += 1;
    const status = candidate.status || "unknown";
    report.by_status[status] = (report.by_status[status] || 0) + 1;
    const category = candidate.category || "Uncategorized";
    report.by_category[category] = (report.by_category[category] || 0) + 1;
  }
  report.coverage_complete = report.active === 0
    ? report.total === 0
    : [...store.publicApiCatalog.values()]
      .filter((item) => item.catalog_presence !== "removed")
      .every((item) => Boolean(item.status));
  return report;
}

export async function requeuePublicApiCandidates(store, options = {}) {
  ensurePipelineStore(store);
  const status = String(options.status || "").trim();
  const reason = String(options.reason || "").trim();
  let requeued = 0;
  for (const candidate of store.publicApiCatalog.values()) {
    if (candidate.catalog_presence === "removed") continue;
    if (status && candidate.status !== status) continue;
    if (reason && candidate.blocking_reason !== reason && candidate.last_error?.code !== reason) continue;
    candidate.status = "queued";
    candidate.retry_priority = true;
    candidate.blocking_reason = null;
    candidate.last_error = null;
    candidate.updated_at = timestamp(options);
    requeued += 1;
  }
  if (requeued) await persistCandidates(store, options);
  return {
    ok: true,
    requeued,
    coverage: publicApiCoverageReport(store)
  };
}

export function listPublicApiCatalog(store, options = {}) {
  ensurePipelineStore(store);
  const query = String(options.query || "").trim().toLowerCase();
  const category = String(options.category || "").trim();
  const availability = String(options.availability || "").trim();
  const status = String(options.status || "").trim();
  const limit = clamp(options.limit, 1, 200, 50);
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const active = [...store.publicApiCatalog.values()]
    .filter((candidate) => candidate.catalog_presence !== "removed");
  const summary = {
    total: active.length,
    usable: active.filter((candidate) => candidateAvailability(candidate) === "usable").length,
    unavailable: active.filter((candidate) => candidateAvailability(candidate) === "unavailable").length,
    pending: active.filter((candidate) => candidateAvailability(candidate) === "pending").length
  };
  const filtered = active
    .filter((candidate) => !status || candidate.status === status)
    .filter((candidate) => !category || candidate.category === category)
    .filter((candidate) => !availability || candidateAvailability(candidate) === availability)
    .filter((candidate) => !query || [
      candidate.title,
      candidate.description,
      candidate.category,
      candidate.documentation_url,
      ...(candidate.usable_drafts || []).flatMap((draft) => [draft.title, draft.service_id, ...(draft.capabilities || [])])
    ].join(" ").toLowerCase().includes(query))
    .sort((left, right) =>
      availabilityRank(candidateAvailability(left)) - availabilityRank(candidateAvailability(right))
      || String(left.title || "").localeCompare(String(right.title || ""))
    );
  return {
    schema_version: "agentrouter_public_api_catalog_v1",
    summary,
    total: filtered.length,
    limit,
    offset,
    has_more: offset + limit < filtered.length,
    apis: filtered.slice(offset, offset + limit).map(publicApiCandidate)
  };
}

export async function hydratePublicApiCoverage(store, options = {}) {
  ensurePipelineStore(store);
  const listCandidates = options.listCandidates || listPersistentPublicApiCandidates;
  const listRuns = options.listRuns || listPersistentPublicApiPipelineRuns;
  const [candidates, runs] = await Promise.all([listCandidates(), listRuns({ limit: 100 })]);
  for (const candidate of candidates) {
    if (candidate?.candidate_id) store.publicApiCatalog.set(candidate.candidate_id, candidate);
  }
  store.publicApiPipelineRuns = runs;
  return publicApiCoverageReport(store);
}

export async function assertSafePublicUrl(value, options = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw unsafeTarget("Invalid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw unsafeTarget("Only HTTP(S) targets are allowed.");
  if (options.requireHttps && url.protocol !== "https:") throw unsafeTarget("HTTPS is required for automated catalog conversion.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw unsafeTarget("Local hostnames are not allowed.");
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw unsafeTarget("Private or reserved IP addresses are not allowed.");
    return url;
  }
  const lookup = options.lookup || dnsLookup;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const wrapped = new Error(`Could not resolve catalog target: ${error.message}`);
    wrapped.code = "CATALOG_TARGET_DNS_FAILED";
    wrapped.statusCode = 502;
    throw wrapped;
  }
  const normalized = Array.isArray(addresses) ? addresses : [addresses];
  const resolvedAddresses = normalized.map((item) => item.address || item);
  const syntheticProxyOnly = resolvedAddresses.length > 0
    && resolvedAddresses.every(isSyntheticProxyAddress);
  if (!resolvedAddresses.length || (
    resolvedAddresses.some(isPrivateAddress)
    && !(options.allowSyntheticProxyAddresses === true && syntheticProxyOnly)
  )) {
    throw unsafeTarget("Target resolves to a private or reserved network.");
  }
  return url;
}

export function createSafePublicFetch(options = {}) {
  const fetchImpl = options.rawFetch || globalThis.fetch;
  return async function safePublicFetch(input, init = {}) {
    let target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertSafePublicUrl(target, { ...options, requireHttps: true });
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort(new DOMException("Public API request timed out.", "AbortError"));
      }, clamp(options.requestTimeoutMs, 1, 120000, 15000));
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutController.signal])
        : timeoutController.signal;
      let response;
      try {
        response = await fetchImpl(target, { ...init, signal, redirect: "manual" });
      } finally {
        clearTimeout(timeout);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      target = new URL(location, target);
    }
    const error = new Error("Too many redirects while fetching public API documentation.");
    error.code = "PUBLIC_API_REDIRECT_LIMIT";
    error.statusCode = 502;
    throw error;
  };
}

async function defaultProbeDraft(draft, { fetchImpl }) {
  if (!draft.upstream_url) {
    return { ok: false, status: null };
  }
  const response = await fetchImpl(draft.upstream_url, {
    method: "GET",
    headers: { accept: "application/json" }
  });
  let resultShape = "unknown";
  try {
    const result = await response.clone().json();
    resultShape = Array.isArray(result) ? "array" : typeof result;
  } catch {
    resultShape = "non_json";
  }
  return { ok: response.ok, status: response.status, result_shape: resultShape };
}

export function createSerializedTask(task) {
  let pending = Promise.resolve();
  return (...args) => {
    const next = pending.then(() => task(...args), () => task(...args));
    pending = next.catch(() => {});
    return next;
  };
}

function publicDraft(draft) {
  const safe = {
    service_id: draft.service_id || null,
    title: draft.title || null,
    method: String(draft.method || "GET").toUpperCase(),
    upstream_url: draft.upstream_url || draft.api_url || null,
    capabilities: Array.isArray(draft.capabilities) ? draft.capabilities : [],
    sample_request: draft.sample_request || {}
  };
  return JSON.parse(JSON.stringify(safe));
}

function isCatalogDataDraft(draft) {
  try {
    const url = new URL(draft.upstream_url || draft.api_url);
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") return false;
    if ((host === "gitlab.com" || host === "www.gitlab.com") && !url.pathname.startsWith("/api/")) return false;
    return true;
  } catch {
    return false;
  }
}

function validationFailureReason(result) {
  if (!result) return "no_probe_result";
  if (result.result_shape === "non_json") return "non_json_response";
  if (result.status && !result.ok) return "http_error";
  return "validation_failed";
}

function candidateAvailability(candidate) {
  if (candidate.status === "validated_ready" && (candidate.usable_drafts || []).length) return "usable";
  if (candidate.status === "queued") return "pending";
  return "unavailable";
}

function availabilityRank(value) {
  return value === "usable" ? 0 : value === "pending" ? 1 : 2;
}

function normalizeCategoryFilter(categories) {
  if (!categories) return null;
  const list = (Array.isArray(categories) ? categories : String(categories).split(","))
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
  return list.length ? new Set(list) : null;
}

function retryPriority(status) {
  return status === "queued" ? 0 : 1;
}

function publicApiCandidate(candidate) {
  const availability = candidateAvailability(candidate);
  return {
    candidate_id: candidate.candidate_id,
    title: candidate.title || null,
    description: candidate.description || null,
    category: candidate.category || "Uncategorized",
    documentation_url: candidate.documentation_url || null,
    auth: candidate.auth || null,
    https: candidate.https === true,
    cors: candidate.cors ?? null,
    status: candidate.status || "unknown",
    availability,
    reason: availability === "usable"
      ? null
      : candidate.blocking_reason || candidate.last_error?.code || "not_yet_validated",
    validation: candidate.validation || null,
    endpoints: availability === "usable"
      ? candidate.usable_drafts.filter(isCatalogDataDraft).map((draft) => ({
        service_id: draft.service_id,
        title: draft.title,
        method: draft.method,
        upstream_url: draft.upstream_url,
        capabilities: draft.capabilities || [],
        validation: draft.validation || null
      }))
      : []
  };
}

function requiresProviderCredential(auth) {
  const normalized = String(auth || "").trim().toLowerCase();
  return Boolean(normalized && !["no", "none", "false"].includes(normalized));
}

function catalogCandidateId(entry) {
  const identity = [
    entry.category || "",
    entry.title || "",
    entry.documentation_url || ""
  ].join("\n");
  return `public_api_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  if (!value) return true;
  if (value.includes(":")) {
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return true;
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return false;
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isSyntheticProxyAddress(address) {
  const octets = String(address || "").split(".").map(Number);
  return octets.length === 4
    && octets[0] === 198
    && (octets[1] === 18 || octets[1] === 19)
    && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function unsafeTarget(message) {
  const error = new Error(message);
  error.code = "UNSAFE_CATALOG_TARGET";
  error.statusCode = 422;
  return error;
}

function ensurePipelineStore(store) {
  if (!store.publicApiCatalog) store.publicApiCatalog = new Map();
  if (!store.publicApiPipelineRuns) store.publicApiPipelineRuns = [];
}

async function persistCandidates(store, options) {
  await (options.persistCandidates || writePersistentPublicApiCandidates)([...store.publicApiCatalog.values()]);
}

async function persistCandidate(candidate, options) {
  if (options.persistCandidate) {
    await options.persistCandidate(candidate);
    return;
  }
  await (options.persistCandidates || writePersistentPublicApiCandidates)([candidate]);
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function timestamp(options) {
  return options.now ? options.now() : new Date().toISOString();
}
