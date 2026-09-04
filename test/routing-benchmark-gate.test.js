import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inferRoutePlan, inferStructuredRoutePlan } from "../src/routing/planner.js";
import { aggregateRoutingAccuracy, evaluateRoutingDecision } from "./support/routing-evaluation.js";

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
    registered_capabilities: entry.context?.registered_capabilities,
    require_price_upper_bound: expected.max_price_usdc !== null,
    constraints: {
      max_price_usdc: expected.max_price_usdc ?? "0.05"
    }
  };
}

function decisionFromPlan(entry, plan, entrypoint) {
  const blocked = [
    "budget_exceeded",
    "price_unknown",
    "invalid_budget",
    "unsupported_source",
    "source_not_callable",
    "capability_not_available"
  ].includes(plan.abstain_reason);
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
    price_usdc: blocked || plan.estimated_price_usdc == null
      ? null
      : Number(plan.estimated_price_usdc),
    confidence: plan.confidence
  };
}

test("the versioned benchmark enforces canonical planner accuracy and safety gates", () => {
  const evaluated = benchmark.cases.map((entry) => {
    const context = contextFor(entry);
    const plan = entry.request
      ? inferStructuredRoutePlan(entry.request, context)
      : inferRoutePlan(entry.prompt, context);
    return evaluateRoutingDecision(entry, decisionFromPlan(entry, plan, "canonical_planner"));
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
  // Runtime entrypoint parity is exercised against real HTTP/MCP/CLI paths in
  // routing-entrypoint-parity and routing-runtime-integration. It must not be
  // manufactured here by cloning one planner output under two labels.
  assert.equal(metrics.entrypoint_parity, null);
  assert.ok(metrics.authorization_accuracy >= 0.98, JSON.stringify(metrics));
  assert.equal(metrics.budget_violation_rate, 0);
  assert.equal(metrics.unsafe_paid_route_rate, 0);
  assert.ok(metrics.high_confidence_misroute_rate <= 0.02, JSON.stringify(metrics));
  assert.ok(metrics.expected_calibration_error <= 0.15, JSON.stringify(metrics));
});
