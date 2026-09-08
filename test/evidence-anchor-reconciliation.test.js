import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { createAnchorOutboxJob } from "../src/anchor-outbox.js";
import { hashJson } from "../src/evidence.js";

const TX = `0x${"a".repeat(64)}`;
const ADDRESS = `0x${"1".repeat(40)}`;
const CONTRACT = `0x${"2".repeat(40)}`;
function fixture(id = "req_pons") {
  const event = { request_id: id, service_id: "holders", provider_id: "nansen",
    trace_hash: hashJson("trace"), result_hash: hashJson("result"), verification_hash: hashJson("verified") };
  const job = { ...createAnchorOutboxJob({ chainId: 56, anchorAddress: ADDRESS, contractAddress: CONTRACT,
    functionName: "anchorEvidence", requestId: id, callArgs: [id, event.trace_hash, event.result_hash,
      event.verification_hash, hashJson(null), hashJson(event.service_id), hashJson(event.provider_id), hashJson("")] }),
    status: "anchored", tx_hash: TX, block_number: "120623869", reserved_nonce: "0" };
  event.arc_anchor = { status: "anchor_pending_retry", chain_id: 56, network: "bsc", tx_hash: null,
    outbox_job_id: job.job_id, anchor_account: ADDRESS, contract_address: CONTRACT };
  return { event, job };
}
async function request(events, readAnchorJobs, run) {
  const store = createMemoryStore();
  store.evidenceEvents = events;
  const server = createServer({ store, readAnchorJobs });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, store); } finally { await new Promise(resolve => server.close(resolve)); }
}

test("evidence GET reconciles completed durable jobs without rewriting historical events or signing again", async () => {
  const { event, job } = fixture();
  const before = structuredClone(event);
  const reads = [];
  await request([event], async ids => { reads.push(ids); return [job]; }, async base => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/agent-router/evidence?request_id=req_pons`);
      const body = await r.json();
      assert.equal(r.status, 200);
      assert.equal(body.events[0].arc_anchor.status, "anchored");
      assert.equal(body.events[0].arc_anchor.tx_hash, TX);
      assert.equal(body.events[0].arc_anchor.block_number, "120623869");
      assert.equal(body.events[0].arc_anchor.explorer_url, `https://bscscan.com/tx/${TX}`);
      assert.equal(body.events[0].arc_anchor.contract_address, CONTRACT);
      assert.equal(body.events[0].arc_anchor.anchor_account, undefined, "keep projection allowlisted");
      assert.deepEqual(event, before);
    }
    assert.deepEqual(reads, [[job.job_id], [job.job_id]]);
  });
});

for (const [name, mutate] of [
  ["pending", j => { j.status = "pending"; }],
  ["submitted without success", j => { j.status = "submitted"; }],
  ["missing hash", j => { j.tx_hash = null; }],
  ["invalid hash", j => { j.tx_hash = "secret"; }],
  ["missing block", j => { j.block_number = null; }],
  ["negative block", j => { j.block_number = "-1"; }],
  ["zero block", j => { j.block_number = "0"; }],
  ["wrong chain", j => { j.chain_id = "97"; }],
  ["wrong sender", j => { j.anchor_address = CONTRACT; }],
  ["wrong contract", j => { j.contract_address = ADDRESS; }],
  ["wrong function", j => { j.function_name = "anchorFeedback"; }],
  ["wrong request", j => { j.request_id = "different"; }],
  ["different evidence hash", j => { j.call_args[2] = hashJson("other"); }],
  ["different job id", j => { j.job_id = "other"; }]
]) test(`evidence GET never promotes ${name} to anchored`, async () => {
  const { event, job } = fixture(); mutate(job);
  await request([event], async () => [job], async base => {
    const body = await (await fetch(`${base}/agent-router/evidence`)).json();
    assert.equal(body.events[0].arc_anchor.status, "anchor_pending_retry");
    assert.equal(body.events[0].arc_anchor.tx_hash, null);
  });
});

test("missing rows and unavailable persistence preserve evidence without leaking errors", async () => {
  for (const read of [async () => [], async () => { throw Error("postgres://secret"); }]) {
    await request([fixture().event], read, async base => {
      const r = await fetch(`${base}/agent-router/evidence`);
      const b = await r.json();
      assert.equal(r.status, 200);
      assert.equal(b.events[0].arc_anchor.status, "anchor_pending_retry");
      assert.doesNotMatch(JSON.stringify(b), /postgres|secret/);
    });
  }
});

test("reconciliation filters before bulk lookup and reflects another instance completing the job", async () => {
  const a = fixture("a"), b = fixture("b"); let ready = false;
  await request([a.event, b.event], async ids => {
    assert.deepEqual(ids, [a.job.job_id]);
    return [{ ...a.job, status: ready ? "anchored" : "pending" }];
  }, async base => {
    assert.equal((await (await fetch(`${base}/agent-router/evidence?request_id=a`)).json()).events[0].arc_anchor.status, "anchor_pending_retry");
    ready = true;
    const result = await (await fetch(`${base}/agent-router/evidence?request_id=a`)).json();
    assert.equal(result.count, 1);
    assert.equal(result.events[0].arc_anchor.status, "anchored");
  });
});

test("reconciliation does not attach a matching outbox id to altered evidence", async () => {
  const { event, job } = fixture(); event.provider_id = "another_vendor";
  await request([event], async () => [job], async base => {
    const result = await (await fetch(`${base}/agent-router/evidence`)).json();
    assert.equal(result.events[0].arc_anchor.status, "anchor_pending_retry");
  });
});
