// Runtime routing telemetry. Offline benchmark evaluation lives under
// test/support so it cannot accidentally become part of the server runtime.
const ROUTE_OBSERVATION_VERSION = "agent_router_route_observation_v2";
const ROUTING_FEEDBACK_VERSION = "agent_router_routing_feedback_v1";
const ROUTING_METRICS_VERSION = "agent_router_routing_metrics_v1";

const ROUTING_ACTIONS = new Set([
  "route",
  "abstain",
  "clarify",
  "connect_account",
  "connect_source",
  "browser_handoff",
  "fallback",
  "no_match"
]);

const ROUTING_VERDICTS = new Set(["correct", "incorrect"]);
const ABSTENTION_ACTIONS = new Set(["abstain", "clarify", "no_match"]);
const AUTHORIZATION_ACTIONS = new Set(["connect_account", "connect_source", "browser_handoff"]);
const BUDGET_OUTCOMES = new Set(["route", "blocked", "quote_required"]);
const routingFeedbackQueues = new WeakMap();

/**
 * Build the common observation envelope used by every routing entrypoint.
 * Prompts are deliberately not retained so routing analytics do not become
 * another store of user content.
 */
export function createRouteObservationV2(input = {}) {
  const candidates = normalizeCandidates(input.candidates);
  const topScore = finiteNumber(candidates[0]?.routing_score);
  const runnerUpScore = finiteNumber(candidates[1]?.routing_score);
  return compactObject({
    observation_version: ROUTE_OBSERVATION_VERSION,
    observation_id: requiredString(input.observation_id, "observation_id"),
    request_id: requiredString(input.request_id, "request_id"),
    created_at: validIsoDate(input.created_at) || new Date().toISOString(),
    entrypoint: normalizeLabel(input.entrypoint, "unknown"),
    task_family: normalizeLabel(input.task_family, "unknown"),
    route_family: normalizeLabel(input.route_family, "unknown"),
    capability: normalizeLabel(input.capability, "unknown"),
    source_family: normalizeLabel(input.source_family, "none"),
    action: normalizeAction(input.action),
    selected_service_id: nullableString(input.selected_service_id),
    candidates,
    top_score: topScore,
    runner_up_score: runnerUpScore,
    score_margin: topScore == null || runnerUpScore == null
      ? null
      : roundMetric(topScore - runnerUpScore),
    confidence: clampProbability(input.confidence),
    fallback: normalizeFallback(input.fallback),
    authorization: normalizeAuthorization(input.authorization),
    budget: normalizeBudget(input.budget),
    actor_key: nullableString(input.actor_key),
    routing_policy_version: nullableString(input.routing_policy_version),
    diagnostics: normalizeDiagnostics(input.diagnostics)
  });
}

/** Persist a terminal routing decision before exposing it to metric readers. */
export async function recordRouteObservationV2(store, input = {}, {
  writeEvent = async () => true
} = {}) {
  const observation = createRouteObservationV2(input);
  store.routeObservations ||= [];
  const existing = store.routeObservations.find((item) => item.observation_id === observation.observation_id);
  if (existing) return existing;
  const written = await writeEvent({
    eventType: "route_observation",
    serviceId: observation.selected_service_id || null,
    requestId: observation.request_id,
    event: observation
  });
  observation.durability_status = written === false ? "memory_only" : "durable";
  store.routeObservations.push(observation);
  return observation;
}

/**
 * Aggregate labels and route observations without returning either raw event
 * collection. Metrics with no valid denominator are null rather than zero.
 */
export function aggregateRoutingMetrics(store, {
  highConfidenceThreshold = 0.8,
  topK = 3
} = {}) {
  const allObservations = Array.isArray(store?.routeObservations) ? store.routeObservations : [];
  const observations = allObservations.filter((item) => item?.observation_version === ROUTE_OBSERVATION_VERSION);
  const eligibleObservations = observations.filter(feedbackEligibleObservation);
  const eligibleObservationIds = new Set(eligibleObservations.map((item) => String(item.observation_id)));
  const observationVersions = countObservationVersions(allObservations);
  const feedbackEvents = Array.isArray(store?.routingFeedbackEvents) ? store.routingFeedbackEvents : [];
  const observationById = new Map(
    observations
      .filter((item) => item?.observation_id)
      .map((item) => [String(item.observation_id), item])
  );
  const feedbackByObservation = latestFeedbackByObservation(feedbackEvents, observationById);
  const eligibleFeedbackByObservation = new Map(
    [...feedbackByObservation.entries()].filter(([observationId]) => eligibleObservationIds.has(observationId))
  );
  const labeledPairs = [...eligibleFeedbackByObservation.entries()]
    .map(([observationId, feedback]) => ({ observation: observationById.get(observationId), feedback }))
    .filter((pair) => pair.observation);
  const routePairs = labeledPairs.filter(({ feedback }) => feedback.expected_action === "route");
  const comparableRoutePairs = routePairs.filter(({ feedback }) => isComparableRouteLabel(feedback));

  const precisionAtOne = rate(
    comparableRoutePairs.map(({ observation, feedback }) => selectedRouteMatches(observation, feedback))
  );
  const topKRecall = rate(
    comparableRoutePairs.map(({ observation, feedback }) => expectedRouteInTopK(observation, feedback, topK))
  );

  const abstentionPairs = labeledPairs.filter(({ feedback }) => ABSTENTION_ACTIONS.has(feedback.expected_action));
  const predictedAbstentions = labeledPairs.filter(({ observation }) => ABSTENTION_ACTIONS.has(observation.action));
  const authPairs = labeledPairs.filter(({ feedback, observation }) =>
    AUTHORIZATION_ACTIONS.has(feedback.expected_action)
    || AUTHORIZATION_ACTIONS.has(observation.action)
    || observation.authorization?.required === true
  );
  const executedBudgetPairs = observations.filter((observation) =>
    observation.action === "route" && knownBudgetPrices(observation.budget)
  );
  const budgetGuardPairs = labeledPairs.filter(({ feedback }) =>
    ["route", "blocked"].includes(feedback.expected_budget_outcome)
  );
  const unknownPriceGuardPairs = labeledPairs.filter(({ feedback }) =>
    feedback.expected_budget_outcome === "quote_required"
  );
  const highConfidenceDecisionPairs = labeledPairs.filter(({ observation }) =>
    finiteNumber(observation.confidence) != null && Number(observation.confidence) >= highConfidenceThreshold
  );

  const calibrationPairs = labeledPairs.filter(({ observation }) => finiteNumber(observation.confidence) != null);

  return {
    metrics_version: ROUTING_METRICS_VERSION,
    generated_at: new Date().toISOString(),
    label_cohort: "self_reported_user_feedback",
    suitable_for_public_accuracy_claims: false,
    metric_use: "Internal routing diagnostics. Use the versioned offline benchmark for public accuracy claims.",
    counts: {
      observations: observations.length,
      eligible_for_feedback: eligibleObservations.length,
      labeled: labeledPairs.length,
      total_observations: allObservations.length,
      legacy_observations: allObservations.length - observations.length,
      by_observation_version: observationVersions
    },
    labeled_coverage: ratio(labeledPairs.length, eligibleObservations.length),
    decision_accuracy: rate(labeledPairs.map(({ observation, feedback }) => routingDecisionCorrect(observation, feedback))),
    route_family_accuracy: accuracyForExpectedField(labeledPairs, "route_family", "expected_route_family"),
    capability_accuracy: accuracyForExpectedField(labeledPairs, "capability", "expected_capability"),
    precision_at_1: precisionAtOne,
    [`top_${Math.max(1, Math.trunc(topK))}_recall`]: topKRecall,
    abstention_accuracy: rate(labeledPairs.map(({ observation, feedback }) =>
      ABSTENTION_ACTIONS.has(observation.action) === ABSTENTION_ACTIONS.has(feedback.expected_action)
    )),
    abstention_precision: rate(predictedAbstentions.map(({ feedback }) => ABSTENTION_ACTIONS.has(feedback.expected_action))),
    abstention_recall: rate(abstentionPairs.map(({ observation }) => ABSTENTION_ACTIONS.has(observation.action))),
    auth_action_accuracy: rate(authPairs.map(({ observation, feedback }) =>
      observation.action === feedback.expected_action
      && (!feedback.expected_source_family || observation.source_family === feedback.expected_source_family)
    )),
    budget_violation_rate: rate(executedBudgetPairs.map((observation) => budgetExceeded(observation.budget))),
    budget_guard_accuracy: rate(budgetGuardPairs.map(({ observation, feedback }) =>
      observedBudgetOutcome(observation) === feedback.expected_budget_outcome
    )),
    unknown_price_guard_rate: rate(unknownPriceGuardPairs.map(({ observation }) =>
      observedBudgetOutcome(observation) === "quote_required"
    )),
    high_confidence_misroute_rate: rate(highConfidenceDecisionPairs.map(({ observation, feedback }) =>
      !routingDecisionCorrect(observation, feedback)
    )),
    expected_calibration_error: expectedCalibrationError(calibrationPairs),
    by_entrypoint: aggregateSlices(observations, eligibleFeedbackByObservation, "entrypoint"),
    by_task_family: aggregateSlices(observations, eligibleFeedbackByObservation, "task_family"),
    by_route_family: aggregateSlices(observations, eligibleFeedbackByObservation, "route_family"),
    by_capability: aggregateSlices(observations, eligibleFeedbackByObservation, "capability"),
    by_source_family: aggregateSlices(observations, eligibleFeedbackByObservation, "source_family")
  };
}

/**
 * Validate, persist, and then materialize an authenticated routing label.
 * Client-supplied actor identifiers are ignored; ownership is determined from
 * the authenticated actor passed by the HTTP boundary.
 */
export async function recordRoutingFeedback(store, input = {}, {
  actorKey = "",
  writeEvent = async () => true,
  refreshEvents = null
} = {}) {
  const observationId = String(input.observation_id || "").trim();
  const requestId = String(input.request_id || "").trim();
  const verdict = String(input.verdict || "").trim().toLowerCase();
  const expectedAction = String(input.expected_action || "").trim().toLowerCase();
  const expectedRouteFamily = nullableLabel(input.expected_route_family);
  const expectedCapability = nullableLabel(input.expected_capability);
  const expectedBudgetOutcome = nullableLabel(input.expected_budget_outcome);
  const expectedSourceFamily = nullableLabel(input.expected_source_family);
  const expectedServiceId = nullableString(input.expected_service_id);
  const reasonCode = normalizeLabel(input.reason_code, verdict === "correct" ? "route_confirmed" : "other");
  const authenticatedActor = String(actorKey || "").trim();

  if (!authenticatedActor) {
    return routingError(401, "authentication_required", "AUTH_REQUIRED", "Authentication is required to label a routing decision.");
  }
  if (!observationId || !requestId || !ROUTING_VERDICTS.has(verdict) || !ROUTING_ACTIONS.has(expectedAction)) {
    return routingError(
      422,
      "invalid_routing_feedback",
      "INVALID_ROUTING_FEEDBACK",
      "observation_id, request_id, verdict, and a supported expected_action are required."
    );
  }
  if (expectedBudgetOutcome && !BUDGET_OUTCOMES.has(expectedBudgetOutcome)) {
    return routingError(
      422,
      "invalid_routing_feedback",
      "INVALID_BUDGET_OUTCOME",
      "expected_budget_outcome must be route, blocked, or quote_required."
    );
  }
  if (expectedAction === "route"
    && !expectedRouteFamily
    && !expectedCapability
    && !expectedSourceFamily
    && !expectedServiceId) {
    return routingError(
      422,
      "invalid_routing_feedback",
      "EXPECTED_ROUTE_REQUIRED",
      "A route label must identify the expected route family, capability, source family, or service."
    );
  }

  let observation = (store.routeObservations || []).find((item) =>
    item?.observation_id === observationId && item?.request_id === requestId
  );
  if (!observation && typeof refreshEvents === "function") {
    let refreshed;
    try {
      refreshed = await refreshEvents();
    } catch {
      return routingError(503, "routing_feedback_persistence_failed", "ROUTING_FEEDBACK_PERSISTENCE_FAILED", "The durable routing observation could not be refreshed.");
    }
    if (refreshed?.ok === false) {
      return routingError(503, "routing_feedback_persistence_failed", "ROUTING_FEEDBACK_PERSISTENCE_FAILED", "The durable routing observation could not be refreshed.");
    }
    observation = (store.routeObservations || []).find((item) =>
      item?.observation_id === observationId && item?.request_id === requestId
    );
  }
  if (!observation) {
    return routingError(404, "routing_observation_not_found", "ROUTING_OBSERVATION_NOT_FOUND", "No matching routing observation exists.");
  }
  if (!observation.actor_key || observation.actor_key !== authenticatedActor) {
    return routingError(403, "forbidden_routing_feedback_actor", "FORBIDDEN_ROUTING_FEEDBACK_ACTOR", "Only the caller that owns this routing observation may label it.");
  }

  const expectedDecisionMatches = routingDecisionMatchesExpected(observation, {
    expected_action: expectedAction,
    expected_route_family: expectedRouteFamily,
    expected_capability: expectedCapability,
    expected_budget_outcome: expectedBudgetOutcome,
    expected_source_family: expectedSourceFamily,
    expected_service_id: expectedServiceId
  });
  if ((verdict === "correct") !== expectedDecisionMatches) {
    return routingError(
      422,
      "inconsistent_routing_feedback",
      "INCONSISTENT_ROUTING_FEEDBACK",
      "verdict does not agree with the expected route fields and recorded decision."
    );
  }

  const proposed = {
    event_version: ROUTING_FEEDBACK_VERSION,
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
    reason_code: reasonCode,
    actor_key: authenticatedActor
  };
  return withRoutingFeedbackLock(store, observationId, async () => {
    store.routingFeedbackEvents ||= [];
    const existing = store.routingFeedbackEvents.find((item) => item.observation_id === observationId);
    if (existing) {
      return sameRoutingFeedback(existing, proposed)
        ? { ok: true, statusCode: 200, status: "routing_feedback_already_recorded", event: existing }
        : routingError(409, "routing_feedback_conflict", "ROUTING_FEEDBACK_CONFLICT", "Different feedback has already been recorded for this routing observation.");
    }

    const event = { ...proposed, created_at: new Date().toISOString() };
    let written;
    try {
      written = await writeEvent({
        eventType: "routing_feedback",
        serviceId: observation.selected_service_id || expectedServiceId || null,
        requestId,
        event
      });
    } catch (error) {
      return routingError(503, "routing_feedback_persistence_failed", "ROUTING_FEEDBACK_PERSISTENCE_FAILED", error?.message || "Routing feedback could not be persisted.");
    }

    if (written?.status === "created" || written?.status === "existing") {
      const canonical = written.event;
      if (!validCanonicalRoutingFeedback(canonical, { observationId, actorKey: authenticatedActor })) {
        return routingError(503, "routing_feedback_persistence_failed", "ROUTING_FEEDBACK_PERSISTENCE_FAILED", "The durable routing feedback record was invalid.");
      }
      materializeRoutingFeedback(store, canonical);
      if (written.status === "existing") {
        return sameRoutingFeedback(canonical, proposed)
          ? { ok: true, statusCode: 200, status: "routing_feedback_already_recorded", event: canonical }
          : routingError(409, "routing_feedback_conflict", "ROUTING_FEEDBACK_CONFLICT", "Different feedback has already been recorded for this routing observation.");
      }
      if (!sameRoutingFeedback(canonical, proposed)) {
        return routingError(503, "routing_feedback_persistence_failed", "ROUTING_FEEDBACK_PERSISTENCE_FAILED", "The durable routing feedback record did not match the accepted label.");
      }
      return { ok: true, statusCode: 201, status: "routing_feedback_recorded", event: canonical };
    }
    store.routingFeedbackEvents.push(event);
    return { ok: true, statusCode: 201, status: "routing_feedback_recorded", event };
  });
}

function validCanonicalRoutingFeedback(event, { observationId, actorKey }) {
  return event?.event_version === ROUTING_FEEDBACK_VERSION
    && event?.observation_id === observationId
    && event?.actor_key === actorKey;
}

function materializeRoutingFeedback(store, event) {
  store.routingFeedbackEvents ||= [];
  if (!store.routingFeedbackEvents.some((item) =>
    item?.observation_id === event.observation_id && item?.actor_key === event.actor_key
  )) {
    store.routingFeedbackEvents.push(event);
  }
}

async function withRoutingFeedbackLock(store, observationId, action) {
  let storeQueues = routingFeedbackQueues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    routingFeedbackQueues.set(store, storeQueues);
  }
  const previous = storeQueues.get(observationId) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn, () => turn);
  storeQueues.set(observationId, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (storeQueues.get(observationId) === tail) storeQueues.delete(observationId);
  }
}

function normalizeCandidates(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).map((candidate, index) => compactObject({
    rank: index + 1,
    service_id: nullableString(candidate?.service_id),
    source_family: normalizeLabel(candidate?.source_family, "unknown"),
    routing_score: finiteNumber(candidate?.routing_score),
    price_usdc: nullableString(candidate?.price_usdc),
    eligible: candidate?.eligible == null ? undefined : Boolean(candidate.eligible),
    rejection_reason: nullableLabel(candidate?.rejection_reason)
  }));
}

function normalizeFallback(input = {}) {
  return compactObject({
    used: Boolean(input?.used),
    from: nullableLabel(input?.from),
    to: nullableLabel(input?.to),
    reason: nullableLabel(input?.reason)
  });
}

function normalizeAuthorization(input = {}) {
  return compactObject({
    required: Boolean(input?.required),
    action: normalizeLabel(input?.action, input?.required ? "connect_source" : "none"),
    source: nullableLabel(input?.source)
  });
}

function normalizeBudget(input = {}) {
  return compactObject({
    max_price_usdc: nullableString(input?.max_price_usdc),
    selected_price_usdc: nullableString(input?.selected_price_usdc),
    compliant: input?.compliant == null ? null : Boolean(input.compliant)
  });
}

function knownBudgetPrices(budget = {}) {
  const maxPrice = finiteNumber(budget?.max_price_usdc);
  const selectedPrice = finiteNumber(budget?.selected_price_usdc);
  return maxPrice != null && maxPrice >= 0 && selectedPrice != null && selectedPrice >= 0;
}

function budgetExceeded(budget = {}) {
  return Number(budget.selected_price_usdc) > Number(budget.max_price_usdc);
}

function observedBudgetOutcome(observation = {}) {
  if (observation.action === "route") return "route";
  const abstainReason = observation.diagnostics?.abstain_reason;
  const policyGate = observation.diagnostics?.policy_gate;
  if (abstainReason === "price_unknown" || policyGate === "quote_required") return "quote_required";
  if (["budget_exceeded", "invalid_budget"].includes(abstainReason) || policyGate === "blocked") return "blocked";
  return null;
}

function normalizeDiagnostics(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const allowed = ["intent_confidence", "candidate_count", "eligible_candidate_count", "abstain_reason", "policy_gate"];
  const result = {};
  for (const key of allowed) {
    const value = input[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function latestFeedbackByObservation(events, observationById) {
  const result = new Map();
  for (const feedback of events) {
    const observationId = String(feedback?.observation_id || "");
    if (!observationId || !observationById.has(observationId)) continue;
    const observation = observationById.get(observationId);
    if (feedback?.event_version !== ROUTING_FEEDBACK_VERSION) continue;
    if (feedback?.request_id !== observation?.request_id) continue;
    if (observation?.actor_key && feedback?.actor_key !== observation.actor_key) continue;
    const current = result.get(observationId);
    const currentTime = Date.parse(current?.created_at || 0) || 0;
    const nextTime = Date.parse(feedback?.created_at || 0) || 0;
    if (!current || nextTime >= currentTime) result.set(observationId, feedback);
  }
  return result;
}

function selectedRouteMatches(observation, feedback) {
  if (observation.action !== "route") return false;
  if (!isComparableRouteLabel(feedback)) return false;
  if (feedback.expected_service_id && observation.selected_service_id !== feedback.expected_service_id) return false;
  if (feedback.expected_source_family && observation.source_family !== feedback.expected_source_family) return false;
  return true;
}

function expectedRouteInTopK(observation, feedback, topK) {
  if (!isComparableRouteLabel(feedback)) return false;
  const candidates = Array.isArray(observation.candidates)
    ? observation.candidates.slice(0, Math.max(1, Math.trunc(topK)))
    : [];
  if (feedback.expected_service_id) {
    return candidates.some((candidate) => candidate.service_id === feedback.expected_service_id);
  }
  if (feedback.expected_source_family) {
    return candidates.some((candidate) => candidate.source_family === feedback.expected_source_family);
  }
  return false;
}

function isComparableRouteLabel(feedback) {
  return Boolean(feedback?.expected_service_id || feedback?.expected_source_family);
}

function feedbackEligibleObservation(observation) {
  return Boolean(
    nullableString(observation?.actor_key)
    && nullableString(observation?.observation_id)
    && nullableString(observation?.request_id)
  );
}

function countObservationVersions(observations) {
  const counts = new Map();
  for (const observation of observations) {
    const rawVersion = nullableString(observation?.observation_version);
    const version = rawVersion && /^[a-z0-9_.-]{1,100}$/i.test(rawVersion) ? rawVersion : "unversioned";
    counts.set(version, (counts.get(version) || 0) + 1);
  }
  return Object.fromEntries(counts);
}

function accuracyForExpectedField(pairs, observationField, feedbackField) {
  const comparable = pairs.filter(({ feedback }) => Boolean(feedback?.[feedbackField]));
  return rate(comparable.map(({ observation, feedback }) =>
    observation?.[observationField] === feedback?.[feedbackField]
  ));
}

function aggregateSlices(observations, feedbackByObservation, field) {
  const result = new Map();
  for (const observation of observations) {
    const key = normalizeLabel(observation?.[field], "unknown");
    const aggregate = result.get(key) || { observations: 0, labeled: 0, correct: 0 };
    aggregate.observations += 1;
    const feedback = feedbackByObservation.get(String(observation?.observation_id || ""));
    if (feedback) {
      aggregate.labeled += 1;
      if (routingDecisionCorrect(observation, feedback)) aggregate.correct += 1;
    }
    result.set(key, aggregate);
  }
  return Object.fromEntries([...result.entries()].map(([key, value]) => [key, {
    observations: value.observations,
    labeled: value.labeled,
    accuracy: value.labeled ? roundMetric(value.correct / value.labeled) : null
  }]));
}

function routingDecisionCorrect(observation, feedback) {
  return feedback.verdict === "correct" && routingDecisionMatchesExpected(observation, feedback);
}

function routingDecisionMatchesExpected(observation, feedback) {
  if (observation.action !== feedback.expected_action) return false;
  if (feedback.expected_route_family && observation.route_family !== feedback.expected_route_family) return false;
  if (feedback.expected_capability && observation.capability !== feedback.expected_capability) return false;
  if (feedback.expected_budget_outcome
    && observedBudgetOutcome(observation) !== feedback.expected_budget_outcome) return false;
  if (feedback.expected_service_id && observation.selected_service_id !== feedback.expected_service_id) return false;
  if (feedback.expected_source_family && observation.source_family !== feedback.expected_source_family) return false;
  return true;
}

function expectedCalibrationError(pairs, bucketCount = 10) {
  if (!pairs.length) return null;
  const buckets = Array.from({ length: bucketCount }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const { observation, feedback } of pairs) {
    const confidence = clampProbability(observation.confidence);
    const index = Math.min(bucketCount - 1, Math.floor(confidence * bucketCount));
    buckets[index].count += 1;
    buckets[index].confidence += confidence;
    if (routingDecisionCorrect(observation, feedback)) buckets[index].correct += 1;
  }
  const error = buckets.reduce((sum, bucket) => {
    if (!bucket.count) return sum;
    const averageConfidence = bucket.confidence / bucket.count;
    const accuracy = bucket.correct / bucket.count;
    return sum + (bucket.count / pairs.length) * Math.abs(averageConfidence - accuracy);
  }, 0);
  return roundMetric(error);
}

function sameRoutingFeedback(left, right) {
  return [
    "observation_id",
    "request_id",
    "verdict",
    "expected_action",
    "expected_route_family",
    "expected_capability",
    "expected_budget_outcome",
    "expected_source_family",
    "expected_service_id",
    "reason_code",
    "actor_key"
  ].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function routingError(statusCode, status, code, message) {
  return { ok: false, statusCode, status, error: { code, message } };
}

function rate(values) {
  if (!values.length) return null;
  return roundMetric(values.filter(Boolean).length / values.length);
}

function ratio(numerator, denominator) {
  return denominator ? roundMetric(numerator / denominator) : null;
}

function roundMetric(value) {
  return Number(Number(value).toFixed(6));
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampProbability(value) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.min(1, Math.max(0, number));
}

function normalizeAction(value) {
  const action = normalizeLabel(value, "route");
  return ROUTING_ACTIONS.has(action) ? action : "route";
}

function normalizeLabel(value, fallback = "") {
  return String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function nullableLabel(value) {
  const normalized = normalizeLabel(value, "");
  return normalized || null;
}

function nullableString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredString(value, field) {
  const normalized = nullableString(value);
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}

function validIsoDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
