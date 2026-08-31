import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inferRoutePlan } from "../src/canonical-route-plan.js";
import { aggregateRoutingAccuracy, evaluateRoutingDecision } from "../src/routing-evaluation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmark = JSON.parse(fs.readFileSync(
  path.join(here, "fixtures", "routing-benchmark-v1.json"),
  "utf8"
));

function contextFor(entry) {
  const expected = entry.expected;
  const connected = entry.context?.source_state === "connected"
    ? expected.acceptable_sources
    : [];
  const browserSessions = entry.context?.browser_session === "connected"
    ? expected.acceptable_sources
    : [];
  return {
    agentrouter_authenticated: entry.context?.account_state === "connected",
    connected_sources: connected,
    local_browser_sessions: browserSessions,
    constraints: {
      max_price_usdc: expected.max_price_usdc ?? "0.05"
    }
  };
}

function decisionFromPlan(entry, plan, entrypoint) {
  const blocked = plan.abstain_reason === "budget_exceeded";
  const action = blocked
    ? "no_match"
    : plan.abstain_reason === "insufficient_context"
      ? "clarify"
      : plan.route_family === "none"
        ? "no_match"
        : "route";
  const routeFamily = action === "clarify"
    ? "clarification"
    : action === "no_match"
      ? "no_match"
      : plan.route_family === "registered_service"
        ? "service_marketplace"
        : plan.route_family;
  const authKind = plan.auth_requirement.kind === "source_connection"
    ? "api_credentials"
    : plan.auth_requirement.kind;
  return {
    case_id: entry.id,
    entrypoint,
    action,
    route_family: routeFamily,
    capability: plan.capability,
    selected_source: blocked ? null : plan.candidate_sources[0] || null,
    candidate_sources: blocked ? [] : plan.candidate_sources,
    authorization_kind: blocked ? "none" : authKind,
    price_usdc: blocked ? 0 : Number(plan.estimated_price_usdc || 0),
    confidence: plan.confidence
  };
}

test("the versioned 80-case benchmark enforces routing accuracy and safety gates", () => {
  const evaluated = benchmark.cases.flatMap((entry) => {
    const plan = inferRoutePlan(entry.prompt, contextFor(entry));
    return ["ask", "fetch"].map((entrypoint) => evaluateRoutingDecision(
      entry,
      decisionFromPlan(entry, plan, entrypoint)
    ));
  });
  const metrics = aggregateRoutingAccuracy(evaluated, {
    eceBins: 10,
    highConfidenceThreshold: 0.8
  });

  assert.ok(metrics.route_family_accuracy >= 0.97, JSON.stringify(metrics));
  assert.ok(metrics.capability_accuracy >= 0.95, JSON.stringify(metrics));
  assert.ok(metrics.source_top1_accuracy >= 0.92, JSON.stringify(metrics));
  assert.ok(metrics.source_recall_at_3 >= 0.97, JSON.stringify(metrics));
  assert.ok(metrics.abstention_precision >= 0.95, JSON.stringify(metrics));
  assert.ok(metrics.abstention_recall >= 0.95, JSON.stringify(metrics));
  assert.equal(metrics.entrypoint_parity, 1);
  assert.ok(metrics.authorization_accuracy >= 0.98, JSON.stringify(metrics));
  assert.equal(metrics.budget_violation_rate, 0);
  assert.equal(metrics.unsafe_paid_route_rate, 0);
  assert.ok(metrics.high_confidence_misroute_rate <= 0.02, JSON.stringify(metrics));
  assert.ok(metrics.expected_calibration_error <= 0.15, JSON.stringify(metrics));
});
