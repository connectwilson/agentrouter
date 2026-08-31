import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import {
  aggregateRoutingMetrics,
  createRouteObservationV2
} from "../src/routing-metrics.js";

const owner = {
  provider: "github",
  id: "routing-owner",
  name: "Routing Owner",
  handle: "routing-owner"
};

const stranger = {
  provider: "github",
  id: "routing-stranger",
  name: "Routing Stranger",
  handle: "routing-stranger"
};

const RAW_PROMPT_SENTINEL = "PRIVATE ROUTING PROMPT: launch plan for codename ORCHID";
const ACTOR_SENTINEL = "github:private-routing-actor";

function candidate(serviceId, sourceFamily, score, price = "0") {
  return {
    service_id: serviceId,
    source_family: sourceFamily,
    routing_score: score,
    price_usdc: price
  };
}

function observation({
  id,
  requestId = `req_${id}`,
  entrypoint = "ask",
  taskFamily = "general_research",
  sourceFamily = "web_search",
  action = "route",
  candidates = [],
  selectedServiceId = candidates[0]?.service_id || null,
  confidence = 0.8,
  fallback = { used: false, reason: null },
  authorization = { required: false, action: "none" },
  budget = { max_price_usdc: null, selected_price_usdc: null, compliant: true },
  actorKey = ACTOR_SENTINEL,
  prompt = RAW_PROMPT_SENTINEL
}) {
  return createRouteObservationV2({
    observation_id: id,
    request_id: requestId,
    created_at: new Date().toISOString(),
    entrypoint,
    task_family: taskFamily,
    source_family: sourceFamily,
    action,
    candidates,
    selected_service_id: selectedServiceId,
    confidence,
    fallback,
    authorization,
    budget,
    actor_key: actorKey,
    prompt
  });
}

function feedback({
  observationId,
  requestId = `req_${observationId}`,
  verdict,
  expectedAction,
  expectedSourceFamily = null,
  expectedServiceId = null
}) {
  return {
    event_version: "agent_router_routing_feedback_v1",
    feedback_id: `routing_feedback_${observationId}`,
    observation_id: observationId,
    request_id: requestId,
    verdict,
    expected_action: expectedAction,
    expected_source_family: expectedSourceFamily,
    expected_service_id: expectedServiceId,
    reason_code: verdict === "correct" ? "route_confirmed" : "wrong_source",
    actor_key: ACTOR_SENTINEL,
    created_at: new Date().toISOString()
  };
}

async function withRoutingServer(run, { store = createMemoryStore(), writeEvent } = {}) {
  const persisted = [];
  const server = createServer({
    store,
    serviceEventPersistence: {
      enabled: () => false,
      refreshConfigs: async () => [],
      refresh: async () => ({ ok: true, status: "fresh", loaded: 0 }),
      writeEvent: writeEvent || (async (entry) => {
        persisted.push(entry);
        return true;
      })
    }
  });
  server.store.authSessions.set("routing-owner-session", {
    user: owner,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  server.store.authSessions.set("routing-stranger-session", {
    user: stranger,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      persisted
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(url, body, cookie = "") {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

test("memory store has durable routing-label and evaluation containers", () => {
  const store = createMemoryStore();
  assert.deepEqual(store.routingFeedbackEvents, []);
  assert.deepEqual(store.routingEvalRuns, []);
});

test("route observation v2 captures comparable diagnostics for every routing entrypoint", () => {
  const entrypoints = ["ask", "fetch", "request", "external_api", "local"];
  for (const [index, entrypoint] of entrypoints.entries()) {
    const event = observation({
      id: `route_obs_entry_${entrypoint}`,
      entrypoint,
      taskFamily: index === 1 ? "academic_research" : "general_research",
      sourceFamily: index === 1 ? "academic" : "web_search",
      candidates: [
        candidate(`selected_${entrypoint}`, "web_search", 0.91, "0.02"),
        candidate(`runner_up_${entrypoint}`, "academic", 0.73, "0.01")
      ],
      confidence: 0.86,
      fallback: {
        used: entrypoint === "local",
        from: entrypoint === "local" ? "remote_api" : null,
        to: entrypoint === "local" ? "local_browser" : null,
        reason: entrypoint === "local" ? "remote_unavailable" : null
      },
      authorization: {
        required: entrypoint === "external_api",
        action: entrypoint === "external_api" ? "connect_source" : "none",
        source: entrypoint === "external_api" ? "google_places" : null
      },
      budget: {
        max_price_usdc: "0.05",
        selected_price_usdc: "0.02",
        compliant: true
      }
    });

    assert.equal(event.observation_version, "agent_router_route_observation_v2");
    assert.equal(event.request_id, `req_route_obs_entry_${entrypoint}`);
    assert.equal(event.entrypoint, entrypoint);
    assert.ok(event.task_family);
    assert.ok(event.source_family);
    assert.equal(event.top_score, 0.91);
    assert.equal(event.runner_up_score, 0.73);
    assert.equal(event.score_margin, 0.18);
    assert.equal(event.confidence, 0.86);
    assert.equal(typeof event.fallback.used, "boolean");
    assert.equal(typeof event.authorization.required, "boolean");
    assert.equal(event.budget.compliant, true);
    assert.equal(event.selected_service_id, `selected_${entrypoint}`);
    assert.equal(event.candidates.length, 2);
  }
});

test("aggregate metrics separate ranking, guardrail, calibration, and slice accuracy", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_correct_web",
      entrypoint: "ask",
      taskFamily: "general_research",
      sourceFamily: "web_search",
      candidates: [
        candidate("exa", "web_search", 0.92, "0.02"),
        candidate("openalex", "academic", 0.6, "0.01")
      ],
      confidence: 0.9,
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0.02", compliant: true }
    }),
    observation({
      id: "route_obs_wrong_academic",
      entrypoint: "fetch",
      taskFamily: "general_research",
      sourceFamily: "academic",
      candidates: [
        candidate("openalex", "academic", 0.91, "0.06"),
        candidate("exa", "web_search", 0.82, "0.02"),
        candidate("generic_web", "web_search", 0.2, "0")
      ],
      confidence: 0.9,
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0.06", compliant: false }
    }),
    observation({
      id: "route_obs_correct_abstain",
      entrypoint: "request",
      taskFamily: "ambiguous",
      sourceFamily: "none",
      action: "abstain",
      candidates: [],
      selectedServiceId: null,
      confidence: 0.7
    }),
    observation({
      id: "route_obs_correct_auth",
      entrypoint: "external_api",
      taskFamily: "places",
      sourceFamily: "places",
      action: "connect_source",
      candidates: [candidate("google_places", "places", 0.88, "0")],
      selectedServiceId: "google_places",
      confidence: 0.8,
      authorization: { required: true, action: "connect_source", source: "google_places" }
    }),
    observation({
      id: "route_obs_unlabeled_local",
      entrypoint: "local",
      taskFamily: "social_post_read",
      sourceFamily: "local_browser",
      candidates: [candidate("x_local", "local_browser", 0.86, "0")],
      confidence: 0.8,
      fallback: { used: true, from: "x_api", to: "local_browser", reason: "auth_unavailable" }
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_correct_web",
      verdict: "correct",
      expectedAction: "route",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    }),
    feedback({
      observationId: "route_obs_wrong_academic",
      verdict: "incorrect",
      expectedAction: "route",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    }),
    feedback({
      observationId: "route_obs_correct_abstain",
      verdict: "correct",
      expectedAction: "abstain"
    }),
    feedback({
      observationId: "route_obs_correct_auth",
      verdict: "correct",
      expectedAction: "connect_source",
      expectedSourceFamily: "places",
      expectedServiceId: "google_places"
    })
  );

  const metrics = aggregateRoutingMetrics(store, { highConfidenceThreshold: 0.8 });

  assert.equal(metrics.metrics_version, "agent_router_routing_metrics_v1");
  assert.deepEqual(metrics.counts, { observations: 5, labeled: 4 });
  assert.equal(metrics.labeled_coverage, 0.8);
  assert.equal(metrics.precision_at_1, 0.5);
  assert.equal(metrics.top_3_recall, 1);
  assert.equal(metrics.abstention_accuracy, 1);
  assert.equal(metrics.auth_action_accuracy, 1);
  assert.equal(metrics.budget_violation_rate, 0.5);
  assert.equal(metrics.high_confidence_misroute_rate, 0.5);
  assert.equal(metrics.expected_calibration_error, 0.4);

  assert.deepEqual(metrics.by_entrypoint.ask, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_entrypoint.fetch, { observations: 1, labeled: 1, accuracy: 0 });
  assert.deepEqual(metrics.by_task_family.general_research, { observations: 2, labeled: 2, accuracy: 0.5 });
  assert.deepEqual(metrics.by_source_family.web_search, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_source_family.academic, { observations: 1, labeled: 1, accuracy: 0 });
});

test("routing metrics use null for undefined rates instead of reporting false success", () => {
  const metrics = aggregateRoutingMetrics(createMemoryStore());
  assert.deepEqual(metrics.counts, { observations: 0, labeled: 0 });
  assert.equal(metrics.labeled_coverage, null);
  assert.equal(metrics.precision_at_1, null);
  assert.equal(metrics.top_3_recall, null);
  assert.equal(metrics.abstention_accuracy, null);
  assert.equal(metrics.auth_action_accuracy, null);
  assert.equal(metrics.budget_violation_rate, null);
  assert.equal(metrics.high_confidence_misroute_rate, null);
  assert.equal(metrics.expected_calibration_error, null);
});

test("routing feedback can only label a real observation owned by the authenticated caller and persists once", async () => {
  const store = createMemoryStore();
  store.routeObservations.push(observation({
    id: "route_obs_owned",
    requestId: "req_owned",
    actorKey: "github:routing-owner",
    candidates: [candidate("openalex", "academic", 0.9, "0.01")]
  }));

  await withRoutingServer(async ({ baseUrl, persisted }) => {
    const body = {
      observation_id: "route_obs_owned",
      request_id: "req_owned",
      verdict: "incorrect",
      expected_action: "route",
      expected_source_family: "web_search",
      expected_service_id: "exa",
      reason_code: "wrong_source",
      actor_key: "github:spoofed-actor"
    };

    const anonymous = await postJson(`${baseUrl}/agent-router/routing-feedback`, body);
    assert.equal(anonymous.status, 401);

    const strangerResponse = await postJson(
      `${baseUrl}/agent-router/routing-feedback`,
      body,
      "ar_session=routing-stranger-session"
    );
    assert.equal(strangerResponse.status, 403);

    const missingResponse = await postJson(
      `${baseUrl}/agent-router/routing-feedback`,
      { ...body, observation_id: "route_obs_missing", request_id: "req_missing" },
      "ar_session=routing-owner-session"
    );
    assert.equal(missingResponse.status, 404);

    const accepted = await postJson(
      `${baseUrl}/agent-router/routing-feedback`,
      body,
      "ar_session=routing-owner-session"
    );
    assert.equal(accepted.status, 201);
    const acceptedPayload = await accepted.json();
    assert.equal(acceptedPayload.status, "routing_feedback_recorded");
    assert.equal(acceptedPayload.event.actor_key, "github:routing-owner");
    assert.equal(store.routingFeedbackEvents.length, 1);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].eventType, "routing_feedback");
    assert.equal(persisted[0].requestId, "req_owned");

    const replay = await postJson(
      `${baseUrl}/agent-router/routing-feedback`,
      body,
      "ar_session=routing-owner-session"
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).status, "routing_feedback_already_recorded");
    assert.equal(store.routingFeedbackEvents.length, 1);
    assert.equal(persisted.length, 1);
  }, { store });
});

test("routing metrics endpoint exposes aggregates only and never raw prompts, actors, observations, or labels", async () => {
  const store = createMemoryStore();
  store.routeObservations.push(observation({
    id: "route_obs_private_context",
    actorKey: ACTOR_SENTINEL,
    prompt: RAW_PROMPT_SENTINEL,
    candidates: [candidate("exa", "web_search", 0.92, "0.02")],
    confidence: 0.9
  }));
  store.routingFeedbackEvents.push(feedback({
    observationId: "route_obs_private_context",
    verdict: "correct",
    expectedAction: "route",
    expectedSourceFamily: "web_search",
    expectedServiceId: "exa"
  }));

  await withRoutingServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/metrics/routing`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/i);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(RAW_PROMPT_SENTINEL));
    assert.doesNotMatch(text, new RegExp(ACTOR_SENTINEL));
    assert.doesNotMatch(text, /route_obs_private_context|req_route_obs_private_context/);

    const payload = JSON.parse(text);
    assert.equal(payload.metrics_version, "agent_router_routing_metrics_v1");
    assert.deepEqual(payload.counts, { observations: 1, labeled: 1 });
    assert.equal(payload.precision_at_1, 1);
    assert.equal(payload.observations, undefined);
    assert.equal(payload.feedback, undefined);
    assert.equal(payload.labels, undefined);
  }, { store });
});
