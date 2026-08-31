import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

test("unexpected request logs contain stable diagnostics but never raw error messages", async () => {
  const secretSentinel = "postgres://private-user:private-password@db.internal/agentrouter";
  const failure = Object.assign(new Error(`connection failed for ${secretSentinel}`), {
    name: "DatabaseConnectionError",
    code: "DATABASE_UNAVAILABLE",
    statusCode: 500
  });
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  const app = createServer({
    store: createMemoryStore(),
    readinessProbe: async () => { throw failure; }
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/agent-router/ready`);
    assert.equal(response.status, 500);
    const output = logs.join("\n");
    assert.match(output, /"code":"DATABASE_UNAVAILABLE"/);
    assert.match(output, /"name":"DatabaseConnectionError"/);
    assert.doesNotMatch(output, /private-password/);
    assert.doesNotMatch(output, /connection failed for/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    console.error = originalConsoleError;
  }
});

test("route-specific request diagnostics never log submitted URLs or raw failure messages", async () => {
  const secretSentinel = "private-password";
  const store = createMemoryStore();
  store.authSessions.set("request-log-session", {
    user: { provider: "github", id: "request-log-user" },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  const app = createServer({ store });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/studio/import/discover`, {
      method: "POST",
      headers: {
        cookie: "ar_session=request-log-session",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        api_url: `postgres://private-user:${secretSentinel}@db.internal/openapi`,
        default_method: "GET",
        auth_header: "authorization"
      })
    });
    assert.equal(response.status, 422);
    const output = logs.join("\n");
    assert.match(output, /\[studio\/import\/discover\] failed/);
    assert.match(output, /"code":"[A-Z0-9_.:-]+"/);
    assert.doesNotMatch(output, new RegExp(secretSentinel));
    assert.doesNotMatch(output, /postgres:\/\//);
    assert.doesNotMatch(output, /"message":/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    console.error = originalConsoleError;
  }
});
