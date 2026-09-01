import test from "node:test";
import assert from "node:assert/strict";

import { serviceEventIdempotencyKey } from "../src/persistence.js";
import { hydrateServiceEventRows } from "../src/registry.js";
import { createMemoryStore } from "../src/store.js";

const requestId = "req_shared_routing_attempt";
const actorKey = "github:routing-owner";

function routingFeedback({ observationId, feedbackId, createdAt = "2026-08-31T00:00:00.000Z" }) {
  return {
    event_version: "agent_router_routing_feedback_v1",
    observation_id: observationId,
    feedback_id: feedbackId,
    request_id: requestId,
    actor_key: actorKey,
    verdict: "incorrect",
    expected_action: "route",
    expected_route_family: "external_api",
    expected_capability: "general_web_research",
    created_at: createdAt
  };
}

function routingFeedbackKey(event, serviceId = "exa") {
  return serviceEventIdempotencyKey({
    eventType: "routing_feedback",
    serviceId,
    requestId,
    event
  });
}

test("routing feedback idempotency is scoped only to observation and actor, not service or label payload", () => {
  const first = routingFeedback({ observationId: "route_obs_one", feedbackId: "routing_feedback_one" });
  const differentObservation = routingFeedback({
    observationId: "route_obs_two",
    feedbackId: "routing_feedback_one"
  });
  const differentFeedback = routingFeedback({
    observationId: "route_obs_one",
    feedbackId: "routing_feedback_two"
  });

  assert.notEqual(routingFeedbackKey(first), routingFeedbackKey(differentObservation));
  assert.equal(routingFeedbackKey(first), routingFeedbackKey(differentFeedback));
  assert.equal(routingFeedbackKey(first, "exa"), routingFeedbackKey(first, "reddit"));
  assert.equal(
    routingFeedbackKey(first),
    routingFeedbackKey({ ...first, created_at: "2026-08-31T00:01:00.000Z" })
  );
});

test("distinct labels sharing request and actor survive persistence replay and restart hydration", async () => {
  const first = routingFeedback({ observationId: "route_obs_one", feedbackId: "routing_feedback_one" });
  const second = routingFeedback({ observationId: "route_obs_two", feedbackId: "routing_feedback_two" });
  const retry = { ...first, created_at: "2026-08-31T00:01:00.000Z" };
  const durableRows = new Map();

  for (const event of [first, second, retry]) {
    const idempotencyKey = routingFeedbackKey(event);
    if (!durableRows.has(idempotencyKey)) {
      durableRows.set(idempotencyKey, {
        event_type: "routing_feedback",
        service_id: "exa",
        request_id: requestId,
        event
      });
    }
  }

  assert.equal(durableRows.size, 2);
  const restarted = createMemoryStore();
  await hydrateServiceEventRows(restarted, [...durableRows.values()]);
  assert.deepEqual(
    restarted.routingFeedbackEvents.map((event) => event.feedback_id).sort(),
    ["routing_feedback_one", "routing_feedback_two"]
  );
});

test("hydration replaces a divergent local routing label with the durable canonical label", async () => {
  const local = {
    ...routingFeedback({ observationId: "route_obs_reconcile", feedbackId: "routing_feedback_reconcile" }),
    expected_service_id: "exa"
  };
  const canonical = {
    ...local,
    expected_service_id: "reddit",
    created_at: "2026-08-31T00:01:00.000Z"
  };
  const store = createMemoryStore();
  store.routingFeedbackEvents.push(local);

  await hydrateServiceEventRows(store, [{
    event_type: "routing_feedback",
    service_id: "openalex",
    request_id: requestId,
    event: canonical
  }]);

  assert.equal(store.routingFeedbackEvents.length, 1);
  assert.deepEqual(store.routingFeedbackEvents[0], canonical);
});
