import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashJson } from "./evidence.js";
import { deleteProviderSecret, writeProviderSecret } from "./provider-secrets.js";
import { assertPersistentProviderStorageReady, deletePersistentProviderConfig, listPersistentProviderConfigs, readPersistentProviderConfig, writePersistentProviderConfig } from "./persistence.js";

export const PROVIDER_DIR = path.resolve(process.env.ADN_PROVIDER_DIR || "providers");

// listProviderConfigs runs on nearly every request; cache it briefly.
// TTL bounds cross-instance staleness; local writes/deletes invalidate immediately.
const CONFIG_CACHE_TTL_MS = Number(process.env.ADN_PROVIDER_CONFIG_CACHE_TTL_MS || 5000);
let configCache = { configs: null, at: 0, version: -1 };
let configVersion = 0;

function invalidateProviderConfigCache() {
  configVersion += 1;
  configCache = { configs: null, at: 0, version: -1 };
}

export async function ensureProviderDir() {
  await fs.mkdir(PROVIDER_DIR, { recursive: true });
}

export function providerConfigPath(serviceId) {
  return path.join(PROVIDER_DIR, `${serviceId}.json`);
}

export async function writeProviderConfig(config) {
  await ensureProviderDir();
  finalizeProviderConfig(config);
  assertPersistentProviderStorageReady({ requiresSecret: Boolean(config.source?.auth?.secret_value) });
  const sanitized = await sanitizeProviderConfig(config);
  finalizeProviderConfig(sanitized);
  Object.assign(config, sanitized);
  await writePersistentProviderConfig(sanitized);
  await fs.writeFile(providerConfigPath(config.manifest.service_id), `${JSON.stringify(sanitized, null, 2)}\n`);
  invalidateProviderConfigCache();
  return providerConfigPath(config.manifest.service_id);
}

export async function readProviderConfig(serviceId) {
  const persistent = await readPersistentProviderConfig(serviceId);
  if (persistent) return persistent;
  const content = await fs.readFile(providerConfigPath(serviceId), "utf8");
  return JSON.parse(content);
}

export async function deleteProviderConfig(serviceId) {
  let config = null;
  try {
    config = await readProviderConfig(serviceId);
  } catch {
    // It may only exist in one backing store; still delete the known paths.
  }
  await deletePersistentProviderConfig(serviceId);
  if (config?.source?.auth?.secret_ref) {
    await deleteProviderSecret(config.source.auth.secret_ref);
  }
  try {
    await fs.rm(providerConfigPath(serviceId), { force: true });
  } catch {
    // Best-effort cleanup.
  }
  invalidateProviderConfigCache();
  return true;
}

export async function listProviderConfigs() {
  const now = Date.now();
  if (configCache.configs && configCache.version === configVersion && now - configCache.at < CONFIG_CACHE_TTL_MS) {
    return configCache.configs;
  }
  const configs = await readAllProviderConfigs();
  configCache = { configs, at: now, version: configVersion };
  return configs;
}

async function readAllProviderConfigs() {
  const persistent = await listPersistentProviderConfigs();
  try {
    await ensureProviderDir();
    const files = await fs.readdir(PROVIDER_DIR);
    const seen = new Set(persistent.map((config) => config.manifest?.service_id).filter(Boolean));
    const configs = [...persistent];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const content = await fs.readFile(path.join(PROVIDER_DIR, file), "utf8");
      const config = JSON.parse(content);
      if (seen.has(config.manifest?.service_id)) continue;
      configs.push(config);
    }
    return configs;
  } catch {
    return persistent;
  }
}

export function createStaticProviderConfig({
  baseUrl,
  serviceId,
  providerId,
  title,
  description,
  capabilities,
  price,
  sampleRequest,
  sampleData,
  liveData,
  summary,
  payoutAddress = ""
}) {
  const manifest = {
    manifest_version: "agent_data_service_manifest_v1",
    manifest_type: "hosted_http_data_api",
    version: "1.0.0",
    service_id: serviceId,
    provider: {
      provider_id: providerId,
      payout_address: payoutAddress || undefined,
      agent_identity: {
        standard: "erc-8004-compatible",
        agent_registry: "optional",
        agent_id: "optional",
        agent_uri: "optional"
      }
    },
    title,
    description_for_agent: description,
    capabilities,
    not_for: [],
    input_schema: schemaFromSample(sampleRequest),
    output_schema: {
      type: "object",
      required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
      properties: {
        schema_version: { type: "string" },
        service_id: { type: "string" },
        request_id: { type: "string" },
        status: { type: "string" },
        query: { type: "object" },
        data: { type: "object" },
        metadata: { type: "object" }
      }
    },
    sample_request: sampleRequest,
    sample_response: createEnvelope({
      serviceId,
      input: sampleRequest,
      data: sampleData,
      sampleType: "preview",
      isEstimated: true,
      confidence: 0.7,
      summary: `${summary} (sample response)`
    }),
    pricing: {
      amount: price,
      currency: "USDC",
      network: "base",
      protocol: "x402",
      pay_to: payoutAddress || undefined,
      settlement_model: payoutAddress ? "direct_provider_wallet" : undefined
    },
    endpoint: {
      url: `${baseUrl.replace(/\/$/, "")}/provider/custom/${serviceId}`,
      method: "POST"
    },
    data_source_claim: {
      source_type: "static_dataset",
      source_provenance_level: "provider_owned",
      authorization_status: "provider_declared",
      redistribution_status: "provider_declared",
      credential_custody: "none",
      platform_stores_credentials: false
    },
    freshness: {
      update_frequency: "manual",
      max_data_lag_seconds: 86400
    },
    agent_contract: createAgentContract({ capabilities, sampleRequest, sampleData, summary }),
    routing: createStructuredRoutingMetadata({ capabilities, sampleRequest, sampleData, summary, title }),
    registration: {
      source_fingerprint: createSourceFingerprint({
        type: "static_json",
        provider_id: providerId,
        summary,
        sample_request: sampleRequest,
        sample_data: sampleData
      }),
      duplicate_policy: "same_provider_source_is_idempotent"
    }
  };
  attachErc8257Compatibility(manifest);

  return {
    provider_config_version: "adn_provider_config_v1",
    source: {
      type: "static_json",
      live_data: liveData,
      summary
    },
    manifest
  };
}

// An Apify Actor is onboarded like a hosted_http service, except the upstream
// identity is the actor id and the buyer-settable input is an allowlist.
export function createApifyActorProviderConfig({
  baseUrl,
  serviceId,
  providerId,
  title,
  description,
  capabilities,
  price,
  sampleRequest,
  sampleData,
  actorId,
  inputTemplate = {},
  inputAllowlist = [],
  datasetFields = [],
  maxItems = 100,
  secretValue = "",
  summary,
  payoutAddress = ""
}) {
  const config = createHostedHttpProviderConfig({
    baseUrl,
    serviceId,
    providerId,
    title,
    description,
    capabilities,
    price,
    sampleRequest,
    sampleData,
    upstreamUrl: `https://apify.com/actors/${String(actorId || "").replace(/~/g, "/")}`,
    upstreamMethod: "POST",
    secretName: "APIFY_TOKEN",
    secretValue,
    summary,
    payoutAddress
  });
  config.source = {
    type: "apify_actor",
    actor_id: actorId,
    execution_mode: "sync",
    input_template: inputTemplate && typeof inputTemplate === "object" ? inputTemplate : {},
    input_allowlist: Array.isArray(inputAllowlist) ? inputAllowlist.filter(Boolean) : [],
    dataset: {
      clean: true,
      max_items: Number(maxItems) > 0 ? Math.trunc(Number(maxItems)) : 100,
      ...(Array.isArray(datasetFields) && datasetFields.length ? { fields: datasetFields.filter(Boolean) } : {})
    },
    auth: {
      mode: "apify_token",
      // Keep the name meaningful in the secret store; overwriting config.source
      // below would otherwise drop what the hosted_http factory set.
      secret_name: "APIFY_TOKEN",
      ...(secretValue ? { secret_value: secretValue } : {})
    },
    summary
  };
  config.manifest.registration.source_fingerprint = createSourceFingerprint({
    type: "apify_actor",
    provider_id: providerId,
    actor_id: actorId
  });
  // The actor runs on Apify, so nothing here binds to a provider-owned origin.
  delete config.manifest.origin_binding;
  return config;
}

export function createHostedHttpProviderConfig({
  baseUrl,
  serviceId,
  providerId,
  title,
  description,
  capabilities,
  price,
  sampleRequest,
  sampleData,
  upstreamUrl,
  upstreamMethod = "POST",
  secretName = "PROVIDER_SECRET",
  secretValue = "",
  authHeader = "authorization",
  summary,
  payoutAddress = ""
}) {
  const manifest = {
    manifest_version: "agent_data_service_manifest_v1",
    manifest_type: "hosted_http_data_api",
    version: "1.0.0",
    service_id: serviceId,
    provider: {
      provider_id: providerId,
      payout_address: payoutAddress || undefined,
      agent_identity: {
        standard: "erc-8004-compatible",
        agent_registry: "optional",
        agent_id: "optional",
        agent_uri: "optional"
      }
    },
    title,
    description_for_agent: description,
    capabilities,
    not_for: [],
    input_schema: schemaFromSample(sampleRequest),
    output_schema: {
      type: "object",
      required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
      properties: {
        schema_version: { type: "string" },
        service_id: { type: "string" },
        request_id: { type: "string" },
        status: { type: "string" },
        query: { type: "object" },
        data: { type: "object" },
        metadata: { type: "object" }
      }
    },
    sample_request: sampleRequest,
    sample_response: createEnvelope({
      serviceId,
      input: sampleRequest,
      data: sampleData,
      sourceType: "hosted_http",
      sampleType: "preview",
      isEstimated: true,
      confidence: 0.7,
      summary: `${summary} (sample response)`
    }),
    pricing: {
      amount: price,
      currency: "USDC",
      network: "base",
      protocol: "x402",
      pay_to: payoutAddress || undefined,
      settlement_model: payoutAddress ? "direct_provider_wallet" : undefined
    },
    endpoint: {
      url: `${baseUrl.replace(/\/$/, "")}/provider/custom/${serviceId}`,
      method: "POST"
    },
    runtime_secrets: {
      required: Boolean(secretValue),
      custody: "hosted_runtime_config",
      public: false
    },
    data_source_claim: {
      source_type: "provider_declared_data_service",
      source_provenance_level: inferSourceProvenanceLevel({ upstreamUrl, secretValue }),
      authorization_status: "provider_declared",
      redistribution_status: "provider_declared",
      credential_custody: secretValue ? "hosted_runtime_config" : "none",
      platform_stores_credentials: Boolean(secretValue)
    },
    freshness: {
      update_frequency: "on_request",
      max_data_lag_seconds: 300
    },
    agent_contract: createAgentContract({ capabilities, sampleRequest, sampleData, summary }),
    routing: createStructuredRoutingMetadata({ capabilities, sampleRequest, sampleData, summary, title, upstreamUrl }),
    origin_binding: createOriginBinding({ upstreamUrl, serviceId, providerId }),
    registration: {
      source_fingerprint: createSourceFingerprint({
        type: "hosted_http",
        provider_id: providerId,
        upstream_url: canonicalizeUrl(upstreamUrl),
        upstream_method: String(upstreamMethod || "POST").toUpperCase()
      }),
      duplicate_policy: "same_provider_source_is_idempotent"
    }
  };
  attachErc8257Compatibility(manifest);

  return {
    provider_config_version: "adn_provider_config_v1",
    source: {
      type: "hosted_http",
      upstream_url: upstreamUrl,
      upstream_method: upstreamMethod,
      auth: {
        mode: secretValue ? "header" : "none",
        header: authHeader,
        secret_name: secretName,
        secret_value: secretValue
      },
      summary
    },
    manifest
  };
}

export function finalizeProviderConfig(config) {
  if (!config || typeof config !== "object") return config;
  validateApifyActorSource(config.source);
  config.provider_config_version ||= "adn_provider_config_v1";
  config.version ||= "1.0.0";
  const manifest = config.manifest || {};
  finalizeManifest(manifest, config);
  config.manifest = manifest;
  return config;
}

// Apify actors are onboarded as a provider source; v1 runs them synchronously
// through run-sync-get-dataset-items, so an async config must be rejected at
// registration rather than failing later at invoke time.
function validateApifyActorSource(source) {
  if (source?.type !== "apify_actor") return;
  if (!String(source.actor_id || "").trim()) {
    const error = new Error("apify_actor source requires actor_id.");
    error.code = "APIFY_ACTOR_ID_REQUIRED";
    error.statusCode = 422;
    throw error;
  }
  source.execution_mode ||= "sync";
  if (source.execution_mode !== "sync") {
    const error = new Error("apify_actor supports execution_mode \"sync\" only; async execution is not implemented.");
    error.code = "APIFY_ASYNC_NOT_SUPPORTED";
    error.statusCode = 422;
    throw error;
  }
}

export function finalizeManifest(manifest, config = null) {
  if (!manifest || typeof manifest !== "object") return manifest;
  manifest.manifest_version ||= "agent_data_service_manifest_v1";
  manifest.manifest_type ||= "hosted_http_data_api";
  manifest.version ||= "1.0.0";
  manifest.capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : ["data_service"];
  manifest.routing ||= createStructuredRoutingMetadata({
    capabilities: manifest.capabilities,
    sampleRequest: manifest.sample_request || {},
    sampleData: manifest.sample_response?.data || {},
    summary: manifest.agent_contract?.summary || manifest.description_for_agent || "",
    title: manifest.title || manifest.service_id || "",
    upstreamUrl: config?.source?.upstream_url || manifest.origin_binding?.origin || ""
  });
  manifest.agent_contract ||= createAgentContract({
    capabilities: manifest.capabilities,
    sampleRequest: manifest.sample_request || {},
    sampleData: manifest.sample_response?.data || {},
    summary: manifest.description_for_agent || ""
  });
  manifest.agent_contract.routing = manifest.routing;
  manifest.agent_contract.capability_tags = manifest.capabilities;
  if (config?.source?.type === "hosted_http" && !manifest.origin_binding) {
    manifest.origin_binding = createOriginBinding({
      upstreamUrl: config.source.upstream_url,
      serviceId: manifest.service_id,
      providerId: manifest.provider?.provider_id || ""
    });
  }
  attachErc8257Compatibility(manifest);

  const configHash = config
    ? hashJson(stripConfigForHash(config))
    : (manifest.integrity?.config_hash || hashJson({
        provider_config_version: "manifest_only_runtime_config_v1",
        service_id: manifest.service_id,
        endpoint: manifest.endpoint || null,
        pricing: manifest.pricing || null
      }));
  const manifestHash = hashJson(stripManifestForHash(manifest));
  const now = manifest.integrity?.created_at || new Date().toISOString();
  manifest.integrity = {
    integrity_version: "agentrouter_manifest_integrity_v1",
    algorithm: "sha256-stable-json",
    manifest_hash: manifestHash,
    config_hash: configHash,
    created_at: now,
    updated_at: new Date().toISOString()
  };
  manifest.registration = {
    ...(manifest.registration || {}),
    manifest_hash: manifestHash,
    config_hash: configHash,
    version: manifest.version,
    manifest_type: manifest.manifest_type
  };
  manifest.erc8257 = {
    ...(manifest.erc8257 || {}),
    metadata_hash: manifestHash
  };
  return manifest;
}

export function createManifestHash(manifest) {
  return hashJson(stripManifestForHash(manifest));
}

export function createConfigHash(config) {
  return hashJson(stripConfigForHash(config));
}

function attachErc8257Compatibility(manifest) {
  manifest.erc8257 = {
    compatible: true,
    compatibility_version: "agentrouter_erc8257_manifest_compat_v1",
    tool_manifest_standard: "ERC-8257",
    tool_type: manifest.manifest_type || "hosted_http_data_api",
    tool_id: manifest.service_id,
    registry_strategy: "compatible_manifest_only_no_custom_onchain_tool_registry",
    metadata_hash: manifest.erc8257?.metadata_hash || null
  };
}

function createOriginBinding({ upstreamUrl = "", serviceId = "", providerId = "" } = {}) {
  let origin = "";
  try {
    origin = new URL(upstreamUrl).origin;
  } catch {
    origin = "";
  }
  return {
    binding_version: "agentrouter_origin_binding_v1",
    status: "not_checked",
    required: false,
    origin,
    well_known_url: origin ? `${origin}/.well-known/agentrouter.json` : "",
    expected_service_id: serviceId,
    expected_provider_id: providerId,
    verification_hint: "If the upstream origin serves /.well-known/agentrouter.json, AgentRouter can bind this service to that origin without inventing a new chain registry."
  };
}

function createStructuredRoutingMetadata({ capabilities = [], sampleRequest = {}, sampleData = {}, summary = "", title = "", upstreamUrl = "" } = {}) {
  const raw = [
    title,
    summary,
    upstreamUrl,
    ...(Array.isArray(capabilities) ? capabilities : []),
    JSON.stringify(sampleRequest || {}),
    JSON.stringify(sampleData || {})
  ].join(" ").toLowerCase();
  const normalizedCapabilities = Array.isArray(capabilities) ? capabilities.filter(Boolean) : [];
  return {
    routing_version: "agentrouter_structured_routing_v1",
    domains: inferDomains(raw, normalizedCapabilities),
    data_types: inferDataTypes(raw, normalizedCapabilities),
    entities: inferEntities(raw, sampleRequest, sampleData),
    chains: inferChains(raw, sampleRequest),
    time_requirements: inferTimeRequirements(raw, sampleRequest),
    input_fields: Object.keys(sampleRequest || {}),
    output_fields: collectFieldPaths(sampleData || {}, 24),
    keywords: inferKeywords([title, summary, ...normalizedCapabilities].join(" ")),
    capability_refs: normalizedCapabilities
  };
}

function inferDomains(raw, capabilities) {
  const domains = new Set();
  if (/crypto|token|chain|wallet|on[-_ ]?chain|defi|perp|futures|etf|exchange|nansen|coinglass|blockbeats/.test(raw)) domains.add("crypto");
  if (/price|ohlc|market|volume|liquidation|funding|open interest|oi|orderbook/.test(raw)) domains.add("market_data");
  if (/wallet|holder|address|smart money|flow|transfer|balance/.test(raw)) domains.add("onchain");
  if (/news|article|rss|flash/.test(raw)) domains.add("news");
  for (const capability of capabilities) {
    if (capability.includes("wallet") || capability.includes("holder")) domains.add("onchain");
    if (capability.includes("market") || capability.includes("price")) domains.add("market_data");
  }
  return [...(domains.size ? domains : new Set(["data_api"]))];
}

function inferDataTypes(raw, capabilities) {
  const dataTypes = new Set(capabilities.filter((capability) => capability !== "data_service").slice(0, 12));
  const patterns = [
    ["smart_money", /smart money|聪明钱/],
    ["holder_distribution", /holder|holders|持仓|持有人/],
    ["token_flow", /flow|netflow|inflow|outflow|净流入|流入|流出/],
    ["liquidation", /liquidation|爆仓/],
    ["funding_rate", /funding|资金费率/],
    ["open_interest", /open interest|\boi\b/],
    ["price", /price|价格/],
    ["news", /news|article|rss|快讯|新闻/],
    ["etf_flow", /\betf\b/],
    ["prediction_market", /prediction|polymarket/]
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(raw)) dataTypes.add(name);
  }
  return [...(dataTypes.size ? dataTypes : new Set(["generic_data"]))];
}

function inferEntities(raw, sampleRequest, sampleData) {
  const fields = [...Object.keys(sampleRequest || {}), ...collectFieldPaths(sampleData || {}, 24)].join(" ").toLowerCase();
  const source = `${raw} ${fields}`;
  const entities = new Set();
  if (/token|symbol|asset|coin|contract/.test(source)) entities.add("token");
  if (/address|wallet|holder|account/.test(source)) entities.add("wallet_address");
  if (/chain|network/.test(source)) entities.add("chain");
  if (/exchange|cex|binance|bybit|okx|coinbase/.test(source)) entities.add("exchange");
  if (/date|time|window|from|to|start|end/.test(source)) entities.add("time_window");
  return [...entities];
}

function inferChains(raw, sampleRequest) {
  const chains = new Set();
  const known = ["ethereum", "base", "bsc", "bnb", "arbitrum", "optimism", "polygon", "solana", "hyperliquid", "hyperevm"];
  for (const chain of known) {
    if (raw.includes(chain)) chains.add(chain);
  }
  const chainValue = sampleRequest?.chain || sampleRequest?.network;
  if (typeof chainValue === "string" && chainValue) chains.add(chainValue.toLowerCase());
  return [...chains];
}

function inferTimeRequirements(raw, sampleRequest) {
  const fields = Object.keys(sampleRequest || {}).join(" ").toLowerCase();
  return {
    supports_realtime: /live|real[-_ ]?time|current|latest|now|24h|hour|minute/.test(raw),
    supports_historical: /date|from|to|start|end|history|historical|days|day|week|month/.test(`${raw} ${fields}`),
    accepted_time_fields: Object.keys(sampleRequest || {}).filter((key) => /date|time|window|from|to|start|end|day|hour/i.test(key))
  };
}

function inferKeywords(text) {
  return [...new Set(String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["the", "and", "for", "with", "api", "data", "get", "post", "use", "this", "service"].includes(word))
    .slice(0, 24))];
}

function stripManifestForHash(manifest) {
  const clone = structuredClone(manifest || {});
  delete clone.integrity;
  if (clone.registration) {
    delete clone.registration.manifest_hash;
    delete clone.registration.config_hash;
    delete clone.registration.version;
    delete clone.registration.manifest_type;
  }
  if (clone.erc8257) delete clone.erc8257.metadata_hash;
  if (clone.origin_binding) {
    delete clone.origin_binding.status;
    delete clone.origin_binding.checked_at;
    delete clone.origin_binding.error;
  }
  return clone;
}

function stripConfigForHash(config) {
  const clone = structuredClone(config || {});
  if (clone.source?.auth) {
    delete clone.source.auth.secret_value;
  }
  if (clone.manifest) clone.manifest = stripManifestForHash(clone.manifest);
  return clone;
}

function inferSourceProvenanceLevel({ upstreamUrl = "", secretValue = "" } = {}) {
  const url = String(upstreamUrl || "").toLowerCase();
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) return "provider_owned";
  if (/api\.|docs\.|data\./.test(url) && secretValue) return "wrapped_api";
  if (/scrap|crawl|html|page/.test(url)) return "scraped";
  return secretValue ? "wrapped_api" : "unknown";
}

function createAgentContract({ capabilities = [], sampleRequest = {}, sampleData = {}, summary = "" }) {
  return {
    contract_version: "agent_data_service_contract_v1",
    capability_tags: capabilities,
    example_questions: exampleQuestionsForCapabilities(capabilities),
    request_shape_summary: summarizeShape(sampleRequest),
    response_shape_summary: summarizeShape(sampleData),
    request_data: requestDataContract(sampleRequest),
    response_data: responseDataContract(sampleData),
    quality_expectations: {
      result_envelope: "agent_data_envelope_v1",
      must_include_metadata: ["data_sources", "generated_at", "freshness_seconds", "confidence", "limitations"],
      preview_paid_shape_should_match: true,
      empty_result_should_be_explicit: true
    },
    routing_hints: {
      good_for: capabilities.filter((capability) => capability !== "data_service").slice(0, 8),
      not_for: []
    },
    summary
  };
}

function requestDataContract(sampleRequest = {}) {
  return {
    purpose: "Use this example before payment to decide whether the service accepts the fields needed for the task.",
    fields: Object.keys(sampleRequest || {}),
    example: sampleRequest || {},
    shape_summary: summarizeShape(sampleRequest)
  };
}

function responseDataContract(sampleData = {}) {
  return {
    purpose: "Use this preview before payment to decide whether the service can return data useful for the task. It is a sample/preview, not a guaranteed paid result.",
    fields: collectFieldPaths(sampleData, 16),
    preview: sampleData || {},
    shape_summary: summarizeShape(sampleData)
  };
}

function schemaFromSample(sample) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(sample || {}).map(([key, value]) => [key, schemaForValue(value)])
    )
  };
}

function schemaForValue(value) {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? schemaForValue(value[0]) : {} };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schemaForValue(child)]))
    };
  }
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function summarizeShape(value) {
  if (Array.isArray(value)) return `array(${value.length} sample items)`;
  if (value && typeof value === "object") return `object keys: ${Object.keys(value).slice(0, 12).join(", ") || "none"}`;
  return typeof value;
}

function collectFieldPaths(value, limit = 16, prefix = "") {
  if (limit <= 0) return [];
  if (Array.isArray(value)) return value.length ? collectFieldPaths(value[0], limit, prefix) : [];
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (paths.length >= limit) break;
    if (child && typeof child === "object") {
      for (const nested of collectFieldPaths(child, limit - paths.length, path)) {
        paths.push(nested);
        if (paths.length >= limit) break;
      }
    }
    if (paths.length >= limit) break;
  }
  return paths;
}

function exampleQuestionsForCapabilities(capabilities = []) {
  if (capabilities.includes("smart_money_netflow")) return ["Query ETH smart money netflow for the latest page.", "查询 ETH 近 24 小时 smart money netflow。"];
  if (capabilities.includes("smart_money_holdings")) return ["Query the first 10 smart money holdings rows.", "查询 smart money holdings 的前 10 条数据。"];
  if (capabilities.includes("perp_liquidation_max_pain")) return ["What is BTC's current liquidation max-pain price?"];
  if (capabilities.includes("fund_flow")) return ["What is the recent fund flow for this chain?"];
  return ["Query this provider data service with the sample request shape."];
}

function createSourceFingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}

async function sanitizeProviderConfig(config) {
  const next = structuredClone(config);
  const auth = next.source?.auth;
  if (auth?.secret_value) {
    const secretRef = await writeProviderSecret({
      serviceId: next.manifest.service_id,
      secretName: auth.secret_name || "PROVIDER_SECRET",
      secretValue: auth.secret_value
    });
    auth.secret_ref = secretRef;
    delete auth.secret_value;
  }
  return next;
}

export function createEnvelope({ serviceId, input, data, sampleType, isEstimated, confidence, summary, sourceType = "static_json" }) {
  const now = new Date().toISOString();
  const envelope = {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: sampleType ? "sample_req" : `req_${Date.now()}`,
    status: "success",
    query: input || {},
    data,
    metadata: {
      data_sources: [`provider_config_${sourceType}`],
      generated_at: now,
      freshness_seconds: sampleType ? 86400 : 60,
      is_estimated: isEstimated,
      confidence,
      limitations: sampleType ? ["Preview response is static and not a live paid response."] : [`${sourceType} provider for MVP onboarding.`]
    },
    agent_hints: {
      good_for: ["MVP validation", "Agent response parsing"],
      warnings: sampleType ? ["Use paid invocation for the full response."] : [],
      suggested_followups: []
    },
    summary
  };
  if (sampleType) envelope.sample_type = sampleType;
  return envelope;
}
