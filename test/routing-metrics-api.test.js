import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import {
  aggregateRoutingMetrics,
  createRouteObservationV2,
  recordRoutingFeedback
} from "../src/routing/metrics.js";

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
  routeFamily = "registered_service",
  capability = "general_web_research",
  sourceFamily = "web_search",
  action = "route",
  candidates = [],
  selectedServiceId = candidates[0]?.service_id || null,
  confidence = 0.8,
  fallback = { used: false, reason: null },
  authorization = { required: false, action: "none" },
  budget = { max_price_usdc: null, selected_price_usdc: null, compliant: true },
  diagnostics = null,
  actorKey = ACTOR_SENTINEL,
  prompt = RAW_PROMPT_SENTINEL
}) {
  return createRouteObservationV2({
    observation_id: id,
    request_id: requestId,
    created_at: new Date().toISOString(),
    entrypoint,
    task_family: taskFamily,
    route_family: routeFamily,
    capability,
    source_family: sourceFamily,
    action,
    candidates,
    selected_service_id: selectedServiceId,
    confidence,
    fallback,
    authorization,
    budget,
    diagnostics,
    actor_key: actorKey,
    prompt
  });
}

function feedback({
  observationId,
  requestId = `req_${observationId}`,
  verdict,
  expectedAction,
  expectedRouteFamily = null,
  expectedCapability = null,
  expectedBudgetOutcome = null,
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
    expected_route_family: expectedRouteFamily,
    expected_capability: expectedCapability,
    expected_budget_outcome: expectedBudgetOutcome,
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

test("memory store has durable routing-label containers", () => {
  const store = createMemoryStore();
  assert.deepEqual(store.routingFeedbackEvents, []);
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
    assert.equal(event.route_family, "registered_service");
    assert.equal(event.capability, "general_web_research");
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
  assert.deepEqual(metrics.counts, {
    observations: 5,
    eligible_for_feedback: 5,
    labeled: 4,
    total_observations: 5,
    legacy_observations: 0,
    by_observation_version: { agent_router_route_observation_v2: 5 }
  });
  assert.equal(metrics.labeled_coverage, 0.8);
  assert.equal(metrics.precision_at_1, 0.5);
  assert.equal(metrics.top_3_recall, 1);
  assert.equal(metrics.abstention_accuracy, 1);
  assert.equal(metrics.auth_action_accuracy, 1);
  assert.equal(metrics.budget_violation_rate, 0.5);
  assert.equal(metrics.high_confidence_misroute_rate, 0.333333);
  assert.equal(metrics.expected_calibration_error, 0.325);

  assert.deepEqual(metrics.by_entrypoint.ask, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_entrypoint.fetch, { observations: 1, labeled: 1, accuracy: 0 });
  assert.deepEqual(metrics.by_task_family.general_research, { observations: 2, labeled: 2, accuracy: 0.5 });
  assert.deepEqual(metrics.by_source_family.web_search, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_source_family.academic, { observations: 1, labeled: 1, accuracy: 0 });
});

test("budget violation rate only measures executed routes with known selected and maximum prices", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_budget_blocked_not_executed",
      action: "no_match",
      candidates: [candidate("paid_source", "web_search", 0.9, "0.06")],
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0.06", compliant: false },
      diagnostics: { abstain_reason: "budget_exceeded", policy_gate: "blocked" }
    }),
    observation({
      id: "route_obs_unknown_price_quote_required",
      action: "no_match",
      candidates: [candidate("metered_source", "web_search", 0.9, null)],
      budget: { max_price_usdc: "0.05", selected_price_usdc: null, compliant: false },
      diagnostics: { abstain_reason: "price_unknown", policy_gate: "quote_required" }
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_budget_blocked_not_executed",
      verdict: "incorrect",
      expectedAction: "route",
      expectedSourceFamily: "web_search"
    }),
    feedback({
      observationId: "route_obs_unknown_price_quote_required",
      verdict: "incorrect",
      expectedAction: "route",
      expectedSourceFamily: "web_search"
    })
  );

  assert.equal(aggregateRoutingMetrics(store).budget_violation_rate, null);
});

test("budget violation rate detects an unlabeled over-budget execution from known prices", () => {
  const store = createMemoryStore();
  store.routeObservations.push(observation({
    id: "route_obs_unlabeled_over_budget_execution",
    action: "route",
    candidates: [candidate("paid_source", "web_search", 0.9, "0.06")],
    budget: { max_price_usdc: "0.05", selected_price_usdc: "0.06", compliant: true }
  }));

  assert.equal(aggregateRoutingMetrics(store).budget_violation_rate, 1);
});

test("budget guard accuracy measures labeled route versus blocked outcomes", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_budget_route_correct",
      action: "route",
      candidates: [candidate("free_source", "web_search", 0.9, "0")],
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0", compliant: true }
    }),
    observation({
      id: "route_obs_budget_block_correct",
      action: "no_match",
      candidates: [candidate("paid_source", "web_search", 0.9, "0.06")],
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0.06", compliant: false },
      diagnostics: { abstain_reason: "budget_exceeded", policy_gate: "blocked" }
    }),
    observation({
      id: "route_obs_budget_block_missed",
      action: "route",
      candidates: [candidate("paid_source", "web_search", 0.9, "0.06")],
      budget: { max_price_usdc: "0.05", selected_price_usdc: "0.06", compliant: false }
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_budget_route_correct",
      verdict: "correct",
      expectedAction: "route",
      expectedBudgetOutcome: "route",
      expectedServiceId: "free_source"
    }),
    feedback({
      observationId: "route_obs_budget_block_correct",
      verdict: "correct",
      expectedAction: "no_match",
      expectedBudgetOutcome: "blocked"
    }),
    feedback({
      observationId: "route_obs_budget_block_missed",
      verdict: "incorrect",
      expectedAction: "no_match",
      expectedBudgetOutcome: "blocked"
    })
  );

  assert.equal(aggregateRoutingMetrics(store).budget_guard_accuracy, 0.666667);
});

test("unknown price guard rate measures quote-required labels separately", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_unknown_price_guarded",
      action: "no_match",
      budget: { max_price_usdc: "0.01", selected_price_usdc: null, compliant: null },
      diagnostics: { abstain_reason: "price_unknown", policy_gate: "quote_required" }
    }),
    observation({
      id: "route_obs_unknown_price_executed",
      action: "route",
      candidates: [candidate("metered_source", "web_search", 0.9, null)],
      budget: { max_price_usdc: "0.01", selected_price_usdc: null, compliant: null },
      diagnostics: { abstain_reason: "price_unknown", policy_gate: "quote_required" }
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_unknown_price_guarded",
      verdict: "correct",
      expectedAction: "no_match",
      expectedBudgetOutcome: "quote_required"
    }),
    feedback({
      observationId: "route_obs_unknown_price_executed",
      verdict: "incorrect",
      expectedAction: "no_match",
      expectedBudgetOutcome: "quote_required"
    })
  );

  assert.equal(aggregateRoutingMetrics(store).unknown_price_guard_rate, 0.5);
});

test("routing metrics use null for undefined rates instead of reporting false success", () => {
  const metrics = aggregateRoutingMetrics(createMemoryStore());
  assert.deepEqual(metrics.counts, {
    observations: 0,
    eligible_for_feedback: 0,
    labeled: 0,
    total_observations: 0,
    legacy_observations: 0,
    by_observation_version: {}
  });
  assert.equal(metrics.labeled_coverage, null);
  assert.equal(metrics.route_family_accuracy, null);
  assert.equal(metrics.capability_accuracy, null);
  assert.equal(metrics.precision_at_1, null);
  assert.equal(metrics.top_3_recall, null);
  assert.equal(metrics.abstention_accuracy, null);
  assert.equal(metrics.abstention_precision, null);
  assert.equal(metrics.abstention_recall, null);
  assert.equal(metrics.auth_action_accuracy, null);
  assert.equal(metrics.budget_violation_rate, null);
  assert.equal(metrics.budget_guard_accuracy, null);
  assert.equal(metrics.unknown_price_guard_rate, null);
  assert.equal(metrics.high_confidence_misroute_rate, null);
  assert.equal(metrics.expected_calibration_error, null);
});

test("routing metrics measure route-family and capability correctness independently", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_taxonomy_correct",
      routeFamily: "external_api",
      capability: "general_web_research",
      candidates: [candidate("exa", "web_search", 0.93)]
    }),
    observation({
      id: "route_obs_taxonomy_wrong",
      routeFamily: "registered_service",
      capability: "academic_search",
      sourceFamily: "academic",
      candidates: [candidate("openalex", "academic", 0.91)]
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_taxonomy_correct",
      verdict: "correct",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    }),
    feedback({
      observationId: "route_obs_taxonomy_wrong",
      verdict: "incorrect",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.route_family_accuracy, 0.5);
  assert.equal(metrics.capability_accuracy, 0.5);
  assert.deepEqual(metrics.by_route_family.external_api, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_route_family.registered_service, { observations: 1, labeled: 1, accuracy: 0 });
  assert.deepEqual(metrics.by_capability.general_web_research, { observations: 1, labeled: 1, accuracy: 1 });
  assert.deepEqual(metrics.by_capability.academic_search, { observations: 1, labeled: 1, accuracy: 0 });
});

test("taxonomy-only route labels stay outside ranking metrics but inform decision calibration", () => {
  const store = createMemoryStore();
  store.routeObservations.push(observation({
    id: "route_obs_taxonomy_only_correct",
    routeFamily: "external_api",
    capability: "general_web_research",
    candidates: [candidate("exa", "web_search", 0.99)],
    confidence: 0.99
  }));
  store.routingFeedbackEvents.push(feedback({
    observationId: "route_obs_taxonomy_only_correct",
    verdict: "correct",
    expectedAction: "route",
    expectedRouteFamily: "external_api",
    expectedCapability: "general_web_research"
  }));

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.precision_at_1, null);
  assert.equal(metrics.top_3_recall, null);
  assert.equal(metrics.high_confidence_misroute_rate, 0);
  assert.equal(metrics.expected_calibration_error, 0.01);
});

test("taxonomy-only successes do not dilute a comparable ranking failure", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_taxonomy_success_not_ranked",
      routeFamily: "external_api",
      capability: "general_web_research",
      candidates: [candidate("exa", "web_search", 0.99)],
      confidence: 0.99
    }),
    observation({
      id: "route_obs_comparable_ranking_failure",
      routeFamily: "external_api",
      capability: "general_web_research",
      sourceFamily: "academic",
      candidates: [candidate("openalex", "academic", 0.9)],
      confidence: 0.9
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_taxonomy_success_not_ranked",
      verdict: "correct",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research"
    }),
    feedback({
      observationId: "route_obs_comparable_ranking_failure",
      verdict: "incorrect",
      expectedAction: "route",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.precision_at_1, 0);
  assert.equal(metrics.top_3_recall, 0);
  assert.equal(metrics.high_confidence_misroute_rate, 0.5);
  assert.equal(metrics.expected_calibration_error, 0.445);
});

test("taxonomy-only failures inform decision calibration without contaminating ranking precision", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_taxonomy_failure_not_ranked",
      routeFamily: "registered_service",
      capability: "academic_search",
      candidates: [candidate("openalex", "academic", 0.99)],
      confidence: 0.99
    }),
    observation({
      id: "route_obs_comparable_ranking_success",
      routeFamily: "external_api",
      capability: "general_web_research",
      candidates: [candidate("exa", "web_search", 0.8)],
      confidence: 0.8
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_taxonomy_failure_not_ranked",
      verdict: "incorrect",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research"
    }),
    feedback({
      observationId: "route_obs_comparable_ranking_success",
      verdict: "correct",
      expectedAction: "route",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.precision_at_1, 1);
  assert.equal(metrics.top_3_recall, 1);
  assert.equal(metrics.high_confidence_misroute_rate, 0.5);
  assert.equal(metrics.expected_calibration_error, 0.595);
});

test("high-confidence misroutes and calibration cover terminal action and authorization labels", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_terminal_taxonomy_correct",
      routeFamily: "external_api",
      capability: "general_web_research",
      confidence: 0.9
    }),
    observation({
      id: "route_obs_terminal_auth_wrong",
      action: "connect_source",
      authorization: { required: true, action: "connect_source", source: "google_places" },
      confidence: 0.9
    }),
    observation({
      id: "route_obs_terminal_clarify_correct",
      action: "clarify",
      confidence: 0.6
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_terminal_taxonomy_correct",
      verdict: "correct",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research"
    }),
    feedback({
      observationId: "route_obs_terminal_auth_wrong",
      verdict: "incorrect",
      expectedAction: "browser_handoff"
    }),
    feedback({
      observationId: "route_obs_terminal_clarify_correct",
      verdict: "correct",
      expectedAction: "clarify"
    })
  );

  const metrics = aggregateRoutingMetrics(store, { highConfidenceThreshold: 0.8 });
  assert.equal(metrics.precision_at_1, null);
  assert.equal(metrics.top_3_recall, null);
  assert.equal(metrics.high_confidence_misroute_rate, 0.5);
  assert.equal(metrics.expected_calibration_error, 0.4);
});

test("labeled coverage excludes anonymous observations that cannot accept feedback", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({ id: "route_obs_eligible_labeled", actorKey: ACTOR_SENTINEL }),
    observation({ id: "route_obs_eligible_unlabeled", actorKey: ACTOR_SENTINEL }),
    observation({ id: "route_obs_anonymous_unlabelable", actorKey: "" })
  );
  store.routingFeedbackEvents.push(feedback({
    observationId: "route_obs_eligible_labeled",
    verdict: "correct",
    expectedAction: "route",
    expectedSourceFamily: "web_search"
  }));

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.counts.observations, 3);
  assert.equal(metrics.counts.eligible_for_feedback, 2);
  assert.equal(metrics.counts.labeled, 1);
  assert.equal(metrics.labeled_coverage, 0.5);
});

test("authorization accuracy counts both false-positive and false-negative auth actions", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({
      id: "route_obs_auth_false_positive",
      action: "connect_account",
      candidates: [candidate("exa", "web_search", 0.8)]
    }),
    observation({
      id: "route_obs_auth_false_negative",
      action: "route",
      candidates: [candidate("google_places", "places", 0.8)]
    }),
    observation({ id: "route_obs_auth_browser", action: "browser_handoff", candidates: [] }),
    observation({ id: "route_obs_auth_source", action: "connect_source", candidates: [] })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_auth_false_positive",
      verdict: "incorrect",
      expectedAction: "route",
      expectedServiceId: "exa"
    }),
    feedback({ observationId: "route_obs_auth_false_negative", verdict: "incorrect", expectedAction: "connect_account" }),
    feedback({ observationId: "route_obs_auth_browser", verdict: "correct", expectedAction: "browser_handoff" }),
    feedback({ observationId: "route_obs_auth_source", verdict: "correct", expectedAction: "connect_source" })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.auth_action_accuracy, 0.333333);
  assert.equal(metrics.authorization_prompt_rate, 0.5);
  assert.equal(metrics.browser_handoff_rate, 0.25);
});

test("empty routing metrics distinguish absent authorization prompts from absent browser work", () => {
  const metrics = aggregateRoutingMetrics(createMemoryStore());
  assert.equal(metrics.authorization_prompt_rate, null);
  assert.equal(metrics.browser_handoff_rate, null);
});

test("clarify and no_match are abstention outcomes in accuracy, precision, and recall", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    observation({ id: "route_obs_clarify", action: "clarify", candidates: [] }),
    observation({ id: "route_obs_no_match", action: "no_match", candidates: [] }),
    observation({ id: "route_obs_non_abstain", action: "route", candidates: [candidate("exa", "web_search", 0.8)] })
  );
  store.routingFeedbackEvents.push(
    feedback({ observationId: "route_obs_clarify", verdict: "correct", expectedAction: "clarify" }),
    feedback({ observationId: "route_obs_no_match", verdict: "correct", expectedAction: "no_match" }),
    feedback({ observationId: "route_obs_non_abstain", verdict: "correct", expectedAction: "route", expectedServiceId: "exa" })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.equal(metrics.abstention_accuracy, 1);
  assert.equal(metrics.abstention_precision, 1);
  assert.equal(metrics.abstention_recall, 1);
});

test("legacy observations are counted but excluded from v2 metric denominators and slices", () => {
  const store = createMemoryStore();
  store.routeObservations.push(
    {
      observation_version: "agent_router_route_observation_v1",
      observation_id: "route_obs_legacy_wrong",
      request_id: "req_route_obs_legacy_wrong",
      entrypoint: "legacy",
      action: "route",
      actor_key: ACTOR_SENTINEL
    },
    observation({
      id: "route_obs_v2_correct",
      routeFamily: "external_api",
      capability: "general_web_research",
      candidates: [candidate("exa", "web_search", 0.9)]
    })
  );
  store.routingFeedbackEvents.push(
    feedback({
      observationId: "route_obs_legacy_wrong",
      verdict: "incorrect",
      expectedAction: "route",
      expectedServiceId: "exa"
    }),
    feedback({
      observationId: "route_obs_v2_correct",
      verdict: "correct",
      expectedAction: "route",
      expectedRouteFamily: "external_api",
      expectedCapability: "general_web_research",
      expectedSourceFamily: "web_search",
      expectedServiceId: "exa"
    })
  );

  const metrics = aggregateRoutingMetrics(store);
  assert.deepEqual(metrics.counts, {
    observations: 1,
    eligible_for_feedback: 1,
    labeled: 1,
    total_observations: 2,
    legacy_observations: 1,
    by_observation_version: {
      agent_router_route_observation_v1: 1,
      agent_router_route_observation_v2: 1
    }
  });
  assert.equal(metrics.labeled_coverage, 1);
  assert.equal(metrics.precision_at_1, 1);
  assert.equal(metrics.by_entrypoint.legacy, undefined);
});

test("routing feedback rejects a correct verdict when route-family or capability labels disagree", async () => {
  const store = createMemoryStore();
  store.routeObservations.push(observation({
    id: "route_obs_inconsistent_taxonomy",
    requestId: "req_inconsistent_taxonomy",
    actorKey: "github:routing-owner",
    routeFamily: "external_api",
    capability: "general_web_research",
    candidates: [candidate("exa", "web_search", 0.9)]
  }));
  let writes = 0;

  const result = await recordRoutingFeedback(store, {
    observation_id: "route_obs_inconsistent_taxonomy",
    request_id: "req_inconsistent_taxonomy",
    verdict: "correct",
    expected_action: "route",
    expected_route_family: "external_api",
    expected_capability: "academic_search",
    expected_source_family: "web_search",
    expected_service_id: "exa"
  }, {
    actorKey: "github:routing-owner",
    writeEvent: async () => { writes += 1; }
  });

  assert.equal(result.statusCode, 422);
  assert.equal(result.error.code, "INCONSISTENT_ROUTING_FEEDBACK");
  assert.equal(writes, 0);
  assert.equal(store.routingFeedbackEvents.length, 0);
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
      expected_route_family: "external_api",
      expected_capability: "general_web_research",
      expected_budget_outcome: "route",
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
    assert.equal(acceptedPayload.event.expected_route_family, "external_api");
    assert.equal(acceptedPayload.event.expected_capability, "general_web_research");
    assert.equal(acceptedPayload.event.expected_budget_outcome, "route");
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
    const anonymous = await fetch(`${baseUrl}/agent-router/metrics/routing`);
    assert.equal(anonymous.status, 401);

    const previousAdminToken = process.env.ADN_ADMIN_API_TOKEN;
    process.env.ADN_ADMIN_API_TOKEN = "routing-metrics-admin-token";
    const response = await fetch(`${baseUrl}/agent-router/metrics/routing`, {
      headers: { authorization: "Bearer routing-metrics-admin-token" }
    });
    if (previousAdminToken == null) delete process.env.ADN_ADMIN_API_TOKEN;
    else process.env.ADN_ADMIN_API_TOKEN = previousAdminToken;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/i);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(RAW_PROMPT_SENTINEL));
    assert.doesNotMatch(text, new RegExp(ACTOR_SENTINEL));
    assert.doesNotMatch(text, /route_obs_private_context|req_route_obs_private_context/);

    const payload = JSON.parse(text);
    assert.equal(payload.metrics_version, "agent_router_routing_metrics_v1");
    assert.equal(payload.label_cohort, "self_reported_user_feedback");
    assert.equal(payload.suitable_for_public_accuracy_claims, false);
    assert.deepEqual(payload.counts, {
      observations: 1,
      eligible_for_feedback: 1,
      labeled: 1,
      total_observations: 1,
      legacy_observations: 0,
      by_observation_version: { agent_router_route_observation_v2: 1 }
    });
    assert.equal(payload.precision_at_1, 1);
    assert.equal(payload.observations, undefined);
    assert.equal(payload.feedback, undefined);
    assert.equal(payload.labels, undefined);
  }, { store });
});
