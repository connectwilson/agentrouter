import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

import { normalizeErc8004ExecutionPolicy } from "./erc8004-hire.js";

const SCAN_API = "https://8004scan.io/api/v1/public";
const CACHE_TTL_MS = 60_000;
const AGENT_CACHE_LIMIT = 500;
const QUERY_CACHE_LIMIT = 100;
const MAX_PENDING_REQUESTS = 4;
const MAX_DISCOVERY_QUERY_CHARS = 256;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_METADATA_REDIRECTS = 3;
const MAX_EXECUTION_INPUT_BYTES = 64 * 1024;
const MAX_EXECUTION_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROTOCOL_PROBE_BYTES = 64 * 1024;
const MAX_ENDPOINTS_PER_PROTOCOL = 4;
const PROTOCOLS = ["mcp", "a2a", "http", "x402"];

export function createErc8004Discovery({
  fetchImpl = fetch,
  endpointProbe = null,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  minRequestIntervalMs = 6100,
  cacheTtlMs = CACHE_TTL_MS,
  agentCacheLimit = AGENT_CACHE_LIMIT,
  queryCacheLimit = QUERY_CACHE_LIMIT,
  maxPendingRequests = MAX_PENDING_REQUESTS
} = {}) {
  const cache = new Map();
  const agentCache = new Map();
  const metrics = {
    cache_hits: 0,
    cache_misses: 0,
    upstream_requests: 0,
    queued_waits: 0,
    upstream_failures: 0,
    overload_rejections: 0
  };
  const safeCacheTtlMs = Math.max(1, Number(cacheTtlMs) || CACHE_TTL_MS);
  const safeAgentCacheLimit = Math.max(1, Number(agentCacheLimit) || AGENT_CACHE_LIMIT);
  const safeQueryCacheLimit = boundedInteger(queryCacheLimit, 1, 1000, QUERY_CACHE_LIMIT);
  const safeMaxPendingRequests = boundedInteger(maxPendingRequests, 1, 100, MAX_PENDING_REQUESTS);
  const safeMinRequestIntervalMs = boundedInteger(minRequestIntervalMs, 0, 60_000, 6100);
  const rememberAgent = (agent) => {
    const key = `${agent.chain_id}:${agent.agent_id}`;
    agentCache.delete(key);
    agentCache.set(key, { at: now(), value: agent });
    while (agentCache.size > safeAgentCacheLimit) agentCache.delete(agentCache.keys().next().value);
  };
  let lastRemoteAt = 0;
  let remoteQueue = Promise.resolve();
  let pendingRemoteRequests = 0;
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && (hit.pending || now() - hit.at < safeCacheTtlMs)) {
      metrics.cache_hits += 1;
      return hit.value;
    }
    if (hit) cache.delete(key);
    pruneQueryCache(cache, { now: now(), ttlMs: safeCacheTtlMs, limit: safeQueryCacheLimit });
    if (cache.size >= safeQueryCacheLimit) {
      metrics.overload_rejections += 1;
      throw discoveryOverloaded(safeMinRequestIntervalMs);
    }
    metrics.cache_misses += 1;
    const pending = Promise.resolve().then(load);
    const entry = { at: now(), value: pending, pending: true };
    cache.set(key, entry);
    try {
      const value = await pending;
      if (cache.get(key) === entry) cache.set(key, { at: now(), value, pending: false });
      return value;
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
  };
  const remote = (path) => {
    if (pendingRemoteRequests >= safeMaxPendingRequests) {
      metrics.overload_rejections += 1;
      throw discoveryOverloaded(safeMinRequestIntervalMs);
    }
    pendingRemoteRequests += 1;
    const scheduled = remoteQueue.catch(() => {}).then(async () => {
      const elapsed = now() - lastRemoteAt;
      const waitMs = lastRemoteAt ? Math.max(0, safeMinRequestIntervalMs - elapsed) : 0;
      if (waitMs > 0) {
        metrics.queued_waits += 1;
        await sleep(waitMs);
      }
      lastRemoteAt = now();
      metrics.upstream_requests += 1;
      try {
        return await fetchScanJson(fetchImpl, path);
      } catch (error) {
        metrics.upstream_failures += 1;
        throw error;
      }
    });
    remoteQueue = scheduled.catch(() => {});
    return scheduled.finally(() => {
      pendingRemoteRequests -= 1;
    });
  };
  return {
    stats() {
      return {
        ...metrics,
        pending_requests: pendingRemoteRequests,
        queue_depth: Math.max(0, pendingRemoteRequests - 1),
        query_cache_entries: cache.size,
        query_cache_limit: safeQueryCacheLimit,
        pending_request_limit: safeMaxPendingRequests
      };
    },
    async search({ query = "", limit = 10, chainId = 56 } = {}) {
      const normalized = normalizeErc8004DiscoveryRequest({ query, limit, chainId });
      const path = normalized.query
        ? `/agents/search?q=${encodeURIComponent(normalized.query)}&chainId=${normalized.chainId}&limit=${normalized.limit}`
        : `/agents?chainId=${normalized.chainId}&limit=${normalized.limit}`;
      return cached(`search:${path}`, async () => {
        const payload = await remote(path);
        const agents = agentRows(payload)
          .map(normalizeErc8004Agent)
          .filter((agent) => agent.agent_id && Number(agent.chain_id) === normalized.chainId);
        for (const agent of agents) rememberAgent(agent);
        return agents;
      });
    },
    async get({ chainId = 56, agentId }) {
      if (!/^\d+$/.test(String(agentId || ""))) throw requestError("ERC8004_AGENT_ID_INVALID", "agent_id must be a numeric token id.");
      const indexed = agentCache.get(`${Number(chainId)}:${agentId}`);
      if (indexed && now() - indexed.at < safeCacheTtlMs) return indexed.value;
      if (indexed) agentCache.delete(`${Number(chainId)}:${agentId}`);
      return cached(`agent:${chainId}:${agentId}`, async () => {
        const agent = normalizeErc8004Agent(await remote(`/agents/${Number(chainId)}/${encodeURIComponent(agentId)}`));
        if (Number(agent.chain_id) !== Number(chainId)) throw requestError("ERC8004_INDEX_CHAIN_MISMATCH", "8004scan returned an agent from a different chain.");
        if (String(agent.agent_id) !== String(agentId)) throw requestError("ERC8004_INDEX_ID_MISMATCH", "8004scan returned a different agent token id.");
        rememberAgent(agent);
        return agent;
      });
    },
    async verify(agent) {
      return verifyErc8004Agent(agent, { fetchImpl, endpointProbe });
    }
  };
}

export function normalizeErc8004DiscoveryRequest({ query = "", limit = 10, chainId = 56 } = {}) {
  const normalizedQuery = String(query ?? "").trim();
  if ([...normalizedQuery].length > MAX_DISCOVERY_QUERY_CHARS) {
    throw requestError(
      "ERC8004_QUERY_TOO_LONG",
      `Discovery query must contain at most ${MAX_DISCOVERY_QUERY_CHARS} characters.`,
      422
    );
  }
  const rawLimit = limit === undefined || limit === null || limit === "" ? 10 : Number(limit);
  const normalizedLimit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 10;
  const normalizedChainId = Number(chainId);
  if (!Number.isSafeInteger(normalizedChainId) || normalizedChainId <= 0) {
    throw requestError("ERC8004_CHAIN_INVALID", "chain_id must be a positive integer.", 422);
  }
  return {
    query: normalizedQuery,
    limit: Math.max(1, Math.min(25, normalizedLimit || 10)),
    chainId: normalizedChainId
  };
}

export function normalizeErc8004Agent(raw = {}) {
  const source = raw.agent || raw.data || raw;
  const chainId = Number(source.chain_id ?? source.chainId ?? 56);
  const compositeAgentId = source.agent_id ?? source.id ?? null;
  const agentId = source.token_id ?? source.tokenId ?? (String(compositeAgentId || "").includes(":")
    ? String(compositeAgentId).split(":").at(-1)
    : compositeAgentId) ?? null;
  const metadata = objectValue(source.metadata) || objectValue(source.agent_metadata) || null;
  const inlineServices = serviceRows(metadata || source);
  const declared = new Set(inlineServices.map(protocolForService).filter(Boolean));
  for (const protocol of [
    ...(Array.isArray(source.protocols) ? source.protocols : []),
    ...(Array.isArray(source.supported_protocols) ? source.supported_protocols : [])
  ]) {
    if (PROTOCOLS.includes(String(protocol).toLowerCase())) declared.add(String(protocol).toLowerCase());
  }
  if (source.x402_supported ?? source.x402Supported) declared.add("x402");
  return {
    agent_id: agentId == null ? null : String(agentId),
    chain_id: chainId,
    registry: source.registry || source.contract_address || source.contractAddress || null,
    name: source.name || metadata?.name || `ERC-8004 Agent #${agentId}`,
    description: source.description || metadata?.description || "",
    image: source.image || source.image_url || metadata?.image || null,
    metadata_uri: source.metadata_uri || source.metadataUri || source.agent_uri || source.agentURI || null,
    metadata,
    services: inlineServices,
    protocols: [...declared],
    x402_supported: Boolean(source.x402_supported ?? source.x402Supported),
    trust: {
      average_score: numberOrNull(source.average_score ?? source.averageScore ?? source.trust?.average_score),
      total_feedbacks: Number(source.total_feedbacks ?? source.totalFeedbacks ?? source.trust?.total_feedbacks ?? 0),
      total_validations: Number(source.total_validations ?? source.totalValidations ?? source.trust?.total_validations ?? 0),
      successful_validations: Number(source.successful_validations ?? source.successfulValidations ?? source.trust?.successful_validations ?? 0),
      rank: numberOrNull(source.rank ?? source.network_rank ?? source.trust?.rank)
    },
    explorer_url: chainId === 56 && agentId != null ? `https://8004scan.io/agents/56/${encodeURIComponent(agentId)}` : null,
    verification_state: "registered_unverified",
    callable: false
  };
}

export async function verifyErc8004Agent(raw, { fetchImpl = fetch, endpointProbe = null } = {}) {
  const agent = normalizeErc8004Agent(raw);
  let metadata = agent.metadata;
  if (!metadata && agent.metadata_uri) metadata = await fetchPublicJson(agent.metadata_uri, fetchImpl);
  const services = serviceRows(metadata || agent);
  const protocols = Object.fromEntries(PROTOCOLS.map((protocol) => [protocol, { status: "not_declared", endpoint: null }]));
  const candidates = Object.fromEntries(PROTOCOLS.map((protocol) => [protocol, []]));
  for (const service of services) {
    const protocol = protocolForService(service);
    const endpoint = endpointForService(service);
    if (!protocol || !endpoint || candidates[protocol].includes(endpoint)) continue;
    if (candidates[protocol].length >= MAX_ENDPOINTS_PER_PROTOCOL) continue;
    candidates[protocol].push(endpoint);
    if (!protocols[protocol].endpoint) protocols[protocol] = { status: "declared", endpoint };
  }
  if (agent.x402_supported && protocols.x402.status === "not_declared") {
    protocols.x402 = { status: "declared", endpoint: candidates.http[0] || firstEndpoint(services) };
  }

  const probe = endpointProbe || ((endpoint, context) => probePublicEndpoint(endpoint, context, fetchImpl));
  for (const protocol of ["mcp", "a2a", "http"]) {
    const entry = protocols[protocol];
    if (!entry.endpoint) continue;
    const attempted = [];
    for (const endpoint of candidates[protocol]) {
      const attempt = { endpoint };
      attempted.push(attempt);
      try {
        const result = await probe(endpoint, { protocol, agent });
        if (result?.status != null) attempt.http_status = result.status;
        if (result?.ok) {
          entry.status = "verified";
          entry.endpoint = endpoint;
          if (result.status != null) entry.http_status = result.status;
          break;
        }
        entry.status = "unreachable";
        if (result?.status != null) entry.http_status = result.status;
      } catch (error) {
        entry.status = "unreachable";
        attempt.error = String(error?.message || "Endpoint probe failed.");
        entry.error = attempt.error;
      }
    }
    if (attempted.length > 1) entry.attempts = attempted;
  }
  const preferredAdapter = ["mcp", "a2a", "http"].find((protocol) => protocols[protocol].status === "verified") || null;
  const callable = Boolean(preferredAdapter);
  const executionPolicy = normalizeErc8004ExecutionPolicy(metadata || {});
  return {
    verification_state: callable ? "verified_callable" : "registered_unverified",
    callable,
    protocols,
    preferred_adapter: preferredAdapter,
    verified_at: new Date().toISOString(),
    ...(executionPolicy ? { execution_policy: executionPolicy } : {}),
    ...(callable ? {} : { verification_error: "No advertised endpoint passed validation." })
  };
}

export async function executeErc8004HttpAgent({ endpoint, input = {}, fetchImpl = fetch } = {}) {
  const serialized = JSON.stringify(input && typeof input === "object" && !Array.isArray(input) ? input : {});
  if (Buffer.byteLength(serialized) > MAX_EXECUTION_INPUT_BYTES) {
    throw requestError("ERC8004_EXECUTION_INPUT_TOO_LARGE", "Agent input exceeds the 64 KiB execution limit.", 413);
  }

  let response;
  try {
    response = await requestPublicEndpoint(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(serialized))
      },
      body: serialized,
      signal: AbortSignal.timeout(10_000)
    }, fetchImpl, {
      collectBody: true,
      maxBytes: MAX_EXECUTION_RESPONSE_BYTES,
      tooLargeCode: "ERC8004_EXECUTION_RESPONSE_TOO_LARGE",
      tooLargeMessage: "Agent response exceeds the 1 MiB execution limit."
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("ERC8004_")) throw error;
    throw requestError("ERC8004_EXECUTION_UNAVAILABLE", `Agent execution failed: ${String(error?.message || "network error")}.`, 502);
  }

  if (isRedirectStatus(response?.status)) {
    throw requestError("ERC8004_EXECUTION_REDIRECT_BLOCKED", "Agent execution endpoints cannot redirect.", 422);
  }
  if (Number(response?.status) === 402) {
    throw requestError("ERC8004_PAYMENT_REQUIRED", "This Agent requires a payment adapter before execution.", 402);
  }
  if (!response?.ok) {
    throw requestError("ERC8004_EXECUTION_UPSTREAM_ERROR", `Agent returned HTTP ${response?.status || "unknown"}.`, 502);
  }
  const contentType = responseHeader(response, "content-type").toLowerCase();
  if (!/application\/(?:json|[^;]+\+json)/.test(contentType)) {
    throw requestError("ERC8004_EXECUTION_INVALID_RESPONSE", "Agent execution did not return JSON.", 502);
  }
  try {
    return await response.json();
  } catch {
    throw requestError("ERC8004_EXECUTION_INVALID_RESPONSE", "Agent execution returned malformed JSON.", 502);
  }
}

async function fetchScanJson(fetchImpl, path) {
  let response;
  try {
    response = await retryOnce(() => fetchImpl(`${SCAN_API}${path}`, { headers: { accept: "application/json" } }));
  } catch (error) {
    throw requestError("ERC8004_SCAN_UNAVAILABLE", `8004scan could not be reached: ${String(error?.message || "network error")}.`, 502);
  }
  if (response?.status === 429) {
    const error = requestError("ERC8004_SCAN_RATE_LIMITED", "8004scan discovery quota is temporarily exhausted.", 429);
    error.retryAfterMs = retryAfterMilliseconds(responseHeader(response, "retry-after"));
    throw error;
  }
  if (!response?.ok) throw requestError("ERC8004_SCAN_UNAVAILABLE", `8004scan returned HTTP ${response?.status || "unknown"}.`, 502);
  try {
    return await response.json();
  } catch {
    throw requestError("ERC8004_SCAN_INVALID_RESPONSE", "8004scan returned malformed JSON.", 502);
  }
}

function retryAfterMilliseconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(String(value || ""));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

async function fetchPublicJson(value, fetchImpl) {
  let target = String(value || "");
  for (let redirects = 0; redirects <= MAX_METADATA_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await retryOnce(() => requestPublicEndpoint(target, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000)
      }, fetchImpl, { collectBody: true }));
    } catch (error) {
      if (String(error?.code || "").startsWith("ERC8004_ENDPOINT_")) throw error;
      throw requestError("ERC8004_METADATA_UNAVAILABLE", `Agent metadata could not be reached: ${String(error?.message || "network error")}.`, 422);
    }
    if (isRedirectStatus(response?.status)) {
      const location = responseHeader(response, "location");
      if (!location) throw requestError("ERC8004_METADATA_UNAVAILABLE", "Agent metadata returned a redirect without a location.", 422);
      target = new URL(location, target).toString();
      continue;
    }
    if (!response?.ok) throw requestError("ERC8004_METADATA_UNAVAILABLE", `Agent metadata returned HTTP ${response?.status || "unknown"}.`, 422);
    try {
      return await response.json();
    } catch {
      throw requestError("ERC8004_METADATA_INVALID_RESPONSE", "Agent metadata returned malformed JSON.", 422);
    }
  }
  throw requestError("ERC8004_METADATA_REDIRECT_LIMIT", "Agent metadata exceeded the safe redirect limit.", 422);
}

async function retryOnce(run) {
  try {
    return await run();
  } catch (error) {
    if (String(error?.code || "").startsWith("ERC8004_")) throw error;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return run();
  }
}

async function probePublicEndpoint(endpoint, { protocol }, fetchImpl) {
  if (protocol === "mcp") return probeMcpInitialize(endpoint, fetchImpl);
  if (protocol === "a2a") return probeA2aAgentCard(endpoint, fetchImpl);
  const request = (method) => requestPublicEndpoint(endpoint, {
    method,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000)
  }, fetchImpl);
  let response = await request("HEAD");
  if (Number(response?.status) === 405) response = await request("GET");
  const status = Number(response?.status);
  const successful = status >= 200 && status < 300;
  return {
    ok: successful || status === 402,
    status: response?.status ?? null
  };
}

async function probeA2aAgentCard(endpoint, fetchImpl) {
  const response = await requestPublicEndpoint(endpoint, {
    method: "GET",
    headers: { accept: "application/agent-card+json, application/json" },
    signal: AbortSignal.timeout(5000)
  }, fetchImpl, protocolProbeBodyOptions());
  const status = Number(response?.status);
  const contentType = responseHeader(response, "content-type").toLowerCase();
  if (status < 200 || status >= 300 || !/application\/(?:agent-card\+json|json|[^;]+\+json)/.test(contentType)) {
    return { ok: false, status: response?.status ?? null };
  }
  const payload = await responseJson(response);
  return { ok: isA2aAgentCard(payload), status: response?.status ?? null };
}

async function probeMcpInitialize(endpoint, fetchImpl) {
  const id = "agentrouter-erc8004-probe";
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "AgentRouter verifier", version: "1.0.0" }
    }
  });
  const response = await requestPublicEndpoint(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body))
    },
    body,
    signal: AbortSignal.timeout(5000)
  }, fetchImpl, protocolProbeBodyOptions());
  const status = Number(response?.status);
  const contentType = responseHeader(response, "content-type").toLowerCase();
  if (status < 200 || status >= 300 || !/(?:application\/(?:json|[^;]+\+json)|text\/event-stream)/.test(contentType)) {
    return { ok: false, status: response?.status ?? null };
  }
  const payloads = contentType.includes("text/event-stream")
    ? await responseSseJson(response)
    : [await responseJson(response)];
  return {
    ok: payloads.some((payload) => isMcpInitializeResult(payload, id)),
    status: response?.status ?? null
  };
}

function protocolProbeBodyOptions() {
  return {
    collectBody: true,
    maxBytes: MAX_PROTOCOL_PROBE_BYTES,
    tooLargeCode: "ERC8004_PROTOCOL_RESPONSE_TOO_LARGE",
    tooLargeMessage: "Advertised protocol response exceeds the 64 KiB verification limit."
  };
}

async function responseJson(response) {
  try {
    if (typeof response?.json !== "function") return null;
    const payload = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function responseSseJson(response) {
  try {
    if (typeof response?.text !== "function") return [];
    const text = await response.text();
    return text.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((value) => value && value !== "[DONE]")
      .map((value) => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter((value) => value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return [];
  }
}

function isA2aAgentCard(value) {
  return Boolean(
    value
    && typeof value.name === "string"
    && value.name.trim()
    && typeof value.description === "string"
    && typeof value.url === "string"
    && value.url.trim()
    && typeof value.version === "string"
    && value.version.trim()
    && value.capabilities
    && typeof value.capabilities === "object"
    && !Array.isArray(value.capabilities)
    && Array.isArray(value.skills)
    && Array.isArray(value.defaultInputModes)
    && Array.isArray(value.defaultOutputModes)
  );
}

function isMcpInitializeResult(value, id) {
  const result = value?.result;
  return Boolean(
    value?.jsonrpc === "2.0"
    && String(value?.id) === id
    && result
    && typeof result === "object"
    && typeof result.protocolVersion === "string"
    && result.protocolVersion.trim()
    && result.capabilities
    && typeof result.capabilities === "object"
    && !Array.isArray(result.capabilities)
    && result.serverInfo
    && typeof result.serverInfo === "object"
    && typeof result.serverInfo.name === "string"
    && result.serverInfo.name.trim()
    && typeof result.serverInfo.version === "string"
    && result.serverInfo.version.trim()
  );
}

async function resolvePublicHttpsUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoint is not a valid URL.", 422); }
  if (url.protocol !== "https:") throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoints must use HTTPS.", 422);
  if (url.username || url.password) throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoints cannot contain credentials.", 422);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw requestError("ERC8004_ENDPOINT_NOT_PUBLIC", "Advertised endpoint must resolve to a public address.", 422);
  }
  return { url, addresses };
}

async function requestPublicEndpoint(value, init, fetchImpl, bodyOptions = {}) {
  const resolved = await resolvePublicHttpsUrl(value);
  if (fetchImpl !== globalThis.fetch) {
    return fetchImpl(resolved.url.toString(), { ...init, redirect: "manual" });
  }
  return pinnedHttpsRequest(resolved, init, bodyOptions);
}

export function pinnedHttpsRequest({ url, addresses }, init = {}, {
  collectBody = false,
  maxBytes = MAX_METADATA_BYTES,
  tooLargeCode = "ERC8004_METADATA_TOO_LARGE",
  tooLargeMessage = "Agent metadata exceeds the maximum allowed size.",
  requestImpl = https.request
} = {}) {
  return new Promise((resolve, reject) => {
    const selected = addresses[0]?.address;
    const family = net.isIP(selected);
    const request = requestImpl(url, {
      method: init.method || "GET",
      headers: init.headers,
      signal: init.signal,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: selected, family }]);
        else callback(null, selected, family);
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        if (!collectBody) return;
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(requestError(tooLargeCode, tooLargeMessage, 422));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const body = collectBody ? Buffer.concat(chunks).toString("utf8") : "";
        resolve({
          ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
          status: response.statusCode,
          headers: { get: (name) => String(response.headers[String(name).toLowerCase()] || "") },
          json: async () => JSON.parse(body),
          text: async () => body
        });
      });
      if (!collectBody) response.resume();
    });
    request.once("error", reject);
    if (init.body != null) request.write(init.body);
    request.end();
  });
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return String(response.headers.get(name) || "");
  return String(response?.headers?.[String(name).toLowerCase()] || "");
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (net.isIPv4(normalized)) return isNonPublicIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  if (normalized === "::" || normalized === "::1") return true;
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = ipv4FromMappedIpv6(normalized);
  return mapped ? isNonPublicIpv4(mapped) : false;
}

function isNonPublicIpv4(address) {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv4FromMappedIpv6(address) {
  if (!address.startsWith("::ffff:")) return null;
  const suffix = address.slice("::ffff:".length);
  if (net.isIPv4(suffix)) return suffix;
  const words = suffix.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function agentRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.agents || payload?.results || payload?.data?.agents || payload?.data || [];
}

function serviceRows(value) {
  const rows = value?.services || value?.endpoints || [];
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
}

function endpointForService(service) {
  return service.endpoint || service.url || service.href || service.uri || null;
}

function firstEndpoint(services) {
  return services.map(endpointForService).find(Boolean) || null;
}

function protocolForService(service) {
  const label = `${service.name || ""} ${service.type || ""} ${service.protocol || ""}`.toLowerCase();
  if (label.includes("mcp")) return "mcp";
  if (label.includes("a2a")) return "a2a";
  if (label.includes("x402")) return "x402";
  return endpointForService(service) ? "http" : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numberOrNull(value) {
  return value == null || value === "" || Number.isNaN(Number(value)) ? null : Number(value);
}

function requestError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function pruneQueryCache(cache, { now, ttlMs, limit }) {
  for (const [key, entry] of cache) {
    if (!entry.pending && now - entry.at >= ttlMs) cache.delete(key);
  }
  while (cache.size >= limit) {
    const settled = [...cache].find(([, entry]) => !entry.pending);
    if (!settled) break;
    cache.delete(settled[0]);
  }
}

function discoveryOverloaded(minRequestIntervalMs) {
  const error = requestError(
    "ERC8004_DISCOVERY_OVERLOADED",
    "ERC-8004 discovery is at capacity; retry after the current upstream request finishes.",
    503
  );
  error.retryAfterMs = Math.max(1000, Number(minRequestIntervalMs) || 0);
  return error;
}
