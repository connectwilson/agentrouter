// Offline benchmark evaluator. This belongs to the test harness and is not
// loaded by the AgentRouter production runtime.
const DEFAULT_ECE_BINS = 10;
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.8;

function normalizedText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text || null;
}

function normalizedSource(value) {
  if (value && typeof value === "object") {
    return normalizedText(
      value.source_id ??
      value.source ??
      value.provider_id ??
      value.provider ??
      value.id ??
      null
    );
  }
  return normalizedText(value);
}

function normalizedSources(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const sources = [];
  for (const value of values) {
    const source = normalizedSource(value);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedConfidence(value) {
  const confidence = optionalNumber(value);
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  return confidence;
}

function isAbstentionAction(action) {
  const normalized = normalizedText(action);
  return normalized === "clarify" || normalized === "no_match";
}

function equalityCheck(expected, actual) {
  return normalizedText(expected) === normalizedText(actual);
}

function ratio(values) {
  const applicable = values.filter((value) => typeof value === "boolean");
  if (applicable.length === 0) return null;
  return applicable.filter(Boolean).length / applicable.length;
}

function violationRate(values) {
  const applicable = values.filter((value) => typeof value === "boolean");
  if (applicable.length === 0) return null;
  return applicable.filter((value) => !value).length / applicable.length;
}

function normalizeDecision(decision = {}) {
  const selectedSource = normalizedSource(decision.selected_source);
  const candidateSources = normalizedSources(decision.candidate_sources);
  if (candidateSources.length === 0 && selectedSource) candidateSources.push(selectedSource);

  return {
    case_id: decision.case_id === null || decision.case_id === undefined
      ? null
      : String(decision.case_id),
    entrypoint: normalizedText(decision.entrypoint),
    action: normalizedText(decision.action),
    route_family: normalizedText(decision.route_family),
    capability: normalizedText(decision.capability),
    selected_source: selectedSource,
    candidate_sources: candidateSources,
    authorization_kind: normalizedText(decision.authorization_kind),
    price_usdc: optionalNumber(decision.price_usdc),
    confidence: normalizedConfidence(decision.confidence)
  };
}

function parityDecision(decision) {
  return {
    action: decision.action,
    route_family: decision.route_family,
    capability: decision.capability,
    selected_source: decision.selected_source,
    authorization_kind: decision.authorization_kind
  };
}

function sameParityDecision(left, right) {
  return JSON.stringify(parityDecision(left)) === JSON.stringify(parityDecision(right));
}

function calibration(evaluated, binCount) {
  const samples = evaluated.filter((entry) => entry.confidence !== null);
  if (samples.length === 0) {
    return {
      expected_calibration_error: null,
      calibration_sample_count: 0,
      calibration_bins: []
    };
  }

  const bins = Array.from({ length: binCount }, (_, index) => ({
    index,
    lower_bound: index / binCount,
    upper_bound: (index + 1) / binCount,
    sample_count: 0,
    confidence_total: 0,
    correct_count: 0
  }));

  for (const entry of samples) {
    const index = Math.min(binCount - 1, Math.floor(entry.confidence * binCount));
    const bin = bins[index];
    bin.sample_count += 1;
    bin.confidence_total += entry.confidence;
    if (entry.correct) bin.correct_count += 1;
  }

  let error = 0;
  const populatedBins = [];
  for (const bin of bins) {
    if (bin.sample_count === 0) continue;
    const averageConfidence = bin.confidence_total / bin.sample_count;
    const accuracy = bin.correct_count / bin.sample_count;
    error += (bin.sample_count / samples.length) * Math.abs(accuracy - averageConfidence);
    populatedBins.push({
      index: bin.index,
      lower_bound: bin.lower_bound,
      upper_bound: bin.upper_bound,
      sample_count: bin.sample_count,
      average_confidence: averageConfidence,
      accuracy
    });
  }

  return {
    expected_calibration_error: error,
    calibration_sample_count: samples.length,
    calibration_bins: populatedBins
  };
}

function entrypointParity(evaluated) {
  const byCase = new Map();
  for (const entry of evaluated) {
    if (!entry.case_id || !entry.decision.entrypoint) continue;
    if (!byCase.has(entry.case_id)) byCase.set(entry.case_id, new Map());
    const byEntrypoint = byCase.get(entry.case_id);
    if (!byEntrypoint.has(entry.decision.entrypoint)) {
      byEntrypoint.set(entry.decision.entrypoint, entry.decision);
    }
  }

  let pairCount = 0;
  let matchingPairs = 0;
  for (const byEntrypoint of byCase.values()) {
    const decisions = [...byEntrypoint.values()];
    for (let left = 0; left < decisions.length; left += 1) {
      for (let right = left + 1; right < decisions.length; right += 1) {
        pairCount += 1;
        if (sameParityDecision(decisions[left], decisions[right])) matchingPairs += 1;
      }
    }
  }

  return {
    entrypoint_pair_count: pairCount,
    entrypoint_parity: pairCount === 0 ? null : matchingPairs / pairCount
  };
}

/**
 * Evaluates one normalized router decision against one benchmark case.
 * Nullable checks are intentional: they mean the metric is not applicable to
 * that case and must not be included in that metric's denominator.
 */
export function evaluateRoutingDecision(benchmarkCase, rawDecision = {}) {
  if (!benchmarkCase || typeof benchmarkCase !== "object") {
    throw new TypeError("benchmarkCase must be an object");
  }
  const expected = benchmarkCase.expected || {};
  const decision = normalizeDecision(rawDecision);
  const acceptableSources = new Set(normalizedSources(expected.acceptable_sources));
  const forbiddenSources = new Set(normalizedSources(expected.forbidden_sources));
  const sourceApplicable = acceptableSources.size > 0;

  const sourceTop1 = sourceApplicable
    ? Boolean(decision.selected_source && acceptableSources.has(decision.selected_source))
    : null;
  const sourceRecallAt3 = sourceApplicable
    ? decision.candidate_sources.slice(0, 3).some((source) => acceptableSources.has(source))
    : null;
  const forbiddenSourceSafe = !decision.selected_source || !forbiddenSources.has(decision.selected_source);

  const maxPrice = optionalNumber(expected.max_price_usdc);
  let budgetSafe = null;
  if (maxPrice !== null) {
    if (decision.action !== "route") {
      budgetSafe = true;
    } else {
      budgetSafe = decision.price_usdc !== null &&
        decision.price_usdc >= 0 &&
        decision.price_usdc <= maxPrice;
    }
  }

  const paidAllowed = expected.paid_allowed === true;
  const paidRouteSafe = paidAllowed ||
    decision.action !== "route" ||
    (decision.price_usdc !== null && decision.price_usdc <= 0);

  const checks = {
    action: equalityCheck(expected.action, decision.action),
    route_family: equalityCheck(expected.route_family, decision.route_family),
    capability: equalityCheck(expected.capability, decision.capability),
    source_top1: sourceTop1,
    source_recall_at_3: sourceRecallAt3,
    authorization: equalityCheck(expected.authorization_kind, decision.authorization_kind),
    budget_safe: budgetSafe,
    paid_route_safe: paidRouteSafe,
    forbidden_source_safe: forbiddenSourceSafe
  };

  const requiredChecks = [
    checks.action,
    checks.route_family,
    checks.capability,
    checks.authorization,
    checks.paid_route_safe,
    checks.forbidden_source_safe
  ];
  if (checks.source_top1 !== null) requiredChecks.push(checks.source_top1);
  if (checks.budget_safe !== null) requiredChecks.push(checks.budget_safe);

  return {
    case_id: benchmarkCase.id || decision.case_id,
    locale: benchmarkCase.locale || null,
    slices: Array.isArray(benchmarkCase.slices) ? [...benchmarkCase.slices] : [],
    expected,
    decision,
    confidence: decision.confidence,
    expected_abstention: isAbstentionAction(expected.action),
    predicted_abstention: isAbstentionAction(decision.action),
    checks,
    correct: requiredChecks.every(Boolean)
  };
}

function aggregateCore(evaluated, options) {
  const eceBins = Number.isInteger(options.eceBins) && options.eceBins > 0
    ? options.eceBins
    : DEFAULT_ECE_BINS;
  const configuredThreshold = optionalNumber(options.highConfidenceThreshold);
  const highConfidenceThreshold = configuredThreshold !== null &&
    configuredThreshold >= 0 &&
    configuredThreshold <= 1
    ? configuredThreshold
    : DEFAULT_HIGH_CONFIDENCE_THRESHOLD;

  const abstentionTruePositives = evaluated.filter((entry) => (
    entry.expected_abstention && entry.predicted_abstention
  )).length;
  const predictedAbstentions = evaluated.filter((entry) => entry.predicted_abstention).length;
  const expectedAbstentions = evaluated.filter((entry) => entry.expected_abstention).length;
  const highConfidence = evaluated.filter((entry) => (
    entry.confidence !== null && entry.confidence >= highConfidenceThreshold
  ));
  const calibrationMetrics = calibration(evaluated, eceBins);
  const parityMetrics = entrypointParity(evaluated);

  return {
    sample_count: evaluated.length,
    overall_accuracy: ratio(evaluated.map((entry) => entry.correct)),
    action_accuracy: ratio(evaluated.map((entry) => entry.checks.action)),
    route_family_accuracy: ratio(evaluated.map((entry) => entry.checks.route_family)),
    capability_accuracy: ratio(evaluated.map((entry) => entry.checks.capability)),
    source_top1_accuracy: ratio(evaluated.map((entry) => entry.checks.source_top1)),
    source_recall_at_3: ratio(evaluated.map((entry) => entry.checks.source_recall_at_3)),
    abstention_precision: predictedAbstentions === 0
      ? null
      : abstentionTruePositives / predictedAbstentions,
    abstention_recall: expectedAbstentions === 0
      ? null
      : abstentionTruePositives / expectedAbstentions,
    authorization_accuracy: ratio(evaluated.map((entry) => entry.checks.authorization)),
    budget_violation_rate: violationRate(evaluated.map((entry) => entry.checks.budget_safe)),
    unsafe_paid_route_rate: violationRate(evaluated.map((entry) => entry.checks.paid_route_safe)),
    forbidden_source_violation_rate: violationRate(evaluated.map((entry) => entry.checks.forbidden_source_safe)),
    expected_calibration_error: calibrationMetrics.expected_calibration_error,
    calibration_sample_count: calibrationMetrics.calibration_sample_count,
    calibration_bins: calibrationMetrics.calibration_bins,
    high_confidence_sample_count: highConfidence.length,
    high_confidence_misroute_rate: highConfidence.length === 0
      ? null
      : highConfidence.filter((entry) => !entry.correct).length / highConfidence.length,
    high_confidence_threshold: highConfidenceThreshold,
    entrypoint_pair_count: parityMetrics.entrypoint_pair_count,
    entrypoint_parity: parityMetrics.entrypoint_parity
  };
}

/** Aggregates benchmark outcomes using a distinct applicable denominator per metric. */
export function aggregateRoutingAccuracy(evaluated = [], options = {}) {
  if (!Array.isArray(evaluated)) throw new TypeError("evaluated must be an array");
  const metrics = aggregateCore(evaluated, options);
  const slices = new Set();
  for (const entry of evaluated) {
    for (const slice of entry.slices || []) slices.add(slice);
  }

  metrics.slice_breakdown = {};
  for (const slice of [...slices].sort()) {
    metrics.slice_breakdown[slice] = aggregateCore(
      evaluated.filter((entry) => entry.slices?.includes(slice)),
      options
    );
  }
  return metrics;
}
