import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, isEvmAddress } from "./arc-payment.js";
import { hashJson } from "./evidence.js";
import { settlementChain } from "./chains.js";

export const AGENT_ROUTER_EVIDENCE_ANCHOR_ABI = [
  {
    type: "function",
    name: "anchorEvidence",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "string" },
      { name: "traceHash", type: "bytes32" },
      { name: "resultHash", type: "bytes32" },
      { name: "verificationHash", type: "bytes32" },
      { name: "feedbackHash", type: "bytes32" },
      { name: "serviceHash", type: "bytes32" },
      { name: "providerHash", type: "bytes32" },
      { name: "paymentTxHash", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "anchorFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
      { name: "serviceHash", type: "bytes32" },
      { name: "providerHash", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "event",
    name: "EvidenceAnchored",
    inputs: [
      { name: "requestId", type: "string", indexed: false },
      { name: "traceHash", type: "bytes32", indexed: true },
      { name: "resultHash", type: "bytes32", indexed: true },
      { name: "verificationHash", type: "bytes32", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
      { name: "serviceHash", type: "bytes32", indexed: true },
      { name: "providerHash", type: "bytes32", indexed: false },
      { name: "paymentTxHash", type: "bytes32", indexed: false },
      { name: "anchor", type: "address", indexed: false },
      { name: "createdAt", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "FeedbackAnchored",
    inputs: [
      { name: "requestId", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: true },
      { name: "serviceHash", type: "bytes32", indexed: true },
      { name: "providerHash", type: "bytes32", indexed: false },
      { name: "anchor", type: "address", indexed: false },
      { name: "createdAt", type: "uint256", indexed: false }
    ]
  }
];

export function evidenceAnchorConfig(env = process.env) {
  return {
    contractAddress: env.ADN_EVIDENCE_ANCHOR_CONTRACT || env.ADN_ARC_ANCHOR_CONTRACT || "",
    privateKey: env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY || env.ADN_ARC_ANCHOR_PRIVATE_KEY || "",
    mode: env.ADN_EVIDENCE_ANCHOR_MODE || env.ADN_ARC_ANCHOR_MODE || "",
    receiptTimeoutMs: Number(env.ADN_EVIDENCE_ANCHOR_RECEIPT_TIMEOUT_MS || env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
  };
}

export function arcAnchorConfigured() {
  const config = evidenceAnchorConfig();
  return Boolean(config.contractAddress && config.privateKey);
}

export async function assertEvidenceAnchorReady({ fetchImpl = globalThis.fetch } = {}) {
  const config = evidenceAnchorConfig();
  if (!config.contractAddress && !config.privateKey) return { ok: true, skipped: true, reason: "not_configured" };
  if (!config.contractAddress || !config.privateKey) {
    throw anchorConfigError("EVIDENCE_ANCHOR_INCOMPLETE", "Evidence anchor contract and private key must be configured together.");
  }
  if (!isEvmAddress(config.contractAddress)) {
    throw anchorConfigError("EVIDENCE_ANCHOR_INVALID_ADDRESS", "Evidence anchor contract must be a valid EVM address.");
  }
  const chain = settlementChain();
  const rpc = async (method, params) => {
    const response = await fetchImpl(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`${method} failed: ${payload.error.message}`);
    return payload.result;
  };
  const reportedChainId = Number(await rpc("eth_chainId", []));
  if (reportedChainId !== chain.id) {
    throw anchorConfigError(
      "EVIDENCE_ANCHOR_CHAIN_MISMATCH",
      `Evidence anchor RPC reports chain ${reportedChainId}, expected ${chain.id}.`
    );
  }
  const code = await rpc("eth_getCode", [config.contractAddress, "latest"]);
  if (!code || code === "0x") {
    throw anchorConfigError(
      "EVIDENCE_ANCHOR_NOT_DEPLOYED",
      `No evidence anchor contract is deployed at ${config.contractAddress} on ${chain.network}.`
    );
  }
  return { ok: true, chain: chain.network, chain_id: chain.id, contract_address: config.contractAddress };
}

export function createUnconfiguredArcAnchor(evidence = {}) {
  const config = evidenceAnchorConfig();
  return {
    anchor_version: "agent_router_arc_anchor_v1",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    status: "not_configured",
    event_type: "AgentRouterEvidence",
    storage_model: "full_evidence_offchain_hashes_onchain",
    trace_hash: evidence.trace_hash || null,
    result_hash: evidence.result_hash || null,
    verification_hash: evidence.verification_hash || null,
    request_id: evidence.request_id || null,
    contract_address: config.contractAddress || null,
    created_at: new Date().toISOString()
  };
}

export async function anchorEvidenceOnArc(evidence = {}) {
  const config = evidenceAnchorConfig();
  if (config.mode === "mock") {
    return {
      ...baseAnchor(evidence),
      status: "anchored",
      mode: "mock",
      tx_hash: `0x${"b".repeat(64)}`,
      block_number: "0",
      contract_address: config.contractAddress || `0x${"c".repeat(40)}`,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"b".repeat(64)}`
    };
  }
  if (!arcAnchorConfigured()) {
    return createUnconfiguredArcAnchor(evidence);
  }
  const contractAddress = config.contractAddress;
  if (!isEvmAddress(contractAddress)) {
    return {
      ...createUnconfiguredArcAnchor(evidence),
      status: "invalid_config",
      error: "ADN_EVIDENCE_ANCHOR_CONTRACT must be a valid EVM address."
    };
  }
  try {
    const account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
    const client = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const txHash = await client.writeContract({
      address: contractAddress,
      abi: AGENT_ROUTER_EVIDENCE_ANCHOR_ABI,
      functionName: "anchorEvidence",
      args: [
        String(evidence.request_id || ""),
        bytes32(evidence.trace_hash),
        bytes32(evidence.result_hash),
        bytes32(evidence.verification_hash),
        feedbackHash(evidence),
        hashJson(evidence.service_id || ""),
        hashJson(evidence.provider_id || ""),
        paymentHash(evidence)
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: config.receiptTimeoutMs
    });
    return {
      ...baseAnchor(evidence),
      status: "anchored",
      mode: settlementChain().network,
      tx_hash: txHash,
      block_number: receipt.blockNumber?.toString?.(),
      contract_address: contractAddress,
      anchor_account: account.address,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
    };
  } catch (error) {
    return {
      ...baseAnchor(evidence),
      status: "anchor_failed",
      mode: settlementChain().network,
      contract_address: contractAddress,
      error: error.shortMessage || error.message
    };
  }
}

export async function anchorConsumerFeedbackOnArc({ requestId, serviceId, providerId, feedback } = {}) {
  const config = evidenceAnchorConfig();
  const feedbackHashValue = hashJson(feedback || null);
  const base = {
    anchor_version: "agent_router_feedback_arc_anchor_v1",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    event_type: "AgentRouterFeedback",
    storage_model: "full_feedback_offchain_hash_onchain",
    request_id: requestId || null,
    feedback_hash: feedbackHashValue,
    service_hash: hashJson(serviceId || ""),
    provider_hash: hashJson(providerId || ""),
    created_at: new Date().toISOString()
  };
  if (config.mode === "mock") {
    return {
      ...base,
      status: "anchored",
      mode: "mock",
      tx_hash: `0x${"d".repeat(64)}`,
      block_number: "0",
      contract_address: config.contractAddress || `0x${"c".repeat(40)}`,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"d".repeat(64)}`
    };
  }
  if (!arcAnchorConfigured()) {
    return {
      ...base,
      status: "not_configured",
      contract_address: config.contractAddress || null
    };
  }
  const contractAddress = config.contractAddress;
  if (!isEvmAddress(contractAddress)) {
    return {
      ...base,
      status: "invalid_config",
      contract_address: contractAddress || null,
      error: "ADN_EVIDENCE_ANCHOR_CONTRACT must be a valid EVM address."
    };
  }
  try {
    const account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
    const client = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: http(ARC_TESTNET.rpcUrls.default.http[0])
    });
    const txHash = await client.writeContract({
      address: contractAddress,
      abi: AGENT_ROUTER_EVIDENCE_ANCHOR_ABI,
      functionName: "anchorFeedback",
      args: [
        String(requestId || ""),
        feedbackHashValue,
        hashJson(serviceId || ""),
        hashJson(providerId || "")
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: config.receiptTimeoutMs
    });
    return {
      ...base,
      status: "anchored",
      mode: settlementChain().network,
      tx_hash: txHash,
      block_number: receipt.blockNumber?.toString?.(),
      contract_address: contractAddress,
      anchor_account: account.address,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
    };
  } catch (error) {
    return {
      ...base,
      status: "anchor_failed",
      mode: settlementChain().network,
      contract_address: contractAddress,
      error: error.shortMessage || error.message
    };
  }
}

function baseAnchor(evidence) {
  return {
    anchor_version: "agent_router_arc_anchor_v1",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    event_type: "AgentRouterEvidence",
    storage_model: "full_evidence_offchain_hashes_onchain",
    request_id: evidence.request_id || null,
    trace_hash: evidence.trace_hash || null,
    result_hash: evidence.result_hash || null,
    verification_hash: evidence.verification_hash || null,
    service_hash: hashJson(evidence.service_id || ""),
    provider_hash: hashJson(evidence.provider_id || ""),
    payment_tx_hash: paymentHash(evidence),
    created_at: new Date().toISOString()
  };
}

function anchorConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bytes32(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || "")) ? value : hashJson(value || "");
}

function feedbackHash(evidence) {
  return evidence.payment?.settlement_receipt
    ? hashJson(evidence.payment.settlement_receipt)
    : hashJson(null);
}

function paymentHash(evidence) {
  const paymentTx = evidence.payment_tx || evidence.payment?.payment_tx || "";
  return /^0x[0-9a-fA-F]{64}$/.test(String(paymentTx)) ? paymentTx : hashJson(paymentTx);
}

function normalizePrivateKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}
