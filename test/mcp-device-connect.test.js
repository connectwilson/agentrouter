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

function createMcpClient(env) {
  const child = spawn(process.execPath, [path.join(process.cwd(), "packages/agentrouter-mcp/bin/agentrouter-mcp.js")], {
    env: { ...process.env, ...env },
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
