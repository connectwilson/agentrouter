import test from "node:test";
import assert from "node:assert/strict";

import { localSocialSearchRequest } from "../packages/agentrouter-mcp/server/local-social-search.js";
import { inferRoutePlan } from "../src/routing/planner.js";

const ROUTING_CONTEXT = Object.freeze({
  agentrouter_authenticated: true,
  connected_sources: [],
  local_browser_sessions: [],
  require_price_upper_bound: false,
  constraints: { max_price_usdc: "0.05" }
});

const X_NATURAL_LANGUAGE_TASKS = [
  "搜索 X 上 Lookonchain 历史上关于开仓、加仓、减仓和平仓的原帖",
  "去 X 上查 Hyperliquid 用户对新版前端的反馈",
  "从 X 找最近一周关于 Agentic Commerce 的讨论",
  "查查 X 里大家如何评价 AgentRouter",
  "帮我找 X 平台上关于 BNB Chain Paymaster 的帖子",
  "在推特上搜索开发者对 ERC-8004 的看法",
  "Twitter 搜索 AI Agent payment 的最新讨论",
  "Find posts on X about stablecoin payments",
  "Look up on X what traders say about HYPE",
  "Check X for recent smart-money discussions",
  "Research what builders are saying on X about agent payments"
];

function fetchMessage(task) {
  return {
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task } }
  };
}

test("varied natural-language X searches stay on the local browser route", () => {
  for (const task of X_NATURAL_LANGUAGE_TASKS) {
    const local = localSocialSearchRequest(fetchMessage(task));
    assert.ok(local, `local MCP did not intercept: ${task}`);
    assert.equal(local.platform, "x", task);
    assert.equal(local.capability, "social_search", task);

    const plan = inferRoutePlan(task, ROUTING_CONTEXT);
    assert.equal(plan.route_family, "local_browser", task);
    assert.equal(plan.capability, "social_search", task);
    assert.equal(plan.source_constraint, "x", task);
    assert.equal(plan.must_not_fallback, true, task);
  }
});

test("common agent-generated X capability aliases are normalized before remote routing", () => {
  const cases = [
    { capability: "x_search", params: { query: "Lookonchain position changes" }, operation: "search" },
    { capability: "twitter_search", params: { query: "AgentRouter feedback" }, operation: "search" },
    { capability: "tweet_search", params: { query: "ERC-8004" }, operation: "search" },
    { capability: "x_user_posts", params: { handle: "lookonchain" }, operation: "read_user_posts" },
    { capability: "twitter_user_posts", params: { handle: "lookonchain" }, operation: "read_user_posts" }
  ];

  for (const entry of cases) {
    const request = localSocialSearchRequest({
      method: "tools/call",
      params: {
        name: "agentrouter_request",
        arguments: { capability: entry.capability, params: entry.params }
      }
    });
    assert.ok(request, `alias was not intercepted: ${entry.capability}`);
    assert.equal(request.platform, "x", entry.capability);
    assert.equal(request.operation, entry.operation, entry.capability);
    assert.equal(
      request.capability,
      entry.operation === "read_user_posts" ? "social_user_voice_research" : "social_search",
      entry.capability
    );
  }
});

test("the X platform detector rejects asset symbols, variables, products, and vendor research", () => {
  const negatives = [
    "查 XLM 当前最大爆仓痛点",
    "求方程 x=2 的解",
    "比较 Model X 和 Model Y 的性能",
    "研究 XPOZ 这家 social vendor 的 API 覆盖"
  ];

  for (const task of negatives) {
    assert.equal(localSocialSearchRequest(fetchMessage(task)), null, task);
    const plan = inferRoutePlan(task, ROUTING_CONTEXT);
    assert.notEqual(plan.source_constraint, "x", task);
  }
});
