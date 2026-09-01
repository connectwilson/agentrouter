import test from "node:test";
import assert from "node:assert/strict";

import { createRouteObservationV2 } from "../src/routing/metrics.js";
import { upsertCompletedCallRouteObservation } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

function preflight(overrides = {}) {
  return createRouteObservationV2({
    observation_id: "route_obs_paid_local_terminal",
    request_id: "route_req_paid_local_terminal",
    created_at: "2026-09-01T00:00:00.000Z",
    entrypoint: "cli_request",
    task_family: "onchain_market_data",
    route_family: "registered_service",
    capability: "perp_liquidation_max_pain",
    source_family: "onchain",
    action: "route",
    selected_service_id: "btc_liquidation_max_pain_demo",
    candidates: [{
      service_id: "btc_liquidation_max_pain_demo",
      source_family: "registered_service",
      routing_score: 0.94,
      price_usdc: "0.02"
    }],
    confidence: 0.94,
    fallback: { used: false, from: null, to: null, reason: null },
    authorization: { required: false, action: "none", source: null },
    budget: { max_price_usdc: "0.05", selected_price_usdc: "0.02", compliant: true },
    actor_key: "wallet:0x1111111111111111111111111111111111111111",
    routing_policy_version: "agentrouter_route_plan_v1",
    diagnostics: { candidate_count: 1, eligible_candidate_count: 1, policy_gate: "allowed" },
    ...overrides
  });
}

const identity = {
  observation_id: "route_obs_paid_local_terminal",
  request_id: "route_req_paid_local_terminal"
};

test("paid local completion replaces its preflight observation with one durable same-id terminal event", async () => {
  const store = createMemoryStore();
  store.routeObservations.push(preflight());
  const writes = [];
  const actorKey = "wallet:0x1111111111111111111111111111111111111111";
  const body = {
    routing_observation: identity,
    routing_summary: {
      route_family: "external_api",
      capability: "stock_quote",
      selected_service_id: "attacker_service",
      action: "fallback",
      budget: { max_price_usdc: "0", selected_price_usdc: "999", compliant: false }
    }
  };

  const terminal = await upsertCompletedCallRouteObservation(store, body, {
    actorKey,
    serviceId: "btc_liquidation_max_pain_demo",
    request: { capability: "perp_liquidation_max_pain" },
    manifest: { pricing: { amount: "0.02", currency: "USDC" } },
    writeEvents: async (entries) => {
      writes.push(entries);
      return true;
    }
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  assert.equal(writes[0][0].eventType, "route_observation");
  assert.equal(writes[0][0].event.observation_id, identity.observation_id);
  assert.equal(store.routeObservations.length, 1, "terminal state replaces, rather than duplicates, the preflight event");
  assert.equal(terminal.observation_id, identity.observation_id);
  assert.equal(terminal.request_id, identity.request_id);
  assert.equal(terminal.action, "route");
  assert.equal(terminal.route_family, "registered_service");
  assert.equal(terminal.capability, "perp_liquidation_max_pain");
  assert.equal(terminal.selected_service_id, "btc_liquidation_max_pain_demo");
  assert.equal(terminal.durability_status, "durable");
  assert.equal(terminal.feedback_endpoint, "/agent-router/routing-feedback");
  assert.deepEqual(terminal.budget, {
    max_price_usdc: "0.05",
    selected_price_usdc: "0.02",
    compliant: true
  });

  const replay = await upsertCompletedCallRouteObservation(store, body, {
    actorKey,
    serviceId: "btc_liquidation_max_pain_demo",
    request: { capability: "perp_liquidation_max_pain" },
    manifest: { pricing: { amount: "0.02", currency: "USDC" } },
    writeEvents: async () => true
  });
  assert.equal(replay.observation_id, terminal.observation_id);
  assert.equal(store.routeObservations.length, 1);
});

test("terminal completion cannot claim another actor, service, capability, or invented observation", async () => {
  const base = {
    actorKey: "wallet:0x1111111111111111111111111111111111111111",
    serviceId: "btc_liquidation_max_pain_demo",
    request: { capability: "perp_liquidation_max_pain" },
    manifest: { pricing: { amount: "0.02", currency: "USDC" } },
    writeEvents: async () => assert.fail("an invalid terminal identity must not be persisted")
  };
  const cases = [
    {
      body: { routing_observation: { observation_id: "invented", request_id: "invented" }, routing_summary: {} },
      options: {},
      code: "ROUTING_OBSERVATION_NOT_FOUND"
    },
    {
      body: { routing_observation: identity, routing_summary: {} },
      options: { actorKey: "wallet:0x2222222222222222222222222222222222222222" },
      code: "FORBIDDEN_ROUTING_OBSERVATION_ACTOR"
    },
    {
      body: { routing_observation: identity, routing_summary: {} },
      options: { serviceId: "another_service" },
      code: "ROUTING_OBSERVATION_SERVICE_MISMATCH"
    },
    {
      body: { routing_observation: identity, routing_summary: {} },
      options: { request: { capability: "stock_quote" } },
      code: "ROUTING_OBSERVATION_CAPABILITY_MISMATCH"
    }
  ];

  for (const item of cases) {
    const store = createMemoryStore();
    store.routeObservations.push(preflight());
    await assert.rejects(
      upsertCompletedCallRouteObservation(store, item.body, { ...base, ...item.options }),
      (error) => error?.code === item.code
    );
    assert.equal(store.routeObservations.length, 1);
    assert.equal(store.routeObservations[0].action, "route");
  }
});

test("terminal routing summary without a server-issued identity is rejected", async () => {
  const store = createMemoryStore();
  store.routeObservations.push(preflight());
  await assert.rejects(
    upsertCompletedCallRouteObservation(store, { routing_summary: { action: "route" } }, {
      actorKey: "wallet:0x1111111111111111111111111111111111111111",
      serviceId: "btc_liquidation_max_pain_demo",
      request: { capability: "perp_liquidation_max_pain" },
      manifest: { pricing: { amount: "0.02", currency: "USDC" } },
      writeEvents: async () => assert.fail("missing identity must not write")
    }),
    (error) => error?.code === "ROUTING_OBSERVATION_IDENTITY_REQUIRED"
  );
});
