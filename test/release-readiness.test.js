import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { agentRouterReadiness, createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

test("readiness reports dependency failures separately from process liveness", async () => {
  const failing = createServer({
    store: createMemoryStore(),
    readinessProbe: async () => ({ ok: false, checks: { database: { ok: false, error: "unreachable" } } })
  });
  await new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve));
  try {
    const live = await fetch(`http://127.0.0.1:${failing.address().port}/health`);
    const ready = await fetch(`http://127.0.0.1:${failing.address().port}/agent-router/ready`);
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).checks.database.ok, false);
  } finally {
    await new Promise((resolve) => failing.close(resolve));
  }
});

test("release CI runs tests, package smoke checks, and dependency audit", async () => {
  const workflow = await fs.readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /mcp:npm:pack/);
  assert.match(workflow, /npm audit/);
  assert.match(workflow, /mcp-package-smoke/);
});

test("packed MCP smoke test bounds pack and install subprocess time", async () => {
  const smoke = await fs.readFile("scripts/mcp-package-smoke.js", "utf8");
  assert.match(smoke, /timeout:\s*\d+/);
  assert.match(smoke, /Packing MCP package/);
  assert.match(smoke, /Installing packed MCP/);
});

test("hosted readiness requires one shared browser handoff signing secret", async () => {
  const missing = await agentRouterReadiness({
    persistenceProbe: async () => ({ ok: true, checks: { database: { ok: true } } }),
    environment: { NODE_ENV: "production" }
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.browser_handoff_signing.ok, false);

  const configured = await agentRouterReadiness({
    persistenceProbe: async () => ({ ok: true, checks: { database: { ok: true } } }),
    environment: { NODE_ENV: "production", ADN_BROWSER_HANDOFF_SECRET: "shared-secret-at-least-32-characters" }
  });
  assert.equal(configured.ok, true);
});
