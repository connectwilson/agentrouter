import test from "node:test";
import assert from "node:assert/strict";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { createMemoryStore } from "../src/store.js";
import { registerService } from "../src/registry.js";
import { inferIntent, intentToCapabilityRequest } from "../src/agent-router.js";
import { inferRoutePlan } from "../src/routing/planner.js";
import { buildInput, quoteCapabilityRequest, routeCapabilityRequest, rankCandidates } from "../src/router.js";

const address = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const task = "查robinhood链上PONS代币的前10大 token holder的地址";
const originalBackend = process.env.ADN_PAYMENT_BACKEND;
test.before(() => { process.env.ADN_PAYMENT_BACKEND = "credits"; });
test.after(() => { if (originalBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND; else process.env.ADN_PAYMENT_BACKEND = originalBackend; });

function fixture({ tokens, rows, mutate, resolver = true, holderStatus = 200 } = {}) {
  const store = createMemoryStore();
  for (const [id, capabilities, sample] of [
    ["nansen_tgm_holders", ["nansen", "token_holders", "holder_distribution"], { chain: "ethereum", token_address: other, date: { from: "2020" } }],
    ["nansen_search_general", ["nansen", "token_search", "token_metadata", "data_service"], { search_query: "PEPE", chain: "ethereum", result_type: "token", limit: 25 }],
    ["nansen_who_bought_sold", ["nansen", "token_god_mode", "token_data", "data_service"], { chain: "ethereum", token_address: other }]
  ]) {
    if (!resolver && id === "nansen_search_general") continue;
    const manifest = structuredClone(baseFundFlowManifest);
    Object.assign(manifest, { service_id: id, title: id.replaceAll("_", " "), description_for_agent: id.replaceAll("_", " "), capabilities,
      sample_request: sample, input_schema: { type: "object", properties: id === "nansen_tgm_holders" ? { chain: { type: "string" }, token_address: { type: "string" } } : {} },
      endpoint: { method: "POST", url: `http://127.0.0.1/provider/${id}` } });
    manifest.provider.provider_id = "provider_nansen_api";
    manifest.pricing.amount = "0.01";
    registerService(store, manifest, "http://127.0.0.1").verification_status = "verified";
  }
  const calls = [];
  const options = { consumerApiKey: "test-only", writeServiceEvent: async () => true, providerTransportOptions: {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async ({ url, body }) => {
      const input = JSON.parse(body);
      calls.push({ url: String(url), input });
      const id = new URL(url).pathname.split("/").at(-1);
      const envelope = structuredClone(baseFundFlowManifest.sample_response);
      delete envelope.sample_type;
      Object.assign(envelope, { service_id: id, request_id: `holders_test_${calls.length}`, query: input,
        data: id === "nansen_search_general"
          ? { tokens: tokens ?? [{ symbol: "PONS", chain: "robinhood", address }], total_results: (tokens ?? [1]).length }
          : { data: rows ?? Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 10).padStart(40, "0")}`, token_amount: 100 - i })), pagination: { is_last_page: true } }
      });
      envelope.metadata.generated_at = new Date().toISOString();
      envelope.metadata.freshness_seconds = 0;
      envelope.metadata.billing = { billing_status: "charged", amount: "0.01" };
      mutate?.(envelope, id);
      return new Response(JSON.stringify(envelope), { status: id === "nansen_search_general" ? 200 : holderStatus, headers: { "content-type": "application/json" } });
    }
  } };
  return { store, calls, options };
}
function request(params = {}, max = "0.05") {
  return { capability: "token_holders", params: { chain: "robinhood", token_symbol: "PONS", limit: 10, ...params }, constraints: { max_price_usdc: max } };
}

// Production canary 2026-09-07: both endpoints advertised token_holders, but
// prediction-market/top-holders accepts market_id, not chain + token_address.
for (const [label, properties, capabilities] of [
  ["prediction market", { market_id: { type: "string" } }, ["prediction_market", "polymarket"]],
  ["missing chain", { token_address: { type: "string" } }, []],
  ["missing contract", { chain: { type: "string" } }, []],
  ["opaque schema", {}, []],
  ["numeric chain", { chain: { type: "number" }, token_address: { type: "string" } }, []],
  ["conflicting domain", { chain: { type: "string" }, token_address: { type: "string" } }, ["prediction_market"]]
]) {
  test(`holder eligibility precedes trust/price ranking: ${label}`, async () => {
    const { store, calls, options } = fixture();
    const manifest = structuredClone(store.services.get("nansen_tgm_holders").manifest);
    Object.assign(manifest, { service_id: "incompatible_top_holders", title: label, input_schema: { type: "object", properties },
      capabilities: [...manifest.capabilities, ...capabilities], endpoint: { method: "POST", url: "http://127.0.0.1/provider/incompatible_top_holders" } });
    manifest.pricing.amount = "0.0001";
    registerService(store, manifest, "http://127.0.0.1").verification_status = "verified";
    assert.deepEqual(rankCandidates(store, { capability: "token_holders", ...request().params }).map(x => x.service_id), ["nansen_tgm_holders"]);
    assert.equal(quoteCapabilityRequest(store, request()).selected_service.service_id, "nansen_tgm_holders");
    const result = await routeCapabilityRequest(store, request(), options);
    assert.equal(result.status, "routed");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => !call.url.includes("incompatible_top_holders")));
    store.services.delete("nansen_tgm_holders");
    calls.length = 0;
    assert.equal((await routeCapabilityRequest(store, request(), options)).status, "no_match");
    assert.equal(calls.length, 0, "do not pay even for resolution when the only holder contract is incompatible");
  });
}

for (const query of [task, "查询 Robinhood Chain 上 PONS 前十名持币地址", "List the top 10 token holders of PONS on Robinhood Chain", "查robinhood链上pons代币前10大持有人"]) {
  test(`natural holder task routes to the registered contract: ${query}`, () => {
    const req = intentToCapabilityRequest(inferIntent(query), { max_price: "0.05" });
    assert.equal(req?.capability, "token_holders");
    assert.equal(req.params.chain, "robinhood");
    assert.equal(req.params.token_symbol, "PONS");
    assert.equal(req.params.limit, 10);
    const plan = inferRoutePlan(query, { registered_capabilities: ["token_holders"], constraints: { max_price_usdc: "0.05" } });
    assert.equal(plan.route_family, "registered_service");
    assert.equal(plan.abstain_reason, null);
  });
}

test("holder ranking excludes generic TGM services and ignores sample chain as coverage", () => {
  const { store } = fixture();
  assert.deepEqual(rankCandidates(store, { capability: "token_holders", ...request().params }).map(x => x.service_id), ["nansen_tgm_holders"]);
  const input = buildInput(store.services.get("nansen_tgm_holders").manifest, { capability: "token_holders", ...request({ token_address: address }).params });
  assert.deepEqual(input, { chain: "robinhood", token_address: address, pagination: { page: 1, per_page: 10 }, aggregate_by_entity: false, label_type: "all_holders", order_by: [{ field: "token_amount", direction: "DESC" }] });
});

test("quote includes resolver plus holders without using sample token or executing either", () => {
  const { store, calls } = fixture();
  const quoted = quoteCapabilityRequest(store, request(), { writeServiceEvent: async () => true });
  assert.equal(quoted.ok, true);
  assert.equal(Number(quoted.quote.amount), 0.02);
  assert.equal(quoted.input.token_address, undefined);
  assert.equal(quoted.token_resolution.status, "required");
  assert.equal(quoted.resolver, undefined, "quote must not expose the internal resolver registry record");
  assert.equal(calls.length, 0);
});

test("symbol task resolves exact chain and executes holder query, with quality verification", async () => {
  const { store, calls, options } = fixture();
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.status, "routed", JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.chain, "robinhood");
  assert.equal(calls[1].input.token_address, address);
  assert.equal(result.verification.intent_fit_valid, true);
  assert.equal(result.token_resolution.resolver_service_id, "nansen_search_general");
});

for (const max of ["0", "0.009", "0.015"]) {
  test(`total budget ${max} blocks BEFORE paid resolution`, async () => {
    const { store, calls, options } = fixture();
    const result = await routeCapabilityRequest(store, request({}, max), options);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
}
test("explicit contract skips resolver and fits a single-call budget", async () => {
  const { store, calls, options } = fixture({ resolver: false });
  const result = await routeCapabilityRequest(store, request({ token_address: address }, "0.01"), options);
  assert.equal(result.status, "routed", JSON.stringify(result));
  assert.equal(calls.length, 1);
});

for (const chain of ["robinhood", "base", "ethereum", "bsc", "bnb", "arbitrum", "optimism", "hyperevm"]) {
  test(`explicit holder contract preserves supported chain ${chain}`, async () => {
    const { store, calls, options } = fixture();
    const result = await routeCapabilityRequest(store, request({ chain, token_address: address }), options);
    assert.equal(result.status, "routed");
    assert.equal(calls[0].input.chain, chain === "bsc" ? "bnb" : chain);
  });
}

test("truncated search cannot prove an unambiguous symbol", async () => {
  const { store, calls, options } = fixture({ mutate: (r, id) => { if (id === "nansen_search_general") r.data.total_results = 60; } });
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.status, "token_resolution_ambiguous");
  assert.equal(calls.length, 1);
});

test("resolver samples cannot authorize buying another dataset", async () => {
  const { store, calls, options } = fixture({ mutate: (r, id) => { if (id === "nansen_search_general") r.sample_type = "historical"; } });
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("missing holder chain is clarified before advertising account authorization", () => {
  const plan = inferRoutePlan("查PONS代币前10大持有人", { registered_capabilities: ["token_holders"], agentrouter_authenticated: false, constraints: { max_price_usdc: "0.05" } });
  assert.equal(plan.auth_requirement.required, false);
  assert.equal(plan.abstain_reason, "needs_clarification");
});

test("Chinese top twenty is not silently top ten", () => {
  assert.equal(intentToCapabilityRequest(inferIntent("查询 Robinhood Chain 上 PONS 前二十名持币地址")).params.limit, 20);
});

test("no resolver available is discovered before payment or provider I/O", async () => {
  const { store, calls, options } = fixture({ resolver: false });
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.status, "token_resolver_not_found");
  assert.equal(calls.length, 0);
});

test("declared endpoint chain coverage wins over generic Nansen coverage", () => {
  const { store } = fixture();
  store.services.get("nansen_tgm_holders").manifest.input_schema.properties.chain = { type: "string", enum: ["ethereum"] };
  const result = quoteCapabilityRequest(store, request());
  assert.equal(result.status, "no_match");
});

test("unverified holder service cannot trigger even the paid resolver", async () => {
  const { store, calls, options } = fixture();
  store.services.get("nansen_tgm_holders").verification_status = "pending";
  assert.equal((await routeCapabilityRequest(store, request(), options)).status, "no_match");
  assert.equal(calls.length, 0);
});

test("duplicate search rows for the same contract are not distinct token candidates", async () => {
  const token = { symbol: "PONS", chain: "robinhood", address };
  const { store, calls, options } = fixture({ tokens: [token, { ...token }] });
  assert.equal((await routeCapabilityRequest(store, request(), options)).status, "routed");
  assert.equal(calls.length, 2);
});

test("holder trust constraints apply before resolution costs are incurred", async () => {
  const { store, calls, options } = fixture();
  const req = request();
  req.constraints.min_trust_score = 1;
  assert.equal((await routeCapabilityRequest(store, req, options)).status, "no_match");
  assert.equal(calls.length, 0);
});

test("incomplete holder page cannot be sold as a complete top ten", async () => {
  const { store, options } = fixture({ mutate: r => { r.data.data = r.data.data.slice(0, 2); r.data.pagination.is_last_page = false; } });
  assert.equal((await routeCapabilityRequest(store, request({ token_address: address }), options)).status, "data_quality_failed");
});

test("non-numeric holder balances fail verification", async () => {
  const { store, options } = fixture({ mutate: r => { r.data.data[0].token_amount = "unknown"; } });
  assert.equal((await routeCapabilityRequest(store, request({ token_address: address }), options)).status, "data_quality_failed");
});

test("current holder contract must not silently answer a historical snapshot request", async () => {
  const { store, calls, options } = fixture();
  const result = await routeCapabilityRequest(store, request({ token_address: address, date: "2024-01-01" }), options);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  const historical = intentToCapabilityRequest(inferIntent("查询 Robinhood Chain 上 PONS 去年的前十名持币地址"));
  assert.equal((await routeCapabilityRequest(store, historical, options)).ok, false);
  assert.equal(calls.length, 0);
});

test("holder schema incompatibility is found before buying token resolution", async () => {
  const { store, calls, options } = fixture();
  store.services.get("nansen_tgm_holders").manifest.input_schema.required = ["chain", "token_address", "date"];
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.status, "preflight_validation_failed");
  assert.equal(calls.length, 0);
});

test("unrepresentable USDC prices are rejected instead of rounded down", async () => {
  const { store, calls, options } = fixture();
  store.services.get("nansen_tgm_holders").manifest.pricing.amount = "0.010000001";
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.status, "price_unknown");
  assert.equal(calls.length, 0);
});

test("second-step failure retains the already-billed resolver receipt", async () => {
  const { store, calls, options } = fixture({ holderStatus: 502 });
  const result = await routeCapabilityRequest(store, request(), options);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.equal(result.token_resolution?.status, "resolved");
  assert.equal(result.token_resolution.billing.amount, "0.01");
});

for (const [name, tokens] of [
  ["wrong chain", [{ symbol: "PONS", chain: "ethereum", address }]],
  ["wrapped substitute", [{ symbol: "WPONS", chain: "robinhood", address }]],
  ["missing chain", [{ symbol: "PONS", address }]],
  ["ambiguous contracts", [{ symbol: "PONS", chain: "robinhood", address }, { symbol: "PONS", chain: "robinhood", address: other }]],
  ["empty search", []]
]) {
  test(`resolver ${name} never buys holder results for a guessed token`, async () => {
    const { store, calls, options } = fixture({ tokens });
    const result = await routeCapabilityRequest(store, request(), options);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(result.status, /token_(not_found|resolution_ambiguous)/);
  });
}

for (const params of [{ chain: "" }, { chain: "fantasychain" }, { token_address: "0xBAD" }, { limit: 0 }, { limit: 101 }, { limit: 1.2 }, { token_symbol: "", token_address: "" }]) {
  test(`invalid holder request is free to reject: ${JSON.stringify(params)}`, async () => {
    const { store, calls, options } = fixture();
    const result = await routeCapabilityRequest(store, request(params), options);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
}

for (const [label, mutate] of [
  ["pools", r => { r.data = { pools: [{ address, volume: 500 }] }; }],
  ["wrong chain", r => { r.query.chain = "bnb"; }],
  ["wrong contract", r => { r.query.token_address = other; }],
  ["unsorted balances", r => { r.data.data.reverse(); }],
  ["duplicate addresses", r => { r.data.data[1].address = r.data.data[0].address; }],
  ["negative balance", r => { r.data.data[9].token_amount = -1; }],
  ["empty result", r => { r.data.data = []; }]
]) {
  test(`holder verification rejects ${label}`, async () => {
    const { store, options } = fixture({ mutate });
    const result = await routeCapabilityRequest(store, request({ token_address: address }), options);
    assert.equal(result.status, "data_quality_failed");
    assert.equal(result.verification.intent_fit_valid, false);
  });
}
