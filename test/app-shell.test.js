import assert from "node:assert/strict";
import test from "node:test";
import { homeHtml } from "../src/home.js";
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
