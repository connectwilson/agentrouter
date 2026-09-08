const SCALAR_TYPES = new Set(["string", "number", "boolean"]);

export function publicManifestProjection(manifest = {}) {
  const projected = structuredClone(manifest);
  if (projected.registration && typeof projected.registration === "object") {
    delete projected.registration.owner;
  }
  return projected;
}

export function publicEvidenceEvent(event = {}) {
  const capability = scalar(event.request?.capability);
  return compact({
    ...pickScalars(event, [
      "evidence_version",
      "route_type",
      "request_id",
      "service_id",
      "provider_id",
      "service_version",
      "manifest_type",
      "manifest_hash",
      "config_hash",
      "result_hash",
      "output_hash",
      "input_hash",
      "verification_hash",
      "verification_report_hash",
      "trace_hash",
      "trace_payload_hash",
      "payment_tx",
      "created_at"
    ]),
    evidence_profile: publicEvidenceProfile(event.evidence_profile),
    service_binding: publicServiceBinding(event.service_binding),
    request: capability === undefined ? undefined : { capability },
    payment: publicEvidencePayment(event.payment),
    verification: publicVerification(event.verification),
    verification_report: publicVerificationReport(event.verification_report),
    arc_anchor: publicArcAnchor(event.arc_anchor)
  });
}

export function publicRouteObservation(event = {}) {
  const capability = scalar(event.request?.capability);
  return compact({
    ...pickScalars(event, [
      "observation_version",
      "observation_id",
      "request_id",
      "created_at",
      "route_type",
      "status",
      "entrypoint",
      "task_family",
      "route_family",
      "capability",
      "source_family",
      "action",
      "candidates_considered",
      "selected_service_id",
      "selected_routing_score",
      "top_score",
      "runner_up_score",
      "score_margin",
      "confidence",
      "routing_policy_version",
      "durability_status"
    ]),
    request: capability === undefined ? undefined : { capability },
    score_model: pickScalars(event.score_model, ["name", "version"]),
    candidates: Array.isArray(event.candidates)
      ? event.candidates.map(publicRouteCandidate)
      : undefined,
    fallback: event.fallback && typeof event.fallback === "object"
      ? pickScalars(event.fallback, ["used", "from", "to", "reason"])
      : undefined,
    authorization: event.authorization && typeof event.authorization === "object"
      ? pickScalars(event.authorization, ["required", "action", "source"])
      : undefined,
    budget: event.budget && typeof event.budget === "object"
      ? pickScalars(event.budget, ["max_price_usdc", "selected_price_usdc", "compliant"])
      : undefined,
    diagnostics: event.diagnostics && typeof event.diagnostics === "object"
      ? pickScalars(event.diagnostics, ["intent_confidence", "candidate_count", "eligible_candidate_count", "abstain_reason", "policy_gate"])
      : undefined,
    quote: publicObservationQuote(event.quote),
    outcome: publicObservationOutcome(event.outcome)
  });
}

export function publicFeedbackEvent(event = {}) {
  const feedback = event.consumer_feedback;
  return compact({
    ...pickScalars(event, [
      "event_version",
      "request_id",
      "service_id",
      "provider_id",
      "status",
      "schema_valid",
      "latency_ms",
      "consumer_rating",
      "created_at",
      "updated_at"
    ]),
    verification: publicVerification(event.verification),
    consumer_feedback: feedback && typeof feedback === "object"
      ? pickScalars(feedback, [
          "intent_fit",
          "answer_useful",
          "data_quality_score",
          "used_in_final_answer",
          "confidence",
          "consumer_score"
        ])
      : null,
    trust_anchor: publicTrustAnchor(event.consumer_feedback_trust_anchor || event.trust_anchor),
    consumer_feedback_arc_anchor: publicArcAnchor(event.consumer_feedback_arc_anchor || event.arc_anchor),
    consumer_feedback_erc8004: publicErc8004(event.consumer_feedback_erc8004 || event.erc8004)
  });
}

function publicEvidenceProfile(profile) {
  if (!profile || typeof profile !== "object") return undefined;
  return pickScalars(profile, [
    "profile_version",
    "profile_type",
    "evidence_scope",
    "manifest_type",
    "erc8004_reputation_compatible",
    "erc8257_manifest_compatible",
    "storage_model"
  ]);
}

function publicServiceBinding(binding) {
  if (!binding || typeof binding !== "object") return undefined;
  return pickScalars(binding, [
    "service_id",
    "provider_id",
    "version",
    "manifest_type",
    "manifest_hash",
    "config_hash"
  ]);
}

function publicEvidencePayment(payment) {
  if (!payment || typeof payment !== "object") return undefined;
  const quote = payment.quote && typeof payment.quote === "object"
    ? compact({
        ...pickScalars(payment.quote, [
          "quote_version",
          "service_id",
          "amount",
          "currency",
          "payment_backend"
        ]),
        price: publicPricing(payment.quote.price)
      })
    : undefined;
  return compact({
    payment_tx: scalar(payment.payment_tx),
    quote
  });
}

function publicVerification(verification) {
  if (!verification || typeof verification !== "object") return verification === null ? null : undefined;
  return compact({
    ...pickScalars(verification, [
      "schema_valid",
      "freshness_valid",
      "coverage_valid",
      "data_non_empty",
      "sanity_valid",
      "agent_friendly_score",
      "deterministic_score",
      "overall_quality_score"
    ]),
    issues: publicIssueCodes(verification.issues),
    data_quality_issues: publicIssueCodes(verification.data_quality_issues)
  });
}

function publicVerificationReport(report) {
  if (!report || typeof report !== "object") return undefined;
  return compact({
    ...pickScalars(report, [
      "report_version",
      "service_id",
      "request_id",
      "schema_valid",
      "freshness_valid",
      "coverage_valid",
      "data_non_empty",
      "report_hash",
      "created_at"
    ]),
    deterministic_checks: publicVerification(report.deterministic_checks)
  });
}

function publicIssueCodes(issues) {
  if (!Array.isArray(issues)) return undefined;
  return issues
    .map((issue) => scalar(issue?.code))
    .filter((code) => code !== undefined)
    .map((code) => ({ code }));
}

function publicArcAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return anchor === null ? null : undefined;
  return pickScalars(anchor, [
    "anchor_version",
    "standard",
    "status",
    "mode",
    "network",
    "caip2",
    "chain_id",
    "tx_hash",
    "block_number",
    "contract_address",
    "explorer_url",
    "event_type",
    "storage_model",
    "request_id",
    "trace_hash",
    "result_hash",
    "output_hash",
    "verification_hash",
    "manifest_hash",
    "config_hash",
    "payment_tx",
    "recorded_offchain",
    "superseded_by",
    "created_at",
    "updated_at"
  ]);
}

function publicErc8004(anchor) {
  if (!anchor || typeof anchor !== "object") return anchor === null ? null : undefined;
  return pickScalars(anchor, [
    "standard",
    "registry_type",
    "status",
    "mode",
    "network",
    "caip2",
    "chain_id",
    "registry_address",
    "agent_id",
    "value",
    "value_decimals",
    "tag1",
    "tag2",
    "endpoint",
    "feedback_uri",
    "feedback_hash",
    "tx_hash",
    "block_number",
    "feedback_account",
    "recorded_offchain",
    "created_at",
    "updated_at"
  ]);
}

function publicTrustAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return anchor === null ? null : undefined;
  return compact({
    ...pickScalars(anchor, ["trust_anchor_version", "primary_standard", "state", "created_at", "updated_at"]),
    arc_anchor: publicArcAnchor(anchor.arc_anchor),
    erc8004: publicErc8004(anchor.erc8004)
  });
}

function publicRouteCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return {};
  return compact({
    ...pickScalars(candidate, [
      "service_id",
      "title",
      "provider_id",
      "trust_score",
      "health_status",
      "source_provenance_level",
      "recent_failure_rate",
      "consumer_feedback_count",
      "routing_score",
      "equivalent_service_count",
      "source_family",
      "price_usdc"
    ]),
    pricing: publicPricing(candidate.pricing),
    equivalent_service_ids: Array.isArray(candidate.equivalent_service_ids)
      ? candidate.equivalent_service_ids.map(scalar).filter((value) => value !== undefined)
      : undefined
  });
}

function publicPricing(pricing) {
  if (!pricing || typeof pricing !== "object") return undefined;
  return pickScalars(pricing, ["amount", "currency", "protocol", "network"]);
}

function publicObservationQuote(quote) {
  if (!quote || typeof quote !== "object") return quote === null ? null : undefined;
  return compact({
    ...pickScalars(quote, ["quote_version", "would_pay", "payment_backend"]),
    price: publicPricing(quote.price)
  });
}

function publicObservationOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return undefined;
  return pickScalars(outcome, [
    "invocation_status_code",
    "feedback_status",
    "schema_valid",
    "agent_friendly_score",
    "evidence_trace_hash",
    "result_hash"
  ]);
}

function pickScalars(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  const result = {};
  for (const key of keys) {
    const value = scalar(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function scalar(value) {
  if (value === null) return null;
  if (!SCALAR_TYPES.has(typeof value)) return undefined;
  return typeof value !== "number" || Number.isFinite(value) ? value : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
