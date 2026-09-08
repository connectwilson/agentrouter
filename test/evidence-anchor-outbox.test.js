import assert from "node:assert/strict";
import test from "node:test";

import { anchorConsumerFeedbackOnArc, anchorEvidenceOnArc, createAnchorClients } from "../src/arc-anchor.js";
import { keccak256 } from "viem";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const PRIVATE_KEY = `0x${"1".repeat(64)}`;
const TRACE_A = `0x${"a".repeat(64)}`;
const TRACE_B = `0x${"b".repeat(64)}`;

function withAnchorEnv(run) {
  const values = {
    ADN_SETTLEMENT_CHAIN: "bsc",
    ADN_SETTLEMENT_RPC_URL: "https://rpc.invalid",
    ADN_EVIDENCE_ANCHOR_MODE: undefined,
    ADN_EVIDENCE_ANCHOR_CONTRACT: CONTRACT,
    ADN_EVIDENCE_ANCHOR_PRIVATE_KEY: PRIVATE_KEY
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("two anchor instances sharing one EOA reserve different nonces", async () => {
  await withAnchorEnv(async () => {
    const outbox = createSharedOutbox();
    const writes = [];
    const clientFactory = () => ({
      publicClient: {
        getTransactionCount: async () => 41n,
        waitForTransactionReceipt: async ({ hash }) => ({ status: "success", blockNumber: BigInt(parseInt(hash.slice(-2), 16)) })
      },
      walletClient: {
        writeContract: async ({ nonce }) => {
          writes.push(nonce);
          await Promise.resolve();
          return txHash(Number(nonce));
        }
      }
    });

    const [first, second] = await Promise.all([
      anchorEvidenceOnArc(evidence("req_nonce_a", TRACE_A), { outbox, clientFactory, workerId: "instance-a" }),
      anchorConsumerFeedbackOnArc({
        requestId: "req_nonce_b",
        serviceId: "service_anchor_test",
        providerId: "provider_anchor_test",
        feedback: { useful: true }
      }, { outbox, clientFactory, workerId: "instance-b" })
    ]);

    assert.equal(first.status, "anchored");
    assert.equal(second.status, "anchored");
    assert.deepEqual(writes.map(String).sort(), ["41", "42"]);
    assert.equal(new Set(writes.map(String)).size, 2, "the shared EOA must never sign two different jobs at one nonce");
  });
});

test("a transient RPC failure leaves durable evidence pending and retries the reserved nonce", async () => {
  await withAnchorEnv(async () => {
    const outbox = createSharedOutbox();
    const attemptedNonces = [];
    let rpcAvailable = false;
    const clientFactory = () => ({
      publicClient: {
        getTransactionCount: async () => 7n,
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n })
      },
      walletClient: {
        writeContract: async ({ nonce }) => {
          attemptedNonces.push(nonce);
          if (!rpcAvailable) throw new Error("temporary RPC outage");
          return txHash(Number(nonce));
        }
      }
    });
    const input = evidence("req_retry", TRACE_A);

    const pending = await anchorEvidenceOnArc(input, { outbox, clientFactory, workerId: "instance-a" });
    assert.equal(pending.status, "anchor_pending_retry");
    assert.equal(pending.durable, true);
    assert.equal(pending.retryable, true);
    const queued = [...outbox.jobs.values()][0];
    assert.equal(queued.status, "pending");
    assert.equal(queued.reserved_nonce, "7");
    assert.match(queued.last_error, /temporary RPC outage/);
    assert.doesNotMatch(JSON.stringify(queued), new RegExp(PRIVATE_KEY.slice(2)), "outbox rows must not persist the EOA private key or a signature");

    rpcAvailable = true;
    const anchored = await anchorEvidenceOnArc(input, { outbox, clientFactory, workerId: "instance-b" });
    assert.equal(anchored.status, "anchored");
    assert.deepEqual(attemptedNonces.map(String), ["7", "7"], "retry must fill the already-reserved nonce rather than creating a gap");
    assert.equal(outbox.nextNonce, 8n, "a retry must not reserve a second nonce");
    assert.equal([...outbox.jobs.values()][0].status, "anchored");

    const duplicate = await anchorEvidenceOnArc(input, { outbox, clientFactory, workerId: "instance-c" });
    assert.equal(duplicate.status, "anchored");
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(attemptedNonces.map(String), ["7", "7"], "an already anchored job must never broadcast again");
  });
});

test("a durable-store outage fails closed before broadcast and reports degraded anchoring", async () => {
  await withAnchorEnv(async () => {
    let broadcast = false;
    const outbox = {
      enqueue: async () => { throw new Error("database unavailable"); }
    };
    const result = await anchorEvidenceOnArc(evidence("req_db_down", TRACE_A), {
      outbox,
      workerId: "instance-a",
      clientFactory: () => ({
        publicClient: { getTransactionCount: async () => 1n },
        walletClient: { writeContract: async () => { broadcast = true; return txHash(1); } }
      })
    });

    assert.equal(result.status, "anchor_degraded");
    assert.equal(result.durable, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /database unavailable/);
    assert.equal(broadcast, false, "an untracked transaction must not be signed or broadcast");
  });
});

test("a DB fault after broadcast retains the tx hash and never signs a second transaction", async () => {
  await withAnchorEnv(async () => {
    const durable = createSharedOutbox();
    let submissionStoreAvailable = false;
    const outbox = {
      ...durable,
      markSubmitted: async (args) => {
        if (!submissionStoreAvailable) throw new Error("submission update unavailable");
        return durable.markSubmitted(args);
      }
    };
    const writes = [];
    const clientFactory = () => ({
      publicClient: {
        getTransactionCount: async () => 13n,
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 99n })
      },
      walletClient: {
        writeContract: async ({ nonce }) => {
          writes.push(nonce);
          return txHash(Number(nonce));
        }
      }
    });
    const input = evidence("req_submit_db_fault", TRACE_B);

    const pending = await anchorEvidenceOnArc(input, { outbox, clientFactory, workerId: "instance-a" });
    assert.equal(pending.status, "anchor_pending_retry");
    assert.equal(pending.durable, true);
    assert.equal([...durable.jobs.values()][0].reserved_nonce, "13");
    assert.equal([...durable.jobs.values()][0].status, "pending");
    assert.equal([...durable.jobs.values()][0].tx_hash, txHash(13), "the broadcast hash must survive the failed submission-state update");

    submissionStoreAvailable = true;
    const anchored = await anchorEvidenceOnArc(input, { outbox, clientFactory, workerId: "instance-b" });
    assert.equal(anchored.status, "anchored");
    assert.deepEqual(writes.map(String), ["13"], "retry should confirm the known transaction instead of signing a replacement");
    assert.equal(durable.nextNonce, 14n);
  });
});

test("production sponsored adapter retains denied jobs, resumes without duplicate broadcasts, and never needs EOA balance", async () => {
  await withAnchorEnv(async () => {
    const outbox = createSharedOutbox();
    let allowed = false;
    let broadcasts = 0;
    const clientFactory = ({ account, chain }) => createAnchorClients({
      account, chain,
      publicClient: {
        getChainId: async () => 56,
        getTransactionCount: async () => 0,
        simulateContract: async () => ({}),
        estimateGas: async () => 80000n,
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 123n })
      },
      paymasterRpc: async (method, params) => {
        if (method === "pm_isSponsorable") return { sponsorable: allowed };
        broadcasts++;
        return keccak256(params[0]);
      }
    });
    const input = evidence("req_sponsored_retry", TRACE_A);
    const first = await anchorEvidenceOnArc(input, { outbox, clientFactory });
    assert.equal(first.status, "anchor_pending_retry");
    assert.match(first.error, /sponsorship denied/);
    assert.equal(broadcasts, 0);
    allowed = true;
    const second = await anchorEvidenceOnArc(input, { outbox, clientFactory });
    assert.equal(second.status, "anchored");
    const third = await anchorEvidenceOnArc(input, { outbox, clientFactory });
    assert.equal(third.duplicate, true);
    assert.equal(broadcasts, 1);
    assert.equal(outbox.nextNonce, 1n);
  });
});

for (const receipt of [undefined, {}, { status: "success" }, { status: "reverted", blockNumber: 123n }]) {
  test(`incomplete or reverted receipt cannot become anchored: ${JSON.stringify(receipt, (_,v)=>typeof v === "bigint" ? String(v) : v)}`, async () => {
    await withAnchorEnv(async () => {
      const result = await anchorEvidenceOnArc(evidence("req_bad_receipt", TRACE_A), {
        outbox: createSharedOutbox(),
        clientFactory: () => ({
          publicClient: { getTransactionCount: async () => 1, waitForTransactionReceipt: async () => receipt },
          walletClient: { writeContract: async () => txHash(1) }
        })
      });
      assert.equal(result.status, "anchor_pending_retry");
      assert.equal(result.tx_hash, txHash(1));
    });
  });
}

function evidence(requestId, traceHash) {
  return {
    request_id: requestId,
    trace_hash: traceHash,
    result_hash: `0x${"c".repeat(64)}`,
    verification_hash: `0x${"d".repeat(64)}`,
    service_id: "service_anchor_test",
    provider_id: "provider_anchor_test",
    payment_tx: `0x${"e".repeat(64)}`
  };
}

function txHash(nonce) {
  return `0x${Number(nonce).toString(16).padStart(64, "0")}`;
}

function createSharedOutbox() {
  const jobs = new Map();
  const outbox = {
    jobs,
    nextNonce: null,
    async enqueue(job) {
      if (!jobs.has(job.job_id)) jobs.set(job.job_id, { ...job, status: "pending", attempts: 0 });
      return { ...jobs.get(job.job_id) };
    },
    async get(jobId) {
      const row = jobs.get(jobId);
      return row ? { ...row } : null;
    },
    async claim({ jobId, workerId }) {
      const row = jobs.get(jobId);
      if (!row || row.status === "anchored" || (row.lease_owner && row.lease_owner !== workerId)) return null;
      row.lease_owner = workerId;
      row.status = "processing";
      row.attempts += 1;
      return { ...row };
    },
    async reserveNonce({ jobId, pendingNonce }) {
      const row = jobs.get(jobId);
      if (row.reserved_nonce != null) return { ...row };
      const pending = BigInt(pendingNonce);
      const allocated = outbox.nextNonce == null || outbox.nextNonce < pending ? pending : outbox.nextNonce;
      outbox.nextNonce = allocated + 1n;
      row.reserved_nonce = allocated.toString();
      return { ...row };
    },
    async markSubmitted({ jobId, txHash: hash }) {
      const row = jobs.get(jobId);
      row.tx_hash = hash;
      row.status = "submitted";
      return { ...row };
    },
    async markAnchored({ jobId, blockNumber }) {
      const row = jobs.get(jobId);
      row.status = "anchored";
      row.block_number = String(blockNumber);
      row.lease_owner = null;
      row.last_error = null;
      return { ...row };
    },
    async markRetry({ jobId, error, txHash: hash = null }) {
      const row = jobs.get(jobId);
      row.status = "pending";
      row.last_error = error;
      row.tx_hash ||= hash;
      row.lease_owner = null;
      return { ...row };
    }
  };
  return outbox;
}
