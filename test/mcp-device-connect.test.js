import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { readStoredCredential, writeStoredCredential } from "../packages/agentrouter-mcp/server/credential-store.js";

test("the MCP bridge stores an origin-scoped credential in a private file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-credential-"));
  const credentialPath = path.join(root, "credentials.json");
  await writeStoredCredential({
    credentialPath,
    origin: "https://agentrouter.network/",
    accessToken: "ar_device_private",
    keyId: "key_device",
    clientName: "Claude Desktop"
  });

  const stored = await readStoredCredential({
    credentialPath,
    origin: "https://agentrouter.network"
  });
  assert.equal(stored.access_token, "ar_device_private");
  assert.equal(stored.key_id, "key_device");
  assert.equal(stored.client_name, "Claude Desktop");
  assert.equal(await readStoredCredential({ credentialPath, origin: "https://other.example" }), null);
  assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
});

test("the MCP bridge control plane initializes and lists tools without any remote network", async () => {
  const primary = await unusedLocalOrigin();
  const fallback = await unusedLocalOrigin();
  const client = createMcpClient({
    AGENT_ROUTER_URL: primary,
    AGENT_ROUTER_FALLBACK_URLS: fallback,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "1",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "250"
  });
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "offline-client", version: "1" }
    });
    const packageMetadata = JSON.parse(await fs.readFile(
      path.join(process.cwd(), "packages/agentrouter-mcp/package.json"),
      "utf8"
    ));
    assert.equal(initialized.serverInfo.name, "AgentRouter");
    assert.equal(initialized.serverInfo.version, packageMetadata.version);

    const listed = await client.request("tools/list", {});
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("agentrouter_fetch"));
    assert.ok(names.includes("agentrouter_request"));
    assert.ok(names.includes("agentrouter_connect"));
    assert.deepEqual(await client.request("ping", {}), {});
  } finally {
    client.close();
  }
});

test("agentrouter_connect completes browser approval and future MCP calls use the saved credential", async () => {
  let approved = false;
  let receivedAuthorization = "";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/device/start") {
      response.writeHead(201);
      response.end(JSON.stringify({
        device_code: "ard_test_device",
        user_code: "AR-TEST-CODE",
        verification_uri: `${baseUrl}/connect`,
        verification_uri_complete: `${baseUrl}/connect?user_code=AR-TEST-CODE`,
        expires_in: 600,
        interval: 1
      }));
      return;
    }
    if (request.url === "/auth/device/token") {
      response.writeHead(approved ? 200 : 400);
      response.end(JSON.stringify(approved
        ? { access_token: "ar_device_automatic", token_type: "Bearer", key_id: "key_automatic" }
        : { error: "authorization_pending" }));
      return;
    }
    if (request.url === "/mcp") {
      receivedAuthorization = String(request.headers.authorization || "");
      const result = body.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "AgentRouter", version: "test" } }
        : body.method === "tools/list"
          ? { tools: [{ name: "agentrouter_fetch", description: "fetch", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], isError: false };
      response.writeHead(200);
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-mcp-connect-"));
  const credentialPath = path.join(root, "credentials.json");
  const client = createMcpClient({
    AGENT_ROUTER_URL: baseUrl,
    AGENT_ROUTER_CREDENTIALS_FILE: credentialPath
  });
  try {
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
    const tools = await client.request("tools/list", {});
    assert.ok(tools.tools.some((tool) => tool.name === "agentrouter_connect"));

    const first = await client.request("tools/call", {
      name: "agentrouter_connect",
      arguments: { client_name: "Claude Desktop", wait_seconds: 0 }
    });
    const pending = JSON.parse(first.content[0].text);
    assert.equal(pending.status, "authorization_required");
    assert.equal(pending.user_code, "AR-TEST-CODE");
    assert.equal(pending.browser_open.status, "disabled");
    assert.equal("access_token" in pending, false);

    approved = true;
    const second = await client.request("tools/call", {
      name: "agentrouter_connect",
      arguments: { wait_seconds: 0 }
    });
    const connected = JSON.parse(second.content[0].text);
    assert.equal(connected.status, "connected");
    assert.equal("access_token" in connected, false);

    await client.request("tools/call", { name: "agentrouter_fetch", arguments: { task: "test" } });
    assert.equal(receivedAuthorization, "Bearer ar_device_automatic");
    assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("agentrouter_fetch turns an account-connection action into browser authorization without a second user command", async () => {
  let approved = false;
  let authenticatedFetches = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/device/start") {
      response.writeHead(201);
      response.end(JSON.stringify({
        device_code: "ard_automatic_handoff",
        user_code: "AR-AUTO",
        verification_uri: `${baseUrl}/connect`,
        verification_uri_complete: `${baseUrl}/connect?user_code=AR-AUTO`,
        expires_in: 600,
        interval: 1
      }));
      return;
    }
    if (request.url === "/auth/device/token") {
      response.writeHead(approved ? 200 : 400);
      response.end(JSON.stringify(approved
        ? { access_token: "ar_automatic_handoff", token_type: "Bearer", key_id: "key_auto" }
        : { error: "authorization_pending" }));
      return;
    }
    if (request.url === "/mcp") {
      const authenticated = request.headers.authorization === "Bearer ar_automatic_handoff";
      if (body.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "AgentRouter", version: "test" } } }));
        return;
      }
      if (body.method === "tools/call" && body.params?.name === "agentrouter_fetch") {
        if (authenticated) authenticatedFetches += 1;
        const value = authenticated
          ? { ok: true, status: "data_returned", answer: "authorized result" }
          : {
              ok: false,
              status: "connection_required",
              error: { code: "AGENTROUTER_CONNECTION_REQUIRED" },
              action_required: { action: "connect_agentrouter_account", preferred_tool: "agentrouter_connect" }
            };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } }));
        return;
      }
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-mcp-auto-connect-"));
  const client = createMcpClient({
    AGENT_ROUTER_URL: baseUrl,
    AGENT_ROUTER_CREDENTIALS_FILE: path.join(root, "credentials.json")
  });
  const request = { name: "agentrouter_fetch", arguments: { task: "research Rialto" } };
  try {
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });

    const first = await client.request("tools/call", request);
    const authorization = JSON.parse(first.content[0].text);
    assert.equal(authorization.status, "authorization_required");
    assert.equal(authorization.action, "open_browser_approval");
    assert.equal(authorization.verification_uri_complete, `${baseUrl}/connect?user_code=AR-AUTO`);
    assert.equal(authorization.retry_original_request, true);
    assert.doesNotMatch(JSON.stringify(authorization), /install|reload/i);

    approved = true;
    const retried = await client.request("tools/call", request);
    assert.equal(JSON.parse(retried.content[0].text).answer, "authorized result");
    assert.equal(authenticatedFetches, 1);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("browser account authorization fails over when the canonical origin cannot resolve or connect", async () => {
  const primary = await unusedLocalOrigin();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/device/start") {
      response.writeHead(201);
      response.end(JSON.stringify({
        device_code: "ard_fallback",
        user_code: "AR-FALLBACK",
        verification_uri: "https://agentrouter.network/connect",
        verification_uri_complete: "https://agentrouter.network/connect?user_code=AR-FALLBACK",
        expires_in: 600,
        interval: 1
      }));
      return;
    }
    if (request.url === "/auth/device/token") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "authorization_pending" }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fallback = `http://127.0.0.1:${server.address().port}`;
  const client = createMcpClient({
    AGENT_ROUTER_URL: primary,
    AGENT_ROUTER_FALLBACK_URLS: fallback,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "2",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "250"
  });
  try {
    const result = await client.request("tools/call", {
      name: "agentrouter_connect",
      arguments: { client_name: "offline-client", wait_seconds: 0 }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.status, "authorization_required");
    assert.equal(payload.user_code, "AR-FALLBACK");
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the MCP bridge retries an explicit transient upstream response", async () => {
  let attempts = 0;
  const server = http.createServer(async (request, response) => {
    attempts += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (attempts === 1) {
      response.setHeader("x-agentrouter-retry-safe", "true");
      response.writeHead(503);
      response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, answer: "recovered" }) }],
        isError: false
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createMcpClient({
    AGENT_ROUTER_URL: baseUrl,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "3",
    AGENT_ROUTER_REMOTE_RETRY_MS: "20",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "1000"
  });
  try {
    const result = await client.request("tools/call", {
      name: "agentrouter_fetch",
      arguments: { task: "research a product" }
    });
    assert.equal(JSON.parse(result.content[0].text).answer, "recovered");
    assert.equal(attempts, 2);
  } finally {
    client.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test("the MCP bridge fails over, stays on the healthy origin, and probes the primary after cooldown", async () => {
  let primaryHealthy = false;
  let fallbackHealthy = true;
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  const handler = (kind) => async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (kind === "primary") primaryAttempts += 1;
    else fallbackAttempts += 1;
    const healthy = kind === "primary" ? primaryHealthy : fallbackHealthy;
    response.setHeader("content-type", "application/json");
    if (!healthy) {
      response.setHeader("x-agentrouter-retry-safe", "true");
      response.writeHead(503);
      response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, answer: `${kind}-result` }) }],
        isError: false
      }
    }));
  };
  const primaryServer = http.createServer(handler("primary"));
  const fallbackServer = http.createServer(handler("fallback"));
  await new Promise((resolve) => primaryServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => fallbackServer.listen(0, "127.0.0.1", resolve));
  const primary = `http://127.0.0.1:${primaryServer.address().port}`;
  const fallback = `http://127.0.0.1:${fallbackServer.address().port}`;
  const client = createMcpClient({
    AGENT_ROUTER_URL: primary,
    AGENT_ROUTER_FALLBACK_URLS: fallback,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "2",
    AGENT_ROUTER_REMOTE_RETRY_MS: "10",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "1000",
    AGENT_ROUTER_REMOTE_COOLDOWN_MS: "100"
  });
  const request = { name: "agentrouter_fetch", arguments: { task: "research a product" } };
  try {
    const first = JSON.parse((await client.request("tools/call", request)).content[0].text);
    const second = JSON.parse((await client.request("tools/call", request)).content[0].text);
    assert.equal(first.answer, "fallback-result");
    assert.equal(second.answer, "fallback-result");
    assert.equal(primaryAttempts, 1, "the unhealthy primary stays out of the hot path during cooldown");
    assert.equal(fallbackAttempts, 2);

    primaryHealthy = true;
    fallbackHealthy = false;
    await new Promise((resolve) => setTimeout(resolve, 130));
    const recovered = JSON.parse((await client.request("tools/call", request)).content[0].text);
    assert.equal(recovered.answer, "primary-result");
    assert.equal(primaryAttempts, 2, "the primary is probed again after cooldown instead of remaining disabled forever");
  } finally {
    client.close();
    await new Promise((resolve) => primaryServer.close(resolve));
    await new Promise((resolve) => fallbackServer.close(resolve));
  }
});

test("the MCP bridge does not automatically replay a paid-capable tool call unless the server marks it retry-safe", async () => {
  let attempts = 0;
  const server = http.createServer(async (request, response) => {
    attempts += 1;
    for await (const _chunk of request) {
      // Drain the request before returning the simulated gateway failure.
    }
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily_unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createMcpClient({
    AGENT_ROUTER_URL: baseUrl,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "3",
    AGENT_ROUTER_REMOTE_RETRY_MS: "10",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "1000"
  });
  try {
    const result = await client.request("tools/call", {
      name: "agentrouter_fetch",
      arguments: { task: "research a product" }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.status, "temporarily_unavailable");
    assert.equal(payload.error.attempts, 1);
    assert.equal(attempts, 1);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the MCP bridge opens a short circuit after an outage instead of repeatedly waiting on the same dead upstream", async () => {
  let attempts = 0;
  const server = http.createServer(async (request, response) => {
    attempts += 1;
    for await (const _chunk of request) {
      // Drain the request before returning the simulated outage.
    }
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily_unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createMcpClient({
    AGENT_ROUTER_URL: baseUrl,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "1",
    AGENT_ROUTER_REMOTE_COOLDOWN_MS: "1000",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "1000"
  });
  try {
    const request = {
      name: "agentrouter_fetch",
      arguments: { task: "research a product" }
    };
    const first = JSON.parse((await client.request("tools/call", request)).content[0].text);
    const second = JSON.parse((await client.request("tools/call", request)).content[0].text);
    assert.equal(first.error.category, "upstream_http");
    assert.equal(second.error.category, "circuit_open");
    assert.equal(second.error.attempts, 0);
    assert.equal(second.retryable, true);
    assert.equal(attempts, 1);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an exhausted remote outage returns a structured retry boundary instead of a JSON-RPC tool failure", async () => {
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const fallback = await unusedLocalOrigin();
  const client = createMcpClient({
    AGENT_ROUTER_URL: `http://127.0.0.1:${port}`,
    AGENT_ROUTER_FALLBACK_URLS: fallback,
    AGENT_ROUTER_REMOTE_ATTEMPTS: "2",
    AGENT_ROUTER_REMOTE_TIMEOUT_MS: "250"
  });
  try {
    const result = await client.request("tools/call", {
      name: "agentrouter_fetch",
      arguments: { task: "research a product" }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.status, "temporarily_unavailable");
    assert.equal(payload.error.code, "AGENTROUTER_REMOTE_UNAVAILABLE");
    assert.equal(payload.retry_original_request, true);
    assert.equal(payload.do_not_fallback_outside_agentrouter, true);
    assert.equal(payload.error.failover_attempted, true);
    assert.equal(payload.error.attempted_origins.length, 2);
    assert.equal(result.isError, false);
  } finally {
    client.close();
  }
});

async function unusedLocalOrigin() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return origin;
}

function createMcpClient(env) {
  const child = spawn(process.execPath, [path.join(process.cwd(), "packages/agentrouter-mcp/bin/agentrouter-mcp.js")], {
    env: { ...process.env, AGENTROUTER_DISABLE_BROWSER_OPEN: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let id = 0;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const callbacks = pending.get(message.id);
      if (!callbacks) continue;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const callbacks of pending.values()) callbacks.reject(new Error(String(chunk)));
    pending.clear();
  });
  return {
    request(method, params) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    },
    close() { child.kill(); }
  };
}
