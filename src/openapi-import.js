import { normalizeEndpoint } from "./http-utils.js";
import { normalizeId, suggestCapabilities } from "./id-utils.js";
import { createHostedHttpProviderConfig, deleteProviderConfig, prepareProviderConfigForPersistence, writePreparedProviderConfigFile } from "./provider-config.js";
import { abortServiceRegistration, finalizeServiceRegistration, findDuplicateService, registerServiceDurably, unregisterService, validateService } from "./registry.js";
import { publicServiceRecord } from "./store.js";

const OPENAPI_CANDIDATES = [
  "",
  "/openapi.json",
  "/swagger.json",
  "/.well-known/openapi.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/api-docs",
  "/api-docs.json",
  "/v3/api-docs",
  "/docs/openapi.json",
  "/docs/swagger.json"
];
const SKIP_PATH_RE = /\/(auth|login|logout|user|users|admin|debug|health|metrics|internal|webhook|reload|refresh|sync)(\/|$)/i;
const DATA_PATH_RE = /(data|market|price|funding|liquidation|wallet|onchain|search|analytics|open-interest|interest|orderbook|sentiment|flow|risk|profile)/i;

export async function discoverApiServices(body, baseUrl, options = {}) {
  const apiUrl = normalizeEndpoint(requireString(body.api_url, "api_url"), baseUrl).replace(/\/$/, "");
  const defaultPrice = String(body.default_price || "0.01");
  const defaultMethod = String(body.default_method || "").toUpperCase();
  const providerName = body.provider_name || null;
  const secretValue = body.secret_value || "";
  const authHeader = body.auth_header || "";
  const payoutAddress = body.payout_address || "";
  if (looksLikePublicApiCatalogSource(apiUrl)) {
    return discoverPublicApiCatalog({ ...body, api_url: apiUrl }, options);
  }
  if (looksLikeSkillSource(apiUrl)) {
    return discoverSkillServices({
      skillUrl: apiUrl,
      defaultPrice,
      providerName,
      secretValue,
      authHeader,
      payoutAddress
    });
  }
  let document;
  try {
    document = await fetchOpenApiDocument(apiUrl, {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      allowDirectJsonEndpoint: options.allowDirectJsonEndpoint === true
    });
  } catch (error) {
    if (looksLikeApiDocsSource(apiUrl) || options.allowDocsFallback === true) {
      return discoverApiDocsServices({
        docsUrl: apiUrl,
        defaultPrice,
        providerName,
        secretValue,
        authHeader,
        payoutAddress,
        fetchImpl: options.fetchImpl || globalThis.fetch
      });
    }
    throw error;
  }
  if (document.directEndpoint) {
    const providerTitle = providerName || hostName(apiUrl);
    const providerId = normalizeId(null, providerTitle, "provider");
    const draft = createDirectEndpointDraft({
      apiUrl,
      providerId,
      providerTitle,
      defaultPrice,
      secretValue,
      defaultMethod,
      authHeader,
      payoutAddress
    });
    return {
      ok: true,
      mode: "direct_endpoint",
      source: apiUrl,
      api_url: new URL(apiUrl).origin,
      provider: {
        provider_id: providerId,
        provider_name: providerTitle
      },
      drafts: [draft],
      skipped: []
    };
  }
  const upstreamBaseUrl = resolveOpenApiServerUrl(document.doc, document.source, apiUrl);
  const providerTitle = providerName || document.doc.info?.title || hostName(apiUrl);
  const providerId = normalizeId(null, providerTitle, "provider");
  const drafts = [];
  const skipped = [];

  for (const [routePath, pathItem] of Object.entries(document.doc.paths || {})) {
    for (const method of ["get", "post", "put", "patch"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const skipReason = skipReasonFor(routePath, method, operation);
      if (skipReason) {
        skipped.push({ method: method.toUpperCase(), path: routePath, reason: skipReason });
        continue;
      }
      drafts.push(createServiceDraft({
        apiUrl: upstreamBaseUrl,
        routePath,
        method,
        operation,
        pathItem,
        doc: document.doc,
        providerId,
        providerTitle,
        defaultPrice,
        secretValue,
        payoutAddress
      }));
    }
  }

  return {
    ok: true,
    mode: "openapi",
    source: document.source,
    api_url: upstreamBaseUrl,
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    drafts,
    skipped
  };
}

export async function discoverPublicApiCatalog(body = {}, options = {}) {
  const requestedUrl = requireString(body.api_url, "api_url");
  if (!looksLikePublicApiCatalogSource(requestedUrl)) {
    const error = new Error("Only the public-apis/public-apis repository or its README can be used with this catalog importer.");
    error.statusCode = 422;
    error.code = "UNSUPPORTED_PUBLIC_API_CATALOG";
    throw error;
  }
  const source = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
  const categories = new Set((Array.isArray(body.catalog_categories) ? body.catalog_categories : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  const query = String(body.catalog_query || "").trim().toLowerCase();
  const httpsOnly = body.catalog_https_only !== false;
  const limit = Math.min(Math.max(Number(body.catalog_limit) || 25, 1), 100);
  const parsed = await fetchPublicApiCatalogEntries({ fetchImpl: options.fetchImpl || globalThis.fetch });
  const skipped = [];
  const eligible = [];
  for (const entry of parsed) {
    if (categories.size && !categories.has(entry.category.toLowerCase())) continue;
    if (query && !`${entry.title} ${entry.description} ${entry.category}`.toLowerCase().includes(query)) continue;
    if (httpsOnly && entry.https !== true) {
      skipped.push({ category: entry.category, title: entry.title, reason: "https_required" });
      continue;
    }
    eligible.push(entry);
    if (eligible.length >= limit) break;
  }
  const defaultPrice = String(body.default_price || "0.01");
  const drafts = eligible.map((entry) => createPublicApiCatalogCandidate(entry, { source, defaultPrice }));
  return {
    ok: true,
    mode: "public_api_catalog",
    source,
    api_url: "https://github.com/public-apis/public-apis",
    provider: {
      provider_id: "public_apis_catalog",
      provider_name: "Public APIs catalog"
    },
    catalog: {
      catalog_id: "github:public-apis/public-apis",
      candidate_count: drafts.length,
      skipped_count: skipped.length,
      categories: [...categories],
      query: query || null,
      https_only: httpsOnly,
      registry_policy: "Candidates require endpoint discovery and live validation before publishing."
    },
    drafts,
    skipped
  };
}

export async function fetchPublicApiCatalogEntries(options = {}) {
  const source = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchWithTimeout(source, { fetchImpl: options.fetchImpl || globalThis.fetch });
      if (response.ok || response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  if (!response && lastError) throw lastError;
  if (!response.ok) {
    const error = new Error(`Public APIs catalog fetch failed with HTTP ${response.status}.`);
    error.statusCode = 502;
    error.code = "PUBLIC_API_CATALOG_FETCH_FAILED";
    throw error;
  }
  return parsePublicApiCatalog(await response.text());
}

// APIs.guru is a spec-first directory: every entry points at an OpenAPI
// document, so conversion can import the spec directly instead of scraping a
// human documentation page (which is why the public-apis catalog mostly fails).
export async function fetchApisGuruCatalogEntries(options = {}) {
  const source = "https://api.apis.guru/v2/list.json";
  // This is a multi-megabyte index. It should not inherit the short timeout
  // for ordinary documentation pages, but it must remain bounded.
  const response = await fetchWithTimeout(source, {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: Number(options.catalogTimeoutMs || process.env.ADN_APIS_GURU_CATALOG_TIMEOUT_MS || 60000)
  });
  if (!response.ok) {
    const error = new Error(`APIs.guru catalog fetch failed with HTTP ${response.status}.`);
    error.statusCode = 502;
    error.code = "PUBLIC_API_CATALOG_FETCH_FAILED";
    throw error;
  }
  const listed = await response.json();
  const entries = [];
  for (const [apiId, record] of Object.entries(listed || {})) {
    const version = record?.versions?.[record?.preferred];
    const specUrl = version?.swaggerUrl;
    if (!specUrl || !apisGuruIsHttps(specUrl)) continue;
    const info = version.info || {};
    const categories = info["x-apisguru-categories"];
    entries.push({
      category: apisGuruCategory(Array.isArray(categories) ? categories[0] : null),
      title: clampText(info.title || apiId, 200),
      description: clampText(info.description || "", 400),
      // The spec URL *is* the documentation target for this source.
      documentation_url: specUrl,
      auth: null,
      https: true,
      cors: null,
      source_catalog: "apis.guru",
      spec_url: specUrl,
      provider_name: info["x-providerName"] || apiId
    });
  }
  return entries;
}

const APIS_GURU_CATEGORIES = {
  open_data: "Open Data",
  cloud: "Development",
  developer_tools: "Development",
  financial: "Finance",
  ecommerce: "Shopping",
  media: "Video",
  analytics: "Business",
  messaging: "Email",
  telecom: "Phone",
  entertainment: "Entertainment",
  text: "Text Analysis",
  location: "Geocoding",
  transport: "Transportation",
  social: "Social",
  security: "Security",
  email: "Email",
  hosting: "Development",
  machine_learning: "Machine Learning",
  sms: "Phone"
};

function apisGuruIsHttps(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function apisGuruCategory(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return APIS_GURU_CATEGORIES[key] || "Development";
}

function clampText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function discoverApiDocsServices({ docsUrl, defaultPrice, providerName, secretValue, authHeader, payoutAddress = "", fetchImpl = globalThis.fetch }) {
  const overview = await fetchTextDocument(docsUrl, { fetchImpl });
  const docLinks = parseApiDocsLinks(overview.raw, docsUrl);
  const providerTitle = providerName || providerNameFromDocsUrl(docsUrl);
  const providerId = normalizeId(null, providerTitle, "provider");
  const endpoints = [];
  const skipped = [];
  const pagesToScan = docLinks.length ? docLinks : [docsUrl];
  for (const link of uniqueBy(pagesToScan, (item) => item)) {
    try {
      const page = await fetchTextDocument(link, { fetchImpl });
      const parsedEndpoints = parseApiEndpointDocs(page.text, link, docsUrl);
      if (!parsedEndpoints.length) {
        skipped.push({ source: link, reason: "no_api_endpoint_found" });
        continue;
      }
      endpoints.push(...parsedEndpoints);
    } catch (error) {
      skipped.push({ source: link, reason: error.message });
    }
  }
  const deduped = uniqueBy(endpoints, (endpoint) => `${endpoint.method} ${endpoint.origin}${endpoint.path}`);
  if (!deduped.length) {
    const error = new Error("API docs import failed: no HTTP API endpoints were found in the documentation pages.");
    error.statusCode = 422;
    error.code = "NO_HTTP_ENDPOINTS_IN_DOCS";
    error.validation = { scanned_links: docLinks.length, skipped: skipped.slice(0, 12) };
    throw error;
  }
  const drafts = deduped.map((endpoint) => createApiDocsEndpointDraft({
    endpoint,
    providerId,
    providerTitle,
    defaultPrice,
    secretValue,
    authHeader,
    docsUrl,
    payoutAddress
  }));
  return {
    ok: true,
    mode: "api_docs",
    source: docsUrl,
    api_url: deduped[0]?.origin || new URL(docsUrl).origin,
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    docs: {
      endpoint_count: drafts.length,
      auth_header: authHeader || deduped.find((endpoint) => endpoint.authHeader)?.authHeader || inferAuthHeader(deduped[0]?.origin || docsUrl)
    },
    drafts,
    skipped
  };
}

async function discoverSkillServices({ skillUrl, defaultPrice, providerName, secretValue, authHeader, payoutAddress = "" }) {
  const skill = await fetchSkillDocument(skillUrl);
  const parsed = parseSkillDocument(skill.text, skillUrl);
  const upstreamBaseUrl = parsed.baseUrl;
  if (!upstreamBaseUrl) {
    const error = new Error("Skill import failed: no Base URL or API host could be found in the skill document.");
    error.statusCode = 422;
    throw error;
  }
  const providerTitle = providerName || parsed.providerName || hostName(upstreamBaseUrl);
  const providerId = normalizeId(null, providerTitle, "provider");
  const secretHeader = authHeader || parsed.authHeader || (secretValue ? "auto" : inferAuthHeader(upstreamBaseUrl));
  const drafts = parsed.endpoints.map((endpoint) => createSkillEndpointDraft({
    endpoint,
    upstreamBaseUrl,
    providerId,
    providerTitle,
    defaultPrice,
    secretValue,
    authHeader: secretHeader,
    payoutAddress,
    skillUrl,
    skillTitle: parsed.title
  }));
  return {
    ok: true,
    mode: "skill_document",
    source: skill.source,
    api_url: upstreamBaseUrl,
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    skill: {
      title: parsed.title,
      auth_header: secretHeader,
      endpoint_count: drafts.length
    },
    drafts,
    skipped: parsed.skipped
  };
}

function looksLikePublicApiCatalogSource(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (host === "github.com") return path === "/public-apis/public-apis" || path === "/public-apis/public-apis/blob/master/readme.md" || path === "/public-apis/public-apis/blob/main/readme.md";
    return host === "raw.githubusercontent.com" && /^\/public-apis\/public-apis\/(?:master|main)\/readme\.md$/.test(path);
  } catch {
    return false;
  }
}

export function parsePublicApiCatalog(markdown) {
  const entries = [];
  let category = "";
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      category = cleanMarkdownCell(heading[1]);
      continue;
    }
    if (!category || !line.trim().startsWith("|")) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 5 || /^api$/i.test(cells[0]) || /^[-: ]+$/.test(cells[0])) continue;
    const link = cells[0].match(/^\[([^\]]+)]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)$/i);
    if (!link) continue;
    entries.push({
      category,
      title: cleanMarkdownCell(link[1]),
      documentation_url: link[2],
      description: cleanMarkdownCell(cells[1]),
      auth: cleanMarkdownCell(cells[2]),
      https: catalogBoolean(cells[3]),
      cors: catalogBoolean(cells[4])
    });
  }
  return entries;
}

function splitMarkdownTableRow(line) {
  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function cleanMarkdownCell(value) {
  return String(value || "")
    .replace(/`/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogBoolean(value) {
  const normalized = cleanMarkdownCell(value).toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return null;
}

function createPublicApiCatalogCandidate(entry, { source, defaultPrice }) {
  const capabilities = suggestCapabilities(`${entry.title} ${entry.description} ${entry.category}`).split(",");
  return {
    selected: false,
    service_id: normalizeId(null, `catalog ${entry.category} ${entry.title}`, "service"),
    provider_id: normalizeId(null, entry.title, "provider"),
    provider_name: entry.title,
    title: entry.title,
    description_for_agent: entry.description,
    capabilities,
    price: defaultPrice,
    sample_request: {},
    preview_data: {},
    summary: `${entry.title} is a ${entry.category} API discovery candidate. Inspect its official documentation before creating an executable AgentRouter service.`,
    source_type: "public_api_catalog",
    source_url: source,
    discovery_url: entry.documentation_url,
    discovery_status: "catalog_candidate",
    registry_eligible: false,
    publish_blocked: true,
    publish_requirements: ["discover_http_endpoint", "confirm_auth_and_terms", "generate_service_contract", "pass_live_validation"],
    catalog_metadata: {
      catalog_id: "github:public-apis/public-apis",
      category: entry.category,
      auth: entry.auth,
      https: entry.https,
      cors: entry.cors,
      documentation_url: entry.documentation_url
    },
    discovery_note: "Imported as a discovery candidate from public-apis/public-apis. It is not executable or routable until official API documentation yields a concrete endpoint that passes AgentRouter live validation."
  };
}

function resolveOpenApiServerUrl(doc, sourceUrl, requestedUrl) {
  const serverUrl = doc.servers?.[0]?.url;
  if (serverUrl) return normalizeEndpoint(serverUrl, sourceUrl).replace(/\/$/, "");
  // Swagger 2.0 declares its origin as host + basePath + schemes instead of
  // servers[]. Without this the endpoints resolve against wherever the spec
  // file was downloaded from, which is wrong whenever the spec is mirrored
  // (for example every spec served by a directory such as APIs.guru).
  if (doc.host) {
    const scheme = (Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : doc.schemes?.[0]) || "https";
    const basePath = String(doc.basePath || "").replace(/\/$/, "");
    return `${scheme}://${doc.host}${basePath}`.replace(/\/$/, "");
  }
  if (requestedUrl.endsWith(".json")) {
    return new URL(".", sourceUrl).toString().replace(/\/$/, "");
  }
  return requestedUrl.replace(/\/$/, "");
}

export async function publishApiDrafts(body, store, baseUrl, {
  user = null,
  ownerKey = "",
  registrationPersistence = {}
} = {}) {
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  if (!drafts.length) {
    const error = new Error("drafts must include at least one service draft");
    error.statusCode = 422;
    throw error;
  }
  const blocked = drafts.filter((draft) => draft.selected !== false && (draft.publish_blocked || draft.source_type === "public_api_catalog"));
  const publishable = drafts.filter((draft) => !blocked.includes(draft));
  const blockedFailures = blocked.map((draft) => ({
    service_id: draft.service_id || null,
    error: "CATALOG_CANDIDATE_REQUIRES_ENDPOINT_DISCOVERY",
    message: "Catalog candidates cannot be published directly. Inspect the official API documentation, discover a concrete HTTP endpoint, and pass live validation first.",
    discovery_url: draft.discovery_url || null
  }));
  if (!publishable.some((draft) => draft.selected !== false)) {
    return { ok: false, published: [], failed: blockedFailures };
  }
  const publishBody = { ...body, drafts: publishable };
  const remoteUrl = normalizedRemoteRegistryUrl(body.remote_registry_url);
  let result;
  if (shouldPublishToRemote({ body, baseUrl, remoteUrl })) {
    result = await publishApiDraftsToRemote({ body: publishBody, remoteUrl });
  } else {
    result = await publishApiDraftsLocal(publishBody, store, baseUrl, {
      user,
      ownerKey,
      registrationPersistence
    });
  }
  if (!blockedFailures.length) return result;
  return {
    ...result,
    ok: false,
    failed: [...(result.failed || []), ...blockedFailures]
  };
}

async function publishApiDraftsLocal(body, store, baseUrl, {
  user = null,
  ownerKey = "",
  registrationPersistence = {}
} = {}) {
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  const published = [];
  const failed = [];
  for (const draft of drafts.filter((item) => item.selected !== false)) {
    try {
      const config = createHostedHttpProviderConfig({
        baseUrl,
        serviceId: draft.service_id,
        providerId: draft.provider_id,
        title: draft.title,
        description: draft.description_for_agent,
        capabilities: draft.capabilities,
        price: draft.price,
        sampleRequest: draft.sample_request,
        sampleData: draft.preview_data,
        upstreamUrl: draft.upstream_url,
        upstreamMethod: draft.method,
        secretName: draft.secret_name || "PROVIDER_SECRET",
        secretValue: draft.secret_value || "",
        authHeader: draft.auth_header || (draft.secret_value ? "auto" : "authorization"),
        summary: draft.summary,
        payoutAddress: draft.payout_address || ""
      });
      applyOwnerMetadata(config.manifest, { user, ownerKey });
      const duplicate = store.services.get(config.manifest.service_id) || findDuplicateService(store, config.manifest);
      if (duplicate) {
        const duplicateOwnerKey = String(duplicate.manifest?.registration?.owner?.user_key || "");
        if (ownerKey && duplicateOwnerKey && duplicateOwnerKey !== ownerKey) {
          const error = new Error(`Service ${duplicate.manifest.service_id} is already registered by another account.`);
          error.statusCode = 409;
          error.code = "SERVICE_ALREADY_REGISTERED";
          throw error;
        }
        const validation = duplicate.validation_runs?.at(-1) || { ok: duplicate.verification_status === "verified" };
        if (validation.ok !== true) {
          await removeUnverifiedServiceForRetry(store, duplicate.manifest.service_id);
        } else {
          published.push({
            ok: true,
            service_id: duplicate.manifest.service_id,
            requested_service_id: config.manifest.service_id,
            already_registered: true,
            duplicate_reason: duplicate.manifest.service_id === config.manifest.service_id ? "service_id" : "same_provider_source",
            warning: null,
            registration: publicServiceRecord(duplicate),
            validation
          });
          continue;
        }
      }
      const record = await registerServiceDurably(store, config.manifest, baseUrl, registrationPersistence);
      let configPath;
      let validation;
      try {
        validation = await validateService(store, config.manifest.service_id, {
          providerConfig: config,
          // Only the platform's own mock upstream is reachable on a private test
          // origin; imported provider manifests cannot extend this allowlist.
          trustedOrigins: [{
            origin: baseUrl,
            pathPrefixes: ["/mock/upstream/", "/mock/api/"],
            exactPaths: ["/api/v1/data/header-key"]
          }]
        });
      } catch (error) {
        await abortServiceRegistration(store, record);
        throw error;
      }
      if (!validation.ok) {
        await abortServiceRegistration(store, record);
        failed.push({
          service_id: config.manifest.service_id,
          error: "VALIDATION_FAILED",
          message: summarizeValidationFailure(validation),
          validation
        });
        continue;
      }
      config.manifest.registration = {
        ...(config.manifest.registration || {}),
        publish_state: "published"
      };
      try {
        const prepared = await prepareProviderConfigForPersistence(config);
        const durable = Boolean(typeof registrationPersistence.enabled === "function"
          ? registrationPersistence.enabled()
          : registrationPersistence.enabled);
        if (!durable) configPath = await writePreparedProviderConfigFile(prepared);
        await finalizeServiceRegistration(store, record, { config: prepared });
        if (durable) configPath = await writePreparedProviderConfigFile(prepared).catch(() => null);
        Object.assign(config, prepared);
      } catch (error) {
        await abortServiceRegistration(store, record);
        if (configPath) await deleteProviderConfig(config.manifest.service_id).catch(() => {});
        throw error;
      }
      published.push({
        ok: true,
        service_id: config.manifest.service_id,
        warning: null,
        provider_config_path: configPath,
        registration: publicServiceRecord(record),
        validation
      });
    } catch (error) {
      const existing = store.services.get(draft.service_id);
      if (existing && /already registered/i.test(error.message)) {
        const validation = existing.validation_runs?.at(-1) || { ok: existing.verification_status === "verified" };
        if (validation.ok !== true) {
          await removeUnverifiedServiceForRetry(store, draft.service_id);
          failed.push({
            service_id: draft.service_id,
            error: "RETRY_REPLACED_UNVERIFIED_SERVICE",
            message: "The previous unverified service was removed. Click Verify & Publish again to retry with the current endpoint/auth/request body.",
            validation
          });
          continue;
        }
        published.push({
          ok: true,
          service_id: draft.service_id,
          already_registered: true,
          warning: null,
          registration: publicServiceRecord(existing),
          validation
        });
        continue;
      }
      failed.push({
        service_id: draft.service_id,
        error: error.code || "PUBLISH_ERROR",
        message: error.message
      });
    }
  }

  return {
    ok: published.length > 0 && failed.length === 0,
    published,
    failed
  };
}

function applyOwnerMetadata(manifest, { user = null, ownerKey = "" } = {}) {
  if (!ownerKey) return;
  manifest.registration = {
    ...(manifest.registration || {}),
    owner: {
      user_key: ownerKey,
      provider: user?.provider || "",
      user_id: user?.id || "",
      handle: user?.handle || "",
      email: user?.email || "",
      name: user?.name || "",
      created_at: new Date().toISOString()
    }
  };
}

async function removeUnverifiedServiceForRetry(store, serviceId) {
  unregisterService(store, serviceId);
  await deleteProviderConfig(serviceId);
}

function summarizeValidationFailure(validation = {}) {
  if (validation.error === "EXPECTED_402_PAYMENT_REQUIRED" && validation.status === 503) {
    return "Provider payout wallet is missing or invalid. Add a provider EVM payout address before publishing paid services.";
  }
  const providerCode = validation.provider_error?.code;
  const providerMessage = validation.provider_error?.message;
  if (providerCode === "UPSTREAM_ERROR") {
    const upstream = validation.provider_error?.upstream_payload;
    const upstreamStatus = validation.provider_error?.upstream_status;
    const upstreamCode = upstream?.code;
    const upstreamReason = upstream?.reason;
    if (upstreamCode === "UPSTREAM_NON_JSON_RESPONSE") {
      return "The endpoint responded, but it did not return JSON. Use a JSON API endpoint or update the URL.";
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return "The upstream API rejected authentication. Check that the API key is valid for this endpoint and that the auth header is correct.";
    }
    if (upstreamReason === "auth_or_permission_error") {
      return "The endpoint rejected authentication. Check the API key and auth header, or leave the header blank so AgentRouter can try common header names.";
    }
    if (upstreamReason === "non_success_status" || upstreamReason === "empty_error_payload") {
      return upstream.message || "The endpoint returned an application-level error instead of usable data.";
    }
    return providerMessage || "The endpoint was reachable, but the upstream API rejected or failed the request.";
  }
  const resultCode = validation.result_errors?.[0]?.code;
  if (resultCode === "RESULT_DATA_EMPTY") return "The endpoint returned empty data. Publish requires one real non-empty result.";
  if (resultCode === "RESULT_DATA_PLACEHOLDER") return "The endpoint returned placeholder data. Publish requires a real result, not a shape-only sample.";
  const schemaMessage = validation.schema_errors?.[0]?.message || validation.envelope_errors?.[0]?.message;
  return schemaMessage || "Service was not registered because validation failed. Confirm the API endpoint, auth, request body, and JSON response shape.";
}

function shouldPublishToRemote({ body, baseUrl, remoteUrl }) {
  const scope = body.publish_scope || process.env.ADN_PUBLISH_SCOPE || "remote_and_local";
  if (scope === "local_only") return false;
  if (!remoteUrl) return false;
  if (!isLocalBaseUrl(baseUrl)) return false;
  return new URL(remoteUrl).origin !== new URL(baseUrl).origin;
}

function normalizedRemoteRegistryUrl(value) {
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "";
  const raw = value || process.env.ADN_REMOTE_REGISTRY_URL || process.env.AGENT_ROUTER_PUBLIC_URL || renderUrl || "https://agentrouter.network";
  if (!raw) return "";
  return normalizeEndpoint(raw, "https://agentrouter.local").replace(/\/$/, "");
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function publishApiDraftsToRemote({ body, remoteUrl }) {
  const remoteToken = body.remote_publish_token || process.env.ADN_REMOTE_PUBLISH_TOKEN || process.env.ADN_STUDIO_API_TOKEN || "";
  const remoteCookie = body.remote_session_cookie || process.env.ADN_REMOTE_SESSION_COOKIE || "";
  const headers = { "content-type": "application/json" };
  if (remoteToken) headers.authorization = `Bearer ${remoteToken}`;
  if (remoteCookie) headers.cookie = remoteCookie;
  const response = await fetchWithTimeout(`${remoteUrl}/studio/import/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...body,
      publish_scope: "local_only",
      remote_publish_token: undefined,
      remote_registry_url: undefined
    })
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: {
      code: "REMOTE_PUBLISH_NON_JSON_RESPONSE",
      message: "Remote registry did not return JSON."
    }
  }));
  if (!response.ok || payload.ok !== true) {
    const remoteError = payload.error || {};
    const message = remoteError.message || payload.message || `Remote registry rejected publish with HTTP ${response.status}.`;
    const code = remoteError.code || payload.error || "REMOTE_PUBLISH_FAILED";
    const drafts = Array.isArray(body.drafts) ? body.drafts : [];
    return {
      ok: false,
      remote_registry_url: remoteUrl,
      publish_scope: "remote_and_local",
      remote_status: response.status,
      local_published: false,
      published: [],
      failed: drafts.map((draft) => ({
        service_id: draft.service_id,
        error: "REMOTE_PUBLISH_FAILED",
        message,
        remote_status: response.status,
        remote_error: code
      }))
    };
  }
  return {
    ...payload,
    ok: response.ok && payload.ok === true,
    remote_registry_url: remoteUrl,
    publish_scope: "remote_and_local",
    remote_status: response.status,
    local_published: false
  };
}

async function fetchOpenApiDocument(apiUrl, { fetchImpl = globalThis.fetch, allowDirectJsonEndpoint = false } = {}) {
  const candidates = buildOpenApiCandidates(apiUrl);
  const attempted = [];
  for (const candidate of candidates) {
    try {
      attempted.push(candidate);
      const response = await fetchWithTimeout(candidate, { fetchImpl });
      if (!response.ok) continue;
      const doc = await response.json();
      if (doc.openapi || doc.swagger) return { source: candidate, doc };
      const converted = convertEndpointIndex(doc, apiUrl);
      if (converted) return { source: candidate, doc: converted };
      if (allowDirectJsonEndpoint && candidate === apiUrl && doc != null && typeof doc === "object") {
        return { source: apiUrl, directEndpoint: true };
      }
    } catch {
      // Try the next candidate.
    }
  }
  const error = new Error(`Could not find OpenAPI/Swagger or endpoint index. Tried: ${attempted.join(", ")}`);
  if (looksLikeCallableEndpoint(apiUrl)) return { source: apiUrl, directEndpoint: true };
  error.statusCode = 422;
  throw error;
}

function buildOpenApiCandidates(apiUrl) {
  if (apiUrl.endsWith(".json")) return [apiUrl];
  const normalized = apiUrl.replace(/\/$/, "");
  const url = new URL(normalized);
  const candidates = new Set(OPENAPI_CANDIDATES.map((suffix) => `${normalized}${suffix}`));
  if (url.pathname.endsWith("/api")) {
    const root = `${url.origin}${url.pathname.replace(/\/api$/, "")}`;
    for (const suffix of OPENAPI_CANDIDATES) candidates.add(`${root}${suffix}`);
  }
  return [...candidates];
}

function convertEndpointIndex(doc, apiUrl) {
  const endpoints = Array.isArray(doc) ? doc : doc.endpoints || doc.routes || doc.data_endpoints;
  if (!Array.isArray(endpoints)) return null;
  const paths = {};
  for (const endpoint of endpoints) {
    const path = endpoint.path || endpoint.url || endpoint.endpoint;
    if (!path) continue;
    const method = String(endpoint.method || "GET").toLowerCase();
    paths[path.startsWith("/") ? path : new URL(path, `${apiUrl.replace(/\/$/, "")}/`).pathname] = {
      [method]: {
        operationId: endpoint.operationId || endpoint.id,
        summary: endpoint.title || endpoint.summary || titleFromPath(path, method),
        description: endpoint.description || "",
        parameters: Object.entries(endpoint.params || endpoint.query || {}).map(([name, example]) => ({
          name,
          in: "query",
          schema: { type: typeof example === "number" ? "number" : "string", example }
        })),
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                example: endpoint.example_response || endpoint.preview_data || { ok: true }
              }
            }
          }
        }
      }
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: hostName(apiUrl), version: "generated" },
    paths
  };
}

function createServiceDraft({ apiUrl, routePath, method, operation, pathItem, doc, providerId, providerTitle, defaultPrice, secretValue, payoutAddress = "" }) {
  const decodedRoutePath = decodePathTemplate(routePath);
  const title = operation.summary || titleFromPath(decodedRoutePath, method);
  const serviceId = normalizeId(operation.operationId, title, "service");
  const upstreamUrl = `${apiUrl.replace(/\/$/, "")}${decodedRoutePath}`;
  const sampleRequest = { ...paramsFromPathTemplate(decodedRoutePath), ...sampleRequestFor(operation, pathItem, doc) };
  const previewData = previewDataFor(operation, doc);
  const summary = routingSummary({
    title,
    providerTitle,
    method,
    routePath: decodedRoutePath,
    sampleRequest,
    previewData,
    description: operation.description,
    sourceTitle: "OpenAPI"
  });
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath: decodedRoutePath,
    sampleRequest,
    baseDescription: operation.description
  });
  const capabilities = suggestCapabilities(capabilityTextFor({
    title,
    routePath: decodedRoutePath,
    sampleRequest
  }));

  return {
    selected: true,
    service_id: serviceId,
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: capabilities.split(","),
    price: defaultPrice,
    method: method.toUpperCase(),
    path: decodedRoutePath,
    upstream_url: upstreamUrl,
    auth_header: secretValue ? "auto" : inferAuthHeader(apiUrl),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    payout_address: payoutAddress,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary,
    data_contract: dataContractFor({ method: method.toUpperCase(), routePath: decodedRoutePath, sampleRequest, previewData })
  };
}

function createDirectEndpointDraft({ apiUrl, providerId, providerTitle, defaultPrice, secretValue, defaultMethod, authHeader, payoutAddress = "" }) {
  const url = new URL(apiUrl);
  const routePath = url.pathname;
  const method = defaultMethod || inferMethodForEndpoint(apiUrl);
  const title = titleFromPath(routePath, method);
  const sampleRequest = sampleRequestForDirectEndpoint(apiUrl);
  const previewData = previewDataForDirectEndpoint(apiUrl);
  const description = agentDescription({ title, providerTitle, method, routePath, sampleRequest });
  return {
    selected: true,
    service_id: normalizeId(null, `${method} ${routePath}`, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: suggestCapabilities(capabilityTextFor({ title, routePath, sampleRequest })).split(","),
    price: defaultPrice,
    method: method.toUpperCase(),
    path: routePath,
    upstream_url: apiUrl,
    auth_header: authHeader || (secretValue ? "auto" : inferAuthHeader(apiUrl)),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    payout_address: payoutAddress,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: resultSummary({ title, providerTitle, routePath, previewData }),
    data_contract: dataContractFor({ method: method.toUpperCase(), routePath, sampleRequest, previewData }),
    discovery_note: "Generated from a direct API endpoint URL because no OpenAPI/Swagger document was found."
  };
}

function createSkillEndpointDraft({ endpoint, upstreamBaseUrl, providerId, providerTitle, defaultPrice, secretValue, authHeader, payoutAddress = "", skillUrl, skillTitle }) {
  const method = endpoint.method || "GET";
  const routePath = endpoint.path.startsWith("/") ? endpoint.path : new URL(endpoint.path, `${upstreamBaseUrl}/`).pathname;
  const title = normalizeEndpointTitle(endpoint.title, routePath, method);
  const sampleRequest = { ...endpoint.params };
  const previewData = endpoint.previewData || { status: 0, message: "", data: { example: true } };
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath,
    sampleRequest,
    baseDescription: endpoint.description,
    sourceTitle: skillTitle
  });
  const capabilities = suggestCapabilities(capabilityTextFor({ title, routePath, sampleRequest })).split(",");
  return {
    selected: true,
    service_id: normalizeId(endpoint.operationId, title, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities,
    price: defaultPrice,
    method,
    path: routePath,
    upstream_url: `${upstreamBaseUrl.replace(/\/$/, "")}${routePath}`,
    auth_header: authHeader,
    secret_name: inferSecretName(upstreamBaseUrl),
    secret_value: secretValue,
    payout_address: payoutAddress,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: endpoint.summary || resultSummary({ title, providerTitle, routePath, previewData }),
    data_contract: dataContractFor({ method, routePath, sampleRequest, previewData }),
    source_type: "skill_import",
    source_url: skillUrl,
    discovery_note: "Generated from a Skill document. The skill text was parsed statically; publish still requires a real upstream validation call."
  };
}

function createApiDocsEndpointDraft({ endpoint, providerId, providerTitle, defaultPrice, secretValue, authHeader, docsUrl, payoutAddress = "" }) {
  const method = endpoint.method || "GET";
  const routePath = decodePathTemplate(endpoint.path);
  const sampleRequest = { ...paramsFromPathTemplate(routePath), ...(endpoint.sampleRequest || {}) };
  const previewData = endpoint.previewData || { data: [{ example: true }] };
  const title = normalizeEndpointTitle(endpoint.title, routePath, method);
  const summary = routingSummary({
    title,
    providerTitle,
    method,
    routePath,
    sampleRequest,
    previewData,
    description: [endpoint.summary, endpoint.description].filter(Boolean).join(" "),
    sourceTitle: "API docs"
  });
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath,
    sampleRequest,
    baseDescription: endpoint.description,
    sourceTitle: "API docs"
  });
  return {
    selected: true,
    service_id: normalizeId(endpoint.operationId, `${providerTitle} ${method} ${routePath}`, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: suggestCapabilities(capabilityTextFor({ title, routePath, sampleRequest })).split(","),
    price: defaultPrice,
    method,
    path: routePath,
    upstream_url: `${endpoint.origin.replace(/\/$/, "")}${routePath}`,
    auth_header: authHeader || endpoint.authHeader || (secretValue ? "auto" : inferAuthHeader(endpoint.origin)),
    secret_name: inferSecretName(endpoint.origin),
    secret_value: secretValue,
    payout_address: payoutAddress,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary,
    data_contract: dataContractFor({ method, routePath, sampleRequest, previewData }),
    source_type: "api_docs_import",
    source_url: endpoint.sourceUrl || docsUrl,
    discovery_note: "Generated from API documentation pages. Publish still requires a real upstream validation call."
  };
}

function agentDescription({ title, providerTitle, method, routePath, sampleRequest = {}, baseDescription = "", sourceTitle = "" }) {
  const cleanBase = cleanDescription(baseDescription);
  const params = Object.keys(sampleRequest);
  const paramText = params.length
    ? ` Accepts ${params.map((name) => `"${name}"`).join(", ")} as input.`
    : " No input is required for the default request.";
  const sourceText = sourceTitle ? ` Imported from ${sourceTitle}.` : "";
  if (cleanBase && !/^use this service to call/i.test(cleanBase)) {
    return `${cleanBase}${paramText}${sourceText}`;
  }
  return `Returns ${title} data from ${providerTitle} via ${String(method).toUpperCase()} ${routePath}.${paramText}${sourceText}`;
}

function capabilityTextFor({ title, routePath, sampleRequest }) {
  return [
    title,
    routePath,
    Object.keys(sampleRequest || {}).join(" ")
  ].filter(Boolean).join(" ");
}

function routingSummary({ title, providerTitle, method, routePath, sampleRequest = {}, previewData, description = "", sourceTitle = "" }) {
  const cleanBase = cleanDescription(description);
  const inputKeys = Object.keys(sampleRequest || {});
  const outputKeys = responseKeys(previewData, 8);
  const routeTerms = routePath
    .split("/")
    .filter(Boolean)
    .filter((part) => !/^api$/i.test(part) && !/^v\d+$/i.test(part))
    .map((part) => part.replace(/^\{|\}$/g, "").replace(/[-_]/g, " "))
    .filter(Boolean);
  const intentTerms = [...new Set([
    ...title.replace(/["']/g, "").split(/\s+/),
    ...routeTerms,
    ...inputKeys
  ].map((term) => String(term || "").trim()).filter((term) => term.length > 2))].slice(0, 12);
  const useFor = cleanBase || `Use this service when an agent needs ${title} from ${providerTitle}.`;
  const inputText = inputKeys.length
    ? `Inputs: ${inputKeys.join(", ")}.`
    : "Inputs: none required for the default request.";
  const outputText = outputKeys.length
    ? `Returns JSON fields such as ${outputKeys.join(", ")}.`
    : "Returns a JSON data response.";
  const sourceText = sourceTitle ? `Source: ${sourceTitle}.` : "";
  const routeText = `Endpoint: ${String(method).toUpperCase()} ${routePath}.`;
  const intentText = intentTerms.length ? `Routing keywords: ${intentTerms.join(", ")}.` : "";
  return [useFor, routeText, inputText, outputText, intentText, sourceText].filter(Boolean).join(" ");
}

function cleanDescription(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^use this service to call\s+/i, "")
    .trim();
}

function dataContractFor({ method, routePath, sampleRequest, previewData }) {
  return {
    request: {
      method: String(method || "GET").toUpperCase(),
      path: routePath,
      example: sampleRequest || {}
    },
    response: {
      content_type: "application/json",
      preview_shape: shapeFor(previewData)
    },
    request_data: {
      fields: Object.keys(sampleRequest || {}),
      example: sampleRequest || {},
      shape: shapeFor(sampleRequest || {})
    },
    response_data: {
      fields: responseKeys(previewData, 16),
      preview: previewData,
      shape: shapeFor(previewData),
      note: "Preview data is exposed before payment so the buyer Agent can judge task fit. Paid responses should keep the same general shape but may contain fresher or fuller data."
    },
    pre_call_context: {
      pricing_hint: "Uses the service price shown on this draft and x402-style per-call payment after publishing.",
      buyer_requirements: {
        payment_required: true,
        needs_buyer_api_key: false
      },
      freshness_hint: "Published hosted API services are validated live and normally invoked on request.",
      source_hint: "Provider-declared source; publish performs a live validation call before the service becomes routable.",
      validation_hint: "Must return JSON and pass the Agent Data Envelope checks before registration."
    }
  };
}

function shapeFor(value) {
  if (Array.isArray(value)) return value.length ? [shapeFor(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, shapeFor(child)]));
  }
  if (value === null) return "null";
  return typeof value;
}

function responseKeys(value, limit = 8, prefix = "") {
  if (limit <= 0) return [];
  if (Array.isArray(value)) return value.length ? responseKeys(value[0], limit, prefix) : [];
  if (!value || typeof value !== "object") return [];
  const keys = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    if (keys.length >= limit) break;
    if (child && typeof child === "object") {
      for (const nested of responseKeys(child, limit - keys.length, path)) {
        keys.push(nested);
        if (keys.length >= limit) break;
      }
    }
    if (keys.length >= limit) break;
  }
  return keys;
}

function looksLikeSkillSource(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return /clawhub\.ai$/i.test(url.hostname) || /skill/i.test(url.pathname);
  } catch {
    return false;
  }
}

function looksLikeApiDocsSource(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return /(^|\.)docs?\./i.test(url.hostname)
      || /\/(api|apis|reference|docs?|developers?)(\/|$)/i.test(url.pathname)
      || /overview|reference|documentation/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function fetchTextDocument(url, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchWithTimeout(url, { fetchImpl });
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.statusCode = 422;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  if (contentType.includes("html")) {
    const markdown = await fetchMarkdownVariant(url, { fetchImpl });
    if (markdown && (containsEmbeddedOpenApi(markdown) || endpointSignalScore(markdown) > endpointSignalScore(raw))) {
      return {
        source: `${url}.md`,
        raw: markdown,
        text: markdown
      };
    }
  }
  return {
    source: url,
    raw,
    text: contentType.includes("html") ? htmlToText(raw) : raw
  };
}

async function fetchMarkdownVariant(url, { fetchImpl = globalThis.fetch } = {}) {
  if (/\.md(?:$|[?#])/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}.md`;
    const response = await fetchWithTimeout(parsed.toString(), { fetchImpl });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

function containsEmbeddedOpenApi(text) {
  return /["']openapi["']\s*:/i.test(text) && /["']paths["']\s*:/i.test(text);
}

function endpointSignalScore(text) {
  const value = String(text || "");
  const methodCount = [...value.matchAll(/\b(GET|POST|PUT|PATCH)\s+(?:https?:\/\/|\/)/gi)].length;
  const urlCount = [...value.matchAll(/https?:\/\/[^\s`"'<>\\)]+/gi)].length;
  const jsonCount = [...value.matchAll(/\{[\s\S]{0,300}\}/g)].length;
  return methodCount * 10 + urlCount * 3 + jsonCount;
}

async function fetchSkillDocument(skillUrl) {
  const response = await fetchWithTimeout(skillUrl);
  if (!response.ok) {
    const error = new Error(`Skill import failed: ${skillUrl} returned HTTP ${response.status}`);
    error.statusCode = 422;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  const text = contentType.includes("html") ? extractSkillReadmeFromHtml(raw) || htmlToText(raw) : raw;
  return { source: skillUrl, text };
}

function parseSkillDocument(text, skillUrl) {
  const title = extractSkillTitle(text, skillUrl);
  const baseUrl = firstMatch(text, /Base URL\s*:\s*`?(https?:\/\/[^\s`]+)`?/i)
    || firstMatch(text, /(https?:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?)/i)?.replace(/\/v\d+\/.*$/i, "");
  const authHeader = firstMatch(text, /Header\s+`?([A-Za-z0-9_-]+)\s*:\s*\$?[A-Z0-9_]+`?/i)
    || firstMatch(text, /Auth\s*:[^\n]*Header\s+`?([A-Za-z0-9_-]+)\s*:\s*\$?[A-Z0-9_]+`?/i)
    || firstMatch(text, /-H\s+["']([^:"']+)\s*:\s*\$?[A-Z0-9_]+["']/i)
    || "";
  const endpoints = parseSkillEndpoints(text, baseUrl);
  if (!endpoints.length) {
    const cliCommands = detectCliSkillCommands(text);
    const error = new Error(cliCommands.length
      ? `Skill import failed: this is a CLI-based Skill, not an HTTP API Skill. Provider Studio can import HTTP API endpoints, but this Skill runs local commands such as: ${cliCommands.slice(0, 3).join("; ")}. Use an API/OpenAPI URL, or add a CLI adapter before publishing it as a data service.`
      : "Skill import failed: no HTTP API endpoints were found in the skill document.");
    error.statusCode = 422;
    error.code = cliCommands.length ? "CLI_SKILL_NOT_HTTP_API" : "NO_HTTP_ENDPOINTS_IN_SKILL";
    error.validation = cliCommands.length ? { detected_cli_commands: cliCommands.slice(0, 12) } : undefined;
    throw error;
  }
  return {
    title,
    baseUrl: baseUrl ? baseUrl.replace(/\/$/, "") : "",
    providerName: providerNameFromSkill(title, baseUrl),
    authHeader,
    endpoints,
    skipped: []
  };
}

function extractSkillTitle(text, skillUrl) {
  const explicitTitle = firstMatch(text, /\b([A-Z][A-Za-z0-9 ._-]{2,80}\s+API Skill)\b/);
  if (explicitTitle) return cleanEndpointTitle(explicitTitle);
  const headings = [...String(text || "").matchAll(/^#\s+(.+)$/gm)]
    .map((match) => cleanEndpointTitle(match[1]))
    .filter((heading) => heading && !/^\d+\./.test(heading));
  return headings.find((heading) => /api skill|skill/i.test(heading) && !/--/.test(heading))
    || headings.find((heading) => /skill/i.test(heading))
    || headings[0]
    || titleFromSkillUrl(skillUrl);
}

function parseSkillEndpoints(text, baseUrl) {
  const endpoints = new Map();
  for (const endpoint of parseCurlEndpoints(text, baseUrl)) {
    endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseReferenceEndpoints(text, baseUrl)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseLooseUrlEndpoints(text, baseUrl)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseLoosePathEndpoints(text)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  return [...endpoints.values()].filter((endpoint) => !SKIP_PATH_RE.test(endpoint.path));
}

function detectCliSkillCommands(text) {
  const commands = [];
  const re = /(?:^|\n)\s*([a-z][a-z0-9_-]*(?:\s+[a-z0-9:_./=-]+){1,12})(?:\s|$)/gi;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const command = match[1].trim();
    if (/^(curl|GET|POST|PUT|PATCH)\b/i.test(command)) continue;
    if (/^(name|description|base|header|auth|endpoint|path|url)\b/i.test(command)) continue;
    if (!/[a-z0-9_-]+\s+[a-z0-9:_./=-]+/i.test(command)) continue;
    if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}

function parseCurlEndpoints(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const endpoints = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isCurlUrlLine(lines, index)) continue;
    const url = firstMatch(line, /(https?:\/\/[^\s"'`\\]+)/);
    if (!url || (baseUrl && !url.startsWith(baseUrl))) continue;
    const previous = previousComment(lines, index);
    const nextLines = lines.slice(index + 1, index + 8);
    const params = {};
    for (const next of nextLines) {
      if (/curl\s+-/.test(next) || /https?:\/\//.test(next)) break;
      const param = firstMatch(next, /--data-urlencode\s+["']?([^="'\s]+)=([^"'\s]+)["']?/);
      if (param) {
        const match = next.match(/--data-urlencode\s+["']?([^="'\s]+)=([^"'\s]+)["']?/);
        params[match[1]] = normalizeParamExample(match[2]);
      }
    }
    endpoints.push(endpointFromUrl({
      url,
      method: inferMethodFromCurlContext(line, nextLines),
      title: cleanEndpointTitle(previous) || titleFromPath(new URL(url).pathname, "GET"),
      params,
      description: previous ? cleanEndpointTitle(previous) : ""
    }));
  }
  return endpoints;
}

function isCurlUrlLine(lines, index) {
  const line = lines[index].trim();
  if (/^curl\b/i.test(line)) return true;
  if (/^["']?https?:\/\//i.test(line)) {
    return lines.slice(Math.max(0, index - 4), index).some((previous) => /^curl\b/i.test(previous.trim()));
  }
  return false;
}

function parseReferenceEndpoints(text, baseUrl) {
  const endpoints = [];
  const re = /\b(GET|POST|PUT|PATCH)\s+((?:https?:\/\/[^\s`|"'\\]+)|(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+))/gi;
  let match;
  while ((match = re.exec(text))) {
    const method = match[1].toUpperCase();
    const rawTarget = match[2].replace(/\s+$/, "");
    const parsedTarget = endpointTarget(rawTarget, baseUrl);
    if (!parsedTarget || !looksLikeDataPath(parsedTarget.path)) continue;
    const windowText = text.slice(Math.max(0, match.index - 100), Math.min(text.length, match.index + 180));
    const title = cleanEndpointTitle(firstMatch(windowText, /([A-Za-z0-9 /&()[\]_-]{4,80})\s+`?(?:GET|POST|PUT|PATCH)\s+(?:https?:\/\/|\/)/i)) || titleFromPath(parsedTarget.path, method);
    endpoints.push({
      method,
      path: parsedTarget.path,
      title,
      description: `Use this service to call ${method} ${parsedTarget.path}.`,
      params: paramsFromReferenceWindow(windowText),
      operationId: normalizeId(null, `${method} ${parsedTarget.path}`, "service")
    });
  }
  return endpoints.filter((endpoint) => !baseUrl || endpoint.path);
}

function parseLooseUrlEndpoints(text, baseUrl) {
  if (!baseUrl) return [];
  const endpoints = [];
  const re = /https?:\/\/[^\s`|"'\\)]+/gi;
  let match;
  while ((match = re.exec(text))) {
    const rawUrl = match[0].replace(/[.,;:]+$/g, "");
    if (!rawUrl.startsWith(baseUrl)) continue;
    const parsed = endpointTarget(rawUrl, baseUrl);
    if (!parsed || !looksLikeDataPath(parsed.path)) continue;
    if (parsed.path === "/" || parsed.path === new URL(baseUrl).pathname) continue;
    const windowText = text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 220));
    endpoints.push(endpointFromUrl({
      url: rawUrl,
      method: inferMethodFromTextWindow(windowText),
      title: cleanEndpointTitle(firstMatch(windowText, /(?:^|\n)\s*(?:#+\s*)?([A-Za-z0-9 /&()[\]_-]{4,80})\s*(?:\n|$)/)) || titleFromPath(parsed.path, "GET"),
      params: paramsFromReferenceWindow(windowText),
      description: ""
    }));
  }
  return endpoints;
}

function parseLoosePathEndpoints(text) {
  const endpoints = [];
  const re = /\b(?:endpoint|path|url|route)\s*[:=]\s*`?((?:GET|POST|PUT|PATCH)\s+)?(\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)`?/gi;
  let match;
  while ((match = re.exec(text))) {
    const method = (match[1] || "GET").trim().toUpperCase() || "GET";
    const path = match[2].replace(/[.,;:]+$/g, "");
    if (!looksLikeDataPath(path)) continue;
    const windowText = text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 220));
    endpoints.push({
      method,
      path,
      title: cleanEndpointTitle(firstMatch(windowText, /(?:name|title|summary)\s*[:=]\s*`?([A-Za-z0-9 /&()[\]_-]{4,80})`?/i)) || titleFromPath(path, method),
      description: `Use this service to call ${method} ${path}.`,
      params: paramsFromReferenceWindow(windowText),
      operationId: normalizeId(null, `${method} ${path}`, "service")
    });
  }
  return endpoints;
}

function endpointTarget(rawTarget, baseUrl) {
  try {
    const parsed = rawTarget.startsWith("http")
      ? new URL(rawTarget)
      : new URL(rawTarget, `${baseUrl || "https://skill.local"}/`);
    const params = {};
    for (const [key, value] of parsed.searchParams.entries()) params[key] = normalizeParamExample(value);
    return { path: decodePathTemplate(parsed.pathname), params };
  } catch {
    return null;
  }
}

function looksLikeDataPath(path) {
  if (!path || path === "/") return false;
  if (SKIP_PATH_RE.test(path)) return false;
  if (/\.(png|jpe?g|gif|svg|css|js|ico|xml|rss|atom|html?)$/i.test(path)) return false;
  if (/\/(docs?|documentation|swagger|openapi|redoc)(\/|$)/i.test(path)) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return true;
}

function inferMethodFromTextWindow(text) {
  const method = firstMatch(text, /\b(GET|POST|PUT|PATCH)\b/i);
  return method ? method.toUpperCase() : "GET";
}

function endpointFromUrl({ url, method, title, params, description }) {
  const parsed = new URL(url);
  for (const [key, value] of parsed.searchParams.entries()) params[key] = normalizeParamExample(value);
  const routePath = decodePathTemplate(parsed.pathname);
  const normalizedTitle = normalizeEndpointTitle(title, routePath, method);
  return {
    method,
    path: routePath,
    title: normalizedTitle,
    description: description || `Use this service to call ${method} ${routePath}.`,
    params,
    operationId: normalizeId(null, `${method} ${routePath}`, "service")
  };
}

function inferMethodFromCurlContext(_line, nextLines) {
  return nextLines.some((line) => /-X\s+POST|--request\s+POST/i.test(line)) ? "POST" : "GET";
}

function previousComment(lines, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 5); cursor -= 1) {
    const line = lines[cursor].trim();
    const comment = firstMatch(line, /^#\s*(.+)$/);
    if (comment) return comment;
    if (line && !/\\$/.test(line) && !/^curl\b/.test(line) && !/^-/.test(line)) return line;
  }
  return "";
}

function paramsFromReferenceWindow(text) {
  const params = {};
  const snippets = text.match(/`[a-zA-Z0-9_]+=[^`]+`|`[a-zA-Z0-9_]+`/g) || [];
  for (const snippet of snippets) {
    const clean = snippet.replace(/`/g, "");
    if (/^GET |^POST |^\//i.test(clean)) continue;
    if (clean.includes("=")) {
      const [key, value] = clean.split("=");
      params[key] = normalizeParamExample((value || "").split("/")[0]);
    }
  }
  return params;
}

function normalizeParamExample(value) {
  const cleaned = String(value || "").replace(/^\[|\]$/g, "");
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  if (cleaned.includes("/")) return cleaned.split("/")[0];
  return cleaned || "example";
}

function decodePathTemplate(path) {
  const rawPath = String(path || "");
  try {
    return rawPath
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return rawPath
      .replace(/%7B/gi, "{")
      .replace(/%7D/gi, "}");
  }
}

function paramsFromPathTemplate(path) {
  const params = {};
  const re = /\{([^}/]+)\}/g;
  let match;
  while ((match = re.exec(String(path || "")))) {
    params[match[1]] = sampleStringForName(match[1]);
  }
  return params;
}

function cleanEndpointTitle(value) {
  return String(value || "")
    .replace(/^\d+\.\s*/, "")
    .replace(/[:：]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEndpointTitle(value, routePath, method = "GET") {
  const cleaned = cleanEndpointTitle(value);
  const derived = friendlyTitleFromRoutePath(routePath);
  if (!cleaned) return derived || titleFromPath(routePath, method);
  if (derived && shouldPreferRouteTitle(cleaned, routePath, derived)) return derived;
  return cleaned;
}

function shouldPreferRouteTitle(title, routePath, derived) {
  const value = String(title || "").trim().toLowerCase();
  const path = String(routePath || "").toLowerCase();
  if (!value) return true;
  if (value.length < 4) return true;
  if (/^(get|post|put|patch)\s+/i.test(title)) return true;
  if (/^(\(?up to \d+\)?|\(?no pagination\)?|request example\b|triggers?\b|copy|responses?|body|parameters?)/i.test(value)) return true;
  if (/^[a-z][a-z-]{3,20}$/.test(title) && !derived.toLowerCase().includes(value)) return true;
  if (/(\/article|\/newsflash)(\/[^/]+)$/.test(path) && /^all (articles|newsflashes)$/i.test(title)) return true;
  if (/\/newsflash\/(onchain|prediction|financing|first|original|ai|important)\b/.test(path)) return true;
  if (/\/article\/(24h|important|original)\b/.test(path)) return true;
  return false;
}

function friendlyTitleFromRoutePath(routePath) {
  const parts = pathMeaningParts(routePath);
  if (!parts.length) return "";
  const [head, ...rest] = parts;
  if (head === "article") return titleForArticleEndpoint(rest);
  if (head === "newsflash") return titleForNewsflashEndpoint(rest);
  if (head === "search") return "Search articles and news";
  if (head === "data" && rest.length) return `${titleCaseEndpointWords(rest)} data`;
  return "";
}

function pathMeaningParts(routePath) {
  return decodePathTemplate(routePath)
    .split("/")
    .filter(Boolean)
    .filter((part) => !/^api$/i.test(part) && !/^v\d+$/i.test(part))
    .map((part) => part.replace(/^\{|\}$/g, "").toLowerCase());
}

function titleForArticleEndpoint(parts) {
  const key = parts.join("_");
  if (!key) return "All articles";
  if (key === "24h") return "Articles from last 24h";
  if (key === "important") return "Important articles";
  if (key === "original") return "Original articles";
  return `${titleCaseEndpointWords(parts)} articles`;
}

function titleForNewsflashEndpoint(parts) {
  const key = parts.join("_");
  if (!key) return "All newsflashes";
  if (key === "24h") return "Newsflashes from last 24h";
  if (key === "important") return "Important newsflashes";
  if (key === "first") return "First important newsflash";
  if (key === "onchain") return "On-chain newsflashes";
  if (key === "financing") return "Financing newsflashes";
  if (key === "prediction") return "Prediction market newsflashes";
  if (key === "original") return "Original newsflashes";
  if (key === "ai") return "AI newsflashes";
  return `${titleCaseEndpointWords(parts)} newsflashes`;
}

function titleCaseEndpointWords(parts) {
  return parts
    .flatMap((part) => String(part).split(/[-_]+/))
    .filter(Boolean)
    .map(endpointWord)
    .join(" ");
}

function endpointWord(word) {
  const upper = new Set(["ai", "api", "aum", "btc", "dxy", "eth", "etf", "fbtc", "ibit", "m2", "pnl", "us", "usd"]);
  const normalized = String(word || "").toLowerCase();
  if (/^top\d+$/.test(normalized)) return `Top ${normalized.slice(3)}`;
  if (/^\d+h$/.test(normalized)) return normalized;
  if (upper.has(normalized)) return normalized.toUpperCase();
  return normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : normalized;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<h4[^>]*>/gi, "\n#### ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|pre|code|tr)>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

function parseApiDocsLinks(html, overviewUrl) {
  const links = new Set();
  const overviewHost = new URL(overviewUrl).hostname;
  const re = /href=["']([^"'#?]+)(?:[#?][^"']*)?["']/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const href = match[1];
    let url;
    try {
      url = new URL(href, overviewUrl);
    } catch {
      continue;
    }
    if (url.hostname !== overviewHost) continue;
    if (isNonEndpointDocsPath(url.pathname)) continue;
    links.add(url.toString().replace(/\/$/, ""));
  }
  const markdownLinkRe = /\[[^\]]+\]\(([^)\s#?]+)(?:[#?][^)]*)?\)/g;
  while ((match = markdownLinkRe.exec(String(html || "")))) {
    const href = match[1];
    let url;
    try {
      url = new URL(href, overviewUrl);
    } catch {
      continue;
    }
    if (url.hostname !== overviewHost) continue;
    if (isNonEndpointDocsPath(url.pathname)) continue;
    links.add(url.toString().replace(/\/$/, ""));
  }
  return [...links];
}

function isNonEndpointDocsPath(pathname) {
  const path = pathname.replace(/\/$/, "");
  if (!path || path === "/") return true;
  if (/\/(authentication|changelog|change-log|endpoint-overview|enterprise-customization|getting-started|mcp-service|responses-error-codes|release-notes|terms|privacy|status)(\/|$)/i.test(path)) return true;
  if (/\/(?:coinglass-agent-skill|websocket|ws-|websocket_)/i.test(path)) return true;
  if (/\.(png|jpe?g|gif|svg|css|js|ico|xml|rss|atom|pdf|zip)$/i.test(path)) return true;
  return false;
}

function parseApiEndpointDocs(text, sourceUrl, overviewUrl) {
  const content = String(text || "");
  const embeddedOpenApiEndpoints = parseEmbeddedOpenApiEndpoints(content, sourceUrl);
  if (embeddedOpenApiEndpoints.length) return embeddedOpenApiEndpoints;
  const targets = extractApiTargets(content, sourceUrl, overviewUrl);
  return targets.map((target) => {
    const title = cleanEndpointTitle(headingNearEndpoint(content, target))
      || cleanEndpointTitle(firstMatch(content, /^#\s+(.+)$/m))
      || titleFromPath(target.path, target.method);
    const description = extractApiDocsDescription(content, title, target);
    const sampleRequest = extractApiDocsRequestBody(content, target) || {};
    const previewData = extractApiDocsPreviewData(content, target) || { data: [{ example: true }] };
    return {
      method: target.method,
      origin: target.origin,
      path: decodePathTemplate(target.path),
      authHeader: inferAuthHeaderFromDocs(content),
      title,
      description,
      sampleRequest: { ...paramsFromPathTemplate(decodePathTemplate(target.path)), ...sampleRequest },
      previewData,
      sourceUrl,
      operationId: normalizeId(null, `${target.method} ${target.origin}${decodePathTemplate(target.path)}`, "service"),
      summary: `${title} via ${target.method} ${decodePathTemplate(target.path)}.`
    };
  });
}

function parseEmbeddedOpenApiEndpoints(content, sourceUrl) {
  const docs = extractBalancedJsonObjects(content).filter((value) => value && typeof value === "object" && (value.openapi || value.swagger) && value.paths);
  const endpoints = [];
  for (const doc of docs) {
    const origin = resolveOpenApiServerUrl(doc, sourceUrl, sourceUrl);
    const authHeader = authHeaderFromOpenApi(doc);
    for (const [routePath, pathItem] of Object.entries(doc.paths || {})) {
      for (const method of ["get", "post", "put", "patch"]) {
        const operation = pathItem?.[method];
        if (!operation) continue;
        const methodUpper = method.toUpperCase();
        const decodedRoutePath = decodePathTemplate(routePath);
        if (skipReasonFor(decodedRoutePath, method, operation)) continue;
        const sampleRequest = { ...paramsFromPathTemplate(decodedRoutePath), ...sampleRequestFor(operation, pathItem, doc) };
        const previewData = previewDataFor(operation, doc);
        const title = operation.summary || titleFromPath(decodedRoutePath, methodUpper);
        endpoints.push({
          method: methodUpper,
          origin,
          path: decodedRoutePath,
          authHeader,
          title,
          description: operation.description || "",
          sampleRequest,
          previewData,
          sourceUrl,
          operationId: operation.operationId || normalizeId(null, `${methodUpper} ${origin}${decodedRoutePath}`, "service"),
          summary: operation.summary || `${title} via ${methodUpper} ${decodedRoutePath}.`
        });
      }
    }
  }
  return uniqueBy(endpoints, (endpoint) => `${endpoint.method} ${endpoint.origin}${endpoint.path}`);
}

function authHeaderFromOpenApi(doc) {
  const schemes = Object.values(doc.components?.securitySchemes || {});
  const apiKey = schemes.find((scheme) => scheme?.type === "apiKey" && scheme?.in === "header" && scheme?.name);
  return apiKey?.name || "";
}

function extractApiTargets(content, sourceUrl, overviewUrl) {
  const overviewHost = new URL(overviewUrl || sourceUrl).hostname;
  const externalUrls = [];
  const fullUrlRe = /https?:\/\/[^\s`"'<>\\)]+/gi;
  let match;
  while ((match = fullUrlRe.exec(content))) {
    const rawUrl = match[0].replace(/[.,;:]+$/g, "");
    try {
      const url = new URL(rawUrl);
      if (url.hostname === overviewHost) continue;
      if (!looksLikeDataPath(url.pathname)) continue;
      externalUrls.push({ url, index: match.index });
    } catch {
      // Keep scanning.
    }
  }

  const methodUrlRe = /\b(GET|POST|PUT|PATCH)\s+(https?:\/\/[^\s`"'<>\\]+|\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)\s*(?:HTTP\/\d(?:\.\d)?)?/gi;
  const targets = [];
  while ((match = methodUrlRe.exec(content))) {
    const windowText = content.slice(Math.max(0, match.index - 240), Math.min(content.length, match.index + 700));
    const nearbyExternal = nearestExternalUrlForPath(externalUrls, match[2], match.index);
    const parsed = apiTargetFromMethodAndUrl(match[1], nearbyExternal?.url?.toString() || match[2], windowText, sourceUrl);
    if (parsed && looksLikeDataPath(parsed.path)) targets.push(parsed);
  }

  for (const { url, index } of externalUrls) {
    const decodedPath = decodePathTemplate(url.pathname.replace(/\/$/, "") || "/");
    if (targets.some((target) => target.origin === url.origin && target.path === decodedPath)) continue;
    const windowText = content.slice(Math.max(0, index - 160), Math.min(content.length, index + 260));
    targets.push({
      method: inferMethodFromTextWindow(windowText),
      origin: url.origin,
      hostname: url.hostname,
      path: decodedPath
    });
  }
  return uniqueBy(targets, (target) => `${target.method} ${target.origin}${target.path}`)
    .filter((target) => target.hostname !== overviewHost || inferOriginFromHostHeader(content));
}

function nearestExternalUrlForPath(externalUrls, rawPath, methodIndex) {
  const path = rawPath.startsWith("http") ? new URL(rawPath).pathname : rawPath.replace(/\/$/, "");
  const matching = externalUrls
    .filter((entry) => entry.url.pathname.replace(/\/$/, "") === path)
    .sort((a, b) => Math.abs(a.index - methodIndex) - Math.abs(b.index - methodIndex));
  return matching[0] || null;
}

function apiTargetFromMethodAndUrl(method, rawTarget, windowText, sourceUrl) {
  try {
    const url = rawTarget.startsWith("http")
      ? new URL(rawTarget)
      : new URL(rawTarget, inferOriginFromHostHeader(windowText) || sourceUrl);
    return {
      method: String(method || "GET").toUpperCase(),
      origin: url.origin,
      hostname: url.hostname,
      path: decodePathTemplate(url.pathname.replace(/\/$/, "") || "/")
    };
  } catch {
    return null;
  }
}

function inferOriginFromHostHeader(text) {
  const host = firstMatch(text, /\bHost\s*:\s*([a-z0-9.-]+(?::\d+)?)/i);
  return host ? `https://${host}` : "";
}

function headingNearEndpoint(content, target) {
  const needles = [`${target.origin}${target.path}`, target.path];
  const indexes = needles
    .map((needle) => content.indexOf(needle))
    .filter((index) => index >= 0);
  if (!indexes.length) return "";
  const index = Math.min(...indexes);
  const before = content.slice(0, index);
  const headings = [...before.matchAll(/^#{1,4}\s+(.+)$/gm)];
  return headings.at(-1)?.[1] || "";
}

function extractApiDocsDescription(content, title, target) {
  const fullEndpoint = `${target.origin}${target.path}`;
  const pathIndex = content.indexOf(fullEndpoint);
  const pathOnlyIndex = pathIndex >= 0 ? pathIndex : content.indexOf(target.path);
  const afterPath = pathOnlyIndex >= 0 ? content.slice(pathOnlyIndex + (pathIndex >= 0 ? fullEndpoint.length : target.path.length)) : "";
  const description = afterPath
    .split(/\n(?:Authorizations|Body|Responses|Copy)\b/i)[0]
    .replace(/\s+/g, " ")
    .trim();
  return description || `Returns ${title} data.`;
}

function extractApiDocsRequestBody(content, target) {
  const start = endpointSnippetStart(content, target);
  if (start < 0) return null;
  const firstJson = extractFirstBalancedJson(content.slice(start));
  return firstJson && !Array.isArray(firstJson) ? firstJson : null;
}

function extractApiDocsPreviewData(content, target) {
  const start = endpointSnippetStart(content, target);
  if (start < 0) return null;
  const segment = content.slice(start);
  const first = extractFirstBalancedJsonWithEnd(segment);
  if (!first) return null;
  const second = extractFirstBalancedJson(segment.slice(first.end));
  if (!second || Array.isArray(second)) return null;
  if (JSON.stringify(second) === JSON.stringify(first.value)) return null;
  return second;
}

function endpointSnippetStart(content, target) {
  const escapedPath = escapeRegExp(target.path);
  const escapedUrl = escapeRegExp(`${target.origin}${target.path}`);
  return content.search(new RegExp(`${target.method}\\s+(?:${escapedUrl}|${escapedPath})\\s*(?:HTTP\\/\\d(?:\\.\\d)?)?`, "i"));
}

function inferAuthHeaderFromDocs(content) {
  return firstMatch(content, /\b([A-Za-z0-9_-]*(?:api|auth|token|key)[A-Za-z0-9_-]*)\s*:\s*(?:YOUR_|Bearer|\$|<)/i)
    || firstMatch(content, /\bHeader\s+`?([A-Za-z0-9_-]+)\s*:\s*\$?[A-Z0-9_]+`?/i)
    || "";
}

function extractFirstBalancedJson(value) {
  return extractFirstBalancedJsonWithEnd(value)?.value || null;
}

function extractBalancedJsonObjects(value) {
  const input = String(value || "");
  const objects = [];
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    if (input[cursor] !== "{") continue;
    const extracted = extractBalancedJsonAt(input, cursor);
    if (!extracted) continue;
    objects.push(extracted.value);
    cursor = extracted.end - 1;
  }
  return objects;
}

function extractFirstBalancedJsonWithEnd(value) {
  const input = String(value || "");
  const start = input.indexOf("{");
  if (start < 0) return null;
  return extractBalancedJsonAt(input, start);
}

function extractBalancedJsonAt(input, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(input.slice(start, index + 1)), end: index + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSkillReadmeFromHtml(html) {
  const readmeLiteral = extractJsStringProperty(html, "readme");
  if (readmeLiteral) return decodeJsStringLiteral(readmeLiteral);
  const markdownLiteral = extractJsStringProperty(html, "markdown")
    || extractJsStringProperty(html, "content");
  const markdown = markdownLiteral ? decodeJsStringLiteral(markdownLiteral) : "";
  return /Base URL|curl\s+-|GET\s+\//i.test(markdown) ? markdown : "";
}

function extractJsStringProperty(source, propertyName) {
  const input = String(source || "");
  const property = `${propertyName}:`;
  let cursor = input.indexOf(property);
  while (cursor !== -1) {
    cursor += property.length;
    while (/\s/.test(input[cursor] || "")) cursor += 1;
    if (input[cursor] === '"') {
      let end = cursor + 1;
      let escaped = false;
      while (end < input.length) {
        const char = input[end];
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          return input.slice(cursor + 1, end);
        }
        end += 1;
      }
    }
    cursor = input.indexOf(property, cursor);
  }
  return "";
}

function decodeJsStringLiteral(value) {
  const input = String(value || "");
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = input[++index];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "v") output += "\v";
    else if (next === "0") output += "\0";
    else if (next === "x") {
      const hex = input.slice(index + 1, index + 3);
      output += /^[0-9a-f]{2}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : `\\x${hex}`;
      if (/^[0-9a-f]{2}$/i.test(hex)) index += 2;
    } else if (next === "u") {
      const hex = input.slice(index + 1, index + 5);
      output += /^[0-9a-f]{4}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : `\\u${hex}`;
      if (/^[0-9a-f]{4}$/i.test(hex)) index += 4;
    } else {
      output += next || "";
    }
  }
  return output;
}

function firstMatch(value, re) {
  const match = String(value || "").match(re);
  return match?.[1] || "";
}

function titleFromSkillUrl(skillUrl) {
  try {
    const path = new URL(skillUrl).pathname.split("/").filter(Boolean).at(-1) || "Imported Skill";
    return path.replace(/[-_]+/g, " ");
  } catch {
    return "Imported Skill";
  }
}

function providerNameFromSkill(title, baseUrl) {
  if (/blockbeats/i.test(title)) return "BlockBeats";
  return baseUrl ? hostName(baseUrl) : title || "Imported Skill Provider";
}

function providerNameFromDocsUrl(docsUrl) {
  try {
    const host = new URL(docsUrl).hostname;
    const parts = host.split(".").filter((part) => !["www", "docs", "doc", "developer", "developers", "api"].includes(part));
    const label = parts[0] || host;
    return label
      .split(/[-_]+/)
      .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : word)
      .join(" ");
  } catch {
    return "Imported API Docs";
  }
}

function looksLikeCallableEndpoint(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (/docs?|documentation|gitbook|swagger|openapi/i.test(url.hostname)) return false;
    if (url.pathname.endsWith(".json")) return false;
    if (/\/(docs?|documentation|swagger|openapi)(\/|$)/i.test(url.pathname)) return false;
    if (/\/(overview|reference|getting-started|introduction)(\/|$)?/i.test(url.pathname)) return false;
    return /\/api\/|\/v\d+\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function inferMethodForEndpoint(apiUrl) {
  return "post";
}

function inferAuthHeader(_apiUrl) {
  return "authorization";
}

function inferSecretName(_apiUrl) {
  return "PROVIDER_SECRET";
}

function sampleRequestForDirectEndpoint(_apiUrl) {
  return {};
}

function previewDataForDirectEndpoint(_apiUrl) {
  return { ok: true };
}

function skipReasonFor(routePath, method, operation) {
  if (SKIP_PATH_RE.test(routePath)) return "non-data or operational endpoint";
  if (operation.deprecated) return "deprecated operation";
  const text = `${routePath} ${operation.summary || ""} ${operation.description || ""}`;
  if (method !== "get" && method !== "post") return "non-query HTTP method";
  if (!DATA_PATH_RE.test(text) && method !== "get") return "not clearly a data query endpoint";
  return null;
}

function sampleRequestFor(operation, pathItem, doc) {
  const sample = {};
  for (const parameter of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    if (!["query", "path"].includes(parameter.in)) continue;
    const value = exampleForSchema(parameter.schema, {
      explicitExample: parameter.example,
      name: parameter.name,
      doc
    });
    if (!parameter.required && (value === "" || value === undefined || value === null)) continue;
    sample[parameter.name] = value === "" ? sampleStringForName(parameter.name) : value;
  }
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  const resolvedBodySchema = resolveSchemaRef(bodySchema, doc);
  if (resolvedBodySchema?.properties) {
    for (const [key, schema] of Object.entries(resolvedBodySchema.properties)) {
      sample[key] = exampleForSchema(schema, {
        explicitExample: schema.example,
        name: key,
        doc
      });
    }
  }
  return sample;
}

function previewDataFor(operation, doc) {
  const response = operation.responses?.["200"] || operation.responses?.["201"] || Object.values(operation.responses || {})[0];
  const json = response?.content?.["application/json"];
  if (json?.example) return json.example;
  const examples = json?.examples;
  if (examples) {
    const first = Object.values(examples)[0];
    if (first?.value) return first.value;
  }
  const schema = json?.schema;
  return exampleObjectForSchema(schema, doc);
}

function exampleObjectForSchema(schema, doc, name = "") {
  schema = resolveSchemaRef(schema, doc);
  if (!schema) return { ok: true };
  if (schema.example) return schema.example;
  if (schema.type === "array") return [exampleObjectForSchema(schema.items, doc, name)];
  if (schema.properties) {
    const output = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      output[key] = exampleForSchema(child, { name: key, doc });
    }
    return output;
  }
  if (schema.type === "object") return {};
  return exampleForSchema(schema, { name, doc });
}

function exampleForSchema(schema = {}, { explicitExample, name = "", doc } = {}) {
  schema = resolveSchemaRef(schema, doc) || {};
  if (explicitExample !== undefined) return explicitExample;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined && schema.default !== "") return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [exampleForSchema(schema.items || {}, { name, doc })];
  if (schema.type === "object" || schema.properties) return exampleObjectForSchema(schema, doc, name);
  return sampleStringForName(name || schema.title || "");
}

function resolveSchemaRef(schema, doc) {
  if (!schema?.$ref || !doc) return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) return schema;
  const name = schema.$ref.slice(prefix.length);
  return doc.components?.schemas?.[name] || schema;
}

function sampleStringForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("address") || lower === "wallet") return "0x0000000000000000000000000000000000000000";
  if (lower.includes("asset") || lower.includes("symbol")) return "BTC";
  if (lower.includes("exchange")) return "Binance";
  if (lower.includes("ticker")) return "GBTC";
  if (lower.includes("interval")) return "1d";
  if (lower.includes("range")) return "1d";
  if (lower.includes("limit") || lower.includes("per_page")) return 10;
  if (lower === "page") return 1;
  if (lower.includes("language")) return "en";
  if (lower.includes("chain")) return "base";
  if (lower.includes("window")) return "7d";
  return "example";
}

function titleFromPath(routePath, method) {
  const words = decodePathTemplate(routePath)
    .split("/")
    .filter(Boolean)
    .filter((part) => !/^api$/i.test(part) && !/^v\d+$/i.test(part))
    .map((part) => part.replace(/^\{|\}$/g, ""))
    .join(" ")
    .replace(/[-_]/g, " ");
  return `${method.toUpperCase()} ${words}`.trim();
}

function summaryFor(title, previewData) {
  const keys = previewData && typeof previewData === "object" && !Array.isArray(previewData)
    ? Object.keys(previewData).slice(0, 3).join(", ")
    : "data";
  return `${title} returned ${keys}.`;
}

function resultSummary({ title, providerTitle, routePath, previewData }) {
  const keys = previewData && typeof previewData === "object" && !Array.isArray(previewData)
    ? Object.keys(previewData).slice(0, 4).filter(Boolean)
    : [];
  const keyText = keys.length ? ` Fields include ${keys.join(", ")}.` : "";
  return `${title} from ${providerTitle} (${routePath}).${keyText}`;
}

function hostName(apiUrl) {
  try {
    return new URL(apiUrl).hostname;
  } catch {
    return "Imported API";
  }
}

function requireString(value, name) {
  if (!String(value || "").trim()) {
    const error = new Error(`${name} is required`);
    error.statusCode = 422;
    throw error;
  }
  return String(value).trim();
}

function fetchWithTimeout(url, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = Number(process.env.ADN_DOCS_FETCH_TIMEOUT_MS || 12000), ...fetchOptions } = options;
  return fetchImpl(url, {
    ...fetchOptions,
    signal: fetchOptions.signal || AbortSignal.timeout(timeoutMs)
  });
}
