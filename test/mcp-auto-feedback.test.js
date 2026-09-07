import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { bridgeMcpTools, remoteMcpTools } from "../packages/agentrouter-mcp/server/tool-catalog.js";

test("the MCP bridge records feedback inside the original data call", async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    calls.push(body.params?.name || body.method);
    response.setHeader("content-type", "application/json");
    response.writeHead(200);
    if (body.params?.name === "agentrouter_feedback") {
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: toolResult({
          ok: true,
          status: "consumer_feedback_recorded",
          request_id: "req_auto_1",
          service_id: "external_api_exa",
          trust_anchor: { state: "offchain_recorded" },
          erc8004: { status: "not_configured" }
        })
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: toolResult({
        ok: true,
        status: "data_returned",
        feedback_required: true,
        next_required_action: "Submit agentrouter_feedback.",
        results: [{
          ok: true,
          status: "completed",
          request_id: "req_auto_1",
          service_id: "external_api_exa",
          result: { items: [{ title: "evidence" }], count: 1 },
          verification: { overall_quality_score: 0.92, coverage_valid: true, intent_fit_valid: true },
          consumer_feedback_request: {
            request_id: "req_auto_1",
            service_id: "external_api_exa",
            feedback_token: "feedback-token",
            must_submit: true,
            example: {
              request_id: "req_auto_1",
              feedback_token: "feedback-token",
              feedback: {
                intent_fit: "yes",
                answer_useful: "yes",
                confidence: 0.9,
                reason: "Results matched the requested evidence."
              }
            }
          }
        }]
      })
    }));
  });
  await listen(server);
  const client = createMcpClient(serverUrl(server));
  try {
    const response = await client.request("tools/call", {
      name: "agentrouter_fetch",
      arguments: { task: "research AgentRouter" }
    });
    const result = JSON.parse(response.content[0].text);

    assert.deepEqual(calls, ["agentrouter_fetch", "agentrouter_feedback"]);
    assert.equal(result.feedback_required, false);
    assert.equal(result.next_required_action, null);
    assert.equal(result.results[0].automatic_feedback.status, "consumer_feedback_recorded");
    assert.equal(result.results[0].consumer_feedback_request.must_submit, false);
    assert.equal(result.results[0].consumer_feedback_request.status, "auto_submitted");
    assert.doesNotMatch(response.content[0].text, /Submit agentrouter_feedback/);
  } finally {
    client.close();
    await close(server);
  }
});

test("an automatic feedback outage never hides otherwise usable data or asks for a second tool call", async () => {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader("content-type", "application/json");
    if (body.params?.name === "agentrouter_feedback") {
      response.writeHead(503, { "x-agentrouter-retry-safe": "true" });
      response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: toolResult({
        ok: true,
        status: "completed",
        request_id: "req_auto_failure",
        service_id: "external_api_exa",
        result: { items: [{ title: "still usable" }], count: 1 },
        verification: { coverage_valid: true, intent_fit_valid: true },
        consumer_feedback_request: {
          request_id: "req_auto_failure",
          service_id: "external_api_exa",
          feedback_token: "feedback-token",
          must_submit: true
        }
      })
    }));
  });
  await listen(server);
  const client = createMcpClient(serverUrl(server), { AGENT_ROUTER_REMOTE_ATTEMPTS: "1" });
  try {
    const response = await client.request("tools/call", {
      name: "agentrouter_request",
      arguments: { capability: "external_api_query", params: { source: "exa" } }
    });
    const result = JSON.parse(response.content[0].text);

    assert.equal(result.ok, true);
    assert.equal(result.result.items[0].title, "still usable");
    assert.equal(result.automatic_feedback.status, "auto_feedback_deferred");
    assert.equal(result.consumer_feedback_request.must_submit, false);
    assert.equal(result.consumer_feedback_request.status, "auto_deferred");
    assert.doesNotMatch(response.content[0].text, /agentrouter_feedback/);
  } finally {
    client.close();
    await close(server);
  }
});

test("explicit feedback is accurately annotated as non-destructive and idempotent", () => {
  const tool = remoteMcpTools.find((candidate) => candidate.name === "agentrouter_feedback");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  });
});

for (const verification of [{}, { source_urls_present: true }, { overall_quality_score: null }, { coverage_valid: true }]) {
  test(`nonempty data is not proof of intent fit: ${JSON.stringify(verification)}`, async () => {
    const calls = [];
    const server = http.createServer(async (request, response) => {
      const body = await readJson(request);
      calls.push(body.params.name);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: toolResult({
        ok: true, status: "completed", request_id: "pons_wrong_pools",
        result: { items: [{ title: "BREW / WBNB", metadata: { network: "bsc" } }] }, verification,
        consumer_feedback_request: { request_id: "pons_wrong_pools", must_submit: true }
      }) }));
    });
    await listen(server);
    const client = createMcpClient(serverUrl(server));
    try {
      const response = await client.request("tools/call", { name: "agentrouter_fetch", arguments: { task: "查robinhood链上PONS代币的前10大 token holder的地址" } });
      const value = JSON.parse(response.content[0].text);
      assert.deepEqual(calls, ["agentrouter_fetch"]);
      assert.equal(value.automatic_feedback.status, "assessment_unavailable");
      assert.notEqual(value.consumer_feedback_request.timing, "submitted_with_original_call");
      assert.equal(value.consumer_feedback_request.must_submit, false);
      assert.equal(value.result.items.length, 1);
    } finally { client.close(); await close(server); }
  });
}

test("every MCP tool declares an explicit least-privilege safety contract", () => {
  const expected = {
    agentrouter_fetch: safety(false, false),
    agentrouter_connect_source: safety(false, true),
    agentrouter_request: safety(false, false),
    agentrouter_quote: safety(true, false),
    agentrouter_quote_feedback: safety(false, true),
    agentrouter_capabilities: safety(true, true, false),
    agentrouter_feedback: safety(false, true),
    agentrouter_ask: safety(false, false),
    agentrouter_connect: safety(false, false),
    agentrouter_complete_handoff: safety(false, false)
  };

  assert.deepEqual(
    Object.fromEntries(bridgeMcpTools.map((tool) => [tool.name, tool.annotations])),
    expected
  );
});

function safety(readOnlyHint, idempotentHint, openWorldHint = true) {
  return {
    readOnlyHint,
    destructiveHint: false,
    idempotentHint,
    openWorldHint
  };
}

for (const [verification, items, fit, useful] of [
  [{ intent_fit_valid: false }, [{ title: "wrong chain" }], "no", "no"],
  [{ schema_valid: false }, [{ title: "pool instead of holder" }], "no", "no"],
  [{ coverage_valid: false }, [{ title: "incomplete" }], "partial", "unknown"],
  [{ intent_fit_valid: true, coverage_valid: true }, [], "no", "no"],
  [{ intent_fit_valid: true, coverage_valid: true, overall_quality_score: null }, [{ title: "matched" }], "yes", "yes"]
]) {
  test(`automatic assessment respects verification: ${JSON.stringify(verification)}, rows=${items.length}`, async () => {
    let submitted;
    const server = http.createServer(async (request, response) => {
      const body = await readJson(request);
      const isFeedback = body.params.name === "agentrouter_feedback";
      if (isFeedback) submitted = body.params.arguments.feedback;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: toolResult(isFeedback
        ? { ok: true, status: "consumer_feedback_recorded" }
        : { ok: true, result: { items }, verification, consumer_feedback_request: { request_id: "assessment_case", must_submit: true } }) }));
    });
    await listen(server);
    const client = createMcpClient(serverUrl(server));
    try {
      await client.request("tools/call", { name: "agentrouter_fetch", arguments: { task: "test assessment" } });
      assert.equal(submitted.intent_fit, fit);
      assert.equal(submitted.answer_useful, useful);
      assert.equal(submitted.data_quality_score, undefined, "missing/null quality is not numeric zero");
    } finally { client.close(); await close(server); }
  });
}

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function createMcpClient(origin, env = {}) {
  const child = spawn(process.execPath, [path.join(process.cwd(), "packages/agentrouter-mcp/bin/agentrouter-mcp.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_ROUTER_URL: origin,
      AGENT_ROUTER_API_KEY: "ar_test_auto_feedback",
      AGENT_ROUTER_REMOTE_RETRY_MS: "10",
      AGENTROUTER_DISABLE_BROWSER_OPEN: "1",
      ...env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 0;
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
    const error = new Error(String(chunk));
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });
  return {
    request(method, params) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      child.kill();
    }
  };
}
