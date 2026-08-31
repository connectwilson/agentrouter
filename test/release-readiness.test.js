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
  assert.match(workflow, /git diff --check/);
});

test("publishable MCP behavior ships under one new consistent version", async () => {
  const manifest = JSON.parse(await fs.readFile("packages/agentrouter-mcp/package.json", "utf8"));
  const lock = JSON.parse(await fs.readFile("packages/agentrouter-mcp/package-lock.json", "utf8"));
  const server = await fs.readFile("packages/agentrouter-mcp/server/index.js", "utf8");
  assert.equal(manifest.version, "0.13.2");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.match(server, new RegExp(`serverInfo: \\{ name: "AgentRouter", version: "${manifest.version.replaceAll(".", "\\.")}" \\}`));
});

test("Render explicitly configures ERC-8004 rollout and verification lifetime", async () => {
  const blueprint = await fs.readFile("render.yaml", "utf8");
  assert.equal((blueprint.match(/key: ADN_ERC8004_DISCOVERY_ENABLED/g) || []).length, 2);
  assert.equal((blueprint.match(/key: ADN_ERC8004_VERIFICATION_TTL_MS/g) || []).length, 2);
});

test("ERC-8004 discovery can be disabled without taking AgentRouter offline", async () => {
  const app = createServer({
    store: createMemoryStore(),
    erc8004DiscoveryEnabled: false
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    const disabled = await fetch(`${origin}/agent-router/erc8004/discover?q=research`);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).error.code, "ERC8004_DISCOVERY_DISABLED");
    const health = await fetch(`${origin}/agent-router/health`);
    assert.equal((await health.json()).features.erc8004_discovery.enabled, false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("ERC-8004 rate limits expose Retry-After and discovery telemetry", async () => {
  const failure = Object.assign(new Error("upstream quota"), {
    code: "ERC8004_SCAN_RATE_LIMITED",
    statusCode: 429,
    retryAfterMs: 2500
  });
  const app = createServer({
    store: createMemoryStore(),
    erc8004Discovery: {
      search: async () => { throw failure; },
      stats: () => ({ cache_hits: 4, cache_misses: 2, upstream_requests: 2, queued_waits: 1, upstream_failures: 1 })
    }
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    const limited = await fetch(`${origin}/agent-router/erc8004/discover?q=research`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "3");
    const health = await fetch(`${origin}/agent-router/health`);
    assert.equal((await health.json()).features.erc8004_discovery.upstream_failures, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
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
