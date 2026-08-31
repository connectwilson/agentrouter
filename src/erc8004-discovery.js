import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const SCAN_API = "https://8004scan.io/api/v1/public";
const CACHE_TTL_MS = 60_000;
const AGENT_CACHE_LIMIT = 500;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_METADATA_REDIRECTS = 3;
const PROTOCOLS = ["mcp", "a2a", "http", "x402"];

export function createErc8004Discovery({
  fetchImpl = fetch,
  endpointProbe = null,
  now = () => Date.now(),
  minRequestIntervalMs = 6100,
  cacheTtlMs = CACHE_TTL_MS,
  agentCacheLimit = AGENT_CACHE_LIMIT
} = {}) {
  const cache = new Map();
  const agentCache = new Map();
  const safeCacheTtlMs = Math.max(1, Number(cacheTtlMs) || CACHE_TTL_MS);
  const safeAgentCacheLimit = Math.max(1, Number(agentCacheLimit) || AGENT_CACHE_LIMIT);
  const rememberAgent = (agent) => {
    const key = `${agent.chain_id}:${agent.agent_id}`;
    agentCache.delete(key);
    agentCache.set(key, { at: now(), value: agent });
    while (agentCache.size > safeAgentCacheLimit) agentCache.delete(agentCache.keys().next().value);
  };
  let lastRemoteAt = 0;
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < safeCacheTtlMs) return hit.value;
    const pending = Promise.resolve().then(load);
    cache.set(key, { at: now(), value: pending });
    try {
      const value = await pending;
      cache.set(key, { at: now(), value });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  };
  const remote = async (path) => {
    const elapsed = now() - lastRemoteAt;
    if (lastRemoteAt && elapsed < minRequestIntervalMs) {
      const error = requestError("ERC8004_SCAN_RATE_LIMITED", "8004scan discovery is rate limited; retry shortly.", 429);
      error.retryAfterMs = minRequestIntervalMs - elapsed;
      throw error;
    }
    lastRemoteAt = now();
    return fetchScanJson(fetchImpl, path);
  };
  return {
    async search({ query = "", limit = 10, chainId = 56 } = {}) {
      const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
      const path = query
        ? `/agents/search?q=${encodeURIComponent(query)}&chainId=${chainId}&limit=${safeLimit}`
        : `/agents?chainId=${chainId}&limit=${safeLimit}`;
      return cached(`search:${path}`, async () => {
        const payload = await remote(path);
        const agents = agentRows(payload)
          .map(normalizeErc8004Agent)
          .filter((agent) => agent.agent_id && Number(agent.chain_id) === Number(chainId));
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
  for (const service of services) {
    const protocol = protocolForService(service);
    const endpoint = endpointForService(service);
    if (!protocol || !endpoint || protocols[protocol].endpoint) continue;
    protocols[protocol] = { status: "declared", endpoint };
  }
  if (agent.x402_supported && protocols.x402.status === "not_declared") {
    protocols.x402 = { status: "declared", endpoint: protocols.http.endpoint || firstEndpoint(services) };
  }

  const probe = endpointProbe || ((endpoint, context) => probePublicEndpoint(endpoint, context, fetchImpl));
  for (const protocol of ["mcp", "a2a", "http"]) {
    const entry = protocols[protocol];
    if (!entry.endpoint) continue;
    try {
      const result = await probe(entry.endpoint, { protocol, agent });
      entry.status = result?.ok ? "verified" : "unreachable";
      if (result?.status != null) entry.http_status = result.status;
    } catch (error) {
      entry.status = "unreachable";
      entry.error = String(error?.message || "Endpoint probe failed.");
    }
  }
  const preferredAdapter = ["mcp", "a2a", "http"].find((protocol) => protocols[protocol].status === "verified") || null;
  const callable = Boolean(preferredAdapter);
  return {
    verification_state: callable ? "verified_callable" : "registered_unverified",
    callable,
    protocols,
    preferred_adapter: preferredAdapter,
    verified_at: new Date().toISOString(),
    ...(callable ? {} : { verification_error: "No advertised endpoint passed validation." })
  };
}

async function fetchScanJson(fetchImpl, path) {
  let response;
  try {
    response = await retryOnce(() => fetchImpl(`${SCAN_API}${path}`, { headers: { accept: "application/json" } }));
  } catch (error) {
    throw requestError("ERC8004_SCAN_UNAVAILABLE", `8004scan could not be reached: ${String(error?.message || "network error")}.`, 502);
  }
  if (!response?.ok) throw requestError("ERC8004_SCAN_UNAVAILABLE", `8004scan returned HTTP ${response?.status || "unknown"}.`, 502);
  try {
    return await response.json();
  } catch {
    throw requestError("ERC8004_SCAN_INVALID_RESPONSE", "8004scan returned malformed JSON.", 502);
  }
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
  const request = (method) => requestPublicEndpoint(endpoint, {
    method,
    headers: { accept: protocol === "mcp" ? "text/event-stream, application/json" : "application/json" },
    signal: AbortSignal.timeout(5000)
  }, fetchImpl);
  let response = await request(protocol === "http" ? "HEAD" : "GET");
  if (protocol === "http" && Number(response?.status) === 405) response = await request("GET");
  const status = Number(response?.status);
  const successful = status >= 200 && status < 300;
  const contentType = responseHeader(response, "content-type").toLowerCase();
  const protocolShapeValid = protocol === "mcp"
    ? /(?:text\/event-stream|application\/(?:json|[^;]+\+json))/.test(contentType)
    : protocol === "a2a"
      ? /application\/(?:json|[^;]+\+json)/.test(contentType)
      : true;
  return {
    ok: protocol === "http" ? (successful || status === 402) : (successful && protocolShapeValid),
    status: response?.status ?? null
  };
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

async function requestPublicEndpoint(value, init, fetchImpl, { collectBody = false } = {}) {
  const resolved = await resolvePublicHttpsUrl(value);
  if (fetchImpl !== globalThis.fetch) {
    return fetchImpl(resolved.url.toString(), { ...init, redirect: "manual" });
  }
  return pinnedHttpsRequest(resolved, init, { collectBody });
}

export function pinnedHttpsRequest({ url, addresses }, init = {}, { collectBody = false, requestImpl = https.request } = {}) {
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
        if (size > MAX_METADATA_BYTES) {
          request.destroy(requestError("ERC8004_METADATA_TOO_LARGE", "Agent metadata exceeds the maximum allowed size.", 422));
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
          json: async () => JSON.parse(body)
        });
      });
      if (!collectBody) response.resume();
    });
    request.once("error", reject);
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
