import assert from "node:assert/strict";
import test from "node:test";

import { createBnbHireSummary } from "../src/bnb-marketplace.js";

test("BNB hire summary exposes one honest judge-facing result contract", () => {
  const summary = createBnbHireSummary({
    agent: {
      chain_id: 56,
      agent_id: "4242",
      name: "Venus Guard",
      explorer_url: "https://8004scan.io/agents/56/4242",
      trust: { average_score: 91, total_feedbacks: 18, total_validations: 7 },
      metadata: { pricing: { amount: "0.01", currency: "USDC" } },
      verification_state: "verified_callable",
      verified_at: "2026-09-03T10:00:00.000Z"
    },
    capability: "health_factor_monitoring",
    dispatch: { adapter: "http", payment: "none_declared", execution: "direct_http" },
    result: { health_factor: 1.42, data_sources: ["Venus"] },
    evidence: { trace_hash: "0xabc", execution_started_at: "2026-09-03T10:00:01.000Z", execution_completed_at: "2026-09-03T10:00:02.250Z" },
    feedbackRequest: { endpoint: "/agent-router/feedback", must_submit: true }
  });

  assert.equal(summary.summary_version, "agent_router_bnb_hire_summary_v1");
  assert.deepEqual(summary.selected_agent, {
    name: "Venus Guard",
    chain_id: 56,
    agent_id: "4242",
    explorer_url: "https://8004scan.io/agents/56/4242"
  });
  assert.equal(summary.selection_reason, "Verified BSC identity, verified endpoint, and read-only capability match.");
  assert.deepEqual(summary.price, { amount: "0.01", currency: "USDC", status: "declared" });
  assert.equal(summary.trust_score.score, 91);
  assert.equal(summary.latency_ms, 1250);
  assert.deepEqual(summary.actual_cost, { amount: "0", currency: "USDC", status: "no_payment_declared" });
  assert.deepEqual(summary.structured_result, { health_factor: 1.42, data_sources: ["Venus"] });
  assert.deepEqual(summary.data_sources, ["Venus"]);
  assert.equal(summary.feedback.status, "consumer_feedback_requested");
  assert.equal(summary.evidence.trace_hash, "0xabc");
});

test("BNB hire summary never invents price, trust, sources, or feedback", () => {
  const summary = createBnbHireSummary({
    agent: { chain_id: 56, agent_id: "9", name: "Unrated Agent" },
    capability: "yield_optimization",
    dispatch: { payment: "unknown" },
    result: { recommendation: "No eligible route" },
    evidence: {}
  });

  assert.deepEqual(summary.price, { amount: null, currency: "USDC", status: "not_declared" });
  assert.equal(summary.trust_score.score, null);
  assert.equal(summary.latency_ms, null);
  assert.equal(summary.actual_cost.amount, null);
  assert.equal(summary.actual_cost.status, "not_reported");
  assert.deepEqual(summary.data_sources, []);
  assert.equal(summary.feedback.status, "not_requested");
});
