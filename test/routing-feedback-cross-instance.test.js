import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { serviceEventIdempotencyKey } from "../src/persistence.js";
import { createRouteObservationV2, recordRoutingFeedback } from "../src/routing/metrics.js";
import { createMemoryStore } from "../src/store.js";

const actorKey = "github:cross-instance-routing-owner";
const observationId = "route_obs_cross_instance_single_label";
const requestId = "req_cross_instance_single_label";

function createStore() {
  const store = createMemoryStore();
  store.routeObservations.push(createRouteObservationV2({
    observation_id: observationId,
    request_id: requestId,
    action: "route",
    route_family: "registered_service",
    capability: "academic_search",
    source_family: "academic",
    selected_service_id: "openalex",
    candidates: [{ service_id: "openalex", source_family: "academic", routing_score: 0.91 }],
    actor_key: actorKey
  }));
  return store;
}

function label(expectedServiceId) {
  return {
    observation_id: observationId,
    request_id: requestId,
    verdict: "incorrect",
    expected_action: "route",
    expected_route_family: "external_api",
    expected_capability: "general_web_research",
    expected_source_family: "web_search",
    expected_service_id: expectedServiceId,
    reason_code: "wrong_source"
  };
}

function createSharedDurableWriter() {
  const rows = new Map();
  return {
    rows,
    async write(entry) {
      await Promise.resolve();
      const idempotencyKey = serviceEventIdempotencyKey(entry);
      const existing = rows.get(idempotencyKey);
      if (existing) return { status: "existing", event: structuredClone(existing.event) };
      rows.set(idempotencyKey, structuredClone(entry));
      return { status: "created", event: structuredClone(entry.event) };
    }
  };
}

test("two instances atomically accept one routing label and return the durable canonical label", async () => {
  const persistence = createSharedDurableWriter();
  const stores = [createStore(), createStore()];
  const attempts = await Promise.all([
    recordRoutingFeedback(stores[0], label("exa"), { actorKey, writeEvent: persistence.write }),
    recordRoutingFeedback(stores[1], label("reddit"), { actorKey, writeEvent: persistence.write })
  ]);

  assert.deepEqual(attempts.map((result) => result.statusCode).sort(), [201, 409]);
  assert.equal(persistence.rows.size, 1);
  const canonical = [...persistence.rows.values()][0].event;
  assert.ok(stores.every((store) => store.routingFeedbackEvents.length === 1));
  assert.ok(stores.every((store) => store.routingFeedbackEvents[0].expected_service_id === canonical.expected_service_id));

  const replayStore = createStore();
  const replay = await recordRoutingFeedback(replayStore, label(canonical.expected_service_id), {
    actorKey,
    writeEvent: persistence.write
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.status, "routing_feedback_already_recorded");
  assert.equal(replay.event.expected_service_id, canonical.expected_service_id);
});

test("routing feedback keeps memory-only behavior when persistence is disabled", async () => {
  const store = createStore();
  const result = await recordRoutingFeedback(store, label("exa"), {
    actorKey,
    writeEvent: async () => false
  });
  assert.equal(result.statusCode, 201);
  assert.equal(store.routingFeedbackEvents.length, 1);
});

test("routing feedback fails closed without materializing a label when persistence fails", async () => {
  const store = createStore();
  const result = await recordRoutingFeedback(store, label("exa"), {
    actorKey,
    writeEvent: async () => { throw new Error("shared database unavailable"); }
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error.code, "ROUTING_FEEDBACK_PERSISTENCE_FAILED");
  assert.equal(store.routingFeedbackEvents.length, 0);
});

test("missing observations fail closed when the durable read-through is unavailable", async () => {
  const store = createMemoryStore();
  const result = await recordRoutingFeedback(store, label("exa"), {
    actorKey,
    writeEvent: async () => true,
    refreshEvents: async () => ({
      ok: false,
      status: "degraded",
      error: { code: "DATABASE_UNAVAILABLE" }
    })
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error.code, "ROUTING_FEEDBACK_PERSISTENCE_FAILED");
});

test("feedback posted to another instance reads through after an overlapping refresh missed the observation", async () => {
  const durableObservation = structuredClone(createStore().routeObservations[0]);
  const targetStore = createMemoryStore();
  targetStore.authSessions.set("cross-instance-routing-session", {
    user: { provider: "github", id: "cross-instance-routing-owner" },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  const persistence = createSharedDurableWriter();
  let refreshCalls = 0;
  const server = createServer({
    store: targetStore,
    serviceEventPersistence: {
      refreshConfigs: async () => [],
      refresh: async (store) => {
        refreshCalls += 1;
        if (refreshCalls >= 2 && !store.routeObservations.some((item) => item.observation_id === observationId)) {
          store.routeObservations.push(structuredClone(durableObservation));
        }
        return { ok: true, status: "fresh", loaded: refreshCalls >= 2 ? 1 : 0 };
      },
      writeEvent: persistence.write
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/agent-router/routing-feedback`, {
      method: "POST",
      headers: {
        cookie: "ar_session=cross-instance-routing-session",
        "content-type": "application/json"
      },
      body: JSON.stringify(label("exa"))
    });
    assert.equal(response.status, 201);
    assert.equal(refreshCalls, 2, "the handler must retry durable refresh when the first snapshot missed the observation");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
