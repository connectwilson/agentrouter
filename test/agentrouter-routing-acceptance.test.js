import test from "node:test";
import assert from "node:assert/strict";

import { askAgentRouter, inferIntent } from "../src/agent-router.js";
import { inferExternalApiRequest, runExternalApiQuery } from "../src/external-api-capability.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { registerService } from "../src/registry.js";
import { findSocialPostUrl } from "../src/social-post-read.js";
import { createMemoryStore } from "../src/store.js";
import { localSocialSearchRequest, runLocalSocialSearch } from "../packages/agentrouter-mcp/server/local-social-search.js";

const PROMPTS = [
  "研究 AgentRouter 的产品定位、主要竞品和市场机会。",
  "调研目前主流 AI Agent API Marketplace 的商业模式。",
  "研究同类量化策略过去一年的实证表现。",
  "在Reddit上，人们对hyperliquid前端产品的看法",
  "查找最近关于 Agentic Commerce 的公开讨论和行业报告。",
  "查找关于 AI Agent 路由的同行评审论文。",
  "找出 Agent routing 领域引用次数最高的 10 篇论文。",
  "查询 DOI 10.1145/3442188.3445922 的论文信息和引用次数。",
  "查找 2024 年以后关于 multi-agent orchestration 的 arXiv 论文。",
  "查询作者 Stuart Russell 最近发表的论文及合作作者。",
  "查询英伟达最新股价、成交量和市值。",
  "查询 BTC 当前价格以及加密货币市值排名。",
  "查询 BNB Chain 最近 24 小时交易量最大的 10 个流动性池。",
  "查询 SOL/USDC 在不同 DEX 上的交易对和流动性。",
  "查询 AZTEC 最近 24 小时的 smart-money activity。",
  "查询苹果公司最近提交的 10-K、8-K 和其他 SEC 文件。",
  "查询台北未来七天的气温、降雨概率和风速。",
  "搜索 GitHub 上与 ERC-8004 相关、最近仍在更新的开源项目。",
  "查询最近一周全球媒体如何报道 AI Agent 支付。",
  "检查 example.com 是否被标记为恶意域名或钓鱼网站。",
  "查找台北车站附近目前营业、评分超过 4.3 的咖啡店。",
  "查询下周五从台北飞往东京的直飞航班。",
  "查询快递单号 EZ1000000001 当前运输状态。",
  "搜索 YouTube 上最近一个月关于 AgentRouter 的评测视频。",
  "阅读这条 X 帖子的内容并总结观点：https://x.com/example/status/1234567890。",
  "使用 OpenAlex 查找 AgentRouter 相关资料。",
  "使用 Exa 研究最近的 AI Agent 创业公司融资情况。",
  "查找小红书上，人们对Agent交易的看法",
  "查询一个最多收费 0.05 USDC 的高可信度链上数据服务。",
  "帮我研究一下这个东西。"
];

const sourceFor = (task, tier = "all") => inferExternalApiRequest(task, {
  connectedSources: ["exa"],
  tier
});

test("the 30-prompt corpus keeps general research separate from specialist sources", () => {
  assert.equal(PROMPTS.length, 30);
  const expectedSources = new Map([
    [0, "exa"], [1, "exa"], [2, "exa"], [4, "exa"],
    [5, "openalex"], [6, "openalex"], [7, "openalex"], [8, "openalex"], [9, "openalex"],
    [10, "yahoo_finance"], [11, "coinmarketcap"], [12, "geckoterminal"], [13, "dexscreener"],
    [15, "sec_edgar"], [16, "open_meteo"], [17, "github"], [18, "gdelt"],
    [19, "virus_total"], [20, "google_places"], [21, "amadeus"], [22, "easy_post"],
    [23, "youtube"], [25, "openalex"], [26, "exa"]
  ]);
  for (const [index, expected] of expectedSources) {
    assert.equal(sourceFor(PROMPTS[index])?.params.source, expected, PROMPTS[index]);
  }
  assert.equal(sourceFor(PROMPTS[0], "specialized"), null, "general product research waits for the web fallback");
  assert.equal(sourceFor(PROMPTS[2], "specialized"), null, "generic empirical research is not scholarly by default");
  assert.equal(sourceFor(PROMPTS[5], "specialized")?.params.source, "openalex");
  const smartMoney = inferIntent(PROMPTS[14]);
  assert.equal(smartMoney.wants_smart_money_activity, true);
  assert.equal(smartMoney.input.token_symbol, "AZTEC");
  assert.equal(findSocialPostUrl(PROMPTS[24])?.platform, "x");
});

test("empirical strategy research emits a multi-source plan without forcing OpenAlex", () => {
  const routed = sourceFor(PROMPTS[2]);
  assert.equal(routed.params.source, "exa");
  assert.equal(routed.research_plan.strategy, "web_evidence_then_specialist_data");
  assert.equal(routed.research_plan.supplemental_requirements[0].capability, "service_discovery");
  assert.ok(!JSON.stringify(routed.research_plan).includes("openalex"));
});

test("natural-language Reddit and Xiaohongshu prompts run locally and plan Exa supplementation when evidence is thin", async () => {
  const reddit = localSocialSearchRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: PROMPTS[3] } }
  });
  const xiaohongshu = localSocialSearchRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: PROMPTS[27] } }
  });
  assert.equal(reddit.platform, "reddit");
  assert.equal(xiaohongshu.platform, "xiaohongshu");
  assert.equal(reddit.supplement_on_insufficient, true);

  const result = await runLocalSocialSearch(reddit, {
    runCommand: async () => ({
      status: "completed",
      data: [{ id: "1", text: "Hyperliquid is fast but the frontend navigation is confusing", url: "https://reddit.com/r/hyperliquid/comments/1" }]
    })
  });
  assert.equal(result.status, "completed");
  assert.equal(result.coverage.status, "insufficient");
  assert.equal(result.supplemental_request.capability, "external_api_query");
  assert.equal(result.supplemental_request.params.source, "exa");
});

test("flight language is normalized before Amadeus authorization", async () => {
  const routed = sourceFor(PROMPTS[21]);
  assert.equal(routed.params.source, "amadeus");
  assert.equal(routed.params.origin, "TPE");
  assert.equal(routed.params.destination, "TYO");
  assert.match(routed.params.departure_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(routed.params.non_stop, true);

  const result = await runExternalApiQuery(createMemoryStore(), "acceptance-user", routed.params);
  assert.equal(result.status, "connection_required");
  assert.equal(result.connection_action.preferred_tool, "agentrouter_connect_source");
});

test("service-discovery language ranks verified on-chain services by trust within budget", async () => {
  const store = createMemoryStore();
  const add = (id, price, event) => {
    const record = registerService(store, {
      ...baseFundFlowManifest,
      service_id: id,
      provider: { provider_id: `provider_${id}` },
      title: `${id} on-chain data`,
      pricing: { ...baseFundFlowManifest.pricing, amount: price },
      endpoint: { ...baseFundFlowManifest.endpoint, url: `/provider/${id}` }
    }, "http://127.0.0.1:8800");
    record.verification_status = "verified";
    record.feedback_events.push(event);
  };
  add("trusted", "0.04", {
    status: "success", schema_valid: true, latency_ms: 100,
    verification: { coverage_valid: true, freshness_valid: true, agent_friendly_score: 1 },
    consumer_feedback: { intent_fit: "yes", answer_useful: "yes", consumer_score: 1 }
  });
  add("weak", "0.01", {
    status: "error", schema_valid: false, latency_ms: 4000,
    verification: { coverage_valid: false, freshness_valid: false, agent_friendly_score: 0 },
    consumer_feedback: { intent_fit: "no", answer_useful: "no", consumer_score: 0 }
  });
  add("over_budget", "0.06", {
    status: "success", schema_valid: true,
    verification: { coverage_valid: true, freshness_valid: true, agent_friendly_score: 1 }
  });

  const result = await askAgentRouter(store, { task: PROMPTS[28], max_price: "0.05", invoke: false });
  assert.equal(result.status, "services_found");
  assert.equal(result.services[0].service_id, "trusted");
  assert.ok(result.services.every((service) => Number(service.price) <= 0.05));
  assert.ok(result.services[0].trust_score > result.services[1].trust_score);
});

test("a vague research object asks for clarification before any external route", async () => {
  const result = await askAgentRouter(createMemoryStore(), { task: PROMPTS[29], invoke: false });
  assert.equal(result.status, "needs_clarification");
  assert.match(result.question, /研究对象|具体/);
  assert.equal(result.suggested_route, undefined);
});

test("credential-backed sources consistently hand off to browser authorization", async () => {
  for (const index of [19, 20, 22, 25, 26]) {
    const routed = sourceFor(PROMPTS[index]);
    const result = await runExternalApiQuery(createMemoryStore(), "acceptance-user", routed.params);
    assert.equal(result.status, "connection_required", PROMPTS[index]);
    assert.equal(result.connection_action.preferred_tool, "agentrouter_connect_source", PROMPTS[index]);
  }
});
