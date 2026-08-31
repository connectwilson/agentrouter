import dns from "node:dns/promises";
import net from "node:net";

const SCAN_API = "https://8004scan.io/api/v1/public";
const CACHE_TTL_MS = 60_000;
const PROTOCOLS = ["mcp", "a2a", "http", "x402"];

export function createErc8004Discovery({ fetchImpl = fetch, endpointProbe = null, now = () => Date.now() } = {}) {
  const cache = new Map();
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    return value;
  };
  return {
    async search({ query = "", limit = 10, chainId = 56 } = {}) {
      const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
      const path = query
        ? `/agents/search?q=${encodeURIComponent(query)}&chainId=${chainId}&limit=${safeLimit}`
        : `/agents?chainId=${chainId}&limit=${safeLimit}`;
      return cached(`search:${path}`, async () => {
        const payload = await fetchScanJson(fetchImpl, path);
        return agentRows(payload).map(normalizeErc8004Agent).filter((agent) => agent.agent_id);
      });
    },
    async get({ chainId = 56, agentId }) {
      if (!/^\d+$/.test(String(agentId || ""))) throw requestError("ERC8004_AGENT_ID_INVALID", "agent_id must be a numeric token id.");
      return cached(`agent:${chainId}:${agentId}`, async () => normalizeErc8004Agent(
        await fetchScanJson(fetchImpl, `/agents/${Number(chainId)}/${encodeURIComponent(agentId)}`)
      ));
    },
    async verify(agent) {
      return verifyErc8004Agent(agent, { fetchImpl, endpointProbe });
    }
  };
}

export function normalizeErc8004Agent(raw = {}) {
  const source = raw.agent || raw.data || raw;
  const chainId = Number(source.chain_id ?? source.chainId ?? 56);
  const agentId = source.agent_id ?? source.token_id ?? source.tokenId ?? source.id?.split(":").at(-1) ?? null;
  const metadata = objectValue(source.metadata) || objectValue(source.agent_metadata) || null;
  const inlineServices = serviceRows(metadata || source);
  const declared = new Set(inlineServices.map(protocolForService).filter(Boolean));
  for (const protocol of Array.isArray(source.protocols) ? source.protocols : []) {
    if (PROTOCOLS.includes(String(protocol).toLowerCase())) declared.add(String(protocol).toLowerCase());
  }
  if (source.x402_supported ?? source.x402Supported) declared.add("x402");
  return {
    agent_id: agentId == null ? null : String(agentId),
    chain_id: chainId,
    registry: source.registry || source.contract_address || source.contractAddress || null,
    name: source.name || metadata?.name || `ERC-8004 Agent #${agentId}`,
    description: source.description || metadata?.description || "",
    image: source.image || metadata?.image || null,
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
  const response = await fetchImpl(`${SCAN_API}${path}`, { headers: { accept: "application/json" } });
  if (!response?.ok) throw requestError("ERC8004_SCAN_UNAVAILABLE", `8004scan returned HTTP ${response?.status || "unknown"}.`, 502);
  return response.json();
}

async function fetchPublicJson(value, fetchImpl) {
  await assertPublicHttpsUrl(value);
  const response = await fetchImpl(value, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response?.ok) throw requestError("ERC8004_METADATA_UNAVAILABLE", `Agent metadata returned HTTP ${response?.status || "unknown"}.`, 422);
  return response.json();
}

async function probePublicEndpoint(endpoint, { protocol }, fetchImpl) {
  await assertPublicHttpsUrl(endpoint);
  const response = await fetchImpl(endpoint, {
    method: protocol === "http" ? "HEAD" : "GET",
    headers: { accept: protocol === "mcp" ? "text/event-stream, application/json" : "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5000)
  });
  return { ok: Boolean(response) && Number(response.status) < 500, status: response?.status ?? null };
}

async function assertPublicHttpsUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoint is not a valid URL.", 422); }
  if (url.protocol !== "https:") throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoints must use HTTPS.", 422);
  if (url.username || url.password) throw requestError("ERC8004_ENDPOINT_INVALID", "Advertised endpoints cannot contain credentials.", 422);
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw requestError("ERC8004_ENDPOINT_NOT_PUBLIC", "Advertised endpoint must resolve to a public address.", 422);
  }
  return url;
}

function isPrivateAddress(address) {
  if (address === "::1" || address === "0.0.0.0" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
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
