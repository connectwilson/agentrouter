import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { agentRouterReadiness, createServer } from "../src/server.js";

const hostedEnvironment = {
  NODE_ENV: "production",
  ADN_BROWSER_HANDOFF_SECRET: "shared-bootstrap-readiness-secret-32-chars"
};

const healthyPersistence = async () => ({
  ok: true,
  checks: { database: { ok: true, configured: true } }
});

test("readiness remains unavailable while bootstrap is still running", async () => {
  const app = createServer({
    readinessProbe: () => agentRouterReadiness({
      persistenceProbe: healthyPersistence,
      environment: hostedEnvironment,
      bootstrapProbe: async () => ({ ok: false, status: "running" })
    })
  });
  await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/agent-router/ready`);
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.checks.bootstrap, { ok: false, status: "running" });
  } finally {
    await close(app);
  }
});

test("readiness remains unavailable after bootstrap fails", async () => {
  const app = createServer({
    readinessProbe: () => agentRouterReadiness({
      persistenceProbe: healthyPersistence,
      environment: hostedEnvironment,
      bootstrapProbe: async () => ({
        ok: false,
        status: "failed",
        error: "provider hydration failed"
      })
    })
  });
  await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/agent-router/ready`);
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.checks.bootstrap, {
      ok: false,
      status: "failed",
      error: "provider hydration failed"
    });
  } finally {
    await close(app);
  }
});

test("readiness becomes available only after bootstrap completes", async () => {
  const result = await agentRouterReadiness({
    persistenceProbe: healthyPersistence,
    environment: hostedEnvironment,
    bootstrapProbe: async () => ({ ok: true, status: "completed" })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.bootstrap, { ok: true, status: "completed" });
});

test("bounded service-event hydration cannot discard every event after the oldest 10,000", async () => {
  const source = await fs.readFile(new URL("../src/persistence.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function listPersistentServiceEvents");
  const end = source.indexOf("export async function deletePersistentProviderSecret", start);
  const implementation = source.slice(start, end);

  assert.ok(start >= 0 && end > start, "listPersistentServiceEvents implementation must be inspectable");

  const boundedOldestPage = /order\s+by\s+created_at\s+asc\s*,\s*event_id\s+asc[\s\S]*?limit\s+\$\d+/i.test(implementation);
  const keysetPagination = /event_id\s*>\s*\$\d+/i.test(implementation)
    && /(?:while\s*\(|for\s*\(\s*;;\s*\))/i.test(implementation);
  const newestPageRestoredChronologically = /order\s+by\s+created_at\s+desc\s*,\s*event_id\s+desc/i.test(implementation)
    && /\.reverse\s*\(/.test(implementation);
  const unbounded = !/limit\s+\$\d+/i.test(implementation);

  assert.equal(
    boundedOldestPage && !(keysetPagination || newestPageRestoredChronologically || unbounded),
    false,
    "A bounded hydration query must paginate through all rows or load the newest rows and restore chronological replay order."
  );
});

test("Docker build context excludes local environment files and private keys", async () => {
  const dockerignore = await fs.readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  const patterns = new Set(dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")));

  for (const required of [".env*", "*.pem", "*.key"]) {
    assert.ok(patterns.has(required), `.dockerignore must contain ${required}`);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
