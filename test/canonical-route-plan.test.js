import test from "node:test";
import assert from "node:assert/strict";

import { inferRoutePlan } from "../src/canonical-route-plan.js";

const DEFAULT_CONTEXT = Object.freeze({
  agentrouter_authenticated: true,
  connected_sources: ["exa"],
  local_browser_sessions: [],
  constraints: { max_price_usdc: "0.05" }
});

function context(overrides = {}) {
  return {
    ...DEFAULT_CONTEXT,
    ...overrides,
    constraints: {
      ...DEFAULT_CONTEXT.constraints,
      ...(overrides.constraints || {})
    }
  };
}

function assertCanonicalEnvelope(plan) {
  assert.equal(plan.schema_version, "agentrouter_route_plan_v1");
  assert.equal(typeof plan.task_family, "string");
  assert.equal(typeof plan.data_family, "string");
  assert.ok(["external_api", "local_browser", "registered_service", "none"].includes(plan.route_family));
  assert.ok(plan.capability === null || typeof plan.capability === "string");
  assert.ok(plan.source_constraint === null || typeof plan.source_constraint === "string");
  assert.ok(plan.provider_constraint === null || typeof plan.provider_constraint === "string");
  assert.ok(Array.isArray(plan.candidate_sources));
  assert.equal(new Set(plan.candidate_sources).size, plan.candidate_sources.length);
  assert.ok(Number.isFinite(plan.confidence) && plan.confidence >= 0 && plan.confidence <= 1);
  assert.ok(Number.isFinite(plan.top1_top2_margin) && plan.top1_top2_margin >= 0 && plan.top1_top2_margin <= 1);
  assert.deepEqual(Object.keys(plan.auth_requirement).sort(), ["kind", "required", "source"]);
  assert.equal(typeof plan.auth_requirement.required, "boolean");
  assert.ok(["none", "agentrouter_account", "source_connection", "local_browser_session"].includes(plan.auth_requirement.kind));
  assert.ok(plan.auth_requirement.source === null || typeof plan.auth_requirement.source === "string");
  assert.deepEqual(Object.keys(plan.budget_gate).sort(), ["max_price_usdc", "paid_calls_allowed", "status"]);
  assert.match(plan.budget_gate.max_price_usdc, /^\d+(?:\.\d+)?$/);
  assert.equal(typeof plan.budget_gate.paid_calls_allowed, "boolean");
  assert.ok(["allowed", "free_only", "blocked"].includes(plan.budget_gate.status));
  assert.ok(plan.abstain_reason === null || typeof plan.abstain_reason === "string");
  assert.equal(typeof plan.must_not_fallback, "boolean");
}

test("canonical route plans expose one stable, measurable decision envelope", () => {
  const plan = inferRoutePlan(
    "研究 AgentRouter 的产品定位、主要竞品和市场机会。",
    context()
  );

  assertCanonicalEnvelope(plan);
  assert.equal(plan.task_family, "research");
  assert.equal(plan.data_family, "current_web");
  assert.equal(plan.route_family, "external_api");
  assert.equal(plan.capability, "public_web_research");
  assert.equal(plan.source_constraint, null);
  assert.equal(plan.provider_constraint, null);
  assert.equal(plan.candidate_sources[0], "exa");
  assert.ok(!plan.candidate_sources.includes("openalex"));
  assert.ok(plan.confidence >= 0.75);
  assert.ok(plan.top1_top2_margin >= 0);
  assert.deepEqual(plan.auth_requirement, { required: false, kind: "none", source: null });
  assert.deepEqual(plan.budget_gate, {
    max_price_usdc: "0.05",
    paid_calls_allowed: true,
    status: "allowed"
  });
  assert.equal(plan.abstain_reason, null);
  assert.equal(plan.must_not_fallback, false);
});

test("general research and scholarly metadata are contrastive routes, not keyword aliases", () => {
  const general = inferRoutePlan(
    "研究同类量化策略过去一年的实证表现。",
    context()
  );
  const scholarly = inferRoutePlan(
    "查找关于 AI Agent 路由的同行评审论文和引用次数。",
    context({ connected_sources: [] })
  );

  assertCanonicalEnvelope(general);
  assertCanonicalEnvelope(scholarly);
  assert.equal(general.data_family, "current_web");
  assert.equal(general.capability, "public_web_research");
  assert.equal(general.candidate_sources[0], "exa");
  assert.ok(!general.candidate_sources.includes("openalex"));

  assert.equal(scholarly.task_family, "research");
  assert.equal(scholarly.data_family, "scholarly_metadata");
  assert.equal(scholarly.route_family, "external_api");
  assert.equal(scholarly.capability, "scholarly_literature");
  assert.equal(scholarly.candidate_sources[0], "openalex");
  assert.ok(!scholarly.candidate_sources.includes("exa"));
  assert.ok(scholarly.confidence >= 0.8);
  assert.ok(scholarly.top1_top2_margin >= 0.15);
  assert.deepEqual(scholarly.auth_requirement, {
    required: true,
    kind: "source_connection",
    source: "openalex"
  });
  assert.equal(scholarly.must_not_fallback, true);
});

test("an isolated X variable never becomes the X social network", () => {
  const variable = inferRoutePlan("Find x if x=2", context());
  const social = inferRoutePlan(
    "在 X 上搜索 AgentRouter 的用户讨论。",
    context({ connected_sources: [], local_browser_sessions: [] })
  );

  assertCanonicalEnvelope(variable);
  assert.equal(variable.task_family, "reasoning");
  assert.equal(variable.data_family, "none");
  assert.equal(variable.route_family, "none");
  assert.equal(variable.capability, null);
  assert.deepEqual(variable.candidate_sources, []);
  assert.equal(variable.abstain_reason, "no_external_data_required");
  assert.equal(variable.must_not_fallback, true);

  assertCanonicalEnvelope(social);
  assert.equal(social.task_family, "social_research");
  assert.equal(social.data_family, "public_social_content");
  assert.equal(social.route_family, "local_browser");
  assert.equal(social.capability, "social_search");
  assert.equal(social.source_constraint, "x");
  assert.deepEqual(social.candidate_sources, ["x"]);
  assert.ok(social.confidence >= 0.8);
  assert.ok(social.top1_top2_margin >= 0.15);
  assert.deepEqual(social.auth_requirement, {
    required: true,
    kind: "local_browser_session",
    source: "x"
  });
  assert.equal(social.must_not_fallback, true);
});

test("a hackathon track and a parcel tracking number take different routes", () => {
  const topic = inferRoutePlan(
    "研究 AltLayer hackathon track 的提交规则。",
    context()
  );
  const parcel = inferRoutePlan(
    "查询快递单号 EZ1000000001 当前运输状态。",
    context({ connected_sources: [] })
  );

  assertCanonicalEnvelope(topic);
  assert.equal(topic.data_family, "current_web");
  assert.equal(topic.capability, "public_web_research");
  assert.equal(topic.candidate_sources[0], "exa");
  assert.ok(!topic.candidate_sources.includes("easy_post"));

  assertCanonicalEnvelope(parcel);
  assert.equal(parcel.task_family, "lookup");
  assert.equal(parcel.data_family, "shipment_status");
  assert.equal(parcel.route_family, "external_api");
  assert.equal(parcel.capability, "shipment_tracking");
  assert.equal(parcel.source_constraint, null);
  assert.deepEqual(parcel.candidate_sources, ["easy_post"]);
  assert.ok(parcel.confidence >= 0.85);
  assert.ok(parcel.top1_top2_margin >= 0.2);
  assert.deepEqual(parcel.auth_requirement, {
    required: true,
    kind: "source_connection",
    source: "easy_post"
  });
  assert.equal(parcel.must_not_fallback, true);
});

test("local social search and direct post reads require browser authorization, never an API key prompt", () => {
  const xiaohongshu = inferRoutePlan(
    "查找小红书上，人们对 Agent 交易的看法。",
    context({ connected_sources: [], local_browser_sessions: [] })
  );
  const xPost = inferRoutePlan(
    "阅读并总结 https://x.com/example/status/1234567890",
    context({ connected_sources: [], local_browser_sessions: ["x"] })
  );

  assertCanonicalEnvelope(xiaohongshu);
  assert.equal(xiaohongshu.task_family, "social_research");
  assert.equal(xiaohongshu.data_family, "public_social_content");
  assert.equal(xiaohongshu.route_family, "local_browser");
  assert.equal(xiaohongshu.capability, "social_search");
  assert.equal(xiaohongshu.source_constraint, "xiaohongshu");
  assert.deepEqual(xiaohongshu.candidate_sources, ["xiaohongshu"]);
  assert.deepEqual(xiaohongshu.auth_requirement, {
    required: true,
    kind: "local_browser_session",
    source: "xiaohongshu"
  });
  assert.equal(xiaohongshu.must_not_fallback, true);

  assertCanonicalEnvelope(xPost);
  assert.equal(xPost.task_family, "social_post_read");
  assert.equal(xPost.data_family, "public_social_post");
  assert.equal(xPost.route_family, "local_browser");
  assert.equal(xPost.capability, "social_post_read");
  assert.equal(xPost.source_constraint, "x");
  assert.deepEqual(xPost.candidate_sources, ["x"]);
  assert.deepEqual(xPost.auth_requirement, { required: false, kind: "none", source: null });
  assert.equal(xPost.must_not_fallback, true);
});

test("explicit source and provider constraints survive planning and disable silent fallback", () => {
  const openAlex = inferRoutePlan(
    "使用 OpenAlex 查找 AgentRouter 相关论文。",
    context({ connected_sources: [] })
  );
  const socialDataX = inferRoutePlan(
    "使用 SocialDataX 查找小红书、抖音和微博上对 Agent 交易的看法。",
    context({ connected_sources: [] })
  );

  assertCanonicalEnvelope(openAlex);
  assert.equal(openAlex.source_constraint, "openalex");
  assert.equal(openAlex.provider_constraint, null);
  assert.deepEqual(openAlex.candidate_sources, ["openalex"]);
  assert.equal(openAlex.data_family, "scholarly_metadata");
  assert.equal(openAlex.capability, "scholarly_literature");
  assert.equal(openAlex.must_not_fallback, true);

  assertCanonicalEnvelope(socialDataX);
  assert.equal(socialDataX.source_constraint, null);
  assert.equal(socialDataX.provider_constraint, "socialdatax");
  assert.deepEqual(socialDataX.candidate_sources, ["socialdatax"]);
  assert.equal(socialDataX.data_family, "public_social_content");
  assert.equal(socialDataX.capability, "social_search");
  assert.deepEqual(socialDataX.auth_requirement, {
    required: true,
    kind: "source_connection",
    source: "socialdatax"
  });
  assert.equal(socialDataX.must_not_fallback, true);
});

test("XLM liquidation max-pain preserves the asset and chooses the registered-service family", () => {
  const plan = inferRoutePlan("查XLM当前最大爆仓痛点", context());

  assertCanonicalEnvelope(plan);
  assert.equal(plan.task_family, "market_analysis");
  assert.equal(plan.data_family, "crypto_derivatives");
  assert.equal(plan.route_family, "registered_service");
  assert.equal(plan.capability, "perp_liquidation_max_pain");
  assert.equal(plan.params.asset, "XLM");
  assert.equal(plan.params.market_type, "perpetual_futures");
  assert.equal(plan.params.window, "current");
  assert.equal(plan.source_constraint, null);
  assert.equal(plan.provider_constraint, null);
  assert.deepEqual(plan.candidate_sources, ["agentrouter_registry"]);
  assert.ok(plan.confidence >= 0.9);
  assert.ok(plan.top1_top2_margin >= 0.25);
  assert.equal(plan.abstain_reason, null);
});

test("a vague research request abstains before auth, routing, or paid execution", () => {
  const plan = inferRoutePlan("帮我研究一下这个东西。", context({ connected_sources: [] }));

  assertCanonicalEnvelope(plan);
  assert.equal(plan.task_family, "clarification");
  assert.equal(plan.data_family, "unknown");
  assert.equal(plan.route_family, "none");
  assert.equal(plan.capability, null);
  assert.deepEqual(plan.candidate_sources, []);
  assert.ok(plan.confidence <= 0.5);
  assert.equal(plan.top1_top2_margin, 0);
  assert.deepEqual(plan.auth_requirement, { required: false, kind: "none", source: null });
  assert.equal(plan.abstain_reason, "insufficient_context");
  assert.equal(plan.must_not_fallback, true);
});

test("a zero budget blocks paid explicit routes but still permits free specialist sources", () => {
  const paid = inferRoutePlan(
    "使用 Exa 研究最近的 AI Agent 创业公司融资情况。",
    context({ connected_sources: [], constraints: { max_price_usdc: "0" } })
  );
  const free = inferRoutePlan(
    "搜索 GitHub 上与 ERC-8004 相关、最近仍在更新的开源项目。",
    context({ connected_sources: [], constraints: { max_price_usdc: "0" } })
  );

  assertCanonicalEnvelope(paid);
  assert.equal(paid.source_constraint, "exa");
  assert.deepEqual(paid.candidate_sources, ["exa"]);
  assert.deepEqual(paid.budget_gate, {
    max_price_usdc: "0",
    paid_calls_allowed: false,
    status: "blocked"
  });
  assert.deepEqual(paid.auth_requirement, { required: false, kind: "none", source: null });
  assert.equal(paid.abstain_reason, "budget_exceeded");
  assert.equal(paid.must_not_fallback, true);

  assertCanonicalEnvelope(free);
  assert.equal(free.route_family, "external_api");
  assert.equal(free.capability, "code_repository_search");
  assert.deepEqual(free.candidate_sources, ["github"]);
  assert.deepEqual(free.budget_gate, {
    max_price_usdc: "0",
    paid_calls_allowed: false,
    status: "free_only"
  });
  assert.deepEqual(free.auth_requirement, { required: false, kind: "none", source: null });
  assert.equal(free.abstain_reason, null);
});
