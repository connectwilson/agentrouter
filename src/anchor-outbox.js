import crypto from "node:crypto";

import { hashJson } from "./evidence.js";
import {
  claimPersistentAnchorJob,
  enqueuePersistentAnchorJob,
  markPersistentAnchorAnchored,
  markPersistentAnchorRetry,
  markPersistentAnchorSubmitted,
  readPersistentAnchorJob,
  reservePersistentAnchorJobNonce
} from "./persistence.js";

const PROCESS_WORKER_ID = `anchor-${process.pid}-${crypto.randomUUID()}`;

export const persistentAnchorOutbox = {
  enqueue: enqueuePersistentAnchorJob,
  get: readPersistentAnchorJob,
  claim: claimPersistentAnchorJob,
  reserveNonce: reservePersistentAnchorJobNonce,
  markSubmitted: markPersistentAnchorSubmitted,
  markAnchored: markPersistentAnchorAnchored,
  markRetry: markPersistentAnchorRetry
};

// The outbox payload is intentionally an allow-list of public call data. The
// EOA key remains an environment secret and viem creates the signature only at
// broadcast time; neither can enter this object or the database row.
export function createAnchorOutboxJob({
  chainId,
  anchorAddress,
  contractAddress,
  functionName,
  requestId,
  callArgs
} = {}) {
  const normalizedFunction = String(functionName || "");
  if (!new Set(["anchorEvidence", "anchorFeedback"]).has(normalizedFunction)) {
    throw new Error("Unsupported evidence anchor function.");
  }
  const args = Array.isArray(callArgs) ? callArgs.map((value) => String(value)) : [];
  const expectedLength = normalizedFunction === "anchorEvidence" ? 8 : 4;
  if (args.length !== expectedLength) throw new Error("Evidence anchor call arguments are incomplete.");
  const identity = [
    String(chainId || ""),
    String(anchorAddress || "").toLowerCase(),
    String(contractAddress || "").toLowerCase(),
    normalizedFunction,
    args
  ];
  return {
    job_id: `anchor_${hashJson(identity).slice(2)}`,
    chain_id: String(chainId || ""),
    anchor_address: String(anchorAddress || "").toLowerCase(),
    contract_address: String(contractAddress || "").toLowerCase(),
    function_name: normalizedFunction,
    request_id: requestId ? String(requestId) : null,
    call_args: args
  };
}

export async function executeAnchorOutboxJob({
  job,
  outbox = persistentAnchorOutbox,
  clientFactory,
  account,
  chain,
  abi,
  receiptTimeoutMs,
  workerId = PROCESS_WORKER_ID,
  leaseMs = Math.max(30_000, Number(receiptTimeoutMs || 60_000) + 10_000),
  now = Date.now()
} = {}) {
  let queued;
  try {
    queued = await outbox.enqueue(job);
  } catch (error) {
    return degradedAnchor(job, error);
  }
  if (!queued) {
    return degradedAnchor(job, new Error("Durable evidence-anchor outbox is not configured."));
  }
  if (queued.status === "anchored") return completedAnchor(queued, { duplicate: true });

  let claimed;
  try {
    claimed = await outbox.claim({ jobId: job.job_id, workerId, leaseMs, now });
  } catch (error) {
    return pendingAnchor(queued, error);
  }
  if (!claimed) {
    const current = await safeGet(outbox, job.job_id, queued);
    if (current?.status === "anchored") return completedAnchor(current, { duplicate: true });
    return pendingAnchor(current || queued, new Error("Another anchor worker currently owns this durable job."));
  }

  let active = claimed;
  let txHash = active.tx_hash || null;
  try {
    const { walletClient, publicClient } = await clientFactory({ account, chain });
    if (!walletClient?.writeContract || !publicClient?.getTransactionCount || !publicClient?.waitForTransactionReceipt) {
      throw new Error("Evidence anchor clients are incomplete.");
    }

    if (active.reserved_nonce === null || active.reserved_nonce === undefined) {
      const pendingNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      const normalizedPending = BigInt(pendingNonce);
      if (normalizedPending < 0n) throw new Error("Evidence anchor RPC returned an invalid pending nonce.");
      active = await outbox.reserveNonce({
        jobId: job.job_id,
        workerId,
        chainId: job.chain_id,
        anchorAddress: job.anchor_address,
        pendingNonce: normalizedPending.toString()
      });
      if (!active?.reserved_nonce) throw new Error("Evidence anchor nonce reservation was not persisted.");
    }
    const nonce = BigInt(active.reserved_nonce);
    if (!txHash) {
      txHash = await walletClient.writeContract({
        address: job.contract_address,
        abi,
        functionName: job.function_name,
        args: job.call_args,
        nonce
      });
      active = await outbox.markSubmitted({ jobId: job.job_id, workerId, txHash });
      if (!active) throw new Error("Evidence anchor broadcast was not recorded in the durable outbox.");
    }
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: receiptTimeoutMs
    });
    if (receipt?.status !== "success" || receipt.blockNumber == null) {
      throw new Error(`Evidence anchor transaction ${txHash} has no confirmed successful receipt.`);
    }
    const anchored = await outbox.markAnchored({
      jobId: job.job_id,
      workerId,
      blockNumber: receipt?.blockNumber ?? 0
    });
    if (!anchored) throw new Error("Evidence anchor receipt was not committed to the durable outbox.");
    return completedAnchor(anchored);
  } catch (error) {
    let pending = active;
    try {
      pending = await outbox.markRetry({
        jobId: job.job_id,
        workerId,
        error: error.shortMessage || error.message,
        txHash,
        retryAt: new Date(now).toISOString()
      }) || active;
    } catch (persistenceError) {
      error = new Error(`${error.shortMessage || error.message}; durable retry update failed: ${persistenceError.message}`);
    }
    return pendingAnchor({ ...pending, tx_hash: pending?.tx_hash || txHash }, error);
  }
}

function completedAnchor(row, extra = {}) {
  return {
    status: "anchored",
    durable: true,
    retryable: false,
    outbox_job_id: row.job_id,
    transaction_nonce: row.reserved_nonce,
    tx_hash: row.tx_hash,
    block_number: row.block_number,
    ...extra
  };
}

function pendingAnchor(row, error) {
  return {
    status: "anchor_pending_retry",
    durable: true,
    retryable: true,
    outbox_job_id: row?.job_id || null,
    transaction_nonce: row?.reserved_nonce ?? null,
    tx_hash: row?.tx_hash || null,
    attempts: Number(row?.attempts || 0),
    error: error.shortMessage || error.message
  };
}

function degradedAnchor(job, error) {
  return {
    status: "anchor_degraded",
    durable: false,
    retryable: true,
    outbox_job_id: job?.job_id || null,
    error: error.shortMessage || error.message
  };
}

async function safeGet(outbox, jobId, fallback) {
  try {
    return typeof outbox.get === "function" ? await outbox.get(jobId) : fallback;
  } catch {
    return fallback;
  }
}
