import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { createServer } from "../src/server.js";
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
