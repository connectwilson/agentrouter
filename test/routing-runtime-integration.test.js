import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const AUTH_USER = {
  provider: "github",
  id: "routing-runtime-owner",
  name: "Routing Runtime Owner",
  handle: "routing-runtime-owner"
};

const AGENT_ROUTER_CLI = fileURLToPath(new URL("../bin/agent-router.js", import.meta.url));
const previousProviderDir = process.env.ADN_PROVIDER_DIR;
const runtimeProviderDir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-routing-providers-"));
process.env.ADN_PROVIDER_DIR = runtimeProviderDir;
const { createServer } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");
const { authUserKey } = await import("../src/auth.js");
const { createCreditApiKey, ensureCreditAccount } = await import("../src/credits.js");
const { createSocialConnection } = await import("../src/social-connections.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const { registerService } = await import("../src/registry.js");
const { inferRoutePlan, inferStructuredRoutePlan } = await import("../src/routing/planner.js");
test.after(async () => {
  if (previousProviderDir === undefined) delete process.env.ADN_PROVIDER_DIR;
  else process.env.ADN_PROVIDER_DIR = previousProviderDir;
  await fs.rm(runtimeProviderDir, { recursive: true, force: true });
});

async function runAgentRouterCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_ROUTER_CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRuntimeServer(run, options = {}) {
  const store = options.store || createMemoryStore();
  const persisted = [];
  const server = createServer({
    ...options,
    store,
    serviceEventPersistence: {
      enabled: () => false,
      refreshConfigs: async () => [],
      refresh: async () => ({ ok: true, status: "fresh", loaded: 0 }),
      writeEvent: async (entry) => {
        persisted.push(entry);
        return true;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({
      store,
      persisted,
      baseUrl: `http://127.0.0.1:${server.address().port}`
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(baseUrl, path, body, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

async function callMcpRequest(baseUrl, args, headers = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "agentrouter_request", arguments: args }
    })
  });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  return JSON.parse(rpc.result.content[0].text);
}

async function callMcpFetch(baseUrl, args, headers = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "agentrouter_fetch", arguments: args }
    })
  });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  return JSON.parse(rpc.result.content[0].text);
}

test("BSC transaction-evidence audit fails closed across HTTP and MCP without contacting a market-data connector", async () => {
  const task = "Verify BSC transaction 0xce780499022ade2028085acc000218a8e5d1cebddf4df912bd9dd779135fc365, ERC-8004 Agent ID 340924, and whether feedback exists for req_1788794834931.";
  await withRuntimeServer(async ({ baseUrl }) => {
    const http = await postJson(baseUrl, "/agent-router/fetch", { task, max_price: "0" });
    const mcp = await callMcpFetch(baseUrl, { task, max_price: "0" });

    for (const payload of [http.payload, mcp]) {
      assert.equal(payload.route_plan.capability, "onchain_evidence_audit");
      assert.equal(payload.route_plan.abstain_reason, "capability_not_available");
      assert.deepEqual(payload.route_plan.candidate_sources, []);
      assert.notEqual(payload.route_plan.params?.source, "geckoterminal");
      assert.notEqual(payload.route_plan.params?.source, "dexscreener");
    }
  });
});

function secretStore() {
  const values = new Map();
  return {
    writeSecret: async ({ serviceId, secretName, secretValue }) => {
      const ref = `${serviceId}:${secretName}`;
      values.set(ref, secretValue);
      return ref;
    },
    readSecret: async (ref) => values.get(ref) || ""
  };
}

function storedObservation(store, payload) {
  const observationId = payload?.routing_observation?.observation_id;
  assert.ok(observationId, "the runtime result must expose its routing observation id");
  const observation = store.routeObservations.find((item) => item.observation_id === observationId);
  assert.ok(observation, `routing observation ${observationId} must be recorded`);
  assert.equal(observation.observation_version, "agent_router_route_observation_v2");
  return observation;
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

test("anonymous ask and fetch agree on the real connect-account action and observation", async () => {
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const task = "使用 OpenAlex 查找 AgentRouter 相关论文。";
    const ask = await postJson(baseUrl, "/agent-router/ask", { task, max_price: "0.05" });
    const fetchResult = await postJson(baseUrl, "/agent-router/fetch", { task, max_price: "0.05" });

    for (const { payload } of [ask, fetchResult]) {
      assert.equal(payload.route_plan.auth_requirement.kind, "agentrouter_account");
      assert.equal(payload.status, "connection_required");
      assert.equal(payload.action_required.action, "connect_agentrouter_account");
      const observation = storedObservation(store, payload);
      assert.equal(observation.action, "connect_account");
      assert.deepEqual(observation.authorization, {
        required: true,
        action: "connect_account",
        source: null
      });
    }
  });
});

test("a composite wallet leaderboard request reports unavailable before auth or payment", async () => {
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const task = "hyperliquid现在上了哪些ronbinhood的代币，这些代币里，最近48小时盈利榜前5的地址是什么";
    const fetchResult = await postJson(baseUrl, "/agent-router/fetch", { task, max_price: "0.05" });

    assert.equal(fetchResult.response.status, 422);
    assert.equal(fetchResult.payload.status, "capability_not_available");
    assert.equal(fetchResult.payload.capability, "wallet_pnl_leaderboard");
    assert.equal(fetchResult.payload.execution_available, false);
    assert.equal(fetchResult.payload.must_not_execute, true);
    assert.equal(fetchResult.payload.must_not_request_payment_authorization, true);
    assert.equal(fetchResult.payload.route_plan.abstain_reason, "capability_not_available");
    assert.equal(fetchResult.payload.route_plan.route_family, "none");
    assert.equal(fetchResult.payload.route_plan.auth_requirement.required, false);
    assert.equal(fetchResult.payload.route_plan.budget_gate.paid_calls_allowed, false);
    assert.equal(fetchResult.payload.route_plan.budget_gate.status, "blocked");
    assert.equal(Object.hasOwn(fetchResult.payload.route_plan.budget_gate, "valid"), false);
    assert.equal(fetchResult.payload.quote, undefined);
    assert.equal(fetchResult.payload.action_required, undefined);
    assert.equal(fetchResult.payload.connection_action, undefined);
    assert.equal(storedObservation(store, fetchResult.payload).action, "no_match");
  });
});

test("PONS holder coverage rejects across HTTP and MCP when no holder service is registered", async () => {
  let providerCalls = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    for (const [id, record] of store.services) if (record.manifest.capabilities.some(c => ["token_holders", "holder_distribution"].includes(c))) store.services.delete(id);
    const task = "查robinhood链上PONS代币的前10大 token holder的地址";
    for (const max_price of ["0", "0.05"]) {
      const http = await postJson(baseUrl, "/agent-router/fetch", { task, max_price });
      assert.equal(http.response.status, 422);
      const mcp = await callMcpFetch(baseUrl, { task, max_price });
      for (const result of [http.payload, mcp]) {
        assert.equal(result.status, "capability_not_available");
        assert.equal(result.capability, "token_holders");
        assert.equal(result.must_not_execute, true);
        assert.equal(result.must_not_request_payment_authorization, true);
        assert.equal(result.route_plan.auth_requirement.required, false);
        assert.equal(result.quote, undefined);
        assert.equal(storedObservation(store, result).action, "no_match");
      }
    }
    assert.equal(providerCalls, 0);
    assert.equal(store.feedbackEvents.length, 0);
  }, { fetchImpl: async () => { providerCalls++; throw new Error("No provider should run"); } });
});

test("CLI quote-only uses the canonical ask entrypoint instead of legacy agent-reach routing", async () => {
  await withRuntimeServer(async ({ baseUrl }) => {
    const task = "使用 Bright Data 搜索 AgentRouter";
    const canonical = await postJson(baseUrl, "/agent-router/ask", { task, max_price: "0.05" });
    for (const command of [["ask", "--quote-only", task], ["quote-only", task]]) {
      const cli = await runAgentRouterCli(command, {
        AGENT_ROUTER_URL: baseUrl,
        ADN_REGISTRY_URL: baseUrl,
        AGENT_ROUTER_MAX_PRICE: "0.05"
      });

      assert.equal(cli.code, 0, cli.stderr);
      const payload = JSON.parse(cli.stdout);
      assert.equal(payload.status, "source_not_callable");
      assert.equal(payload.route_plan.schema_version, "agentrouter_route_plan_v1");
      assert.equal(payload.route_plan.source_constraint, "bright_data");
      assert.ok(payload.routing_observation.observation_id);
      assert.equal(payload.routing_observation.action, "no_match");
      assert.deepEqual(payload.route_plan, canonical.payload.route_plan);
      assert.deepEqual(
        {
          action: payload.routing_observation.action,
          route_family: payload.routing_observation.route_family,
          capability: payload.routing_observation.capability
        },
        {
          action: canonical.payload.routing_observation.action,
          route_family: canonical.payload.routing_observation.route_family,
          capability: canonical.payload.routing_observation.capability
        }
      );
      assert.equal(payload.handoff?.backend, undefined);
      assert.doesNotMatch(JSON.stringify(payload), /agent-reach/i);
    }
  });
});

test("registered Nansen holder tasks share exact-chain quotes through HTTP and MCP", async () => {
  await withRuntimeServer(async ({ baseUrl, store }) => {
    store.services.clear();
    for (const [id, capabilities, input] of [
      ["nansen_tgm_holders", ["nansen", "token_holders"], { chain: "ethereum", token_address: `0x${"2".repeat(40)}` }],
      ["nansen_prediction_market_top_holders", ["nansen", "token_holders", "holder_distribution", "prediction_market"], { market_id: "sample-market" }],
      ["nansen_search_general", ["nansen", "token_search", "entity_search"], { chain: "ethereum", search_query: "PEPE", result_type: "token", limit: 25 }]
    ]) {
      const manifest = structuredClone(baseFundFlowManifest);
      Object.assign(manifest, { service_id: id, title: id, description_for_agent: id, capabilities, sample_request: input,
        input_schema: { type: "object", properties: Object.fromEntries(Object.keys(input).map(key => [key, { type: typeof input[key] }])) } });
      manifest.provider.provider_id = "provider_nansen_api";
      manifest.pricing.amount = id === "nansen_prediction_market_top_holders" ? "0.0001" : "0.01";
      registerService(store, manifest, baseUrl).verification_status = "verified";
    }
    const task = "查robinhood链上PONS代币的前10大 token holder的地址";
    const results = [
      (await postJson(baseUrl, "/agent-router/ask", { task, max_price: "0.05" })).payload,
      (await postJson(baseUrl, "/agent-router/fetch", { task, max_price: "0.05" })).payload,
      await callMcpFetch(baseUrl, { task, max_price: "0.05" })
    ];
    for (const result of results) {
      assert.equal(result.route_plan.capability, "token_holders");
      assert.equal(result.route_plan.params.chain, "robinhood");
      assert.equal(Number(result.quote.amount), 0.02);
      if (result.presentation_policy?.hide_provider_details) assert.equal(result.service_match.matched, true);
      else assert.equal(result.selected_service.service_id, "nansen_tgm_holders");
      assert.equal(storedObservation(store, result).capability, "token_holders");
      assert.equal(result.token_resolution.status, "required");
      assert.equal(result.quote.agent_decision.can_answer, false, "a quote must not promise indexed PONS data");
      assert.equal(result.input.token_address, undefined);
      assert.notEqual(result.action_required?.action, "connect_api_source");
    }
    const missing = (await postJson(baseUrl, "/agent-router/fetch", { task: "查PONS代币前10大持有人", max_price: "0.05" })).payload;
    assert.equal(missing.status, "needs_clarification");
    assert.equal(missing.route_plan.auth_requirement.required, false);
    assert.equal(missing.quote, undefined);
    assert.equal(store.feedbackEvents.length, 0, "quotes are not executions");
  }, { fetchImpl: async () => { throw new Error("Quote-only test must not invoke a provider"); } });
});

test("cookie-authenticated ask and fetch share the connected source owner without another login", async () => {
  const store = createMemoryStore();
  const secrets = secretStore();
  const ownerKey = authUserKey(AUTH_USER);
  await createSocialConnection(store, ownerKey, {
    platform: "exa",
    provider_type: "exa_api",
    credentials: { api_key: "exa-cookie-owner-secret" }
  }, secrets);
  store.authSessions.set("routing-runtime-cookie-owner", {
    user: AUTH_USER,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });

  await withRuntimeServer(async ({ baseUrl }) => {
    const task = "Use my connected Exa source to research AgentRouter";
    const ask = await postJson(baseUrl, "/agent-router/ask", { task }, "ar_session=routing-runtime-cookie-owner");
    const fetchResult = await postJson(baseUrl, "/agent-router/fetch", { task }, "ar_session=routing-runtime-cookie-owner");

    assert.notEqual(ask.payload.status, "connection_required");
    assert.notEqual(fetchResult.payload.status, "connection_required");
    assert.equal(fetchResult.payload.status, "data_returned");
    for (const payload of [ask.payload, fetchResult.payload]) {
      assert.equal(payload.route_plan.candidate_sources[0], "exa");
      assert.deepEqual(payload.route_plan.auth_requirement, { required: false, kind: "none", source: null });
      assert.deepEqual(storedObservation(store, payload).authorization, {
        required: false,
        action: "none",
        source: null
      });
    }
  }, {
    store,
    socialConnectionOptions: {
      ...secrets,
      fetchImpl: async (url, options) => {
        assert.equal(String(url), "https://api.exa.ai/search");
        assert.equal(options.headers["x-api-key"], "exa-cookie-owner-secret");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ title: "AgentRouter", url: "https://example.com/agentrouter", text: "Evidence" }]
          })
        };
      }
    }
  });
});

test("legacy registry intents use one canonical decision across ask, fetch, MCP, and CLI quote-only", async () => {
  const store = createMemoryStore();
  for (const capability of ["wallet_profile", "related_wallets", "smart_money_netflow"]) {
    const record = registerService(store, {
      ...baseFundFlowManifest,
      service_id: `runtime_${capability}`,
      provider: { provider_id: `runtime_provider_${capability}` },
      title: `Runtime ${capability}`,
      capabilities: ["data_service", capability],
      endpoint: { ...baseFundFlowManifest.endpoint, url: `/provider/runtime_${capability}` }
    }, "http://127.0.0.1:9999");
    record.verification_status = "verified";
  }
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const cases = [
      { task: "查询标记为 Matrixport 的地址", capability: "wallet_profile" },
      { task: "查询 Matrixport 关联钱包", capability: "related_wallets" },
      { task: "查询 ETH smart money 净流入", capability: "smart_money_netflow" }
    ];
    for (const item of cases) {
      const ask = await postJson(baseUrl, "/agent-router/ask", { task: item.task, max_price: "0.05" });
      const fetchResult = await postJson(baseUrl, "/agent-router/fetch", { task: item.task, max_price: "0.05" });
      const mcp = await callMcpFetch(baseUrl, { task: item.task, max_price: "0.05" });
      const cli = await runAgentRouterCli(["ask", "--quote-only", item.task], {
        AGENT_ROUTER_URL: baseUrl,
        ADN_REGISTRY_URL: baseUrl,
        AGENT_ROUTER_MAX_PRICE: "0.05"
      });
      assert.equal(cli.code, 0, cli.stderr);
      const cliPayload = JSON.parse(cli.stdout);

      const plans = [ask.payload, fetchResult.payload, mcp, cliPayload].map((payload) => payload.route_plan);
      for (const plan of plans) {
        assert.equal(plan.route_family, "registered_service", item.task);
        assert.equal(plan.capability, item.capability, item.task);
        assert.deepEqual(plan.candidate_sources, ["agentrouter_registry"], item.task);
        assert.equal(plan.abstain_reason, null, item.task);
      }
      for (const payload of [ask.payload, fetchResult.payload, mcp, cliPayload]) {
        assert.equal(payload.routing_observation.route_family, "registered_service", item.task);
        assert.equal(payload.routing_observation.capability, item.capability, item.task);
        storedObservation(store, payload);
      }
    }
  }, { store });
});

test("local-browser research handoff never sends the agent into source/API-key connection", async () => {
  await withRuntimeServer(async ({ baseUrl }) => {
    const { payload } = await postJson(baseUrl, "/agent-router/fetch", {
      task: "查找小红书上，人们对 Agent 交易的看法",
      max_price: "0"
    });

    assert.equal(payload.route_plan.route_family, "local_browser");
    assert.equal(payload.status, "local_browser_handoff_required");
    assert.equal(payload.action_required.authorization_kind, "local_browser_session");
    assert.equal(payload.action_required.requires_agentrouter_login, false);
    assert.equal(payload.action_required.preferred_tool, "agentrouter_request");
    assert.equal(payload.free_alternative.requires_api_key, false);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /agentrouter_connect_source|configure_api_credentials|paste (?:an )?api key|provide (?:an )?api key/i
    );
  });
});

test("HTTP structured external_api_query emits and durably records a v2 observation", async () => {
  await withRuntimeServer(async ({ baseUrl, store, persisted }) => {
    const { response, payload } = await postJson(baseUrl, "/agent-router/request", {
      capability: "external_api_query",
      params: { source: "open_meteo", operation: "forecast", query: "Taipei" }
    });

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    const observation = storedObservation(store, payload);
    assert.equal(observation.entrypoint, "request");
    assert.equal(observation.action, "route");
    assert.notEqual(observation.source_family, "none");
    assert.equal(observation.durability_status, "durable");
    assert.ok(persisted.some((entry) =>
      entry.eventType === "route_observation"
      && entry.event?.observation_version === "agent_router_route_observation_v2"
      && entry.event?.observation_id === observation.observation_id
    ));
  }, { socialConnectionOptions: { fetchImpl: weatherFetch } });
});

test("remote MCP structured external_api_query emits and durably records a v2 observation", async () => {
  await withRuntimeServer(async ({ baseUrl, store, persisted }) => {
    const result = await callMcpRequest(baseUrl, {
      capability: "external_api_query",
      params: { source: "open_meteo", operation: "forecast", query: "Taipei" }
    });
    assert.equal(result.ok, true);
    const observation = storedObservation(store, result);
    assert.equal(observation.entrypoint, "mcp_request");
    assert.equal(observation.action, "route");
    assert.notEqual(observation.source_family, "none");
    assert.equal(observation.durability_status, "durable");
    assert.ok(persisted.some((entry) =>
      entry.eventType === "route_observation"
      && entry.event?.observation_version === "agent_router_route_observation_v2"
      && entry.event?.observation_id === observation.observation_id
    ));
  }, { socialConnectionOptions: { fetchImpl: weatherFetch } });
});

test("HTTP and MCP structured external calls fail closed on zero, tiny, or unbounded pricing before connector I/O", async () => {
  const store = createMemoryStore();
  const secrets = secretStore();
  const ownerKey = authUserKey(AUTH_USER);
  for (const connection of [
    { platform: "exa", provider_type: "exa_api", credentials: { api_key: "exa-secret" } },
    { platform: "firecrawl", provider_type: "firecrawl_api", credentials: { api_key: "firecrawl-secret" } },
    { platform: "jina", provider_type: "jina_api", credentials: { api_key: "jina-secret" } },
    { platform: "youtube", provider_type: "youtube_api", credentials: { api_key: "youtube-secret" } },
    { platform: "perplexity", provider_type: "perplexity_api", credentials: { api_key: "perplexity-secret" } }
  ]) {
    await createSocialConnection(store, ownerKey, connection, secrets);
  }
  const account = await ensureCreditAccount(store, AUTH_USER);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "Routing budget regression" });
  let paidConnectorCalls = 0;
  let freeConnectorCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("open-meteo")) {
      freeConnectorCalls += 1;
      return weatherFetch(url);
    }
    paidConnectorCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await withRuntimeServer(async ({ baseUrl }) => {
    store.authSessions.set("routing-runtime-budget-session", {
      user: AUTH_USER,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000
    });
    const guarded = [
      { source: "exa", max: "0" },
      { source: "exa", max: "0.0001" },
      { source: "firecrawl", max: "100" },
      { source: "jina", max: "100" },
      { source: "youtube", max: "100" },
      { source: "perplexity", max: "100" }
    ];
    for (const { source, max } of guarded) {
      const request = {
        capability: "external_api_query",
        params: { source, operation: "search", query: "AgentRouter", limit: 1 },
        constraints: { max_price_usdc: max }
      };
      const http = await postJson(
        baseUrl,
        "/agent-router/request",
        request,
        "ar_session=routing-runtime-budget-session"
      );
      assert.equal(http.response.status, 402, `${source} HTTP must require a bounded quote`);
      assert.equal(http.payload.status, "quote_required");
      assert.equal(http.payload.must_not_execute, true);
      assert.equal(http.payload.route_plan.budget_gate.status, "quote_required");

      const mcp = await callMcpRequest(baseUrl, request, { "x-agentrouter-api-key": apiKey });
      assert.equal(mcp.status, "quote_required", `${source} MCP must require a bounded quote`);
      assert.equal(mcp.must_not_execute, true);
      assert.equal(mcp.route_plan.budget_gate.status, "quote_required");
    }
    assert.equal(paidConnectorCalls, 0, "a blocked budget must never reach a paid connector");

    const free = await postJson(baseUrl, "/agent-router/request", {
      capability: "external_api_query",
      params: { source: "open_meteo", operation: "forecast", query: "Taipei" },
      constraints: { max_price_usdc: "0" }
    });
    assert.equal(free.response.status, 200);
    assert.equal(free.payload.ok, true);
    assert.ok(freeConnectorCalls > 0, "a proven-free connector remains callable with a zero budget");
    assert.equal(paidConnectorCalls, 0);
  }, {
    store,
    socialConnectionOptions: { ...secrets, fetchImpl }
  });
});

test("hard budget preflight outranks account authorization for natural, HTTP, and MCP routes", async () => {
  let connectorIo = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const task = "Use Exa to research AgentRouter";
    const ask = await postJson(baseUrl, "/agent-router/ask", { task, max_price: "0" });
    assert.equal(ask.response.status, 402);
    assert.equal(ask.payload.status, "quote_blocked");
    assert.equal(ask.payload.route_plan.abstain_reason, "budget_exceeded");
    assert.equal(storedObservation(store, ask.payload).action, "no_match");

    const request = {
      capability: "external_api_query",
      params: { source: "exa", operation: "search", query: "AgentRouter" },
      constraints: { max_price_usdc: "0" }
    };
    const http = await postJson(baseUrl, "/agent-router/request", request);
    assert.equal(http.response.status, 402);
    assert.equal(http.payload.status, "quote_required");
    assert.equal(http.payload.route_plan.abstain_reason, "budget_exceeded");
    assert.equal(storedObservation(store, http.payload).action, "no_match");

    const mcp = await callMcpRequest(baseUrl, request);
    assert.equal(mcp.status, "quote_required");
    assert.equal(mcp.route_plan.abstain_reason, "budget_exceeded");
    assert.equal(storedObservation(store, mcp).action, "no_match");
    assert.equal(connectorIo, 0);
  }, {
    socialConnectionOptions: {
      fetchImpl: async () => {
        connectorIo += 1;
        throw new Error("a hard budget gate must run before connector transport");
      }
    }
  });
});

test("natural and structured explicit budgets both fail closed on unknown provider-defined prices", async () => {
  const store = createMemoryStore();
  const secrets = secretStore();
  const ownerKey = authUserKey(AUTH_USER);
  await createSocialConnection(store, ownerKey, {
    platform: "youtube",
    provider_type: "youtube_api",
    credentials: { api_key: "youtube-price-owner-secret" }
  }, secrets);
  const account = await ensureCreditAccount(store, AUTH_USER);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "Unknown price parity" });
  store.authSessions.set("routing-runtime-price-owner", {
    user: AUTH_USER,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  let connectorIo = 0;

  const planningContext = {
    agentrouter_authenticated: true,
    connected_sources: ["youtube"],
    local_browser_sessions: [],
    constraints: { max_price_usdc: "100" }
  };
  const naturalPlan = inferRoutePlan("Use YouTube to search for AgentRouter reviews", planningContext);
  const structuredPlan = inferStructuredRoutePlan({
    capability: "external_api_query",
    params: { source: "youtube", operation: "search", query: "AgentRouter" },
    constraints: { max_price_usdc: "100" }
  }, planningContext);
  for (const plan of [naturalPlan, structuredPlan]) {
    assert.equal(plan.abstain_reason, "price_unknown");
    assert.equal(plan.budget_gate.status, "quote_required");
    assert.equal(plan.auth_requirement.required, false);
  }

  await withRuntimeServer(async ({ baseUrl }) => {
    const cookie = "ar_session=routing-runtime-price-owner";
    const ask = await postJson(baseUrl, "/agent-router/ask", {
      task: "Use YouTube to search for AgentRouter reviews",
      max_price: "100"
    }, cookie);
    assert.equal(ask.response.status, 402);
    assert.equal(ask.payload.status, "quote_required");
    assert.equal(ask.payload.route_plan.budget_gate.status, "quote_required");
    assert.equal(storedObservation(store, ask.payload).action, "no_match");

    const request = {
      capability: "external_api_query",
      params: { source: "youtube", operation: "search", query: "AgentRouter" },
      constraints: { max_price_usdc: "100" }
    };
    const http = await postJson(baseUrl, "/agent-router/request", request, cookie);
    assert.equal(http.response.status, 402);
    assert.equal(http.payload.status, "quote_required");
    assert.equal(http.payload.route_plan.budget_gate.status, "quote_required");
    assert.equal(storedObservation(store, http.payload).action, "no_match");

    const mcp = await callMcpRequest(baseUrl, request, { "x-agentrouter-api-key": apiKey });
    assert.equal(mcp.status, "quote_required");
    assert.equal(mcp.route_plan.budget_gate.status, "quote_required");
    assert.equal(storedObservation(store, mcp).action, "no_match");
    assert.equal(connectorIo, 0);
  }, {
    store,
    socialConnectionOptions: {
      ...secrets,
      fetchImpl: async () => {
        connectorIo += 1;
        throw new Error("an unknown provider-defined price must not execute");
      }
    }
  });
});

test("fetch with multiple structured data_requirements records exactly one terminal v2 batch observation", async () => {
  await withRuntimeServer(async ({ baseUrl, store, persisted }) => {
    const before = store.routeObservations.length;
    const { response, payload } = await postJson(baseUrl, "/agent-router/fetch", {
      data_requirements: [
        { capability: "external_api_query", params: { source: "open_meteo", operation: "forecast", query: "Taipei" } },
        { capability: "external_api_query", params: { source: "open_meteo", operation: "forecast", query: "Tokyo" } }
      ],
      constraints: { max_price_usdc: "0" }
    });

    assert.equal(response.status, 200);
    assert.equal(payload.status, "data_returned");
    assert.equal(payload.data_returned_count, 2);
    const observation = storedObservation(store, payload);
    assert.equal(observation.entrypoint, "fetch");
    assert.equal(observation.task_family, "structured_batch");
    assert.equal(observation.capability, "structured_batch");
    assert.equal(store.routeObservations.length - before, 1);
    assert.equal(persisted.filter((entry) =>
      entry.eventType === "route_observation" && entry.event?.observation_id === observation.observation_id
    ).length, 1);
  }, { socialConnectionOptions: { fetchImpl: weatherFetch } });
});

test("a successful connected X post read reconciles the planned browser route to the actual external provider", async () => {
  const postUrl = "https://x.com/example/status/1234567890";
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const { response, payload } = await postJson(baseUrl, "/agent-router/fetch", { task: `Read ${postUrl}` });
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "completed");
    assert.equal(payload.source.backend_id, "x-api:connected-runtime");
    const observation = storedObservation(store, payload);
    assert.equal(observation.route_family, "external_api");
    assert.equal(observation.source_family, "social");
    assert.equal(observation.action, "route");
    assert.deepEqual(observation.authorization, { required: false, action: "none", source: null });
    assert.equal(payload.route_plan.route_family, "external_api");
    assert.equal(payload.route_plan.auth_requirement.required, false);
  }, {
    socialProviderFactory: async () => ({
      x: [{
        id: "x-api:connected-runtime",
        readPost: async () => ({
          status: "completed",
          rows: [{ id: "1234567890", url: postUrl, text: "Connected provider result", author: "example" }]
        })
      }]
    })
  });
});

test("a failed connected X post read retains browser authorization and provider-attempt quality evidence", async () => {
  const postUrl = "https://x.com/example/status/1234567890";
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const { payload } = await postJson(baseUrl, "/agent-router/fetch", { task: `Read ${postUrl}` });
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "local_connector_required");
    assert.equal(payload.attempts[0].backend_id, "x-api:failing-runtime");
    assert.equal(payload.attempts[0].status, "provider_error");
    const observation = storedObservation(store, payload);
    assert.equal(observation.route_family, "local_browser");
    assert.equal(observation.action, "browser_handoff");
    assert.deepEqual(observation.authorization, { required: true, action: "browser_handoff", source: "x" });
  }, {
    socialProviderFactory: async () => ({
      x: [{
        id: "x-api:failing-runtime",
        readPost: async () => ({ status: "provider_error", error: "upstream unavailable", rows: [] })
      }]
    })
  });
});

test("HTTP structured social and generic branches preserve results while emitting v2 observations", async () => {
  const socialResearchRunner = async (params) => ({
    ok: true,
    status: "completed",
    result: { marker: "social-runtime-result", question: params.question }
  });
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const social = await postJson(baseUrl, "/agent-router/request", {
      capability: "social_user_voice_research",
      params: { question: "What do users think?" }
    });
    assert.equal(social.response.status, 200);
    assert.equal(social.payload.result.marker, "social-runtime-result");
    const socialObservation = storedObservation(store, social.payload);
    assert.equal(socialObservation.entrypoint, "request");
    assert.equal(socialObservation.capability, "social_user_voice_research");
    assert.equal(socialObservation.source_family, "social");

    const socialPost = await postJson(baseUrl, "/agent-router/request", {
      capability: "social_post_read",
      params: { url: "not-a-social-post-url" }
    });
    assert.equal(socialPost.response.status, 422);
    assert.equal(socialPost.payload.status, "invalid_request");
    const socialPostObservation = storedObservation(store, socialPost.payload);
    assert.equal(socialPostObservation.entrypoint, "request");
    assert.equal(socialPostObservation.capability, "social_post_read");

    const generic = await postJson(baseUrl, "/agent-router/request", {
      capability: "not_registered_capability",
      params: { marker: "generic-runtime-input" }
    });
    assert.equal(generic.response.status, 200);
    assert.equal(generic.payload.status, "no_match");
    const genericObservation = storedObservation(store, generic.payload);
    assert.equal(genericObservation.entrypoint, "request");
    assert.equal(genericObservation.capability, "not_registered_capability");
    assert.equal(genericObservation.route_family, "registered_service");
  }, {
    socialProviderFactory: async () => ({}),
    socialResearchRunner
  });
});

test("remote MCP structured social and generic branches preserve results while emitting v2 observations", async () => {
  const socialResearchRunner = async (params) => ({
    ok: true,
    status: "completed",
    result: { marker: "mcp-social-runtime-result", question: params.question }
  });
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const social = await callMcpRequest(baseUrl, {
      capability: "social_user_voice_research",
      params: { question: "What do users think?" }
    });
    assert.equal(social.result.marker, "mcp-social-runtime-result");
    const socialObservation = storedObservation(store, social);
    assert.equal(socialObservation.entrypoint, "mcp_request");
    assert.equal(socialObservation.capability, "social_user_voice_research");
    assert.equal(socialObservation.source_family, "social");

    const socialPost = await callMcpRequest(baseUrl, {
      capability: "social_post_read",
      params: { url: "not-a-social-post-url" }
    });
    assert.equal(socialPost.status, "invalid_request");
    const socialPostObservation = storedObservation(store, socialPost);
    assert.equal(socialPostObservation.entrypoint, "mcp_request");
    assert.equal(socialPostObservation.capability, "social_post_read");

    const generic = await callMcpRequest(baseUrl, {
      capability: "not_registered_capability",
      params: { marker: "generic-runtime-input" }
    });
    assert.equal(generic.status, "no_match");
    const genericObservation = storedObservation(store, generic);
    assert.equal(genericObservation.entrypoint, "mcp_request");
    assert.equal(genericObservation.capability, "not_registered_capability");
    assert.equal(genericObservation.route_family, "registered_service");
  }, {
    socialProviderFactory: async () => ({}),
    socialResearchRunner
  });
});

test("only an authenticated observation advertises the routing-feedback endpoint", async () => {
  await withRuntimeServer(async ({ baseUrl, store }) => {
    store.authSessions.set("routing-runtime-owner-session", {
      user: AUTH_USER,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000
    });

    for (const path of ["/agent-router/ask", "/agent-router/fetch"]) {
      const anonymous = await postJson(baseUrl, path, { task: "Find x if x=2" });
      storedObservation(store, anonymous.payload);
      assert.ok(
        !anonymous.payload.routing_observation.feedback_endpoint,
        `${path} must not advertise an endpoint that rejects anonymous feedback`
      );
    }

    const authenticated = await postJson(
      baseUrl,
      "/agent-router/ask",
      { task: "Find x if x=2" },
      "ar_session=routing-runtime-owner-session"
    );
    const observation = storedObservation(store, authenticated.payload);
    assert.ok(observation.actor_key);
    assert.equal(authenticated.payload.routing_observation.feedback_endpoint, "/agent-router/routing-feedback");
  });
});

test("canonical plans preserve explicit unavailable sources but abstain before authorization or fallback", () => {
  const context = {
    agentrouter_authenticated: true,
    connected_sources: [],
    local_browser_sessions: [],
    constraints: { max_price_usdc: "0.05" }
  };
  const cases = [
    { source: "parallel", task: "使用 Parallel 搜索 AgentRouter" },
    { source: "bright_data", task: "使用 Bright Data 搜索 AgentRouter" },
    { source: "linkedin", task: "使用 LinkedIn API 搜索 AgentRouter" },
    { source: "socialcrawl", task: "使用 SocialCrawl 搜索 AgentRouter" },
    { source: "largitdata", task: "使用 LargitData 搜索 AgentRouter" }
  ];

  for (const { source, task } of cases) {
    const natural = inferRoutePlan(task, context);
    assert.equal(natural.source_constraint, source, `${source} must remain explainable as the explicit constraint`);
    assert.deepEqual(natural.candidate_sources, [source]);
    assert.equal(natural.abstain_reason, "source_not_callable");
    assert.equal(natural.must_not_fallback, true);
    assert.deepEqual(natural.auth_requirement, { required: false, kind: "none", source: null });

    const structured = inferStructuredRoutePlan({
      capability: "external_api_query",
      params: { source, operation: "search", query: "AgentRouter" }
    }, context);
    assert.equal(structured.source_constraint, source);
    assert.deepEqual(structured.candidate_sources, [source]);
    assert.equal(structured.abstain_reason, "source_not_callable");
    assert.equal(structured.must_not_fallback, true);
    assert.deepEqual(structured.auth_requirement, { required: false, kind: "none", source: null });
  }
});

test("HTTP, MCP, and natural fetch fail closed for planned and partner-only sources before connector I/O", async () => {
  let connectorIo = 0;
  let hostedSocialRuns = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    for (const source of ["parallel", "bright_data", "socialcrawl"]) {
      const request = {
        capability: "external_api_query",
        params: { source, operation: "search", query: "AgentRouter" }
      };
      const http = await postJson(baseUrl, "/agent-router/request", request);
      assert.equal(http.response.status, 422, `${source} HTTP must stop before execution`);
      assert.equal(http.payload.status, "source_not_callable");
      assert.equal(http.payload.must_not_execute, true);
      assert.equal(http.payload.source, source);
      assert.equal(http.payload.error.code, "SOURCE_NOT_CALLABLE");
      assert.equal(storedObservation(store, http.payload).action, "no_match");

      const mcp = await callMcpRequest(baseUrl, request);
      assert.equal(mcp.status, "source_not_callable");
      assert.equal(mcp.must_not_execute, true);
      assert.equal(mcp.source, source);
      assert.equal(mcp.error.code, "SOURCE_NOT_CALLABLE");
      assert.equal(storedObservation(store, mcp).action, "no_match");
    }

    const socialPartnerRequest = {
      capability: "social_user_voice_research",
      params: { question: "AgentRouter feedback", platforms: ["socialcrawl"] }
    };
    const socialHttp = await postJson(baseUrl, "/agent-router/request", socialPartnerRequest);
    assert.equal(socialHttp.response.status, 422);
    assert.equal(socialHttp.payload.status, "source_not_callable");
    assert.equal(socialHttp.payload.source, "socialcrawl");
    assert.equal(storedObservation(store, socialHttp.payload).action, "no_match");
    const socialMcp = await callMcpRequest(baseUrl, socialPartnerRequest);
    assert.equal(socialMcp.status, "source_not_callable");
    assert.equal(socialMcp.source, "socialcrawl");
    assert.equal(storedObservation(store, socialMcp).action, "no_match");

    const natural = await postJson(baseUrl, "/agent-router/fetch", {
      task: "使用 Bright Data 搜索 AgentRouter",
      max_price: "0.05"
    });
    assert.equal(natural.response.status, 200);
    assert.equal(natural.payload.status, "source_not_callable");
    assert.equal(natural.payload.must_not_execute, true);
    assert.equal(natural.payload.source, "bright_data");
    assert.equal(storedObservation(store, natural.payload).action, "no_match");
    assert.equal(connectorIo, 0);
    assert.equal(hostedSocialRuns, 0);
  }, {
    socialConnectionOptions: {
      fetchImpl: async () => {
        connectorIo += 1;
        throw new Error("an unavailable source must never reach connector transport");
      }
    },
    socialResearchRunner: async () => {
      hostedSocialRuns += 1;
      return { ok: true, status: "completed", result: { items: [] } };
    }
  });
});

test("structured browser-only external sources return executable browser handoffs before connector I/O", async () => {
  let connectorIo = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    for (const source of ["xiaohongshu", "bilibili"]) {
      const request = {
        capability: "external_api_query",
        params: { source, operation: "search", query: "AgentRouter" }
      };
      const http = await postJson(baseUrl, "/agent-router/request", request);
      assert.equal(http.response.status, 200);
      assert.equal(http.payload.status, "local_browser_handoff_required");
      assert.equal(http.payload.action_required.preferred_tool, "agentrouter_request");
      assert.equal(http.payload.action_required.authorization_kind, "local_browser_session");
      assert.equal(http.payload.action_required.requires_agentrouter_login, false);
      assert.equal(http.payload.free_alternative.requires_api_key, false);
      assert.equal(storedObservation(store, http.payload).action, "browser_handoff");

      const mcp = await callMcpRequest(baseUrl, request);
      assert.equal(mcp.status, "local_browser_handoff_required");
      assert.equal(mcp.action_required.preferred_tool, "agentrouter_request");
      assert.equal(mcp.action_required.authorization_kind, "local_browser_session");
      assert.equal(mcp.action_required.requires_agentrouter_login, false);
      assert.equal(mcp.free_alternative.requires_api_key, false);
      assert.equal(storedObservation(store, mcp).action, "browser_handoff");
    }
    assert.equal(connectorIo, 0);
  }, {
    socialConnectionOptions: {
      fetchImpl: async () => {
        connectorIo += 1;
        throw new Error("a browser-only source must never reach hosted connector transport");
      }
    }
  });
});

test("structured multi-platform social research has natural local-browser parity and never runs hosted", async () => {
  const platforms = ["reddit", "x", "xiaohongshu"];
  const context = {
    agentrouter_authenticated: false,
    connected_sources: [],
    local_browser_sessions: [],
    constraints: { max_price_usdc: "0.05" }
  };
  for (const task of [
    "在 Reddit 上研究 AgentRouter 用户反馈",
    "在 X 上研究 AgentRouter 用户讨论",
    "查找小红书上 AgentRouter 用户讨论"
  ]) {
    const natural = inferRoutePlan(task, context);
    assert.equal(natural.route_family, "local_browser");
    assert.equal(natural.auth_requirement.kind, "local_browser_session");
  }

  const request = {
    capability: "social_user_voice_research",
    params: { question: "研究 AgentRouter 用户反馈", platforms }
  };
  const structured = inferStructuredRoutePlan(request, context);
  assert.equal(structured.task_family, "structured_batch");
  assert.equal(structured.route_family, "local_browser");
  assert.deepEqual(structured.candidate_sources, platforms);
  assert.deepEqual(structured.auth_requirement, {
    required: true,
    kind: "local_browser_session",
    source: null
  });

  let hostedRuns = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    const http = await postJson(baseUrl, "/agent-router/request", request);
    assert.equal(http.response.status, 200);
    assert.equal(http.payload.status, "local_browser_handoff_required");
    assert.deepEqual(http.payload.local_route.params.platforms, platforms);
    assert.equal(Object.hasOwn(http.payload.local_route.params, "platform"), false);
    assert.equal(storedObservation(store, http.payload).action, "browser_handoff");

    const mcp = await callMcpRequest(baseUrl, request);
    assert.equal(mcp.status, "local_browser_handoff_required");
    assert.deepEqual(mcp.local_route.params.platforms, platforms);
    assert.equal(Object.hasOwn(mcp.local_route.params, "platform"), false);
    assert.equal(storedObservation(store, mcp).action, "browser_handoff");
    assert.equal(hostedRuns, 0, "a local multi-platform batch must not silently invoke hosted research");
  }, {
    socialProviderFactory: async () => ({}),
    socialResearchRunner: async () => {
      hostedRuns += 1;
      return { ok: true, status: "completed", result: { items: [] } };
    }
  });
});

test("mixed structured social batches fail closed without dropping unavailable or unknown platforms", async () => {
  const context = {
    agentrouter_authenticated: false,
    connected_sources: [],
    local_browser_sessions: [],
    constraints: { max_price_usdc: "0.05" }
  };
  const cases = [
    { platforms: ["reddit", "socialcrawl"], reason: "source_not_callable", blocked: "socialcrawl" },
    { platforms: ["x", "linkedin"], reason: "source_not_callable", blocked: "linkedin" },
    { platforms: ["reddit", "not_a_real_social_source"], reason: "unsupported_source", blocked: "not_a_real_social_source" }
  ];

  for (const item of cases) {
    const plan = inferStructuredRoutePlan({
      capability: "social_user_voice_research",
      params: { question: "AgentRouter feedback", platforms: item.platforms }
    }, context);
    assert.equal(plan.abstain_reason, item.reason);
    assert.equal(plan.source_constraint, item.blocked);
    assert.deepEqual(plan.candidate_sources, item.platforms);
    assert.deepEqual(plan.params.platforms, item.platforms);
    assert.deepEqual(plan.params.blocked_sources, [item.blocked]);
    assert.equal(plan.must_not_fallback, true);
  }

  let hostedRuns = 0;
  let connectorIo = 0;
  await withRuntimeServer(async ({ baseUrl, store }) => {
    for (const item of cases) {
      const request = {
        capability: "social_user_voice_research",
        params: { question: "AgentRouter feedback", platforms: item.platforms }
      };
      const http = await postJson(baseUrl, "/agent-router/request", request);
      assert.equal(http.response.status, 422);
      assert.equal(http.payload.status, item.reason);
      assert.equal(http.payload.source, item.blocked);
      assert.equal(storedObservation(store, http.payload).action, "no_match");

      const mcp = await callMcpRequest(baseUrl, request);
      assert.equal(mcp.status, item.reason);
      assert.equal(mcp.source, item.blocked);
      assert.equal(storedObservation(store, mcp).action, "no_match");
    }
    assert.equal(hostedRuns, 0);
    assert.equal(connectorIo, 0);
  }, {
    socialConnectionOptions: {
      fetchImpl: async () => {
        connectorIo += 1;
        throw new Error("a blocked mixed social batch must not call connector I/O");
      }
    },
    socialResearchRunner: async () => {
      hostedRuns += 1;
      return { ok: true, status: "completed", result: { items: [] } };
    }
  });
});
