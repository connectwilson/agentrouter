import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, isEvmAddress } from "./arc-payment.js";
import { erc8004Registries } from "./chains.js";
import { hashJson } from "./evidence.js";
import { keccak256Hex } from "./keccak.js";

// Kept for existing importers. The 0x8004… registries are deployed
// deterministically at the same addresses on Arc, BSC and BSC testnet, so this
// resolves from the chain registry rather than pinning one network's copy.
export const ERC8004_ARC_TESTNET = erc8004Registries();

export const ERC8004_REPUTATION_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" }
    ],
    outputs: []
  }
];

export const ERC8004_IDENTITY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }]
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }]
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
];

export function erc8004Configured({ serviceId, manifest } = {}) {
  return Boolean(
    reputationRegistryAddress() &&
    process.env.ADN_ERC8004_PRIVATE_KEY &&
    resolveErc8004AgentId({ serviceId, manifest })
  );
}

export function resolveErc8004AgentId({ serviceId, manifest } = {}) {
  const fromManifest =
    manifest?.registration?.erc8004?.agent_id ||
    manifest?.provider?.erc8004_agent_id ||
    manifest?.provider?.agent_id ||
    manifest?.erc8004?.agent_id;
  if (fromManifest != null && fromManifest !== "") return String(fromManifest);

  const serviceEnvName = serviceId ? `ADN_ERC8004_AGENT_ID_${envKey(serviceId)}` : "";
  if (serviceEnvName && process.env[serviceEnvName]) return process.env[serviceEnvName];
  return process.env.ADN_ERC8004_AGENT_ID || "";
}

export function createErc8004AgentMetadata({ manifest, baseUrl = "" } = {}) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  const serviceId = manifest?.service_id || "";
  const providerId = manifest?.provider?.provider_id || "";
  const detailUrl = origin && serviceId ? `${origin}/agent-router/service?service_id=${encodeURIComponent(serviceId)}` : "";
  const feedbackUrl = origin ? `${origin}/agent-router/feedback` : "/agent-router/feedback";
  const metadata = {
    type: "erc8004-agent-v1",
    name: manifest?.title || serviceId || "AgentRouter data service",
    description: manifest?.description_for_agent || "Agent-callable data API service routed by AgentRouter.",
    agent_type: "data_provider",
    version: "1.0.0",
    provider: {
      provider_id: providerId,
      payout_address: manifest?.provider?.payout_address || manifest?.pricing?.pay_to || null
    },
    capabilities: manifest?.capabilities || [],
    services: [
      {
        type: "agentrouter_data_api",
        service_id: serviceId,
        title: manifest?.title || serviceId,
        description: manifest?.description_for_agent || "",
        capabilities: manifest?.capabilities || [],
        price: {
          amount: manifest?.pricing?.amount || null,
          currency: manifest?.pricing?.currency || null,
          network: manifest?.pricing?.network || null,
          payment_protocol: manifest?.pricing?.protocol || "x402"
        },
        endpoint: detailUrl,
        feedback_endpoint: feedbackUrl
      }
    ],
    supported_trust: ["reputation", "validation"],
    registrations: [
      {
        chain: ARC_TESTNET.network,
        caip2: ARC_TESTNET.caip2,
        identity_registry: erc8004Registries().identityRegistry,
        reputation_registry: erc8004Registries().reputationRegistry,
        validation_registry: erc8004Registries().validationRegistry
      }
    ]
  };
  if (resolveErc8004AgentId({ serviceId, manifest })) {
    metadata.agent_id = resolveErc8004AgentId({ serviceId, manifest });
  }
  return metadata;
}

export function defaultErc8004MetadataUri({ manifest, baseUrl = "" } = {}) {
  if (process.env.ADN_ERC8004_METADATA_URI) return process.env.ADN_ERC8004_METADATA_URI;
  const serviceId = manifest?.service_id || "";
  const origin = String(process.env.ADN_ERC8004_METADATA_BASE_URL || baseUrl || "").replace(/\/$/, "");
  if (!origin || !serviceId) return "";
  return `${origin}/.well-known/erc8004/agents/${encodeURIComponent(serviceId)}.json`;
}

export async function registerErc8004AgentIdentity({ manifest, baseUrl = "", metadataUri = "" } = {}) {
  const serviceId = manifest?.service_id || "";
  const identityRegistry = identityRegistryAddress();
  const tokenUri = metadataUri || defaultErc8004MetadataUri({ manifest, baseUrl });
  const base = {
    standard: "ERC-8004",
    registry_type: "identity",
    event_type: "AgentRouterProviderIdentity",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    registry_address: identityRegistry || null,
    reputation_registry_address: erc8004Registries().reputationRegistry,
    validation_registry_address: erc8004Registries().validationRegistry,
    service_id: serviceId || null,
    provider_id: manifest?.provider?.provider_id || null,
    metadata_uri: tokenUri || null,
    metadata_hash: hashJson(createErc8004AgentMetadata({ manifest, baseUrl })),
    function_name: "register",
    created_at: new Date().toISOString()
  };

  if (process.env.ADN_ERC8004_MODE === "mock") {
    const agentId = String(process.env.ADN_ERC8004_MOCK_AGENT_ID || resolveErc8004AgentId({ serviceId, manifest }) || mockAgentId(serviceId));
    return {
      ...base,
      status: "registered",
      mode: "mock",
      agent_id: agentId,
      owner_address: `0x${"4".repeat(40)}`,
      tx_hash: `0x${"4".repeat(64)}`,
      block_number: "0",
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"4".repeat(64)}`
    };
  }
  if (!tokenUri) {
    return {
      ...base,
      status: "not_configured",
      error: "ERC-8004 metadata URI is missing. Configure ADN_ERC8004_METADATA_BASE_URL or pass metadata_uri."
    };
  }
  if (!identityRegistry || !isEvmAddress(identityRegistry)) {
    return {
      ...base,
      status: identityRegistry ? "invalid_config" : "not_configured",
      error: identityRegistry ? "ADN_ERC8004_IDENTITY_REGISTRY must be a valid EVM address." : "ERC-8004 Identity Registry is not configured."
    };
  }
  if (!process.env.ADN_ERC8004_OWNER_PRIVATE_KEY && !process.env.ADN_ERC8004_PRIVATE_KEY) {
    return {
      ...base,
      status: "not_configured",
      error: "ADN_ERC8004_OWNER_PRIVATE_KEY or ADN_ERC8004_PRIVATE_KEY is required to register an ERC-8004 identity."
    };
  }

  try {
    const privateKey = process.env.ADN_ERC8004_OWNER_PRIVATE_KEY || process.env.ADN_ERC8004_PRIVATE_KEY;
    const account = privateKeyToAccount(normalizePrivateKey(privateKey));
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const walletClient = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const simulation = await publicClient.simulateContract({
      address: identityRegistry,
      abi: ERC8004_IDENTITY_ABI,
      functionName: "register",
      args: [tokenUri],
      account
    });
    const txHash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: Number(process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
    });
    return {
      ...base,
      status: "registered",
      mode: "arc_testnet",
      agent_id: simulation.result?.toString?.() || null,
      owner_address: account.address,
      tx_hash: txHash,
      block_number: receipt.blockNumber?.toString?.(),
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
    };
  } catch (error) {
    return {
      ...base,
      status: "registration_failed",
      mode: "arc_testnet",
      error: error.shortMessage || error.message
    };
  }
}

export async function submitErc8004Feedback({
  requestId,
  serviceId,
  providerId,
  manifest,
  feedback,
  baseUrl = "",
  privateKey = "",
  submitter = "server"
} = {}) {
  const agentId = resolveErc8004AgentId({ serviceId, manifest });
  const registry = reputationRegistryAddress();
  const value = feedbackValue(feedback);
  const valueDecimals = 2;
  const endpoint = endpointFor(baseUrl, requestId);
  const feedbackURI = endpoint;
  const feedbackHash = keccakHashJson({
    standard: "ERC-8004",
    request_id: requestId || null,
    service_id: serviceId || null,
    provider_id: providerId || null,
    feedback: feedback || null
  });
  const base = {
    standard: "ERC-8004",
    registry_type: "reputation",
    event_type: "AgentRouterConsumerFeedback",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    registry_address: registry || null,
    identity_registry_address: erc8004Registries().identityRegistry,
    validation_registry_address: erc8004Registries().validationRegistry,
    agent_id: agentId || null,
    function_name: "giveFeedback",
    value,
    value_decimals: valueDecimals,
    tag1: "data_quality",
    tag2: "intent_fit",
    endpoint,
    feedback_uri: feedbackURI,
    feedback_hash: feedbackHash,
    request_id: requestId || null,
    service_hash: hashJson(serviceId || ""),
    provider_hash: hashJson(providerId || ""),
    created_at: new Date().toISOString()
  };

  if (process.env.ADN_ERC8004_MODE === "mock") {
    return {
      ...base,
      status: "submitted",
      mode: "mock",
      tx_hash: `0x${"8".repeat(64)}`,
      block_number: "0",
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"8".repeat(64)}`
    };
  }
  if (!registry || !isEvmAddress(registry)) {
    return {
      ...base,
      status: registry ? "invalid_config" : "not_configured",
      error: registry ? "ADN_ERC8004_REPUTATION_REGISTRY must be a valid EVM address." : "ERC-8004 Reputation Registry is not configured."
    };
  }
  if (!agentId) {
    return {
      ...base,
      status: "not_configured",
      error: "ERC-8004 agent_id is missing. Set ADN_ERC8004_AGENT_ID or attach registration.erc8004.agent_id to the service manifest."
    };
  }
  const signingKey = privateKey || process.env.ADN_ERC8004_PRIVATE_KEY;
  if (!signingKey) {
    return {
      ...base,
      status: "not_configured",
      submitter,
      error: "A consumer feedback signing key is required to submit ERC-8004 feedback."
    };
  }

  try {
    const account = privateKeyToAccount(normalizePrivateKey(signingKey));
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const client = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const txHash = await client.writeContract({
      address: registry,
      abi: ERC8004_REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [
        BigInt(agentId),
        BigInt(value),
        valueDecimals,
        base.tag1,
        base.tag2,
        endpoint,
        feedbackURI,
        feedbackHash
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: Number(process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
    });
    return {
      ...base,
      status: "submitted",
      mode: "arc_testnet",
      submitter,
      tx_hash: txHash,
      block_number: receipt.blockNumber?.toString?.(),
      feedback_account: account.address,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
    };
  } catch (error) {
    return {
      ...base,
      status: "submit_failed",
      mode: "arc_testnet",
      submitter,
      error: error.shortMessage || error.message
    };
  }
}

function reputationRegistryAddress() {
  return erc8004Registries().reputationRegistry;
}

function identityRegistryAddress() {
  return erc8004Registries().identityRegistry;
}

function feedbackValue(feedback = {}) {
  const explicit =
    asNumber(feedback.consumer_score) ??
    asNumber(feedback.data_quality_score) ??
    asNumber(feedback.score);
  if (explicit != null) return clampScore(explicit);
  const intentFit = yesNoScore(feedback.intent_fit);
  const useful = yesNoScore(feedback.answer_useful);
  const nonNull = [intentFit, useful].filter((item) => item != null);
  if (!nonNull.length) return 50;
  return clampScore(nonNull.reduce((sum, item) => sum + item, 0) / nonNull.length);
}

function clampScore(score) {
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(10000, Math.round(normalized * 100)));
}

function yesNoScore(value) {
  const normalized = String(value || "").toLowerCase();
  if (["yes", "true", "1", "useful", "fit"].includes(normalized)) return 1;
  if (["partial", "partially", "mixed"].includes(normalized)) return 0.5;
  if (["no", "false", "0", "not_useful", "not_fit"].includes(normalized)) return 0;
  return null;
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function endpointFor(baseUrl, requestId) {
  const path = `/agent-router/feedback${requestId ? `?request_id=${encodeURIComponent(requestId)}` : ""}`;
  if (!baseUrl) return path;
  return `${String(baseUrl).replace(/\/$/, "")}${path}`;
}

function keccakHashJson(value) {
  return `0x${keccak256Hex(stableStringify(value))}`;
}

function envKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  return key.startsWith("0x") ? key : `0x${key}`;
}

function mockAgentId(serviceId) {
  const hex = hashJson(serviceId || "agentrouter").slice(2, 10);
  return String(Number.parseInt(hex, 16));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
