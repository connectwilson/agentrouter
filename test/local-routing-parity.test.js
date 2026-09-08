import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-local-routing-"));
const mcpPackageBin = fileURLToPath(new URL("../packages/agentrouter-mcp/bin/agentrouter-mcp.js", import.meta.url));
process.env.ADN_DIR = path.join(runtimeRoot, ".adn");
process.env.ADN_PROVIDER_DIR = path.join(runtimeRoot, "providers");
process.env.ADN_WALLET_PASSPHRASE = "test-passphrase";
process.env.ADN_PAYMENT_BACKEND = "circle_arc";
process.env.ADN_ARC_BALANCE_MOCK = "1000";
process.env.ADN_ARC_TRANSFER_MODE = "mock";
process.env.ADN_ARC_VERIFY_MODE = "mock";
process.env.ADN_ARC_ANCHOR_MODE = "mock";
process.env.ADN_ERC8004_MODE = "mock";
process.env.ADN_ERC8004_AGENT_ID = "1001";
process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb";

const { routeCapabilityRequestWithLocalWallet, routeTaskWithLocalWallet } = await import("../src/local-route.js");
const { createServer, seedDemoService } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");
const { attachLocalFeedbackGrant } = await import("../packages/agentrouter-mcp/server/index.js");
const {
  decorateStandaloneLocalResult,
  handleLocalStructuredSocialBatchRequest
} = await import("../packages/agentrouter-mcp/server/local-routing.js");
const { initSessionWallet, resetWalletForTests } = await import("../src/wallet.js");

test.after(async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
});

async function withServer(run, options = {}) {
  await resetWalletForTests();
  await fs.rm(process.env.ADN_PROVIDER_DIR, { recursive: true, force: true });
  await fs.mkdir(process.env.ADN_PROVIDER_DIR, { recursive: true });
  await initSessionWallet({ force: true });
  const server = createServer({
    store: options.store || createMemoryStore(),
    serviceEventPersistence: {
      refreshConfigs: async () => [],
      refresh: async () => ({ ok: true, status: "fresh", loaded: 0 }),
      writeEvent: async () => true
    },
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await seedDemoService(baseUrl, server.store);
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

function normalizedObservation(value) {
  return {
    action: value?.action,
    route_family: value?.route_family,
    capability: value?.capability,
    durability_status: value?.durability_status,
    feedback_endpoint: value?.feedback_endpoint || null
  };
}

async function withStubServer(handler, run) {
  await resetWalletForTests();
  await fs.rm(process.env.ADN_PROVIDER_DIR, { recursive: true, force: true });
  await fs.mkdir(process.env.ADN_PROVIDER_DIR, { recursive: true });
  await initSessionWallet({ force: true });
  const server = http.createServer((req, res) => handler(req, res, server));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function callLocalMcpPackage(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPackageBin], {
      env: { ...process.env, AGENT_ROUTER_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`local MCP exited ${code}: ${stderr}`));
        return;
      }
      const responses = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      resolve(responses.find((entry) => entry.id === message.id));
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

async function withLocalMcpPackageConversation(run) {
  const child = spawn(process.execPath, [mcpPackageBin], {
    env: {
      ...process.env,
      AGENT_ROUTER_URL: "http://127.0.0.1:1",
      AGENT_ROUTER_REMOTE_ATTEMPTS: "1",
      AGENT_ROUTER_REMOTE_TIMEOUT_MS: "250"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const newline = stdout.indexOf("\n");
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const payload = JSON.parse(line);
      const waiter = pending.get(payload.id);
      if (waiter) {
        pending.delete(payload.id);
        waiter.resolve(payload);
      }
    }
  });
  child.once("error", (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const call = (message) => new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  try {
    await run(call);
  } finally {
    child.stdin.end();
    const code = await new Promise((resolve) => child.once("close", resolve));
    if (code !== 0) throw new Error(`local MCP exited ${code}: ${stderr}`);
  }
}

function weatherFetch(url) {
  if (String(url).includes("geocoding-api")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          name: "Taipei",
          country: "Taiwan",
          latitude: 25.04,
          longitude: 121.56,
          timezone: "Asia/Taipei"
        }]
      })
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      current: { temperature_2m: 30, weather_code: 1 },
      current_units: { temperature_2m: "°C" }
    })
  });
}

function registeredCanonicalStub({
  observationId = "route_obs_stub_connect",
  requestId = "route_req_stub_connect"
} = {}) {
  return {
    ok: false,
    status: "connection_required",
    route_plan: {
      schema_version: "agentrouter_route_plan_v1",
      task_family: "market_data",
      data_family: "derivatives_market",
      route_family: "registered_service",
      capability: "perp_liquidation_max_pain",
      source_constraint: null,
      provider_constraint: null,
      candidate_sources: ["agentrouter_registry"],
      candidate_scores: [],
      params: { asset: "BTC", market_type: "perpetual_futures", window: "current" },
      estimated_price_usdc: "0.02",
      confidence: 0.96,
      top1_top2_margin: 1,
      auth_requirement: { required: true, kind: "agentrouter_account", source: null },
      budget_gate: { max_price_usdc: "0.05", paid_calls_allowed: true, status: "allowed" },
      abstain_reason: null,
      must_not_fallback: true
    },
    routing_observation: {
      observation_id: observationId,
      request_id: requestId,
      action: "connect_account",
      route_family: "registered_service",
      capability: "perp_liquidation_max_pain",
      durability_status: "durable",
      feedback_endpoint: null
    }
  };
}

test("local natural-language wallet routing reuses the hosted canonical route plan for clarify and local-browser branches", async () => {
  await withServer(async (baseUrl) => {
    const cases = [
      { task: "帮我研究一下这个东西。", expectedStatus: "needs_clarification", expectedRouteFamily: "none", httpBody: { task: "帮我研究一下这个东西。" } },
      { task: "查找小红书上，人们对 Agent 交易的看法", expectedStatus: "local_browser_handoff_required", expectedRouteFamily: "local_browser", httpBody: { task: "查找小红书上，人们对 Agent 交易的看法", max_price: "0.05" } }
    ];

    for (const entry of cases) {
      const http = await postJson(baseUrl, "/agent-router/fetch", entry.httpBody);
      const local = await routeTaskWithLocalWallet({
        baseUrl,
        task: entry.task,
        ...(entry.httpBody.max_price ? { constraints: { max_price_usdc: entry.httpBody.max_price } } : {})
      });

      assert.equal(local.status, entry.expectedStatus, entry.task);
      assert.equal(local.route_plan?.schema_version, "agentrouter_route_plan_v1", entry.task);
      assert.equal(local.route_plan?.route_family, entry.expectedRouteFamily, entry.task);
      assert.deepEqual(local.route_plan, http.payload.route_plan, entry.task);
      assert.deepEqual(normalizedObservation(local.routing_observation), normalizedObservation(http.payload.routing_observation), entry.task);
      assert.ok(local.routing_observation?.observation_id, entry.task);
      assert.ok(local.routing_observation?.request_id, entry.task);
    }
  });
});

test("local natural-language wallet preflight does not inject a default explicit budget into hosted canonical routing", async () => {
  const seenBodies = [];
  await withStubServer(async (req, res, server) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    seenBodies.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      status: "connection_required",
      route_plan: {
        schema_version: "agentrouter_route_plan_v1",
        task_family: "research",
        data_family: "public_web",
        route_family: "external_api",
        capability: "public_web_research",
        source_constraint: "firecrawl",
        provider_constraint: null,
        candidate_sources: ["firecrawl"],
        candidate_scores: [],
        params: { source: "firecrawl", query: body.task },
        estimated_price_usdc: null,
        confidence: 0.9,
        top1_top2_margin: 1,
        auth_requirement: { required: true, kind: "agentrouter_account", source: null },
        budget_gate: { max_price_usdc: null, paid_calls_allowed: true, status: "allowed" },
        abstain_reason: null,
        must_not_fallback: true
      },
      routing_observation: {
        observation_id: "route_obs_stub_fetch",
        request_id: "route_req_stub_fetch",
        action: "connect_account",
        route_family: "external_api",
        capability: "public_web_research",
        durability_status: "durable",
        feedback_endpoint: null
      }
    }));
  }, async (baseUrl) => {
    const local = await routeTaskWithLocalWallet({
      baseUrl,
      task: "Use Firecrawl API to research AgentRouter competitors."
    });
    assert.equal(local.status, "connection_required");
  });

  assert.equal(seenBodies.length, 1);
  assert.equal(seenBodies[0].path, "/agent-router/fetch");
  assert.equal(Object.hasOwn(seenBodies[0].body, "max_price"), false);
  assert.equal(Object.hasOwn(seenBodies[0].body, "budget"), false);
  assert.equal(Object.hasOwn(seenBodies[0].body, "constraints"), false);
});

test("local structured wallet routing returns the hosted canonical result for free external API requests", async () => {
  await withServer(async (baseUrl) => {
    const request = {
      capability: "external_api_query",
      params: { source: "open_meteo", operation: "forecast", query: "Taipei" }
    };
    const http = await postJson(baseUrl, "/agent-router/request", request);
    const local = await routeCapabilityRequestWithLocalWallet({ baseUrl, request });

    assert.equal(http.response.status, 200);
    assert.equal(local.ok, true);
    assert.equal(local.status, "completed");
    assert.equal(local.route_plan?.schema_version, "agentrouter_route_plan_v1");
    assert.equal(local.routing_observation?.durability_status, "durable");
    assert.deepEqual(local.route_plan, http.payload.route_plan);
    assert.deepEqual(normalizedObservation(local.routing_observation), normalizedObservation(http.payload.routing_observation));
    assert.ok(local.routing_observation?.observation_id);
    assert.ok(local.routing_observation?.request_id);
    assert.equal(local.local_payment, undefined);
    assert.match(local.result?.items?.[0]?.title || "", /Taipei/);
  }, {
    socialConnectionOptions: { fetchImpl: weatherFetch }
  });
});

test("local natural-language wallet execution replaces stale connect-account routing state after a successful paid route", async () => {
  let providerCalls = 0;
  let completedCallBody = null;
  await withStubServer(async (req, res, server) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (req.url === "/agent-router/fetch") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        status: "connection_required",
        route_plan: {
          schema_version: "agentrouter_route_plan_v1",
          task_family: "market_data",
          data_family: "derivatives_market",
          route_family: "registered_service",
          capability: "perp_liquidation_max_pain",
          source_constraint: null,
          provider_constraint: null,
          candidate_sources: ["agentrouter_registry"],
          candidate_scores: [],
          params: { asset: "BTC", market_type: "perpetual_futures", window: "current" },
          estimated_price_usdc: "0.02",
          confidence: 0.96,
          top1_top2_margin: 1,
          auth_requirement: { required: true, kind: "agentrouter_account", source: null },
          budget_gate: { max_price_usdc: null, paid_calls_allowed: true, status: "allowed" },
          abstain_reason: null,
          must_not_fallback: true
        },
        routing_observation: {
          observation_id: "route_obs_stub_connect",
          request_id: "route_req_stub_connect",
          action: "connect_account",
          route_family: "registered_service",
          capability: "perp_liquidation_max_pain",
          durability_status: "durable",
          feedback_endpoint: null
        }
      }));
      return;
    }
    if (req.url === "/agent-router/quote") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        status: "payment_required",
        request: body,
        input: { symbol: "BTCUSDT" },
        selected_service: { service_id: "btc_liquidation_max_pain_demo" },
        quote: { amount: "0.02", currency: "USDC" }
      }));
      return;
    }
    if (req.url === "/connector/get_manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        service_id: "btc_liquidation_max_pain_demo",
        manifest_type: "hosted_http_data_api",
        provider: { provider_id: "provider_btc_liquidation_max_pain_demo" },
        endpoint: {
          url: `http://127.0.0.1:${server.address().port}/provider/mock`,
          method: "POST"
        },
        pricing: {
          amount: "0.02",
          currency: "USDC",
          network: "base",
          pay_to: "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb"
        }
      }));
      return;
    }
    if (req.url === "/provider/mock") {
      providerCalls += 1;
      if (providerCalls === 1) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({
          payment: {
            amount: "0.02",
            asset: "USDC",
            network: "base",
            pay_to: "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb",
            nonce: "challenge_nonce_stub",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            resource_hash: "0xresourcehash",
            service_id: "btc_liquidation_max_pain_demo",
            completion_grant: "grant_stub"
          }
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: "success",
        request_id: "req_paid_local_stub",
        data: { max_pain_price: 12345 }
      }));
      return;
    }
    if (req.url === "/agent-router/calls/complete") {
      completedCallBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        request_id: "req_paid_local_stub",
        evidence: { recorded: true },
        feedback: { billing_status: "charged_success" },
        consumer_feedback_request: {
          request_id: "req_paid_local_stub",
          service_id: "btc_liquidation_max_pain_demo"
        },
        routing_observation: {
          observation_id: "route_obs_stub_connect",
          request_id: "route_req_stub_connect",
          action: "route",
          route_family: "registered_service",
          capability: "perp_liquidation_max_pain",
          durability_status: "durable",
          feedback_endpoint: "/agent-router/feedback"
        }
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unhandled ${req.url}` } }));
  }, async (baseUrl, server) => {
    const task = "BTC 当前最大爆仓痛点是多少";
    const local = await routeTaskWithLocalWallet({ baseUrl, task });

    assert.equal(local.status, "paid_with_local_wallet");
    assert.equal(local.route_plan?.route_family, "registered_service");
    assert.deepEqual(local.route_plan?.auth_requirement, { required: false, kind: "none", source: null });
    assert.equal(local.routing_observation?.action, "route");
    assert.equal(local.routing_observation?.route_family, "registered_service");
    assert.equal(local.routing_observation?.durability_status, "durable");
    assert.equal(local.routing_observation?.feedback_endpoint, "/agent-router/feedback");
    assert.equal(local.routing_observation?.observation_id, "route_obs_stub_connect");
    assert.equal(local.routing_observation?.request_id, "route_req_stub_connect");
    assert.ok(local.local_payment?.status === "success");
    assert.equal(completedCallBody.routing_observation.observation_id, "route_obs_stub_connect");
    assert.equal(completedCallBody.routing_observation.request_id, "route_req_stub_connect");
    assert.equal(completedCallBody.routing_summary.action, "route");
    assert.equal(completedCallBody.routing_summary.route_family, "registered_service");
    assert.equal(completedCallBody.routing_summary.selected_service_id, "btc_liquidation_max_pain_demo");
    assert.equal(JSON.stringify(completedCallBody.routing_summary).includes(task), false);
  });
});

test("local wallet quote blocking replaces stale allowed/connect-account routing state", async () => {
  await withStubServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/agent-router/fetch") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(registeredCanonicalStub()));
      return;
    }
    if (req.url === "/agent-router/quote") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        status: "quote_blocked",
        quote: { would_pay: false, amount: "0.02", currency: "USDC" },
        error: { code: "BUDGET_EXCEEDED", message: "The route exceeds the budget." }
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unhandled ${req.url}` } }));
  }, async (baseUrl) => {
    const local = await routeTaskWithLocalWallet({
      baseUrl,
      task: "BTC 当前最大爆仓痛点是多少",
      constraints: { max_price_usdc: "0.001" }
    });

    assert.equal(local.status, "quote_blocked");
    assert.equal(local.route_plan.auth_requirement.kind, "none");
    assert.equal(local.route_plan.budget_gate.status, "blocked");
    assert.equal(local.route_plan.budget_gate.paid_calls_allowed, false);
    assert.equal(local.route_plan.abstain_reason, "budget_exceeded");
    assert.equal(local.routing_observation.action, "no_match");
    assert.equal(local.routing_observation.durability_status, "memory_only");
    assert.notEqual(local.routing_observation.observation_id, "route_obs_stub_connect");
  });
});

test("local wallet invocation failure replaces stale connect-account state without mislabeling the route", async () => {
  await withStubServer(async (req, res, server) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/agent-router/fetch") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(registeredCanonicalStub()));
      return;
    }
    if (req.url === "/agent-router/quote") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        status: "payment_required",
        input: { symbol: "BTCUSDT" },
        selected_service: { service_id: "btc_liquidation_max_pain_demo" },
        quote: { amount: "0.02", currency: "USDC" }
      }));
      return;
    }
    if (req.url === "/connector/get_manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        service_id: "btc_liquidation_max_pain_demo",
        manifest_type: "hosted_http_data_api",
        provider: { provider_id: "provider_btc_liquidation_max_pain_demo" },
        endpoint: { url: `http://127.0.0.1:${server.address().port}/provider/mock`, method: "POST" },
        pricing: {
          amount: "0.02",
          currency: "USDC",
          network: "base",
          pay_to: "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb"
        }
      }));
      return;
    }
    if (req.url === "/provider/mock") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Provider unavailable." } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unhandled ${req.url}` } }));
  }, async (baseUrl) => {
    const local = await routeTaskWithLocalWallet({ baseUrl, task: "BTC 当前最大爆仓痛点是多少" });

    assert.equal(local.status, "provider_unavailable_before_payment");
    assert.equal(local.data_returned, false);
    assert.equal(local.route_plan.auth_requirement.kind, "none");
    assert.equal(local.route_plan.abstain_reason, null);
    assert.equal(local.routing_observation.action, "route");
    assert.equal(local.routing_observation.route_family, "registered_service");
    assert.equal(local.routing_observation.durability_status, "memory_only");
    assert.notEqual(local.routing_observation.observation_id, "route_obs_stub_connect");
  });
});

test("local MCP structured social batch preserves all requested platforms and emits a privacy-minimized routing observation", async () => {
  const result = await handleLocalStructuredSocialBatchRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: {
        capability: "social_user_voice_research",
        params: {
          question: "What do users think about AgentRouter?",
          platforms: ["x", "reddit"]
        }
      }
    }
  }, {
    runLocalSearch: async ({ platform, query, capability }) => ({
      ok: true,
      status: "completed",
      request_id: `local_search_${platform}_test`,
      service_id: `local_social_${platform}`,
      request: { capability, params: { platform, query } },
      result: {
        items: [{ id: `${platform}-1`, text: `${platform} says ok`, url: `https://${platform}.example/1` }],
        item_count: 1
      },
      coverage: { status: "sufficient", item_count: 1, minimum_items: 1, reasons: [] },
      source: { backend_id: `opencli-${platform}`, attempts: [{ backend_id: `opencli-${platform}`, status: "completed", error: null }] },
      consumer_feedback_request: {
        endpoint: "/agent-router/feedback",
        request_id: `local_search_${platform}_test`,
        service_id: `local_social_${platform}`
      }
    })
  });

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.request.capability, "social_user_voice_research");
  assert.deepEqual(result.request.params.platforms, ["x", "reddit"]);
  assert.deepEqual(result.route_plan.candidate_sources, ["x", "reddit"]);
  assert.equal(result.route_plan.route_family, "local_browser");
  assert.equal(result.routing_observation.capability, "social_user_voice_research");
  assert.equal(result.routing_observation.route_family, "local_browser");
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.result.platforms, ["x", "reddit"]);
  assert.equal(JSON.stringify(result.routing_observation).includes("What do users think about AgentRouter?"), false);
});

test("local MCP structured social batch does not silently drop unsupported platforms", async () => {
  let localCalls = 0;
  const result = await handleLocalStructuredSocialBatchRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: {
        capability: "social_user_voice_research",
        params: {
          query: "AgentRouter market feedback",
          platforms: ["x", "linkedin"]
        }
      }
    }
  }, {
    runLocalSearch: async ({ platform }) => ({
      ...(localCalls += 1, {}),
      ok: true,
      status: "completed",
      request_id: `local_search_${platform}_test`,
      service_id: `local_social_${platform}`,
      request: { capability: "social_user_voice_research", params: { platform, query: "AgentRouter market feedback" } },
      result: { items: [{ id: `${platform}-1`, text: "ok" }], item_count: 1 },
      coverage: { status: "sufficient", item_count: 1, minimum_items: 1, reasons: [] },
      consumer_feedback_request: {}
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "source_not_callable");
  assert.equal(result.must_not_execute, true);
  assert.equal(localCalls, 0);
  assert.deepEqual(result.request.params.platforms, ["x", "linkedin"]);
  assert.deepEqual(result.route_plan.candidate_sources, ["x", "linkedin"]);
  assert.deepEqual(result.route_plan.params.blocked_sources, ["linkedin"]);
  assert.equal(result.route_plan.route_family, "external_api");
  assert.equal(result.route_plan.abstain_reason, "source_not_callable");
  assert.equal(result.routing_observation.action, "no_match");
  assert.deepEqual(result.coverage.unavailable_platforms, ["linkedin"]);
  assert.deepEqual(result.coverage.unsupported_platforms, []);
  assert.deepEqual(result.coverage.failed_platforms, ["linkedin"]);
  assert.equal(result.results.length, 0);

  const unknown = await handleLocalStructuredSocialBatchRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: {
        capability: "social_user_voice_research",
        params: { query: "AgentRouter market feedback", platforms: ["reddit", "not_a_real_social_source"] }
      }
    }
  }, {
    runLocalSearch: async () => {
      localCalls += 1;
      throw new Error("unknown mixed batches must stop before local execution");
    }
  });
  assert.equal(unknown.status, "unsupported_source");
  assert.equal(unknown.must_not_execute, true);
  assert.equal(localCalls, 0);
  assert.deepEqual(unknown.route_plan.candidate_sources, ["reddit", "not_a_real_social_source"]);
  assert.deepEqual(unknown.route_plan.params.blocked_sources, ["not_a_real_social_source"]);
  assert.equal(unknown.routing_observation.action, "no_match");
});

test("the real local MCP package entrypoint fail-closes a mixed unavailable social batch", async () => {
  const response = await callLocalMcpPackage({
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: {
        capability: "social_user_voice_research",
        params: { query: "AgentRouter feedback", platforms: ["reddit", "socialcrawl"] }
      }
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.status, "source_not_callable");
  assert.equal(payload.must_not_execute, true);
  assert.deepEqual(payload.route_plan.candidate_sources, ["reddit", "socialcrawl"]);
  assert.deepEqual(payload.route_plan.params.blocked_sources, ["socialcrawl"]);
  assert.equal(payload.routing_observation.action, "no_match");
  assert.equal(payload.results.length, 0);
});

test("local MCP single-platform search and post results keep auth in auth_requirement, not abstain_reason", () => {
  const cases = [
    {
      result: {
        ok: true,
        status: "completed",
        request_id: "local_search_reddit_single",
        service_id: "local_social_reddit",
        request: { capability: "social_search", params: { platform: "reddit", query: "AgentRouter" } },
        result: { items: [{ id: "reddit-1" }], item_count: 1 }
      },
      action: "route",
      authRequired: false
    },
    {
      result: {
        ok: false,
        status: "auth_required",
        request_id: "local_search_x_auth",
        service_id: "local_social_x",
        request: { capability: "social_search", params: { platform: "x", query: "AgentRouter" } }
      },
      action: "browser_handoff",
      authRequired: true
    },
    {
      result: {
        ok: false,
        status: "local_connector_runtime_unavailable",
        request_id: "local_search_x_runtime_unavailable",
        service_id: "local_social_x",
        request: { capability: "social_search", params: { platform: "x", query: "AgentRouter" } }
      },
      action: "browser_handoff",
      authRequired: true
    },
    {
      result: {
        ok: true,
        status: "completed",
        request_id: "local_post_x_single",
        service_id: "local_social_x",
        request: { capability: "social_post_read", params: { platform: "x", url: "https://x.com/example/status/1" } },
        result: { items: [{ id: "1" }], item_count: 1 }
      },
      action: "route",
      authRequired: false
    }
  ];

  for (const entry of cases) {
    const decorated = decorateStandaloneLocalResult(entry.result);
    assert.equal(decorated.route_plan.route_family, "local_browser");
    assert.equal(decorated.route_plan.abstain_reason, null);
    assert.equal(decorated.route_plan.auth_requirement.required, entry.authRequired);
    assert.equal(decorated.route_plan.auth_requirement.kind, entry.authRequired ? "local_browser_session" : "none");
    assert.equal(decorated.routing_observation.action, entry.action);
    assert.equal(decorated.routing_observation.route_family, "local_browser");
    assert.equal(decorated.routing_observation.capability, entry.result.request.capability);
  }
});

test("built-in browser post handoff and completion both return canonical route plan and V2 terminal observations", async () => {
  await withLocalMcpPackageConversation(async (call) => {
    const handoffRpc = await call({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "agentrouter_request",
        arguments: {
          capability: "social_post_read",
          params: { url: "https://x.com/example/status/1234567890" },
          consumer_context: {
            local_browser: {
              adapters: [{ adapter: "codex_browser", available: true, operations: ["read_post"] }],
              preferred_adapter: "codex_browser"
            }
          }
        }
      }
    });
    const handoff = JSON.parse(handoffRpc.result.content[0].text);
    assert.equal(handoff.status, "local_connector_required");
    assert.equal(handoff.route_plan.schema_version, "agentrouter_route_plan_v1");
    assert.equal(handoff.route_plan.auth_requirement.kind, "local_browser_session");
    assert.equal(handoff.routing_observation.observation_version, "agent_router_route_observation_v2");
    assert.equal(handoff.routing_observation.action, "browser_handoff");

    const completedRpc = await call({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "agentrouter_complete_handoff",
        arguments: {
          handoff: handoff.handoff,
          result: {
            canonical_url: "https://x.com/example/status/1234567890",
            text: "AgentRouter launch update",
            author_handle: "example",
            published_at: "2026-08-30T00:00:00Z",
            engagement: { likes: 42 }
          }
        }
      }
    });
    const completed = JSON.parse(completedRpc.result.content[0].text);
    assert.equal(completed.status, "completed");
    assert.equal(completed.route_plan.schema_version, "agentrouter_route_plan_v1");
    assert.equal(completed.route_plan.auth_requirement.kind, "none");
    assert.equal(completed.routing_observation.observation_version, "agent_router_route_observation_v2");
    assert.equal(completed.routing_observation.action, "route");
  });
});

test("natural X post reads take precedence over keyword search and preserve a zero budget", async () => {
  const response = await callLocalMcpPackage({
    jsonrpc: "2.0",
    id: 390,
    method: "tools/call",
    params: {
      name: "agentrouter_fetch",
      arguments: {
        task: "读取这条帖子 https://x.com/hyperyoolo/status/2097171633140310195",
        constraints: { max_price_usdc: "0" },
        consumer_context: {
          local_browser: {
            adapter: "codex_browser",
            available: true,
            operations: ["read_post"]
          }
        }
      }
    }
  });
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, "local_connector_required");
  assert.equal(result.request.capability, "social_post_read");
  assert.equal(result.handoff.operation, "read_post");
  assert.equal(result.handoff.target, "https://x.com/hyperyoolo/status/2097171633140310195");
  assert.equal(result.route_plan.budget_gate.max_price_usdc, "0");
  assert.equal(result.route_plan.budget_gate.paid_calls_allowed, false);
});

test("natural X account URLs reach the native account-history handoff", async () => {
  const response = await callLocalMcpPackage({
    jsonrpc: "2.0",
    id: 391,
    method: "tools/call",
    params: {
      name: "agentrouter_fetch",
      arguments: {
        task: "能读到 https://x.com/hyperyoolo 内容吗？请读取该账号公开资料及最近几条原创帖子",
        consumer_context: {
          local_browser: {
            adapter: "codex_browser",
            available: true,
            operations: ["read_user_posts"]
          }
        }
      }
    }
  });
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, "local_connector_required");
  assert.equal(result.request.capability, "social_user_voice_research");
  assert.equal(result.request.params.operation, "read_user_posts");
  assert.equal(result.request.params.handle, "hyperyoolo");
  assert.equal(result.handoff.target, "https://x.com/hyperyoolo");
  assert.equal(result.handoff.selected_adapter, "codex_browser");
});

test("structured social batches prefer native browser handoffs per platform", async () => {
  const routed = await handleLocalStructuredSocialBatchRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: {
        capability: "social_user_voice_research",
        params: { query: "AgentRouter feedback", platforms: ["x", "reddit"], limit: 5 },
        consumer_context: {
          local_browser: {
            adapter: "codex_browser",
            available: true,
            operations: ["search"]
          }
        }
      }
    }
  }, {
    runLocalSearch: async () => assert.fail("OpenCLI fallback must not run when native search is declared")
  });

  assert.equal(routed.status, "local_connector_required");
  assert.equal(routed.results.length, 2);
  assert.deepEqual(routed.results.map((item) => item.handoff.selected_adapter), ["codex_browser", "codex_browser"]);
  assert.deepEqual(routed.results.map((item) => item.handoff.operation), ["search", "search"]);
  assert.equal(routed.routing_observation.action, "browser_handoff");
});

test("local structured social explicit zero budget stays zero in plan and feedback telemetry", async () => {
  for (const maxPrice of ["0", 0]) {
    const routed = await handleLocalStructuredSocialBatchRequest({
      method: "tools/call",
      params: {
        name: "agentrouter_request",
        arguments: {
          capability: "social_user_voice_research",
          params: { query: "AgentRouter feedback", platforms: ["reddit"] },
          constraints: { max_price_usdc: maxPrice }
        }
      }
    }, {
      runLocalSearch: async ({ platform, query, capability }) => ({
        ok: true,
        status: "completed",
        request_id: `local_search_${platform}_zero_budget_${String(maxPrice)}`,
        service_id: `local_social_${platform}`,
        request: { capability, params: { platform, query } },
        result: { items: [{ id: "reddit-1", text: "ok" }], item_count: 1 },
        consumer_feedback_request: {}
      })
    });
    assert.equal(routed.route_plan.budget_gate.max_price_usdc, "0");
    assert.equal(routed.results[0].route_plan.budget_gate.max_price_usdc, "0");

    const calls = [];
    await attachLocalFeedbackGrant(routed, {
      registerGrant: async (body) => {
        calls.push(body);
        return { ok: true, payload: { feedback_token: `token_${body.request_id}` } };
      }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].routing_summary.budget.max_price_usdc, "0");
    assert.equal(calls[0].routing_summary.budget.selected_price_usdc, "0");
  }
});

test("local MCP feedback grant registration decorates nested social batch results without sending raw query text", async () => {
  const calls = [];
  const result = {
    request: {
      capability: "social_user_voice_research",
      params: {
        question: "private raw prompt must stay local",
        platforms: ["x", "reddit"]
      }
    },
    results: [
      {
        status: "completed",
        request_id: "local_search_x_token",
        service_id: "local_social_x",
        request: { capability: "social_user_voice_research", params: { platform: "x", query: "private raw prompt must stay local" } },
        consumer_feedback_request: {}
      },
      {
        status: "completed",
        request_id: "local_search_reddit_token",
        service_id: "local_social_reddit",
        request: { capability: "social_user_voice_research", params: { platform: "reddit", query: "private raw prompt must stay local" } },
        consumer_feedback_request: {}
      }
    ]
  };

  await attachLocalFeedbackGrant(result, {
    registerGrant: async (body) => {
      calls.push(body);
      return { ok: true, payload: { feedback_token: `token_${body.request_id}` } };
    }
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.request_id).sort(), ["local_search_reddit_token", "local_search_x_token"]);
  assert.equal(JSON.stringify(calls).includes("private raw prompt must stay local"), false);
  assert.equal(calls.every((call) => call.routing_summary?.route_family === "local_browser"), true);
  assert.equal(calls.every((call) => call.routing_summary?.authorization?.action === "none"), true);
  assert.equal(result.results[0].consumer_feedback_request.feedback_token_required, true);
  assert.equal(result.results[1].consumer_feedback_request.feedback_token_required, true);
});
