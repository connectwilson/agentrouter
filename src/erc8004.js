import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, isEvmAddress } from "./arc-payment.js";
import { erc8004Registries, erc8004AgentRegistryId, erc8004ExplorerUrl, settlementChain } from "./chains.js";
import { hashJson } from "./evidence.js";
import { keccak256Hex } from "./keccak.js";

// The EIP's own schema id; indexers key off this exact string.
export const ERC8004_REGISTRATION_SCHEMA = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

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
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true }
    ]
  },
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

export function createErc8004RegistrationTransaction({ agentUri } = {}) {
  const chain = settlementChain();
  const registryAddress = erc8004Registries().identityRegistry;
  const uri = String(agentUri || "").trim();
  if (!uri) throw erc8004VerificationError("ERC8004_AGENT_URI_REQUIRED", "An ERC-8004 agent URI is required.");
  if (!isEvmAddress(registryAddress)) throw erc8004VerificationError("ERC8004_IDENTITY_REGISTRY_INVALID", "The ERC-8004 Identity Registry is not configured.");
  return {
    standard: "ERC-8004",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
    chain_name: chain.name,
    rpc_url: chain.rpcUrls.default.http[0],
    explorer: chain.blockExplorers.default.url,
    agent_uri: uri,
    transaction: {
      to: registryAddress,
      data: encodeFunctionData({ abi: ERC8004_IDENTITY_ABI, functionName: "register", args: [uri] }),
      value: "0x0"
    }
  };
}

export async function verifyErc8004IdentityRegistrationTransaction({ txHash, expected = {}, publicClient } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) {
    throw erc8004VerificationError("ERC8004_INVALID_TX_HASH", "A valid transaction hash is required.");
  }
  const chain = settlementChain();
  const client = publicClient || createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) throw erc8004VerificationError("ERC8004_RECEIPT_NOT_FOUND", "The ERC-8004 registration transaction is still pending or was not found.");
  if (receipt.status !== "success") throw erc8004VerificationError("ERC8004_TRANSACTION_REVERTED", "The ERC-8004 registration transaction reverted.");
  const chainId = await client.getChainId();
  if (Number(chainId) !== Number(expected.chainId)) throw erc8004VerificationError("ERC8004_CHAIN_MISMATCH", `Transaction is on chain ${chainId}, expected ${expected.chainId}.`);
  const transaction = await client.getTransaction({ hash: txHash }).catch(() => null);
  if (!transaction) throw erc8004VerificationError("ERC8004_TRANSACTION_NOT_FOUND", "The ERC-8004 registration transaction was not found.");
  if (transaction.chainId != null && Number(transaction.chainId) !== Number(expected.chainId)) {
    throw erc8004VerificationError("ERC8004_CHAIN_MISMATCH", `Transaction declares chain ${transaction.chainId}, expected ${expected.chainId}.`);
  }
  if (String(transaction.to || "").toLowerCase() !== String(expected.registryAddress || "").toLowerCase()) {
    throw erc8004VerificationError("ERC8004_REGISTRY_MISMATCH", "Transaction target is not the expected ERC-8004 Identity Registry.");
  }
  if (expected.ownerAddress && String(transaction.from || "").toLowerCase() !== String(expected.ownerAddress).toLowerCase()) {
    throw erc8004VerificationError("ERC8004_OWNER_MISMATCH", "The connected wallet did not send this registration transaction.");
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ERC8004_IDENTITY_ABI, data: transaction.input || transaction.data });
  } catch {
    throw erc8004VerificationError("ERC8004_CALL_INVALID", "Transaction input is not a valid ERC-8004 registration call.");
  }
  if (decoded.functionName !== "register" || String(decoded.args?.[0] || "") !== String(expected.agentUri || "")) {
    throw erc8004VerificationError("ERC8004_AGENT_URI_MISMATCH", "The registration transaction does not contain the expected AgentRouter metadata URI.");
  }
  const registered = (receipt.logs || []).filter((log) =>
    String(log.address || "").toLowerCase() === String(expected.registryAddress || "").toLowerCase()
  ).map((log) => {
    try { return decodeEventLog({ abi: ERC8004_IDENTITY_ABI, data: log.data, topics: log.topics, eventName: "Registered" }); }
    catch { return null; }
  }).find((event) => event?.eventName === "Registered");
  if (registered?.args?.agentId == null) throw erc8004VerificationError("ERC8004_REGISTERED_EVENT_MISSING", "The Identity Registry did not emit a Registered event.");
  if (String(registered.args.agentURI || "") !== String(expected.agentUri || "")) throw erc8004VerificationError("ERC8004_AGENT_URI_MISMATCH", "The Registered event contains a different metadata URI.");
  if (expected.ownerAddress && String(registered.args.owner || "").toLowerCase() !== String(expected.ownerAddress).toLowerCase()) {
    throw erc8004VerificationError("ERC8004_OWNER_MISMATCH", "The Registered event belongs to a different wallet.");
  }
  return {
    standard: "ERC-8004",
    registry_type: "identity",
    status: "registered",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
    registry_address: expected.registryAddress,
    reputation_registry_address: erc8004Registries().reputationRegistry,
    validation_registry_address: erc8004Registries().validationRegistry,
    agent_id: registered.args.agentId.toString(),
    owner_address: transaction.from,
    metadata_uri: expected.agentUri,
    tx_hash: txHash,
    block_number: receipt.blockNumber?.toString?.() || null,
    explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}`
  };
}

export function erc8004Configured({ serviceId, manifest } = {}) {
  return Boolean(
    reputationRegistryAddress() &&
    process.env.ADN_ERC8004_PRIVATE_KEY &&
    resolveErc8004AgentId({ serviceId, manifest })
  );
}

export function resolveErc8004AgentId({ serviceId, manifest } = {}) {
  return resolveErc8004AgentIdentity({ serviceId, manifest }).agentId;
}

function resolveErc8004AgentIdentity({ serviceId, manifest } = {}) {
  const registration = manifest?.registration?.erc8004;
  if (registration?.agent_id != null && registration.agent_id !== "" && registrationMatchesSettlementChain(registration)) {
    return { agentId: String(registration.agent_id), source: "manifest_registration" };
  }

  const serviceEnvName = serviceId ? `ADN_ERC8004_AGENT_ID_${envKey(serviceId)}` : "";
  if (serviceEnvName && process.env[serviceEnvName]) return { agentId: process.env[serviceEnvName], source: "service_override" };
  if (String(serviceId || "").startsWith("external_api_")) {
    return { agentId: "", source: "external_vendor_not_configured" };
  }
  if (process.env.ADN_ERC8004_AGENT_ID) return { agentId: process.env.ADN_ERC8004_AGENT_ID, source: "global_fallback" };

  // Legacy manifests sometimes stored only a token id under provider. Accept
  // those only when there is no explicit cross-chain registration proving the
  // id belongs elsewhere; token ids are local to a registry and chain.
  if (registration?.agent_id != null && registration.agent_id !== "") return { agentId: "", source: "cross_chain_registration_rejected" };
  const legacy = manifest?.provider?.erc8004_agent_id || manifest?.provider?.agent_id || manifest?.erc8004?.agent_id;
  return legacy != null && legacy !== ""
    ? { agentId: String(legacy), source: "legacy_manifest" }
    : { agentId: "", source: "not_configured" };
}

function registrationMatchesSettlementChain(registration = {}) {
  const chain = settlementChain();
  if (registration.chain_id != null && registration.chain_id !== "") {
    return Number(registration.chain_id) === chain.id;
  }
  if (registration.caip2) return String(registration.caip2).toLowerCase() === chain.caip2.toLowerCase();
  if (registration.network) {
    const network = String(registration.network).toLowerCase();
    return network === chain.network.toLowerCase() || network === String(chain.id) || network === chain.caip2.toLowerCase();
  }
  return true;
}

export function createErc8004AgentMetadata({ manifest, baseUrl = "" } = {}) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  const serviceId = manifest?.service_id || "";
  const providerId = manifest?.provider?.provider_id || "";
  const detailUrl = origin && serviceId ? `${origin}/agent-router/service?service_id=${encodeURIComponent(serviceId)}` : "";
  const feedbackUrl = origin ? `${origin}/agent-router/feedback` : "/agent-router/feedback";
  const agentId = resolveErc8004AgentId({ serviceId, manifest });
  const describedServices = Array.isArray(manifest?.services) && manifest.services.length
    ? manifest.services
    : [{
      service_id: serviceId,
      title: manifest?.title || serviceId,
      description_for_agent: manifest?.description_for_agent || "",
      capabilities: manifest?.capabilities || [],
      pricing: manifest?.pricing || {},
      endpoint: detailUrl
    }];
  // Canonical EIP-8004 registration card. The keys below are the ones indexers
  // (8004scan) read: `type` must be the EIP's schema URL, `supportedTrust` is
  // camelCase, and `image` is what renders the agent in a listing — we shipped
  // a private "erc8004-agent-v1" shape with none of those, so the cards were
  // valid JSON that no indexer could place. Our extra detail (pricing,
  // capabilities, feedback endpoint) rides alongside; unknown keys are ignored
  // by indexers but are what an agent reading the card directly actually needs.
  const metadata = {
    type: ERC8004_REGISTRATION_SCHEMA,
    name: manifest?.title || serviceId || "AgentRouter data service",
    description: manifest?.description_for_agent || "Agent-callable data API service routed by AgentRouter.",
    image: manifest?.image || manifest?.provider?.logo_url || (origin ? `${origin}/assets/brand/logo.png` : ""),
    active: manifest?.status ? manifest.status === "published" : true,
    x402Support: (manifest?.pricing?.protocol || "x402") === "x402",
    supportedTrust: ["reputation", "validation"],
    services: describedServices.map((service) => {
      const describedServiceId = service.service_id || "";
      return {
        name: "agentrouter_data_api",
        endpoint: service.endpoint || (origin && describedServiceId ? `${origin}/agent-router/service?service_id=${encodeURIComponent(describedServiceId)}` : ""),
        service_id: describedServiceId,
        title: service.title || describedServiceId,
        description: service.description_for_agent || service.description || "",
        capabilities: service.capabilities || [],
        price: {
          amount: service.pricing?.amount || null,
          currency: service.pricing?.currency || null,
          network: service.pricing?.network || null,
          payment_protocol: service.pricing?.protocol || "x402"
        },
        feedback_endpoint: feedbackUrl
      };
    }),
    registrations: [
      {
        // Null until the identity is minted — the EIP's own cards carry null
        // here too, since the card must exist before it can be registered.
        agentId: agentId ? String(agentId) : null,
        agentRegistry: erc8004AgentRegistryId(),
        chain: settlementChain().network,
        caip2: settlementChain().caip2,
        identity_registry: erc8004Registries().identityRegistry,
        reputation_registry: erc8004Registries().reputationRegistry,
        validation_registry: erc8004Registries().validationRegistry
      }
    ],
    provider: {
      provider_id: providerId,
      payout_address: manifest?.provider?.payout_address || manifest?.pricing?.pay_to || null
    },
    capabilities: manifest?.capabilities || []
  };
  // Only once minted: a link to the registry listing tells an agent nothing
  // about *this* service.
  if (agentId) {
    const explorerUrl = erc8004ExplorerUrl(agentId);
    if (explorerUrl) metadata.explorer_url = explorerUrl;
  }
  if (agentId) metadata.agent_id = String(agentId);
  return metadata;
}

export function defaultErc8004MetadataUri({ manifest, baseUrl = "" } = {}) {
  if (process.env.ADN_ERC8004_METADATA_URI) return process.env.ADN_ERC8004_METADATA_URI;
  const serviceId = manifest?.service_id || "";
  const origin = String(process.env.ADN_ERC8004_METADATA_BASE_URL || baseUrl || "").replace(/\/$/, "");
  if (!origin || !serviceId) return "";
  return `${origin}/.well-known/erc8004/agents/${encodeURIComponent(serviceId)}.json`;
}

// A registry address with bytecode is not a registry. On BSC the reputation and
// validation addresses hold bare UUPS placeholder proxies — owner(), initialize()
// and nothing else — so giveFeedback would revert and burn the gas. Simulating
// first turns a lost transaction into a reported reason.
export async function assertRegistryImplements({ publicClient, address, abi, functionName, args, account }) {
  try {
    await publicClient.simulateContract({ address, abi, functionName, args, account });
    return null;
  } catch (error) {
    const code = await publicClient.getBytecode({ address }).catch(() => null);
    if (!code || code === "0x") {
      return `No contract is deployed at ${address} on ${settlementChain().network}.`;
    }
    return `${address} on ${settlementChain().network} does not implement ${functionName}: ${error.shortMessage || error.message}`;
  }
}

export async function registerErc8004AgentIdentity({ manifest, baseUrl = "", metadataUri = "" } = {}) {
  const chain = settlementChain();
  const serviceId = manifest?.service_id || "";
  const identityRegistry = identityRegistryAddress();
  const tokenUri = metadataUri || defaultErc8004MetadataUri({ manifest, baseUrl });
  const base = {
    standard: "ERC-8004",
    registry_type: "identity",
    event_type: "AgentRouterProviderIdentity",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
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
      explorer_url: `${chain.blockExplorers.default.url}/tx/0x${"4".repeat(64)}`
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
      chain,
      transport: http(chain.rpcUrls.default.http[0])
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(chain.rpcUrls.default.http[0])
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
      mode: settlementChain().network,
      agent_id: simulation.result?.toString?.() || null,
      owner_address: account.address,
      tx_hash: txHash,
      block_number: receipt.blockNumber?.toString?.(),
      explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}`
    };
  } catch (error) {
    return {
      ...base,
      status: "registration_failed",
      mode: settlementChain().network,
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
  const base = createErc8004FeedbackDescriptor({ requestId, serviceId, providerId, manifest, feedback, baseUrl });
  const agentId = base.agent_id;
  const registry = base.registry_address;
  const value = feedbackValue(feedback);
  const valueDecimals = base.value_decimals;
  const endpoint = base.endpoint;
  const feedbackURI = base.feedback_uri;
  const feedbackHash = base.feedback_hash;

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
    const args = [
      BigInt(agentId),
      BigInt(value),
      valueDecimals,
      base.tag1,
      base.tag2,
      endpoint,
      feedbackURI,
      feedbackHash
    ];
    const unsupported = await assertRegistryImplements({
      publicClient,
      address: registry,
      abi: ERC8004_REPUTATION_ABI,
      functionName: "giveFeedback",
      args,
      account
    });
    if (unsupported) {
      return {
        ...base,
        status: "registry_unavailable",
        submitter,
        registry_address: registry,
        error: unsupported,
        recorded_offchain: true
      };
    }
    const txHash = await client.writeContract({
      address: registry,
      abi: ERC8004_REPUTATION_ABI,
      functionName: "giveFeedback",
      args
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: Number(process.env.ADN_ERC8004_RECEIPT_TIMEOUT_MS || process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
    });
    return {
      ...base,
      status: "submitted",
      mode: settlementChain().network,
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
      mode: settlementChain().network,
      submitter,
      error: error.shortMessage || error.message
    };
  }
}

export function createErc8004FeedbackDescriptor({ requestId, serviceId, providerId, manifest, feedback, baseUrl = "" } = {}) {
  const chain = settlementChain();
  const identity = resolveErc8004AgentIdentity({ serviceId, manifest });
  const agentId = identity.agentId;
  const registry = reputationRegistryAddress();
  const endpoint = endpointFor(baseUrl, requestId);
  return {
    standard: "ERC-8004",
    registry_type: "reputation",
    event_type: "AgentRouterConsumerFeedback",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
    registry_address: registry || null,
    identity_registry_address: erc8004Registries().identityRegistry,
    validation_registry_address: erc8004Registries().validationRegistry,
    agent_id: agentId || null,
    agent_id_source: identity.source,
    function_name: "giveFeedback",
    value: feedbackValue(feedback),
    value_decimals: 2,
    tag1: "data_quality",
    tag2: "intent_fit",
    endpoint,
    feedback_uri: endpoint,
    feedback_hash: keccakHashJson({
      standard: "ERC-8004",
      request_id: requestId || null,
      service_id: serviceId || null,
      provider_id: providerId || null,
      feedback: feedback || null
    }),
    request_id: requestId || null,
    provider_id: providerId || null,
    service_hash: hashJson(serviceId || ""),
    provider_hash: hashJson(providerId || ""),
    created_at: new Date().toISOString()
  };
}

export async function verifyErc8004FeedbackTransaction({ txHash, expected = {}, publicClient } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) {
    throw erc8004VerificationError("ERC8004_INVALID_TX_HASH", "A valid transaction hash is required.");
  }
  const chain = settlementChain();
  const client = publicClient || createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) throw erc8004VerificationError("ERC8004_RECEIPT_NOT_FOUND", "The ERC-8004 transaction receipt was not found.");
  if (receipt.status !== "success") throw erc8004VerificationError("ERC8004_TRANSACTION_REVERTED", "The ERC-8004 transaction reverted.");
  const reportedChainId = await client.getChainId();
  if (Number(reportedChainId) !== Number(expected.chainId)) {
    throw erc8004VerificationError("ERC8004_CHAIN_MISMATCH", `Transaction is on chain ${reportedChainId}, expected ${expected.chainId}.`);
  }
  const transaction = await client.getTransaction({ hash: txHash }).catch(() => null);
  if (!transaction) throw erc8004VerificationError("ERC8004_TRANSACTION_NOT_FOUND", "The ERC-8004 transaction was not found.");
  if (transaction.chainId != null && Number(transaction.chainId) !== Number(expected.chainId)) {
    throw erc8004VerificationError("ERC8004_CHAIN_MISMATCH", `Transaction declares chain ${transaction.chainId}, expected ${expected.chainId}.`);
  }
  if (String(transaction.to || "").toLowerCase() !== String(expected.registryAddress || "").toLowerCase()) {
    throw erc8004VerificationError("ERC8004_REGISTRY_MISMATCH", "Transaction target is not the expected ERC-8004 Reputation Registry.");
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ERC8004_REPUTATION_ABI, data: transaction.input || transaction.data });
  } catch {
    throw erc8004VerificationError("ERC8004_CALL_INVALID", "Transaction does not contain a valid ERC-8004 Reputation call.");
  }
  if (decoded.functionName !== "giveFeedback") {
    throw erc8004VerificationError("ERC8004_CALL_INVALID", "Transaction did not call giveFeedback.");
  }
  if (String(decoded.args[0]) !== String(expected.agentId)) {
    throw erc8004VerificationError("ERC8004_AGENT_MISMATCH", "Transaction feedback targets a different agent.");
  }
  if (String(decoded.args[1]) !== String(expected.value) || Number(decoded.args[2]) !== Number(expected.valueDecimals)) {
    throw erc8004VerificationError("ERC8004_FEEDBACK_VALUE_MISMATCH", "Transaction feedback score does not match the recorded feedback.");
  }
  if (
    String(decoded.args[3]) !== String(expected.tag1) ||
    String(decoded.args[4]) !== String(expected.tag2) ||
    String(decoded.args[5]) !== String(expected.endpoint) ||
    String(decoded.args[6]) !== String(expected.feedbackUri)
  ) {
    throw erc8004VerificationError("ERC8004_FEEDBACK_METADATA_MISMATCH", "Transaction feedback metadata does not match the prepared call.");
  }
  if (String(decoded.args[7]).toLowerCase() !== String(expected.feedbackHash || "").toLowerCase()) {
    throw erc8004VerificationError("ERC8004_FEEDBACK_HASH_MISMATCH", "Transaction feedback hash does not match the recorded feedback.");
  }
  if (expected.submitter && String(transaction.from || "").toLowerCase() !== String(expected.submitter).toLowerCase()) {
    throw erc8004VerificationError("ERC8004_SUBMITTER_MISMATCH", "Transaction sender does not match the consumer wallet.");
  }
  return {
    standard: "ERC-8004",
    registry_type: "reputation",
    status: "submitted",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: Number(expected.chainId),
    registry_address: expected.registryAddress,
    agent_id: String(expected.agentId),
    feedback_hash: expected.feedbackHash,
    feedback_account: transaction.from || null,
    tx_hash: txHash,
    block_number: receipt.blockNumber?.toString?.() || null,
    explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}`,
    verified_at: new Date().toISOString()
  };
}

function erc8004VerificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
