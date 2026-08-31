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
    auth_requirement: plan.auth_requirement,
    budget_gate: plan.budget_gate,
    abstain_reason: plan.abstain_reason,
    must_not_fallback: plan.must_not_fallback
  };
}

test("ask and fetch expose the same canonical decision for high-risk natural-language routes", async () => {
  await withServer(async (baseUrl) => {
    for (const task of [
      "研究 AgentRouter 的产品定位、主要竞品和市场机会。",
      "查找关于 AI Agent 路由的同行评审论文和引用次数。",
      "Find x if x=2",
      "查XLM当前最大爆仓痛点"
    ]) {
      const [ask, fetchResult] = await Promise.all([
        post(baseUrl, "/agent-router/ask", task),
        post(baseUrl, "/agent-router/fetch", task)
      ]);
      assert.deepEqual(normalizedDecision(ask), normalizedDecision(fetchResult), task);
    }
  });
});

test("canonical plans make auth and fallback decisions observable instead of hiding them in result copy", async () => {
  await withServer(async (baseUrl) => {
    const scholarly = await post(baseUrl, "/agent-router/fetch", "使用 OpenAlex 查找 AgentRouter 相关论文。");
    assert.equal(scholarly.route_plan.source_constraint, "openalex");
    assert.equal(scholarly.route_plan.must_not_fallback, true);
    assert.equal(scholarly.route_plan.auth_requirement.kind, "source_connection");

    const vague = await post(baseUrl, "/agent-router/fetch", "帮我研究一下这个东西。");
    assert.equal(vague.route_plan.route_family, "none");
    assert.equal(vague.route_plan.abstain_reason, "insufficient_context");
    assert.equal(vague.route_plan.must_not_fallback, true);
  });
});
