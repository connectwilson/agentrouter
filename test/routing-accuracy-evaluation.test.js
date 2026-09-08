import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmark = JSON.parse(fs.readFileSync(
  path.join(here, "fixtures", "routing-benchmark-v1.json"),
  "utf8"
));

const REQUIRED_SLICES = [
  "paraphrase",
  "contrast",
  "cjk_english",
  "ambiguity",
  "auth",
  "budget",
  "no_match",
  "implementation_status",
  "partner_api",
  "browser_only",
  "structured_request",
  "registered_service",
  "legacy_intent"
];

function approximate(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function decisionFor(entry, overrides = {}) {
  const expected = entry.expected;
  return {
    case_id: entry.id,
    entrypoint: "ask",
    action: expected.action,
    route_family: expected.route_family,
    capability: expected.capability,
    selected_source: expected.acceptable_sources[0] || null,
    candidate_sources: [...expected.acceptable_sources],
    authorization_kind: expected.authorization_kind,
    price_usdc: expected.max_price_usdc === "0" ? 0 : 0,
    confidence: 1,
    ...overrides
  };
}

async function loadEvaluator() {
  return import("./support/routing-evaluation.js");
}

test("offline routing evaluation stays outside the production source tree", () => {
  assert.equal(fs.existsSync(path.join(here, "..", "src", "routing-evaluation.js")), false);
  assert.equal(fs.existsSync(path.join(here, "support", "routing-evaluation.js")), true);
});

test("routing benchmark is versioned, provider-tolerant, and covers the known risk slices", () => {
  assert.equal(benchmark.schema_version, "agentrouter_routing_benchmark_v1");
  assert.match(benchmark.benchmark_version, /^\d+\.\d+\.\d+$/);
  assert.ok(benchmark.cases.length >= 94);
  assert.equal(benchmark.cases.filter((entry) => entry.provenance === "original_30").length, 30);

  const ids = new Set();
  for (const entry of benchmark.cases) {
    assert.ok(!ids.has(entry.id), `duplicate benchmark id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.prompt.trim().length > 0);
    assert.ok(entry.locale);
    assert.ok(Array.isArray(entry.slices) && entry.slices.length > 0);
    if (entry.request) {
      assert.equal(typeof entry.request.capability, "string", entry.id);
      assert.equal(typeof entry.request.params, "object", entry.id);
    }
    assert.ok(["route", "clarify", "no_match"].includes(entry.expected.action), entry.id);
    assert.ok([
      "external_api",
      "local_browser",
      "service_marketplace",
      "clarification",
      "no_match"
    ].includes(entry.expected.route_family), entry.id);
    assert.ok(Array.isArray(entry.expected.acceptable_sources), entry.id);
    assert.ok(Array.isArray(entry.expected.forbidden_sources), entry.id);
    for (const source of entry.expected.acceptable_sources) {
      assert.ok(!entry.expected.forbidden_sources.includes(source), `${entry.id}: source is both acceptable and forbidden`);
    }
    assert.ok([
      "none",
      "agentrouter_account",
      "api_credentials",
      "local_browser_session"
    ].includes(entry.expected.authorization_kind), entry.id);
    assert.equal(typeof entry.expected.paid_allowed, "boolean", entry.id);
    if (entry.expected.max_price_usdc !== null) {
      assert.ok(Number.isFinite(Number(entry.expected.max_price_usdc)), entry.id);
      assert.ok(Number(entry.expected.max_price_usdc) >= 0, entry.id);
    }
  }

  for (const slice of REQUIRED_SLICES) {
    assert.ok(benchmark.cases.some((entry) => entry.slices.includes(slice)), `missing slice: ${slice}`);
  }
  assert.ok(benchmark.cases.some((entry) => entry.expected.acceptable_sources.length > 1), "benchmark must allow equivalent providers");
  assert.ok(benchmark.cases.some((entry) => entry.expected.acceptable_sources.length === 0 && entry.expected.action === "route"), "dynamic marketplace routes must not require one hard-coded vendor");
});

test("a perfect run exposes every top-level accuracy, safety, calibration, and slice metric", async () => {
  const { evaluateRoutingDecision, aggregateRoutingAccuracy } = await loadEvaluator();
  const evaluated = benchmark.cases.map((entry) => evaluateRoutingDecision(entry, decisionFor(entry)));
  const metrics = aggregateRoutingAccuracy(evaluated, {
    eceBins: 10,
    highConfidenceThreshold: 0.8
  });

  assert.equal(metrics.sample_count, benchmark.cases.length);
  assert.equal(metrics.route_family_accuracy, 1);
  assert.equal(metrics.capability_accuracy, 1);
  assert.equal(metrics.source_top1_accuracy, 1);
  assert.equal(metrics.source_recall_at_3, 1);
  assert.equal(metrics.abstention_precision, 1);
  assert.equal(metrics.abstention_recall, 1);
  assert.equal(metrics.authorization_accuracy, 1);
  assert.equal(metrics.budget_violation_rate, 0);
  assert.equal(metrics.unsafe_paid_route_rate, 0);
  assert.equal(metrics.expected_calibration_error, 0);
  assert.equal(metrics.high_confidence_misroute_rate, 0);
  assert.ok(metrics.slice_breakdown.ambiguity.sample_count > 0);
  assert.equal(metrics.slice_breakdown.ambiguity.route_family_accuracy, 1);
  assert.ok(metrics.slice_breakdown.auth.sample_count > 0);
  assert.equal(metrics.slice_breakdown.auth.authorization_accuracy, 1);
});

test("evaluation distinguishes top-1 precision from recall@3 and measures abstention", async () => {
  const { evaluateRoutingDecision, aggregateRoutingAccuracy } = await loadEvaluator();
  const cases = [benchmark.cases[0], benchmark.cases[5], benchmark.cases[29], benchmark.cases[44]];
  const decisions = [
    decisionFor(cases[0], { confidence: 0.9 }),
    decisionFor(cases[1], {
      capability: "public_web_research",
      selected_source: "exa",
      candidate_sources: ["exa", "openalex"],
      confidence: 0.8
    }),
    decisionFor(cases[2], { confidence: 0.6 }),
    decisionFor(cases[3], {
      action: "route",
      route_family: "external_api",
      capability: "public_web_research",
      selected_source: "exa",
      candidate_sources: ["exa"],
      price_usdc: 0.01,
      confidence: 0.2
    })
  ];
  const evaluated = cases.map((entry, index) => evaluateRoutingDecision(entry, decisions[index]));
  const metrics = aggregateRoutingAccuracy(evaluated, {
    eceBins: 2,
    highConfidenceThreshold: 0.75
  });

  assert.equal(metrics.route_family_accuracy, 0.75);
  assert.equal(metrics.capability_accuracy, 0.5);
  assert.equal(metrics.source_top1_accuracy, 0.5);
  assert.equal(metrics.source_recall_at_3, 1);
  assert.equal(metrics.abstention_precision, 1);
  assert.equal(metrics.abstention_recall, 0.5);
  assert.equal(metrics.unsafe_paid_route_rate, 0.25);
  approximate(metrics.expected_calibration_error, 0.125);
  assert.equal(metrics.high_confidence_misroute_rate, 0.5);
});

test("entrypoint parity compares the normalized decision, not merely whether both calls returned", async () => {
  const { evaluateRoutingDecision, aggregateRoutingAccuracy } = await loadEvaluator();
  const first = benchmark.cases[0];
  const second = benchmark.cases[5];
  const evaluated = [
    evaluateRoutingDecision(first, decisionFor(first, { entrypoint: "ask" })),
    evaluateRoutingDecision(first, decisionFor(first, { entrypoint: "fetch" })),
    evaluateRoutingDecision(second, decisionFor(second, { entrypoint: "ask" })),
    evaluateRoutingDecision(second, decisionFor(second, {
      entrypoint: "fetch",
      capability: "public_web_research",
      selected_source: "exa",
      candidate_sources: ["exa", "openalex"]
    }))
  ];
  const metrics = aggregateRoutingAccuracy(evaluated);

  assert.equal(metrics.entrypoint_pair_count, 2);
  assert.equal(metrics.entrypoint_parity, 0.5);
});

test("budget and authorization errors are first-class routing failures", async () => {
  const { evaluateRoutingDecision, aggregateRoutingAccuracy } = await loadEvaluator();
  const budgetCases = [benchmark.cases[56], benchmark.cases[57], benchmark.cases[60]];
  const evaluated = [
    evaluateRoutingDecision(budgetCases[0], decisionFor(budgetCases[0], { price_usdc: 0.051 })),
    evaluateRoutingDecision(budgetCases[1], decisionFor(budgetCases[1], { price_usdc: 0.001 })),
    evaluateRoutingDecision(budgetCases[2], decisionFor(budgetCases[2], { price_usdc: 0.004 }))
  ];
  const metrics = aggregateRoutingAccuracy(evaluated);

  approximate(metrics.budget_violation_rate, 2 / 3);
  approximate(metrics.unsafe_paid_route_rate, 1 / 3);
  assert.equal(evaluated[0].checks.budget_safe, false);
  assert.equal(evaluated[1].checks.paid_route_safe, false);

  const authCase = benchmark.cases[50];
  const wrongAuth = evaluateRoutingDecision(authCase, decisionFor(authCase, {
    authorization_kind: "local_browser_session"
  }));
  assert.equal(wrongAuth.checks.authorization, false);
  assert.equal(aggregateRoutingAccuracy([wrongAuth]).authorization_accuracy, 0);
});

test("a forbidden-source hit is wrong even when its broad route family looks plausible", async () => {
  const { evaluateRoutingDecision } = await loadEvaluator();
  const entry = benchmark.cases[0];
  const result = evaluateRoutingDecision(entry, decisionFor(entry, {
    capability: "scholarly_literature",
    selected_source: "openalex",
    candidate_sources: ["openalex", "exa"],
    confidence: 0.99
  }));

  assert.equal(result.checks.route_family, true);
  assert.equal(result.checks.capability, false);
  assert.equal(result.checks.source_top1, false);
  assert.equal(result.checks.forbidden_source_safe, false);
  assert.equal(result.correct, false);
});

test("critical route parameters are part of correctness and entrypoint parity", async () => {
  const { evaluateRoutingDecision, aggregateRoutingAccuracy } = await loadEvaluator();
  const entry = {
    id: "onchain-holders-robinhood-pons",
    locale: "zh-CN",
    slices: ["onchain", "parameter_identity"],
    expected: {
      action: "route",
      route_family: "external_api",
      capability: "token_holders",
      acceptable_sources: ["nansen"],
      forbidden_sources: [],
      authorization_kind: "agentrouter_account",
      paid_allowed: true,
      max_price_usdc: "0.05",
      params: { chain: "robinhood", token: "PONS", limit: 10 }
    }
  };
  const correct = decisionFor(entry, {
    params: { chain: "robinhood", token: "PONS", limit: 10 }
  });
  const wrongChain = decisionFor(entry, {
    entrypoint: "fetch",
    params: { chain: "ethereum", token: "PONS", limit: 10 }
  });

  const expected = evaluateRoutingDecision(entry, correct);
  const incorrect = evaluateRoutingDecision(entry, wrongChain);

  assert.equal(expected.checks.params, true);
  assert.equal(incorrect.checks.params, false);
  assert.equal(incorrect.correct, false);
  assert.equal(aggregateRoutingAccuracy([expected, incorrect]).entrypoint_parity, 0);
});
