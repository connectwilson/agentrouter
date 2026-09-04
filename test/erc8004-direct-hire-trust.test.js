import test from "node:test";
import assert from "node:assert/strict";

import { createDevSession } from "../src/auth.js";
import { verifyErc8004Agent } from "../src/erc8004-discovery.js";
import { executeErc8004HireOnce } from "../src/erc8004-hire.js";
import { hydrateServiceEventRows } from "../src/registry.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function withServer(options, run) {
  const server = createServer(options);
  const baseUrl = await listen(server);
  try {
    return await run({ baseUrl, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function signedInFixture({ policy = readOnlyPolicy() } = {}) {
  const store = createMemoryStore();
  const session = createDevSession(store, "http://127.0.0.1");
  store.erc8004Imports.set("56:42", {
    chain_id: 56,
    agent_id: "42",
    name: "Read-only Risk Agent",
    callable: true,
    verification_state: "verified_callable",
    preferred_adapter: "http",
    verified_at: new Date().toISOString(),
    execution_policy: policy,
    protocols: {
      mcp: { status: "not_declared", endpoint: null },
      a2a: { status: "not_declared", endpoint: null },
      http: { status: "verified", endpoint: "https://1.1.1.1/query" },
      x402: { status: "not_declared", endpoint: null }
    }
  });
  return {
    store,
    headers: {
      cookie: session.cookie.split(";")[0],
      "content-type": "application/json"
    }
  };
}

function readOnlyPolicy(overrides = {}) {
  return {
    policy_version: "agent_router_erc8004_execution_policy_v1",
    access: "read_only",
    allowed_capabilities: ["account_health"],
    ...overrides
  };
}

function createSharedHirePersistence() {
  const claims = new Map();
  const events = [];
  let completionFailures = 0;
  return {
    claims,
    events,
    failNextCompletion() {
      completionFailures += 1;
    },
    async claim(input) {
      const existing = claims.get(input.claim_key);
      if (existing) {
        const completion = [...events].reverse().find((entry) =>
          entry.eventType === "erc8004_hire_completion" &&
          entry.requestId === existing.request_id &&
          entry.serviceId === existing.service_id &&
          entry.event?.claim_key === input.claim_key &&
          entry.event?.request_hash === input.request_hash
        );
        if (existing.status !== "completed" && completion?.event?.response_bundle) {
          Object.assign(existing, {
            status: "completed",
            response: structuredClone(completion.event.response_bundle),
            error: null
          });
        }
        return { claimed: false, record: structuredClone(existing) };
      }
      const record = { ...structuredClone(input), status: "in_progress", response: null };
      claims.set(input.claim_key, record);
      return { claimed: true, record: structuredClone(record) };
    },
    async complete(input) {
      if (completionFailures > 0) {
        completionFailures -= 1;
        throw new Error("simulated idempotency completion outage");
      }
      const record = claims.get(input.claim_key);
      Object.assign(record, { status: "completed", response: structuredClone(input.response) });
      return structuredClone(record);
    },
    async fail(input) {
      const record = claims.get(input.claim_key);
      if (record) Object.assign(record, { status: "failed", error: String(input.error || "") });
      return record ? structuredClone(record) : null;
    },
    async writeEvent(entry) {
      events.push(structuredClone(entry));
      return true;
    }
  };
}

test("endpoint verification carries the on-chain metadata execution policy into the durable import", async () => {
  const policy = readOnlyPolicy();
  const verified = await verifyErc8004Agent({
    chain_id: 56,
    token_id: "42",
    metadata: {
      services: [{ name: "HTTP", endpoint: "https://1.1.1.1/query" }],
      execution_policy: policy
    }
  }, {
    endpointProbe: async () => ({ ok: true })
  });
  assert.deepEqual(verified.execution_policy, policy);
});

async function hire(baseUrl, headers, {
  idempotencyKey = "hire-account-health-1",
  input = { account: "0xabc" },
  capability = "account_health"
} = {}) {
  return fetch(`${baseUrl}/agent-router/erc8004/hire`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      agent_id: "42",
      execute: true,
      capability,
      input
    })
  });
}

async function submitFeedback(baseUrl, payload) {
  return fetch(`${baseUrl}/agent-router/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service_id: payload.consumer_feedback_request.service_id,
      request_id: payload.request_id,
      feedback_token: payload.consumer_feedback_request.feedback_token,
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        reason: "The response directly answered the account-health request."
      }
    })
  });
}

test("successful ERC-8004 direct hire durably records invocation/evidence and returns a usable feedback grant", async () => {
  const previousChain = process.env.ADN_SETTLEMENT_CHAIN;
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  const { store, headers } = signedInFixture();
  const persistence = createSharedHirePersistence();

  try {
    await withServer({
      store,
      erc8004Executor: async () => ({ answer: "healthy", health_factor: 1.82 }),
      erc8004HirePersistence: persistence
    }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, headers);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, "completed");
    assert.match(payload.request_id, /^erc8004_/);
    assert.equal(payload.evidence.request_id, payload.request_id);
    assert.equal(payload.evidence.agent_identity.agent_id, "42");
    assert.match(payload.evidence.trace_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(payload.consumer_feedback_request.request_id, payload.request_id);
    assert.ok(payload.consumer_feedback_request.feedback_token);
    assert.equal(payload.judge_summary.summary_version, "agent_router_bnb_hire_summary_v1");
    assert.equal(payload.judge_summary.selected_agent.agent_id, "42");
    assert.equal(payload.judge_summary.agent_identity.agent_id, "42");
    assert.equal(payload.judge_summary.capability, "account_health");
    assert.equal(payload.judge_summary.feedback.status, "consumer_feedback_requested");
    assert.equal(payload.judge_summary.feedback_status, "consumer_feedback_requested");
    assert.equal(payload.judge_summary.evidence.trace_hash, payload.evidence.trace_hash);

    assert.equal(store.evidenceEvents.some((event) => event.request_id === payload.request_id), true);
    assert.equal(store.feedbackEvents.some((event) => event.request_id === payload.request_id), true);
    assert.equal(store.feedbackGrants.has(payload.request_id), true);
    assert.deepEqual(
      persistence.events.map((entry) => entry.eventType),
      ["erc8004_hire_invocation", "evidence", "invocation_feedback_grant", "erc8004_hire_completion"]
    );

    const feedback = await submitFeedback(baseUrl, payload);
    const feedbackPayload = await feedback.json();
    assert.equal(feedback.status, 200);
    assert.equal(feedbackPayload.status, "consumer_feedback_recorded");
    assert.equal(feedbackPayload.erc8004.agent_id, "42");

    const hydrated = createMemoryStore();
    await hydrateServiceEventRows(hydrated, persistence.events.map((entry, index) => ({
      event_id: index + 1,
      event_type: entry.eventType,
      service_id: entry.serviceId,
      request_id: entry.requestId,
      event: entry.event
    })));
    assert.equal(hydrated.evidenceEvents.some((event) => event.request_id === payload.request_id), true);
    assert.equal(hydrated.feedbackEvents.some((event) => event.request_id === payload.request_id), true);
    assert.equal(hydrated.feedbackGrants.has(payload.request_id), true);
    });
  } finally {
    if (previousChain === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previousChain;
  }
});

test("direct-hire consumer feedback can attach its submitted ERC-8004 transaction without a registry service record", async () => {
  const previousChain = process.env.ADN_SETTLEMENT_CHAIN;
  const previousMode = process.env.ADN_ERC8004_MODE;
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  process.env.ADN_ERC8004_MODE = "mock";
  const { store, headers } = signedInFixture();
  const persistence = createSharedHirePersistence();

  try {
    await withServer({
      store,
      erc8004HirePersistence: persistence,
      erc8004Executor: async () => ({ answer: "healthy" })
    }, async ({ baseUrl }) => {
      const hirePayload = await (await hire(baseUrl, headers, { idempotencyKey: "direct-hire-onchain-feedback" })).json();
      const feedbackResponse = await submitFeedback(baseUrl, hirePayload);
      const feedbackPayload = await feedbackResponse.json();
      assert.equal(feedbackResponse.status, 200);
      assert.equal(feedbackPayload.erc8004.status, "consumer_submission_required");

      const attached = await fetch(`${baseUrl}/agent-router/feedback/erc8004`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          service_id: hirePayload.consumer_feedback_request.service_id,
          request_id: hirePayload.request_id,
          erc8004: {
            ...feedbackPayload.erc8004,
            status: "submitted",
            mode: "mock",
            tx_hash: `0x${"1".repeat(64)}`,
            block_number: "123"
          }
        })
      });
      const attachedPayload = await attached.json();

      assert.equal(attached.status, 200);
      assert.equal(attachedPayload.status, "erc8004_feedback_attached");
      assert.equal(attachedPayload.trust_anchor.state, "onchain_submitted");
      const consumerEvent = [...store.feedbackEvents].reverse().find((event) =>
        event.request_id === hirePayload.request_id && event.event_version === "agent_consumer_feedback_v1"
      );
      assert.equal(consumerEvent?.erc8004?.tx_hash, `0x${"1".repeat(64)}`);
    });
  } finally {
    if (previousChain === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previousChain;
    if (previousMode === undefined) delete process.env.ADN_ERC8004_MODE;
    else process.env.ADN_ERC8004_MODE = previousMode;
  }
});

test("same-process completed replay rotates its direct-hire feedback grant without re-executing", async () => {
  const { store, headers } = signedInFixture();
  const persistence = createSharedHirePersistence();
  let executions = 0;

  await withServer({
    store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    const first = await (await hire(baseUrl, headers, { idempotencyKey: "expired-grant-replay" })).json();

    const replayResponse = await hire(baseUrl, headers, { idempotencyKey: "expired-grant-replay" });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(executions, 1);
    assert.equal(replay.request_id, first.request_id);
    assert.notEqual(replay.consumer_feedback_request.feedback_token, first.consumer_feedback_request.feedback_token);

    const staleFeedback = await submitFeedback(baseUrl, first);
    assert.equal(staleFeedback.status, 401);
    const freshFeedback = await submitFeedback(baseUrl, replay);
    assert.equal(freshFeedback.status, 200);
  });
});

test("a durable completion event reconciles an idempotency-finalization outage without remote re-execution", async () => {
  const firstFixture = signedInFixture();
  const secondFixture = signedInFixture();
  const persistence = createSharedHirePersistence();
  persistence.failNextCompletion();
  let executions = 0;

  await withServer({
    store: firstFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, firstFixture.headers, { idempotencyKey: "completion-outage" });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "ERC8004_HIRE_PERSISTENCE_FAILED");
  });

  assert.equal(executions, 1);
  assert.equal(persistence.events.some((entry) => entry.eventType === "erc8004_hire_completion"), true);

  await withServer({
    store: secondFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, secondFixture.headers, { idempotencyKey: "completion-outage" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.result.execution, 1);
    assert.ok(payload.consumer_feedback_request.feedback_token);
  });

  assert.equal(executions, 1);
});

test("concurrent direct hires with one idempotency key execute the remote agent exactly once", async () => {
  const { store, headers } = signedInFixture();
  const persistence = createSharedHirePersistence();
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });

  await withServer({
    store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => {
      executions += 1;
      started();
      await gate;
      return { answer: "once" };
    }
  }, async ({ baseUrl }) => {
    const first = hire(baseUrl, headers, { idempotencyKey: "same-key" });
    await firstStarted;
    const second = hire(baseUrl, headers, { idempotencyKey: "same-key" });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const [firstPayload, secondPayload] = await Promise.all([firstResponse.json(), secondResponse.json()]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(executions, 1);
    assert.equal(firstPayload.request_id, secondPayload.request_id);
    assert.deepEqual(firstPayload.result, secondPayload.result);
  });
});

test("an in-process request joining an active hire receives the completed value without a nested outcome", async () => {
  const store = createMemoryStore();
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let executions = 0;
  const invoke = () => executeErc8004HireOnce({
    store,
    claimKey: "join-active-hire",
    requestHash: "same-request",
    requestId: "erc8004_joined",
    serviceId: "erc8004:56:42",
    execute: async () => {
      executions += 1;
      started();
      await gate;
      return { response: { request_id: "erc8004_joined", result: { answer: "once" } } };
    }
  });

  const first = invoke();
  await firstStarted;
  const joined = invoke();
  release();
  const [firstOutcome, joinedOutcome] = await Promise.all([first, joined]);

  assert.equal(executions, 1);
  assert.deepEqual(joinedOutcome.value, firstOutcome.value);
  assert.equal(joinedOutcome.value.response.result.answer, "once");
  assert.equal(joinedOutcome.joinedInProgress, true);
});

test("a completed idempotent hire is replayed across server instances without remote re-execution", async () => {
  const firstFixture = signedInFixture();
  const secondFixture = signedInFixture();
  const persistence = createSharedHirePersistence();
  let executions = 0;
  let requestId;

  await withServer({
    store: firstFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, firstFixture.headers, { idempotencyKey: "cross-instance" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    requestId = payload.request_id;
  });

  await withServer({
    store: secondFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, secondFixture.headers, { idempotencyKey: "cross-instance" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.request_id, requestId);
    assert.equal(payload.result.execution, 1);
    assert.ok(payload.consumer_feedback_request.feedback_token);
  });

  assert.equal(executions, 1);
});

test("a shared in-progress claim blocks a second server instance from executing the same hire", async () => {
  const firstFixture = signedInFixture();
  const secondFixture = signedInFixture();
  const persistence = createSharedHirePersistence();
  let firstExecutions = 0;
  let secondExecutions = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { started = resolve; });

  await withServer({
    store: firstFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => {
      firstExecutions += 1;
      started();
      await gate;
      return { answer: "first" };
    }
  }, async ({ baseUrl: firstUrl }) => {
    await withServer({
      store: secondFixture.store,
      erc8004HirePersistence: persistence,
      erc8004Executor: async () => {
        secondExecutions += 1;
        return { answer: "second" };
      }
    }, async ({ baseUrl: secondUrl }) => {
      const first = hire(firstUrl, firstFixture.headers, { idempotencyKey: "cross-instance-in-progress" });
      await firstStarted;
      const blocked = await hire(secondUrl, secondFixture.headers, { idempotencyKey: "cross-instance-in-progress" });
      const blockedPayload = await blocked.json();
      assert.equal(blocked.status, 409);
      assert.equal(blockedPayload.error.code, "ERC8004_HIRE_IN_PROGRESS");
      release();
      assert.equal((await first).status, 200);
    });
  });

  assert.equal(firstExecutions, 1);
  assert.equal(secondExecutions, 0);
});

test("an ambiguous failed hire is never re-executed by a fresh server instance", async () => {
  const firstFixture = signedInFixture();
  const secondFixture = signedInFixture();
  const persistence = createSharedHirePersistence();
  let executions = 0;

  await withServer({
    store: firstFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => {
      executions += 1;
      throw new Error("connection closed after dispatch");
    }
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, firstFixture.headers, { idempotencyKey: "ambiguous-failure" });
    assert.equal(response.status, 500);
  });

  await withServer({
    store: secondFixture.store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => {
      executions += 1;
      return { answer: "must not run" };
    }
  }, async ({ baseUrl }) => {
    const response = await hire(baseUrl, secondFixture.headers, { idempotencyKey: "ambiguous-failure" });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "ERC8004_HIRE_EXECUTION_UNCERTAIN");
  });

  assert.equal(executions, 1);
});

test("an idempotency key cannot be reused for different direct-hire input", async () => {
  const { store, headers } = signedInFixture();
  const persistence = createSharedHirePersistence();
  let executions = 0;

  await withServer({
    store,
    erc8004HirePersistence: persistence,
    erc8004Executor: async () => ({ execution: ++executions })
  }, async ({ baseUrl }) => {
    assert.equal((await hire(baseUrl, headers, { idempotencyKey: "conflict", input: { account: "0xaaa" } })).status, 200);
    const conflicting = await hire(baseUrl, headers, { idempotencyKey: "conflict", input: { account: "0xbbb" } });
    const payload = await conflicting.json();
    assert.equal(conflicting.status, 409);
    assert.equal(payload.error.code, "ERC8004_HIRE_IDEMPOTENCY_CONFLICT");
    assert.equal(executions, 1);
  });
});

test("direct hire requires an idempotency key before remote execution", async () => {
  const { store, headers } = signedInFixture();
  let called = false;
  await withServer({ store, erc8004Executor: async () => { called = true; } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent_id: "42", execute: true, capability: "account_health", input: {} })
    });
    const payload = await response.json();
    assert.equal(response.status, 428);
    assert.equal(payload.error.code, "ERC8004_HIRE_IDEMPOTENCY_KEY_REQUIRED");
    assert.equal(called, false);
  });
});

test("direct hire fails closed for missing, side-effecting, and unknown capability policy", async (t) => {
  const cases = [
    {
      name: "missing policy",
      policy: null,
      capability: "account_health",
      code: "ERC8004_EXECUTION_POLICY_REQUIRED"
    },
    {
      name: "write policy",
      policy: readOnlyPolicy({ access: "write" }),
      capability: "account_health",
      code: "ERC8004_EXECUTION_NOT_READ_ONLY"
    },
    {
      name: "unknown capability",
      policy: readOnlyPolicy(),
      capability: "withdraw_funds",
      code: "ERC8004_CAPABILITY_NOT_ALLOWED"
    },
    {
      name: "omitted capability",
      policy: readOnlyPolicy(),
      capability: null,
      code: "ERC8004_CAPABILITY_REQUIRED"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { store, headers } = signedInFixture({ policy: scenario.policy });
      let called = false;
      await withServer({ store, erc8004Executor: async () => { called = true; } }, async ({ baseUrl }) => {
        const response = await hire(baseUrl, headers, {
          idempotencyKey: `policy-${scenario.name}`,
          capability: scenario.capability
        });
        const payload = await response.json();
        assert.equal(response.status, 422);
        assert.equal(payload.error.code, scenario.code);
        assert.equal(called, false);
      });
    });
  }
});
