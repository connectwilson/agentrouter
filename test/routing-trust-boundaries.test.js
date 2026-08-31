import test from "node:test";
import assert from "node:assert/strict";

import { baseFundFlowManifest } from "../src/fixtures.js";
import { invokePaidService, registerService } from "../src/registry.js";
import { rankCandidates, routeCapabilityRequest } from "../src/router.js";
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

function installProviderFetchSpy(serviceId) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(liveFundFlowEnvelope(serviceId)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
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

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
