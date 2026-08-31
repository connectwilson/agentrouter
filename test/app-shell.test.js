import assert from "node:assert/strict";
import test from "node:test";
import { agentHtml, homeHtml, serviceDetailHtml } from "../src/home.js";
import { researchHtml } from "../src/research.js";
import { studioHtml } from "../src/studio.js";

test("first-party application pages share the Naive design shell and client-side router", () => {
  const pages = [
    homeHtml({}),
    researchHtml({}),
    studioHtml({})
  ];

  for (const page of pages) {
    assert.match(page, /data-agentrouter-app/);
    assert.match(page, /--ar-bg:#000000/);
    assert.match(page, /GeistPixel_Circle\.woff2/);
    assert.match(page, /--ar-button-small:32px/);
    assert.match(page, /--ar-button-large:48px/);
    assert.match(page, /data-agentrouter-spa/);
    assert.match(page, /history\.pushState/);
  }
});

test("client-side router preserves normal navigation boundaries", () => {
  const page = homeHtml({});

  assert.match(page, /same-origin/);
  assert.match(page, /target === "_blank"/);
  assert.match(page, /\/auth\//);
  assert.match(page, /popstate/);
});

test("homepage emits only the Naive black-and-white visual system", () => {
  const page = homeHtml({});

  assert.match(page, /--ar-card:#161616/);
  assert.match(page, /GeistPixelCircle/);
  assert.doesNotMatch(page, /--color-accent:#5cff73/);
  assert.doesNotMatch(page, /--color-accent-cool:#dffcff/);
  assert.doesNotMatch(page, /--shadow-lift:/);
});

test("homepage renders live recent calls instead of process-load registration order", () => {
  const page = homeHtml({});

  assert.match(page, /<h3>Recent calls<\/h3>/);
  assert.doesNotMatch(page, /<h3>Recently registered<\/h3>/);
  assert.match(page, /stats\.recent_calls/);
  assert.match(page, /renderRecentCallRows/);
  assert.match(page, /cache:\s*"no-store"/);
  assert.match(page, /setInterval\(loadHomeStats,\s*30_000\)/);
  assert.match(page, /clearInterval\(window\.__agentRouterHomeStatsInterval\)/);
  assert.match(page, /removeEventListener\("visibilitychange",\s*window\.__agentRouterHomeVisibilityHandler\)/);
});

test("agent hub renders one data-backed Categories list without empty source taxonomy", () => {
  const hub = agentHtml({});

  assert.match(hub, /agent-router\/service-categories/);
  assert.doesNotMatch(hub, /<strong>Sources<\/strong>/);
  assert.doesNotMatch(hub, /Public APIs catalog/);
  assert.doesNotMatch(hub, /const PUBLIC_API_SOURCE_CATEGORIES/);
});

test("agent hub category links restore the selected category from the URL", () => {
  const hub = agentHtml({});

  assert.match(hub, /const requestedCategory = pageParams\.get\("category"\)/);
  assert.match(hub, /categories\.some\(\(item\) => item\.category === requestedCategory\)/);
});

test("agent hub leads with productized capability packs that filter the live service catalog", () => {
  const hub = agentHtml({});

  assert.match(hub, /Start with a capability/);
  assert.match(hub, /agent-router\/capability-packs/);
  assert.match(hub, /id="capability-pack-grid"/);
  assert.match(hub, /const requestedPack = pageParams\.get\("pack"\)/);
  assert.match(hub, /params\.set\("pack", activePack\)/);
  assert.match(hub, /data-pack/);
  assert.match(hub, /Canonical contract/);
  assert.match(hub, /selectedPack\?\.discovery_query/);
  assert.match(hub, /erc8004\/discover\?q=/);
});

test("agent hub exposes callable AI Search API sources as one category", () => {
  const hub = agentHtml({});
  assert.match(hub, /AI Search/);
  assert.doesNotMatch(hub, /AI Research/);
  assert.match(hub, /fetch\("\/agent-router\/api-sources"\)/);
  assert.match(hub, /hub_category === aiSearchCategory/);
  assert.match(hub, /externalApiSourceCard/);
  assert.match(hub, /return apiCard\(source, \{ link: true \}\)/);
  assert.match(hub, /service\.price_label/);
  assert.match(hub, /if \(value == null\) return "--"/);
  assert.match(hub, /class="api-core-metrics"/);
  assert.match(hub, /class="api-price"/);
  assert.match(hub, /class="api-trust"/);
  assert.match(hub, /formatTrustScore\(service\.trust_score\)/);
  assert.match(hub, /No feedback/);
  assert.match(hub, />Calls<\/span>/);
  assert.match(hub, />Success<\/span>/);
  assert.doesNotMatch(hub, /class="heart"/);
  assert.doesNotMatch(hub, /class="[^"]*sk-heart/);
  assert.doesNotMatch(hub, /Connection required/);
  assert.doesNotMatch(hub, /Connect API to use/);
});

test("agent hub browser capability cards share the emphasized price and trust layout", () => {
  const hub = agentHtml({});

  assert.match(hub, /<strong>Free<\/strong><small>Local read<\/small>/);
  assert.match(hub, /<strong>—<\/strong><small>Not rated<\/small>/);
  assert.match(hub, /\.api-card\.builtin-capability-card\{min-height:390px\}/);
  assert.match(hub, /\.builtin-capability-card \.api-performance\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});

test("agent hub service grid keeps three equal columns without content-driven overflow", () => {
  const hub = agentHtml({});

  assert.match(hub, /\.market-shell\.list-only > section \{ min-width:0; \}/);
  assert.match(hub, /\.market-grid > \.api-card \{ width:100%; min-width:0; \}/);
  assert.match(hub, /\.api-heading>div:last-child\{min-width:0\}/);
  assert.match(hub, /\.network-tables>section\{min-width:0\}/);
  assert.match(hub, /\.pager\{[^}]*flex-wrap:wrap/);
  assert.match(hub, /\.pager-pages\{[^}]*flex-wrap:wrap/);
});

test("research mobile header keeps actions readable without duplicate home navigation", () => {
  const page = researchHtml({ authenticated: false });

  assert.match(page, /class="research-nav"/);
  assert.match(page, /@media\(max-width:560px\)/);
  assert.doesNotMatch(page, /<a href="\/">AgentRouter<\/a>/);
  assert.match(page, /id="question-error" role="alert"/);
  assert.match(page, /#question:focus:placeholder-shown\+\.question-error\{display:block\}/);
});

test("service detail explains trust separately from evidence traces", () => {
  const page = serviceDetailHtml({
    service: {
      service_id: "external_api_exa",
      title: "Exa",
      trust: {
        feedback_state: "observed",
        trust_score: 0.84,
        trust_score_confidence: 0.96,
        operational_feedback_count: 118,
        consumer_feedback_count: 4,
        success_rate: 1
      },
      trust_basis: {
        model: "observed_call_feedback",
        caveat: "This score is not proof of claim-level factual accuracy."
      }
    },
    manifest: { service_id: "external_api_exa", pricing: { amount: "0", currency: "USDC" } },
    recent_evidence_events: [],
    recent_quality_events: []
  });

  assert.match(page, /Trust basis/);
  assert.match(page, /observed_call_feedback/);
  assert.match(page, /not proof of claim-level factual accuracy/);
});
