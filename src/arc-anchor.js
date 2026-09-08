import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isEvmAddress } from "./arc-payment.js";
import { hashJson } from "./evidence.js";
import { settlementChain, SETTLEMENT_CHAINS } from "./chains.js";
import { readPersistentAnchorJobs } from "./persistence.js";
import { createAnchorOutboxJob, executeAnchorOutboxJob, persistentAnchorOutbox } from "./anchor-outbox.js";
import { createSponsoredAnchorWallet } from "./bsc-anchor-paymaster.js";

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
  const chain = settlementChain();
  return {
    anchor_version: "agent_router_arc_anchor_v1",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
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

export async function anchorEvidenceOnArc(evidence = {}, {
  outbox = persistentAnchorOutbox,
  clientFactory = createAnchorClients,
  workerId
} = {}) {
  const config = evidenceAnchorConfig();
  const chain = settlementChain();
  if (config.mode === "mock") {
    return {
      ...baseAnchor(evidence),
      status: "anchored",
      mode: "mock",
      tx_hash: `0x${"b".repeat(64)}`,
      block_number: "0",
      contract_address: config.contractAddress || `0x${"c".repeat(40)}`,
      explorer_url: `${chain.blockExplorers.default.url}/tx/0x${"b".repeat(64)}`
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
  let account;
  try {
    account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
  } catch (error) {
    return anchorConfigFailure(baseAnchor(evidence), chain, contractAddress, error);
  }
  const args = evidenceAnchorArgs(evidence);
  const job = createAnchorOutboxJob({
    chainId: chain.id,
    anchorAddress: account.address,
    contractAddress,
    functionName: "anchorEvidence",
    requestId: evidence.request_id,
    callArgs: args
  });
  const execution = await executeAnchorOutboxJob({
    job,
    outbox,
    clientFactory,
    account,
    chain,
    abi: AGENT_ROUTER_EVIDENCE_ANCHOR_ABI,
    receiptTimeoutMs: config.receiptTimeoutMs,
    workerId
  });
  return anchorExecutionResult(baseAnchor(evidence), execution, { chain, contractAddress, account });
}

export async function anchorConsumerFeedbackOnArc({ requestId, serviceId, providerId, feedback } = {}, {
  outbox = persistentAnchorOutbox,
  clientFactory = createAnchorClients,
  workerId
} = {}) {
  const config = evidenceAnchorConfig();
  const chain = settlementChain();
  const feedbackHashValue = hashJson(feedback || null);
  const base = {
    anchor_version: "agent_router_feedback_arc_anchor_v1",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
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
      explorer_url: `${chain.blockExplorers.default.url}/tx/0x${"d".repeat(64)}`
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
  let account;
  try {
    account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
  } catch (error) {
    return anchorConfigFailure(base, chain, contractAddress, error);
  }
  const args = [
    String(requestId || ""),
    feedbackHashValue,
    hashJson(serviceId || ""),
    hashJson(providerId || "")
  ];
  const job = createAnchorOutboxJob({
    chainId: chain.id,
    anchorAddress: account.address,
    contractAddress,
    functionName: "anchorFeedback",
    requestId,
    callArgs: args
  });
  const execution = await executeAnchorOutboxJob({
    job,
    outbox,
    clientFactory,
    account,
    chain,
    abi: AGENT_ROUTER_EVIDENCE_ANCHOR_ABI,
    receiptTimeoutMs: config.receiptTimeoutMs,
    workerId
  });
  return anchorExecutionResult(base, execution, { chain, contractAddress, account });
}

export function createAnchorClients({ account, chain, publicClient: suppliedClient, paymasterRpc }) {
  const publicClient = suppliedClient || createPublicClient({ chain, transport: http(chain.rpcUrl) });
  return {
    walletClient: [56, 97].includes(chain.id)
      ? createSponsoredAnchorWallet({ account, chain, publicClient, paymasterRpc })
      : createWalletClient({
      account,
      chain,
      transport: http(chain.rpcUrl)
    }),
    publicClient
  };
}

// A retry finishes independently of the historical execution snapshot. Join
// that snapshot to its exact durable job at read time, without mutating either
// record or causing another transaction. Hash binding prevents cross-call,
// cross-provider and cross-chain attribution of a successful receipt.
export async function refreshEvidenceAnchors(events, readJobs = readPersistentAnchorJobs) {
  const expected = new Map();
  for (const event of events) {
    const anchor = event.arc_anchor;
    if (!anchor?.outbox_job_id || anchor.mode === "mock" || !SETTLEMENT_CHAINS.includes(anchor.network)) continue;
    if (settlementChain(anchor.network).id !== Number(anchor.chain_id)) continue;
    if (!isEvmAddress(anchor.anchor_account) || !isEvmAddress(anchor.contract_address)) continue;
    const job = createAnchorOutboxJob({ chainId: anchor.chain_id, anchorAddress: anchor.anchor_account,
      contractAddress: anchor.contract_address, functionName: "anchorEvidence",
      requestId: event.request_id, callArgs: evidenceAnchorArgs(event) });
    if (job.job_id === anchor.outbox_job_id) expected.set(event, job);
  }
  const ids = [...new Set([...expected.values()].map(job => job.job_id))];
  if (!ids.length) return events;
  const completed = new Map();
  try {
    for (let i = 0; i < ids.length; i += 200) {
      for (const row of await readJobs(ids.slice(i, i + 200))) {
        if (row.status !== "anchored" || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash || "")
          || !/^[1-9]\d*$/.test(String(row.block_number ?? ""))) continue;
        // Recompute even the persisted job ID rather than trusting a returned
        // row merely because it claims to have the requested ID.
        const identity = createAnchorOutboxJob({ chainId: row.chain_id, anchorAddress: row.anchor_address,
          contractAddress: row.contract_address, functionName: row.function_name,
          requestId: row.request_id, callArgs: row.call_args });
        if (identity.job_id === row.job_id) completed.set(row.job_id, row);
      }
    }
  } catch { return events; } // Keep historical evidence available; never leak DB errors.
  return events.map(event => {
    const wanted = expected.get(event);
    const job = wanted && completed.get(wanted.job_id);
    if (!job || job.request_id !== event.request_id) return event;
    const chain = settlementChain(event.arc_anchor.network);
    return { ...event, arc_anchor: { ...event.arc_anchor, status: "anchored", retryable: false,
      tx_hash: job.tx_hash, block_number: String(job.block_number),
      explorer_url: `${chain.blockExplorers.default.url}/tx/${job.tx_hash}` } };
  });
}

function evidenceAnchorArgs(evidence) {
  return [String(evidence.request_id || ""), bytes32(evidence.trace_hash), bytes32(evidence.result_hash),
    bytes32(evidence.verification_hash), feedbackHash(evidence), hashJson(evidence.service_id || ""),
    hashJson(evidence.provider_id || ""), paymentHash(evidence)];
}

function anchorExecutionResult(base, execution, { chain, contractAddress, account }) {
  const txHash = execution.tx_hash || null;
  return {
    ...base,
    ...execution,
    mode: chain.network,
    contract_address: contractAddress,
    anchor_account: account.address,
    ...(txHash && chain.blockExplorers?.default?.url
      ? { explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}` }
      : {})
  };
}

function anchorConfigFailure(base, chain, contractAddress, error) {
  return {
    ...base,
    status: "anchor_degraded",
    durable: false,
    retryable: false,
    mode: chain.network,
    contract_address: contractAddress,
    error: error.shortMessage || error.message
  };
}

function baseAnchor(evidence) {
  const chain = settlementChain();
  return {
    anchor_version: "agent_router_arc_anchor_v1",
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
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
