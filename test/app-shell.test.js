import assert from "node:assert/strict";
import test from "node:test";
import { agentHtml, homeHtml } from "../src/home.js";
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
  assert.match(hub, /Calls<\/b>/);
  assert.match(hub, /Success<\/b>/);
  assert.match(hub, /Trust<\/b>/);
  assert.doesNotMatch(hub, /Connection required/);
  assert.doesNotMatch(hub, /Connect API to use/);
});

test("agent hub browser capability cards keep compact content height", () => {
  const hub = agentHtml({});

  assert.match(hub, /\.builtin-capability-card \.api-main\{flex:0 0 auto\}/);
  assert.match(hub, /\.builtin-capability-card \.detail-link\{[^}]*display:inline-block/);
});

test("agent hub service grid keeps three equal columns without content-driven overflow", () => {
  const hub = agentHtml({});

  assert.match(hub, /\.market-shell\.list-only > section \{ min-width:0; \}/);
  assert.match(hub, /\.market-grid > \.api-card \{ width:100%; min-width:0; \}/);
  assert.match(hub, /\.api-main > div:last-child \{ min-width:0; \}/);
});
