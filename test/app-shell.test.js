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
