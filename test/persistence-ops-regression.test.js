import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { listPersistentServiceEvents } from "../src/persistence.js";
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

test("service-event hydration keyset-pages every row beyond 10,000 in reducer order", async () => {
  const storedRows = Array.from({ length: 10001 }, (_, index) => {
    const createdAt = new Date(1_700_000_000_000 + Math.floor(index / 3) * 1000).toISOString();
    return {
      event_id: String(index + 1),
      event_type: index === 0 ? "provider_claim" : "consumer_feedback",
      service_id: `service-${index % 7}`,
      request_id: `request-${index + 1}`,
      event: { sequence: index + 1 },
      created_at: createdAt,
      created_at_cursor: createdAt
    };
  });
  const requestedPageSizes = [];
  let queryCount = 0;

  const hydrated = await listPersistentServiceEvents({
    limit: 257,
    query: async (sql, params) => {
      queryCount += 1;
      assert.match(sql, /order by created_at asc, event_id asc/i);
      assert.match(sql, /event_id > \$2/i);
      const [afterCreatedAt, afterEventId, requestedPageSize] = params;
      requestedPageSizes.push(requestedPageSize);
      const start = afterEventId === null ? 0 : Number(afterEventId);
      if (start > 0) assert.equal(String(afterCreatedAt), storedRows[start - 1].created_at_cursor);
      return { rows: storedRows.slice(start, start + requestedPageSize) };
    }
  });

  assert.equal(hydrated.length, storedRows.length);
  assert.deepEqual(hydrated.map((row) => row.event.sequence), storedRows.map((row) => row.event.sequence));
  assert.equal(hydrated[0].event_type, "provider_claim", "old claims must survive hydration");
  assert.equal(hydrated.at(-1).event.sequence, 10001, "newest state must survive hydration");
  assert.ok(queryCount > 1, "hydration must use multiple bounded pages");
  assert.ok(requestedPageSizes.every((size) => size === 257), "every database query must stay page-bounded");
});

test("service-event hydration fails fast when a keyset page makes no cursor progress", async () => {
  const repeatedPage = [1, 2].map((eventId) => ({
    event_id: String(eventId),
    event_type: "consumer_feedback",
    service_id: "service-stalled",
    request_id: `request-${eventId}`,
    event: { sequence: eventId },
    created_at: "2026-08-31T00:00:00.000Z",
    created_at_cursor: "2026-08-31T00:00:00.000Z"
  }));
  let queryCount = 0;

  await assert.rejects(
    listPersistentServiceEvents({
      limit: 2,
      query: async () => {
        queryCount += 1;
        return { rows: repeatedPage };
      }
    }),
    /cursor.*(?:progress|stalled)/i
  );
  assert.ok(queryCount <= 2, "a stalled database page must not create an infinite loop");
});

test("incremental service-event reads use the durable event id so backdated events are not skipped", async () => {
  const backdated = {
    event_id: "11",
    event_type: "evidence",
    service_id: "service-live",
    request_id: "request-backdated",
    event: { sequence: 11, created_at: "2020-01-01T00:00:00.000Z" },
    created_at: "2020-01-01T00:00:00.000Z",
    created_at_cursor: "2020-01-01T00:00:00.000Z"
  };
  let queryCount = 0;

  const events = await listPersistentServiceEvents({
    limit: 100,
    afterCreatedAt: "2030-01-01T00:00:00.000Z",
    afterEventId: "10",
    query: async (sql, params) => {
      queryCount += 1;
      assert.match(sql, /where\s+event_id\s*>\s*\$1/i);
      assert.match(sql, /order by\s+event_id\s+asc/i);
      assert.deepEqual(params, ["10", 100]);
      return { rows: queryCount === 1 ? [backdated] : [] };
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, "11");
  assert.equal(events[0].created_at_cursor, backdated.created_at_cursor);
});

test("service-event schema indexes the chronological hydration cursor", async () => {
  const source = await fs.readFile(new URL("../src/persistence.js", import.meta.url), "utf8");
  assert.match(
    source,
    /create index if not exists \w+\s+on adn_service_events\s*\(created_at\s*,\s*event_id\s*\)/i
  );
});

test("service-event writers serialize id allocation so the incremental high-water mark cannot skip a late commit", async () => {
  const source = await fs.readFile(new URL("../src/persistence.js", import.meta.url), "utf8");
  assert.match(
    source,
    /writePersistentServiceEvent[\s\S]*pg_advisory_xact_lock[\s\S]*insert into adn_service_events/i
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
