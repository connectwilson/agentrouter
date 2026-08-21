import test from "node:test";
import assert from "node:assert/strict";

process.env.ADN_PAYMENT_BACKEND = "credits";

const { askAgentRouter } = await import("../src/agent-router.js");
const { createServer } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");
const { registerService } = await import("../src/registry.js");

function createPaidService(store, baseUrl = "http://127.0.0.1:8800") {
  const record = registerService(store, {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: "browser_auth_test_service",
    title: "BTC liquidation max pain",
    description_for_agent: "Returns the current BTC perpetual liquidation max-pain level.",
    capabilities: ["data_service", "perp_liquidation_max_pain"],
    pricing: { amount: "0.01", currency: "USDC", network: "agentrouter" },
    provider: { provider_id: "browser_auth_test_provider" },
    endpoint: { url: `${baseUrl}/provider/browser-auth-test`, method: "POST" },
    input_schema: { type: "object", properties: {} },
    output_schema: { type: "object", properties: {} },
    sample_request: {},
    sample_response: {}
  }, baseUrl);
  record.verification_status = "verified";
  return record;
}

function assertBrowserConnectionRequired(payload) {
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "connection_required");
  assert.equal(payload.action_required.preferred_tool, "agentrouter_connect");
  assert.match(payload.action_required.user_experience, /browser approval link/i);
  assert.doesNotMatch(JSON.stringify(payload), /configure an AgentRouter API key/i);
}

test("credit-backed natural-language calls direct the agent to browser approval", async () => {
  const store = createMemoryStore();
  createPaidService(store);

  const result = await askAgentRouter(store, {
    task: "BTC liquidation max pain",
    max_price: "0.05",
    invoke: false
  });

  assertBrowserConnectionRequired(result);
  assert.ok(result.quote, "the connection response should retain the selected service quote");
});

test("credit-backed HTTP calls return a browser connection action instead of API-key setup", async () => {
  const store = createMemoryStore();
  createPaidService(store);
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: { asset: "BTC", market_type: "perpetual_futures", window: "current" },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assertBrowserConnectionRequired(payload);
    assert.ok(payload.quote, "the connection response should retain the selected service quote");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credit-backed connector calls distinguish missing connection from insufficient payment", async () => {
  const store = createMemoryStore();
  createPaidService(store);
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "browser_auth_test_service",
        input: { asset: "BTC" },
        budget: { max_amount: "0.05", currency: "USDC" }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assertBrowserConnectionRequired(payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
