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

function fixture({ tokens, rows, mutate, resolver = true } = {}) {
  const store = createMemoryStore();
  for (const [id, capabilities, sample] of [
    ["nansen_tgm_holders", ["nansen", "token_holders", "holder_distribution"], { chain: "ethereum", token_address: other, date: { from: "2020" } }],
    ["nansen_search_general", ["nansen", "token_search", "token_metadata", "data_service"], { search_query: "PEPE", chain: "ethereum", result_type: "token", limit: 25 }],
    ["nansen_who_bought_sold", ["nansen", "token_god_mode", "token_data", "data_service"], { chain: "ethereum", token_address: other }]
  ]) {
    if (!resolver && id === "nansen_search_general") continue;
    const manifest = structuredClone(baseFundFlowManifest);
    Object.assign(manifest, { service_id: id, title: id.replaceAll("_", " "), description_for_agent: id.replaceAll("_", " "), capabilities,
      sample_request: sample, input_schema: { type: "object", properties: {} },
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
      return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
    }
  } };
  return { store, calls, options };
}
function request(params = {}, max = "0.05") {
  return { capability: "token_holders", params: { chain: "robinhood", token_symbol: "PONS", limit: 10, ...params }, constraints: { max_price_usdc: max } };
}

for (const query of [task, "查询 Robinhood Chain 上 PONS 前十名持币地址", "List the top 10 token holders of PONS on Robinhood Chain", "查robinhood链上pons代币前10大持有人"]) {
  test(`natural holder task routes to the registered contract: ${query}`, () => {
    const req = intentToCapabilityRequest(inferIntent(query), { max_price: "0.05" });
    assert.equal(req?.capability, "token_holders");
    assert.equal(req.params.chain, "robinhood");
    assert.equal(req.params.token_symbol, "PONS");
    assert.equal(req.params.limit, 10);
    const plan = inferRoutePlan(query, { registered_capabilities: ["token_holders"] });
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
