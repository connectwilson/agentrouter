import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

async function withServer(run) {
  const server = createServer({
    store: createMemoryStore(),
    serviceEventPersistence: {
      refreshConfigs: async () => [],
      refresh: async () => ({ ok: true, status: "fresh", loaded: 0 }),
      writeEvent: async () => true
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(baseUrl, path, task) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, max_price: "0.05" })
  });
  return response.json();
}

function normalizedDecision(payload) {
  const plan = payload.route_plan;
  assert.equal(plan?.schema_version, "agentrouter_route_plan_v1");
  return {
    task_family: plan.task_family,
    data_family: plan.data_family,
    route_family: plan.route_family,
    capability: plan.capability,
    source_constraint: plan.source_constraint,
    provider_constraint: plan.provider_constraint,
    candidate_sources: plan.candidate_sources,
    params: plan.params,
    auth_requirement: plan.auth_requirement,
    budget_gate: plan.budget_gate,
    abstain_reason: plan.abstain_reason,
    must_not_fallback: plan.must_not_fallback
  };
}

function normalizedOutcome(payload) {
  const observation = payload.routing_observation;
  assert.ok(observation?.observation_id, "the real entrypoint must record its terminal decision");
  return {
    status: payload.status,
    action: observation.action,
    route_family: observation.route_family,
    capability: observation.capability,
    authorization_kind: payload.action_required?.authorization_kind
      || payload.connection_action?.authorization_kind
      || null,
    preferred_tool: payload.action_required?.preferred_tool
      || payload.connection_action?.preferred_tool
      || null
  };
}

test("ask and fetch expose the same canonical decision for high-risk natural-language routes", async () => {
  await withServer(async (baseUrl) => {
    for (const task of [
      "研究 AgentRouter 的产品定位、主要竞品和市场机会。",
      "查找关于 AI Agent 路由的同行评审论文和引用次数。",
      "Find x if x=2",
      "查XLM当前最大爆仓痛点",
      "阅读这条 X 帖子的内容并总结观点：https://x.com/example/status/1234567890。",
      "Show the top 5 profitable Hyperliquid wallets over 48 hours for tokens listed by Robinhood.",
      "Verify BSC transaction 0xce780499022ade2028085acc000218a8e5d1cebddf4df912bd9dd779135fc365, ERC-8004 Agent ID 340924, and whether feedback exists for req_1788794834931."
    ]) {
      const [ask, fetchResult] = await Promise.all([
        post(baseUrl, "/agent-router/ask", task),
        post(baseUrl, "/agent-router/fetch", task)
      ]);
      assert.deepEqual(normalizedDecision(ask), normalizedDecision(fetchResult), task);
      assert.deepEqual(normalizedOutcome(ask), normalizedOutcome(fetchResult), task);
    }
  });
});

test("canonical plans make auth and fallback decisions observable instead of hiding them in result copy", async () => {
  await withServer(async (baseUrl) => {
    const scholarly = await post(baseUrl, "/agent-router/fetch", "使用 OpenAlex 查找 AgentRouter 相关论文。");
    assert.equal(scholarly.route_plan.source_constraint, "openalex");
    assert.equal(scholarly.route_plan.must_not_fallback, true);
    // Account authorization is the outer boundary. Source authorization only
    // becomes actionable after AgentRouter knows which user's source to bind.
    assert.equal(scholarly.route_plan.auth_requirement.kind, "agentrouter_account");

    const vague = await post(baseUrl, "/agent-router/fetch", "帮我研究一下这个东西。");
    assert.equal(vague.route_plan.route_family, "none");
    assert.equal(vague.route_plan.abstain_reason, "insufficient_context");
    assert.equal(vague.route_plan.must_not_fallback, true);
  });
});
