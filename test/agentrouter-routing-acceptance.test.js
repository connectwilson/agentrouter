import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { askAgentRouter, inferIntent } from "../src/agent-router.js";
import { inferExternalApiRequest, runExternalApiQuery } from "../src/external-api-capability.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { registerService } from "../src/registry.js";
import { findSocialPostUrl } from "../src/social-post-read.js";
import { createMemoryStore } from "../src/store.js";
import { localSocialSearchRequest, runLocalSocialSearch } from "../packages/agentrouter-mcp/server/local-social-search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(
  path.join(here, "fixtures", "agentrouter-feedback-regressions.json"), "utf8"
));
const PROMPTS = corpus.routing_cases.map((entry) => entry.prompt);

const sourceFor = (task, tier = "all") => inferExternalApiRequest(task, {
  connectedSources: ["exa"],
  tier
});

test("the 30-prompt corpus keeps general research separate from specialist sources", () => {
  assert.equal(PROMPTS.length, 30);
  for (const entry of corpus.routing_cases.filter((item) => item.expected.kind === "source")) {
    assert.equal(sourceFor(entry.prompt)?.params.source, entry.expected.source, `${entry.id}: ${entry.prompt}`);
    if (Object.hasOwn(entry.expected, "specialized_source")) {
      assert.equal(sourceFor(entry.prompt, "specialized")?.params.source || null,
        entry.expected.specialized_source, `${entry.id}: specialized route`);
    }
  }
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

test("social-provider market research does not become a Reddit post search", () => {
  const request = localSocialSearchRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_fetch",
      arguments: {
        task: "Research API providers that cover X, Instagram, TikTok, Reddit, YouTube and Xiaohongshu for AgentRouter integration."
      }
    }
  });
  assert.equal(request, null);
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
