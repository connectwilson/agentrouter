import test from "node:test";
import assert from "node:assert/strict";

import { baseFundFlowManifest } from "../src/fixtures.js";
import { invokePaidService, registerService } from "../src/registry.js";
import { quoteCapabilityRequest, rankCandidates, routeCapabilityRequest } from "../src/router.js";
import { createMemoryStore } from "../src/store.js";

const originalPaymentBackend = process.env.ADN_PAYMENT_BACKEND;
const originalDatabaseUrl = process.env.DATABASE_URL;

test.before(() => {
  process.env.ADN_PAYMENT_BACKEND = "credits";
  delete process.env.DATABASE_URL;
});

test.after(() => {
  restoreEnvironment("ADN_PAYMENT_BACKEND", originalPaymentBackend);
  restoreEnvironment("DATABASE_URL", originalDatabaseUrl);
});

test("pending services are excluded from candidate ranking", () => {
  const { store, serviceId } = registeredFundFlowService({ verificationStatus: "pending" });

  const candidates = rankCandidates(store, fundFlowIntent(), { max_price_usdc: "0.05" });

  assert.equal(
    candidates.some((candidate) => candidate.service_id === serviceId),
    false,
    "an unverified service must not be eligible for demand-side routing"
  );
});

test("a current on-chain request excludes services whose declared freshness cannot meet its hard limit", () => {
  const { store, record } = registeredFundFlowService({ verificationStatus: "verified" });
  record.manifest.freshness.max_data_lag_seconds = 3600;

  const candidates = rankCandidates(store, fundFlowIntent(), {
    max_price_usdc: "0.05",
    freshness_seconds: 60
  });

  assert.deepEqual(candidates, []);
});

test("token smart-money resolution never substitutes a same-symbol address from another chain", async () => {
  const store = createMemoryStore();
  const resolver = structuredClone(baseFundFlowManifest);
  resolver.service_id = "strict_chain_token_resolver";
  resolver.provider.provider_id = "strict_chain_token_directory";
  resolver.title = "Strict Chain Token Resolver";
  resolver.description_for_agent = "Resolve a token symbol to its contract address on the requested chain.";
  resolver.capabilities = ["data_service", "token_search", "token_metadata"];
  resolver.endpoint = { method: "POST", url: "http://127.0.0.1/provider/strict-token-resolver" };
  resolver.input_schema = {
    type: "object",
    required: ["search_query", "chain"],
    properties: { search_query: { type: "string" }, chain: { type: "string" } }
  };
  resolver.sample_request = { search_query: "PONS", chain: "bsc" };

  const flow = structuredClone(baseFundFlowManifest);
  flow.service_id = "strict_chain_token_flow";
  flow.provider.provider_id = "strict_chain_flow_provider";
  flow.title = "Strict Chain Token Flow";
  flow.description_for_agent = "Token flow intelligence with who bought and sold activity.";
  flow.capabilities = ["data_service", "token_god_mode", "token_data", "flow_intelligence", "token_flow", "smart_money"];
  flow.endpoint = { method: "POST", url: "http://127.0.0.1/provider/strict-token-flow" };
  flow.input_schema = {
    type: "object",
    required: ["chain", "token_address"],
    properties: { chain: { type: "string" }, token_address: { type: "string" } }
  };
  flow.sample_request = { chain: "bsc", token_address: "0x1111111111111111111111111111111111111111" };

  for (const manifest of [resolver, flow]) {
    const record = registerService(store, manifest, "https://agentrouter.test");
    record.verification_status = "verified";
  }

  const providerCalls = [];
  const routed = await routeCapabilityRequest(store, {
    capability: "token_smart_money_activity",
    params: { token_symbol: "PONS", chain: "bsc", window: "24h" },
    constraints: { max_price_usdc: "0.05" }
  }, {
    consumerApiKey: "ar_consumer_secret",
    providerTransportOptions: {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      requestHop: async ({ url }) => {
        providerCalls.push(String(url));
        if (String(url).includes("strict-token-resolver")) {
          return new Response(JSON.stringify(tokenResolverEnvelope(resolver.service_id, [{
            symbol: "PONS",
            token_address: "0x1111111111111111111111111111111111111111",
            chain: "ethereum"
          }])), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error("The token-flow provider must not be called for a wrong-chain token match.");
      }
    }
  });

  assert.equal(routed.ok, false);
  assert.equal(routed.status, "token_not_found");
  assert.equal(routed.token_resolution.resolver_input.chain, "bnb");
  assert.deepEqual(providerCalls, ["http://127.0.0.1/provider/strict-token-resolver"]);
});

test("token smart-money requests without an explicit chain fail before token resolution or payment", async () => {
  const store = createMemoryStore();
  const routed = await routeCapabilityRequest(store, {
    capability: "token_smart_money_activity",
    params: { token_symbol: "PONS", window: "24h" },
    constraints: { max_price_usdc: "0.05" }
  }, { consumerApiKey: "ar_consumer_secret" });

  assert.equal(routed.ok, false);
  assert.equal(routed.status, "invalid_request");
  assert.equal(routed.error, "MISSING_REQUIRED_PARAM");
  assert.deepEqual(routed.missing, ["chain"]);
});

test("direct invocation rejects a pending service before any provider fetch", async () => {
  const { store, serviceId } = registeredFundFlowService({ verificationStatus: "pending" });
  const fetchSpy = installProviderFetchSpy(serviceId);

  try {
    const invocation = await invokePaidService(
      store,
      serviceId,
      { chain: "base", days: 7 },
      { max_amount: "0.05", currency: "USDC" },
      { consumerApiKey: "ar_consumer_secret" }
    );

    assert.equal(fetchSpy.calls.length, 0, "verification must be checked before network I/O");
    assert.equal(invocation.statusCode, 409);
    assert.equal(invocation.body.error.code, "SERVICE_NOT_VERIFIED");
  } finally {
    fetchSpy.restore();
  }
});

for (const [label, maxPrice] of [["numeric zero", 0], ["string zero", "0"]]) {
  test(`${label} budget is free-only and never invokes a paid service`, async () => {
    const { store, serviceId } = registeredFundFlowService({ verificationStatus: "verified" });
    const fetchSpy = installProviderFetchSpy(serviceId);

    try {
      const routed = await routeCapabilityRequest(store, capabilityRequest(maxPrice), {
        consumerApiKey: "ar_consumer_secret"
      });

      assert.equal(fetchSpy.calls.length, 0, "a zero budget must not reach a paid provider");
      assert.equal(routed.ok, false);
      assert.equal(routed.selected_service, undefined);
    } finally {
      fetchSpy.restore();
    }
  });
}

for (const [label, maxPrice] of [
  ["malformed string", "not-a-number"],
  ["negative number", -1],
  ["positive infinity", Infinity]
]) {
  test(`${label} budget is rejected before routing or invocation`, async () => {
    const { store, serviceId } = registeredFundFlowService({ verificationStatus: "verified" });
    const fetchSpy = installProviderFetchSpy(serviceId);

    try {
      const routed = await routeCapabilityRequest(store, capabilityRequest(maxPrice), {
        consumerApiKey: "ar_consumer_secret"
      });

      assert.equal(fetchSpy.calls.length, 0, "invalid budget input must fail before network I/O");
      assert.equal(routed.ok, false);
      assert.equal(routed.status, "invalid_request");
      assert.equal(routed.error, "INVALID_BUDGET");
    } finally {
      fetchSpy.restore();
    }
  });
}

test("a blocked payment quote never reaches the selected provider", async () => {
  const { store, serviceId } = registeredFundFlowService({ verificationStatus: "verified" });
  const fetchSpy = installProviderFetchSpy(serviceId);

  try {
    // Today this malformed maximum reaches createPaymentQuote, which correctly
    // blocks it. The regression is that routeCapabilityRequest invokes anyway.
    await routeCapabilityRequest(store, capabilityRequest("not-a-number"), {
      consumerApiKey: "ar_consumer_secret"
    });

    assert.equal(fetchSpy.calls.length, 0, "quote.would_pay=false must be a hard execution boundary");
  } finally {
    fetchSpy.restore();
  }
});

test("consumer platform API key is never forwarded to a provider-controlled origin", async () => {
  const consumerApiKey = "ar_consumer_platform_secret";
  const { store, serviceId } = registeredFundFlowService({
    verificationStatus: "verified",
    endpoint: "https://provider-controlled.example/paid-data"
  });
  const fetchSpy = installProviderFetchSpy(serviceId);

  try {
    await invokePaidService(
      store,
      serviceId,
      { chain: "base", days: 7 },
      { max_amount: "0.05", currency: "USDC" },
      { consumerApiKey }
    );

    for (const call of fetchSpy.calls) {
      const serializedRequest = JSON.stringify({ headers: call.init.headers, body: call.init.body });
      assert.equal(
        serializedRequest.includes(consumerApiKey),
        false,
        "the AgentRouter account credential must terminate at the platform trust boundary"
      );
      assert.equal(new Headers(call.init.headers).has("x-agentrouter-api-key"), false);
    }
  } finally {
    fetchSpy.restore();
  }
});

test("a paid provider result with a failed status is returned as a quality failure, not a routed success", async () => {
  const { store, serviceId } = registeredFundFlowService({
    verificationStatus: "verified",
    endpoint: "http://127.0.0.1/provider/quality-status"
  });
  const fetchSpy = installProviderFetchSpy(serviceId, (envelope) => {
    envelope.status = "error";
    envelope.error = { code: "UPSTREAM_FAILED" };
  });
  try {
    const routed = await routeCapabilityRequest(store, capabilityRequest("0.05"), {
      consumerApiKey: "ar_consumer_secret",
      providerTransportOptions: fetchSpy.transportOptions
    });
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "data_quality_failed");
    assert.ok(routed.verification.issues.some((issue) => issue.code === "STATUS_NOT_SUCCESS"));
    assert.equal(routed.retry_plan.reason_code, "data_quality_failed");
  } finally {
    fetchSpy.restore();
  }
});

test("a stale paid provider result is explicitly downgraded instead of silently routed", async () => {
  const { store, serviceId } = registeredFundFlowService({
    verificationStatus: "verified",
    endpoint: "http://127.0.0.1/provider/quality-freshness"
  });
  const fetchSpy = installProviderFetchSpy(serviceId, (envelope) => {
    envelope.metadata.generated_at = "2010-01-01T00:00:00Z";
    envelope.metadata.freshness_seconds = 0;
  });
  try {
    const routed = await routeCapabilityRequest(store, capabilityRequest("0.05"), {
      consumerApiKey: "ar_consumer_secret",
      providerTransportOptions: fetchSpy.transportOptions
    });
    assert.equal(routed.ok, true);
    assert.equal(routed.status, "routed_with_quality_warning");
    assert.equal(routed.verification.freshness_valid, false);
    assert.equal(routed.retry_plan.reason_code, "data_quality_warning");
  } finally {
    fetchSpy.restore();
  }
});

test("a delivered paid result reports degraded durability when evidence artifacts cannot persist", async () => {
  const { store, serviceId } = registeredFundFlowService({
    verificationStatus: "verified",
    endpoint: "http://127.0.0.1/provider/durability-failure"
  });
  const fetchSpy = installProviderFetchSpy(serviceId);
  try {
    const routed = await routeCapabilityRequest(store, capabilityRequest("0.05"), {
      consumerApiKey: "ar_consumer_secret",
      providerTransportOptions: fetchSpy.transportOptions,
      writeServiceEvent: async ({ eventType }) => {
        if (["evidence", "route_observation"].includes(eventType)) {
          const error = new Error("database unavailable");
          error.code = "PERSISTENCE_WRITE_FAILED";
          throw error;
        }
        return true;
      }
    });

    assert.equal(routed.ok, true, "an already-delivered provider result must remain available");
    assert.equal(routed.durability_status, "degraded");
    assert.deepEqual(routed.durability_errors.map((item) => item.event_type).sort(), ["evidence", "route_observation"]);
    assert.ok(routed.durability_errors.every((item) => item.code === "PERSISTENCE_WRITE_FAILED"));
  } finally {
    fetchSpy.restore();
  }
});

test("quote persistence failure is observable instead of being swallowed", async () => {
  const { store } = registeredFundFlowService({ verificationStatus: "verified" });
  const quote = quoteCapabilityRequest(store, capabilityRequest("0.05"), {
    writeServiceEvent: async () => {
      const error = new Error("database unavailable");
      error.code = "PERSISTENCE_WRITE_FAILED";
      throw error;
    }
  });
  assert.equal(quote.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.routerDurabilityFailures.length, 1);
  assert.equal(store.routerDurabilityFailures[0].event_type, "issued_quote");
  assert.equal(store.routerDurabilityFailures[0].code, "PERSISTENCE_WRITE_FAILED");
});

function registeredFundFlowService({ verificationStatus, endpoint = "https://provider-controlled.example/fund-flow" }) {
  const store = createMemoryStore();
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = `routing_boundary_${Math.random().toString(36).slice(2, 10)}`;
  manifest.provider.provider_id = `provider_${manifest.service_id}`;
  manifest.endpoint = { method: "POST", url: endpoint };
  const record = registerService(store, manifest, "https://agentrouter.test");
  record.verification_status = verificationStatus;
  return { store, record, serviceId: manifest.service_id };
}

function fundFlowIntent() {
  return { capability: "onchain_fund_flow", chain: "base", days: 7 };
}

function capabilityRequest(maxPrice) {
  return {
    capability: "onchain_fund_flow",
    params: { chain: "base", days: 7 },
    constraints: { max_price_usdc: maxPrice }
  };
}

function installProviderFetchSpy(serviceId, mutate = null) {
  const calls = [];
  return {
    calls,
    transportOptions: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestHop: async ({ url, method, headers, body }) => {
        const init = { method, headers, body };
        calls.push({ url: String(url), init });
        const envelope = liveFundFlowEnvelope(serviceId);
        mutate?.(envelope);
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    },
    restore: () => {}
  };
}

function liveFundFlowEnvelope(serviceId) {
  const envelope = structuredClone(baseFundFlowManifest.sample_response);
  delete envelope.sample_type;
  envelope.service_id = serviceId;
  envelope.request_id = `request_${serviceId}`;
  envelope.metadata.generated_at = new Date().toISOString();
  envelope.metadata.freshness_seconds = 0;
  envelope.metadata.billing = {
    billing_status: "charged",
    amount: "0.01",
    ledger_entry_id: `ledger_${serviceId}`,
    balance_after: "1.00"
  };
  return envelope;
}

function tokenResolverEnvelope(serviceId, data) {
  const envelope = liveFundFlowEnvelope(serviceId);
  envelope.data = data;
  envelope.query = { search_query: "PONS", chain: "bnb" };
  return envelope;
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
