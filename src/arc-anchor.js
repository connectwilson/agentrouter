import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, isEvmAddress } from "./arc-payment.js";
import { hashJson } from "./evidence.js";

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

export function arcAnchorConfigured() {
  return Boolean(process.env.ADN_ARC_ANCHOR_CONTRACT && process.env.ADN_ARC_ANCHOR_PRIVATE_KEY);
}

export function createUnconfiguredArcAnchor(evidence = {}) {
  return {
    anchor_version: "agent_router_arc_anchor_v1",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    status: "not_configured",
    event_type: "AgentRouterEvidence",
    storage_model: "full_evidence_offchain_hashes_on_arc",
    trace_hash: evidence.trace_hash || null,
    result_hash: evidence.result_hash || null,
    verification_hash: evidence.verification_hash || null,
    request_id: evidence.request_id || null,
    contract_address: process.env.ADN_ARC_ANCHOR_CONTRACT || null,
    created_at: new Date().toISOString()
  };
}

export async function anchorEvidenceOnArc(evidence = {}) {
  if (process.env.ADN_ARC_ANCHOR_MODE === "mock") {
    return {
      ...baseAnchor(evidence),
      status: "anchored",
      mode: "mock",
      tx_hash: `0x${"b".repeat(64)}`,
      block_number: "0",
      contract_address: process.env.ADN_ARC_ANCHOR_CONTRACT || `0x${"c".repeat(40)}`,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"b".repeat(64)}`
    };
  }
  if (!arcAnchorConfigured()) {
    return createUnconfiguredArcAnchor(evidence);
  }
  const contractAddress = process.env.ADN_ARC_ANCHOR_CONTRACT;
  if (!isEvmAddress(contractAddress)) {
    return {
      ...createUnconfiguredArcAnchor(evidence),
      status: "invalid_config",
      error: "ADN_ARC_ANCHOR_CONTRACT must be a valid EVM address."
    };
  }
  try {
    const account = privateKeyToAccount(normalizePrivateKey(process.env.ADN_ARC_ANCHOR_PRIVATE_KEY));
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
      timeout: Number(process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
    });
    return {
      ...baseAnchor(evidence),
      status: "anchored",
      mode: "arc_testnet",
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
      mode: "arc_testnet",
      contract_address: contractAddress,
      error: error.shortMessage || error.message
    };
  }
}

export async function anchorConsumerFeedbackOnArc({ requestId, serviceId, providerId, feedback } = {}) {
  const feedbackHashValue = hashJson(feedback || null);
  const base = {
    anchor_version: "agent_router_feedback_arc_anchor_v1",
    network: ARC_TESTNET.network,
    caip2: ARC_TESTNET.caip2,
    chain_id: ARC_TESTNET.id,
    event_type: "AgentRouterFeedback",
    storage_model: "full_feedback_offchain_hash_on_arc",
    request_id: requestId || null,
    feedback_hash: feedbackHashValue,
    service_hash: hashJson(serviceId || ""),
    provider_hash: hashJson(providerId || ""),
    created_at: new Date().toISOString()
  };
  if (process.env.ADN_ARC_ANCHOR_MODE === "mock") {
    return {
      ...base,
      status: "anchored",
      mode: "mock",
      tx_hash: `0x${"d".repeat(64)}`,
      block_number: "0",
      contract_address: process.env.ADN_ARC_ANCHOR_CONTRACT || `0x${"c".repeat(40)}`,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"d".repeat(64)}`
    };
  }
  if (!arcAnchorConfigured()) {
    return {
      ...base,
      status: "not_configured",
      contract_address: process.env.ADN_ARC_ANCHOR_CONTRACT || null
    };
  }
  const contractAddress = process.env.ADN_ARC_ANCHOR_CONTRACT;
  if (!isEvmAddress(contractAddress)) {
    return {
      ...base,
      status: "invalid_config",
      contract_address: contractAddress || null,
      error: "ADN_ARC_ANCHOR_CONTRACT must be a valid EVM address."
    };
  }
  try {
    const account = privateKeyToAccount(normalizePrivateKey(process.env.ADN_ARC_ANCHOR_PRIVATE_KEY));
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
      timeout: Number(process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
    });
    return {
      ...base,
      status: "anchored",
      mode: "arc_testnet",
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
      mode: "arc_testnet",
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
    storage_model: "full_evidence_offchain_hashes_on_arc",
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
