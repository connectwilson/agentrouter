import { settlementChain, erc8004Registries, erc8004ExplorerUrl } from "./chains.js";
import { serviceMatchesCapabilityPack } from "./capability-packs.js";

export function createMemoryStore() {
  return {
    providers: new Map(),
    services: new Map(),
    validationRuns: [],
    invocationLogs: [],
    feedbackEvents: [],
    qualityEvents: [],
    evidenceEvents: [],
    routeObservations: [],
    issuedQuotes: new Map(),
    quoteFeedbackEvents: [],
    feedbackGrants: new Map(),
    creditAccounts: new Map(),
    creditApiKeys: new Map(),
    creditLedger: [],
    authSessions: new Map(),
    oauthStates: new Map(),
    deviceAuthorizations: new Map(),
    socialConnections: new Map(),
    publicApiCatalog: new Map(),
    publicApiPipelineRuns: [],
    erc8004PlatformIdentities: new Map(),
    erc8004VendorIdentities: new Map(),
    erc8004Imports: new Map()
  };
}

export function publicServiceRecord(record) {
  const trust = summarizeTrust(record);
  const health = summarizeHealth(record);
  const provenance = summarizeProvenance(record);
  const requestData = requestDataContract(record);
  const responseData = responseDataContract(record);
  const displayTitle = displayTitleForRecord(record);
  return {
    service_id: record.manifest.service_id,
    manifest_type: record.manifest.manifest_type || "hosted_http_data_api",
    version: record.manifest.version || "1.0.0",
    manifest_hash: record.manifest.integrity?.manifest_hash || record.manifest.registration?.manifest_hash || null,
    config_hash: record.manifest.integrity?.config_hash || record.manifest.registration?.config_hash || null,
    title: record.manifest.title,
    display_title: displayTitle,
    description_for_agent: record.manifest.description_for_agent,
    capabilities: record.manifest.capabilities,
    routing: record.manifest.routing || null,
    pricing: record.manifest.pricing,
    verification_status: record.verification_status,
    trust,
    sample_request: record.manifest.sample_request || {},
    request_data: requestData,
    response_data: responseData,
    pre_call_context: preCallContext(record, { trust, health, provenance, requestData, responseData }),
    sample_response: publicSampleResponse(record.manifest.sample_response),
    validation_result_preview: publicValidationPreview(record.validation_runs?.at(-1)?.result_preview || null),
    source_provenance: provenance,
    quality_profile: summarizeQuality(record),
    health,
    erc8004: publicErc8004(record),
    erc8004_status: publicErc8004Status(record),
    badges: summarizeBadges(record),
    created_at: record.created_at || null,
    updated_at: record.updated_at || null
  };
}

function preCallContext(record, { trust, health, provenance, requestData, responseData }) {
  const manifest = record.manifest;
  const pricing = manifest.pricing || {};
  const freshness = manifest.freshness || {};
  const runtimeSecrets = manifest.runtime_secrets || {};
  const limitations = [
    ...(manifest.sample_response?.metadata?.limitations || []),
    ...(manifest.agent_contract?.limitations || [])
  ].filter(Boolean);
  return {
    context_version: "agent_pre_call_context_v1",
    decision_summary: [
      `Use ${manifest.service_id} when the task fits: ${(manifest.capabilities || []).filter((capability) => capability !== "data_service").slice(0, 6).join(", ") || manifest.title}.`,
      `Costs ${pricing.amount || "0"} ${pricing.currency || "USDC"} via ${pricing.protocol || "x402"} on ${pricing.network || "base"}.`,
      health.status === "healthy" ? "Service is currently healthy." : `Service health is ${health.status}.`
    ].join(" "),
    buyer_requirements: {
      payment_required: true,
      payment_protocol: pricing.protocol || "x402",
      currency: pricing.currency || "USDC",
      network: pricing.network || "base",
      needs_buyer_api_key: false,
      max_budget_field: "max_amount"
    },
    provider_requirements: {
      provider_credential_required: Boolean(runtimeSecrets.required),
      credential_public: false,
      credential_custody: provenance.credential_custody
    },
    pricing,
    freshness: {
      update_frequency: freshness.update_frequency || "unknown",
      max_data_lag_seconds: freshness.max_data_lag_seconds ?? null,
      declared_live_on_request: freshness.update_frequency === "on_request"
    },
    provenance,
    verification: {
      status: record.verification_status,
      last_validation_ok: health.last_validation_ok,
      last_validation_at: health.last_validation_at,
      latest_http_status: health.latest_http_status
    },
    trust,
    health,
    request_data: requestData,
    response_data: responseData,
    limitations,
    risk_flags: preCallRiskFlags({ record, health, trust, provenance, limitations })
  };
}

function preCallRiskFlags({ record, health, trust, provenance, limitations }) {
  const flags = [];
  if (record.verification_status !== "verified") flags.push("not_verified");
  if (health.status !== "healthy") flags.push(`health_${health.status}`);
  if (provenance.source_provenance_level === "unknown") flags.push("unknown_source_provenance");
  if (trust.recent_failure_rate != null && trust.recent_failure_rate > 0.2) flags.push("recent_failures");
  if ((limitations || []).length) flags.push("has_declared_limitations");
  return flags;
}

function requestDataContract(record) {
  return record.manifest.agent_contract?.request_data || {
    fields: Object.keys(record.manifest.sample_request || {}),
    example: record.manifest.sample_request || {},
    shape_summary: summarizeShape(record.manifest.sample_request || {})
  };
}

function responseDataContract(record) {
  const sampleData = record.manifest.sample_response?.data || {};
  return record.manifest.agent_contract?.response_data || {
    fields: collectFieldPaths(sampleData, 16),
    preview: redactDataPreview(sampleData),
    shape_summary: summarizeShape(sampleData)
  };
}

export function publicSampleResponse(sampleResponse) {
  if (!sampleResponse || typeof sampleResponse !== "object") return null;
  return {
    schema_version: sampleResponse.schema_version || null,
    status: sampleResponse.status || null,
    sample_type: sampleResponse.sample_type || "redacted_shape_only",
    query_shape: redactDataPreview(sampleResponse.query || {}),
    data_shape: redactDataPreview(sampleResponse.data || {}),
    metadata: publicMetadata(sampleResponse.metadata),
    agent_hints: sampleResponse.agent_hints || null,
    summary: sampleResponse.summary || null,
    redaction: {
      redacted: true,
      reason: "Public discovery responses expose schema and shape only. Real values require paid invocation."
    }
  };
}

export function publicValidationRun(validationRun) {
  if (!validationRun) return null;
  return {
    ok: validationRun.ok,
    service_id: validationRun.service_id,
    status: validationRun.status,
    schema_errors: validationRun.schema_errors || [],
    envelope_errors: validationRun.envelope_errors || [],
    result_errors: validationRun.result_errors || [],
    result_preview: publicValidationPreview(validationRun.result_preview),
    created_at: validationRun.created_at,
    redaction: {
      redacted: true,
      reason: "Latest validation proves the endpoint responded with JSON, but public output omits paid data values."
    }
  };
}

export function publicValidationPreview(preview) {
  if (!preview) return null;
  return {
    shape: redactDataPreview(preview),
    fields: collectFieldPaths(preview, 32),
    shape_summary: summarizeShape(preview),
    redacted: true
  };
}

function publicMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  return {
    data_sources: Array.isArray(metadata.data_sources) ? metadata.data_sources : undefined,
    freshness_seconds: metadata.freshness_seconds ?? undefined,
    is_estimated: metadata.is_estimated ?? undefined,
    confidence: metadata.confidence ?? undefined,
    limitations: Array.isArray(metadata.limitations) ? metadata.limitations : undefined
  };
}

function redactDataPreview(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return summarizeShape(value);
  if (Array.isArray(value)) {
    return {
      type: "array",
      item_count_sample: value.length,
      item_shape: value.length ? redactDataPreview(value[0], depth + 1) : null
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 30).map(([key, item]) => [key, redactDataPreview(item, depth + 1)])
    );
  }
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<boolean>";
  if (typeof value === "string") return value.startsWith("0x") ? "<address_or_hash>" : "<string>";
  return `<${typeof value}>`;
}

export function summarizeTrust(record) {
  const events = record.feedback_events || [];
  const operationalEvents = events.filter((event) => event.status !== "consumer_feedback_only");
  const successful = operationalEvents.filter((event) => event.status === "success").length;
  const schemaValid = operationalEvents.filter((event) => event.schema_valid).length;
  const freshnessValid = operationalEvents.filter((event) => event.verification?.freshness_valid === true).length;
  const coverageValid = operationalEvents.filter((event) => event.verification?.coverage_valid === true).length;
  const agentFriendlyEvents = operationalEvents
    .map((event) => event.verification?.agent_friendly_score)
    .filter((score) => typeof score === "number");
  const consumerFeedbackEvents = events
    .map((event) => event.consumer_feedback)
    .filter(Boolean);
  const intentFitScores = consumerFeedbackEvents
    .map((feedback) => assessmentScore(feedback.intent_fit))
    .filter((score) => typeof score === "number");
  const usefulScores = consumerFeedbackEvents
    .map((feedback) => assessmentScore(feedback.answer_useful))
    .filter((score) => typeof score === "number");
  const consumerScores = consumerFeedbackEvents
    .map((feedback) => feedback.consumer_score)
    .filter((score) => typeof score === "number");
  const successRate = operationalEvents.length ? successful / operationalEvents.length : null;
  const schemaValidRate = operationalEvents.length ? schemaValid / operationalEvents.length : null;
  const freshnessValidRate = operationalEvents.length ? freshnessValid / operationalEvents.length : null;
  const coverageValidRate = operationalEvents.length ? coverageValid / operationalEvents.length : null;
  const averageAgentFriendlyScore = agentFriendlyEvents.length
    ? agentFriendlyEvents.reduce((sum, score) => sum + score, 0) / agentFriendlyEvents.length
    : null;
  const intentFitRate = intentFitScores.length
    ? intentFitScores.reduce((sum, score) => sum + score, 0) / intentFitScores.length
    : null;
  // "This did not match my question" is the verdict a misrouted call earns. It
  // needs to be visible on its own: averaged into a single score, three
  // mismatches barely move the ranking of an otherwise healthy service.
  const intentMismatchCount = consumerFeedbackEvents.filter((feedback) => feedback.intent_fit === "no").length;
  const intentMismatchRate = consumerFeedbackEvents.length
    ? intentMismatchCount / consumerFeedbackEvents.length
    : null;
  const usefulnessRate = usefulScores.length
    ? usefulScores.reduce((sum, score) => sum + score, 0) / usefulScores.length
    : null;
  const averageConsumerScore = consumerScores.length
    ? consumerScores.reduce((sum, score) => sum + score, 0) / consumerScores.length
    : null;
  const latencyEvents = operationalEvents.filter((event) => typeof event.latency_ms === "number");
  const recentOperationalEvents = operationalEvents.slice(-10);
  const recentFailures = recentOperationalEvents.filter((event) => event.status !== "success").length;
  const averageLatencyMs = latencyEvents.length
    ? latencyEvents.reduce((sum, event) => sum + event.latency_ms, 0) / latencyEvents.length
    : null;
  const verificationScore = record.verification_status === "verified" ? 1 : 0.2;
  const subjectiveScore = averageConsumerScore ?? usefulnessRate ?? intentFitRate ?? null;
  const hasTrustEvents = operationalEvents.length || consumerFeedbackEvents.length;
  const trustScore = hasTrustEvents
    ? (
        (successRate ?? verificationScore) * 0.22 +
        (schemaValidRate ?? verificationScore) * 0.18 +
        (coverageValidRate ?? schemaValidRate ?? 0) * 0.12 +
        (freshnessValidRate ?? schemaValidRate ?? 0) * 0.08 +
        (averageAgentFriendlyScore ?? 0.7) * 0.08 +
        (subjectiveScore ?? (schemaValidRate ?? verificationScore)) * 0.22 +
        latencyScore(averageLatencyMs) * 0.05 +
        verificationScore * 0.05
      )
    : verificationScore * 0.7;
  const trustSampleSize = Math.max(operationalEvents.length, consumerFeedbackEvents.length);
  const trustScoreConfidence = trustSampleSize ? trustSampleSize / (trustSampleSize + 5) : 0;
  const trustScorePrior = verificationScore * 0.7;
  const routingTrustScore = trustScore * trustScoreConfidence + trustScorePrior * (1 - trustScoreConfidence);
  return {
    provider_id: record.manifest.provider.provider_id,
    feedback_count: events.length,
    operational_feedback_count: operationalEvents.length,
    consumer_feedback_count: consumerFeedbackEvents.length,
    recent_failure_rate: recentOperationalEvents.length ? Number((recentFailures / recentOperationalEvents.length).toFixed(2)) : null,
    success_rate: successRate,
    schema_valid_rate: schemaValidRate,
    freshness_valid_rate: freshnessValidRate,
    coverage_valid_rate: coverageValidRate,
    intent_fit_rate: intentFitRate == null ? null : Number(intentFitRate.toFixed(2)),
    intent_mismatch_count: intentMismatchCount,
    intent_mismatch_rate: intentMismatchRate == null ? null : Number(intentMismatchRate.toFixed(2)),
    usefulness_rate: usefulnessRate == null ? null : Number(usefulnessRate.toFixed(2)),
    average_consumer_score: averageConsumerScore == null ? null : Number(averageConsumerScore.toFixed(2)),
    average_agent_friendly_score: averageAgentFriendlyScore == null ? null : Number(averageAgentFriendlyScore.toFixed(2)),
    average_latency_ms: averageLatencyMs == null ? null : Number(averageLatencyMs.toFixed(2)),
    verification_status: record.verification_status,
    feedback_state: hasTrustEvents ? "observed" : "no_feedback_yet",
    trust_score: Number(trustScore.toFixed(4)),
    trust_score_prior: Number(trustScorePrior.toFixed(4)),
    trust_score_confidence: Number(trustScoreConfidence.toFixed(4)),
    routing_trust_score: Number(routingTrustScore.toFixed(4))
  };
}

function assessmentScore(value) {
  if (value === "yes") return 1;
  if (value === "partial") return 0.5;
  if (value === "no") return 0;
  return null;
}

export function summarizeQuality(record) {
  const events = record.feedback_events || [];
  const verificationEvents = events.map((event) => event.verification).filter(Boolean);
  const qualityEvents = record.quality_events || [];
  const latestValidation = record.validation_runs?.at(-1) || null;
  const latestVerification = verificationEvents.at(-1) || null;
  const upstreamErrors = events.filter((event) => event.status === "error").length;
  const businessErrors = qualityEvents.filter((event) => event.business_error?.detected).length;
  return {
    profile_version: "agent_data_quality_profile_v1",
    verification_status: record.verification_status,
    latest_validation_ok: latestValidation?.ok ?? null,
    latest_validation_error: latestValidation?.error || null,
    feedback_count: events.length,
    quality_event_count: qualityEvents.length,
    upstream_error_count: upstreamErrors,
    business_error_count: businessErrors,
    latest_verification: latestVerification,
    latest_quality_event: qualityEvents.at(-1) || null,
    declared_freshness_seconds: record.manifest.freshness?.max_data_lag_seconds ?? null,
    result_contract: {
      envelope_required: true,
      deterministic_checks: ["http_status", "schema", "envelope", "freshness", "coverage", "empty_result"],
      semantic_checks: ["agent_friendliness", "intent_fit_summary"]
    }
  };
}

export function summarizeHealth(record) {
  const latestValidation = record.validation_runs?.at(-1) || null;
  const operationalEvents = (record.feedback_events || []).filter((event) => event.status !== "consumer_feedback_only");
  const latestOperational = operationalEvents.at(-1) || null;
  const recent = operationalEvents.slice(-10);
  const recentFailures = recent.filter((event) => event.status !== "success").length;
  const latestIsFailure = Boolean(latestOperational && latestOperational.status !== "success");
  const circuitActive = latestIsFailure && recentFailures >= 3;
  return {
    health_version: "agent_service_health_v1",
    status: latestValidation?.ok === false || recentFailures >= 3 ? "degraded" : record.verification_status === "verified" ? "healthy" : "unknown",
    last_validation_at: latestValidation?.created_at || null,
    last_validation_ok: latestValidation?.ok ?? null,
    last_success_at: [...operationalEvents].reverse().find((event) => event.status === "success")?.created_at || null,
    last_failure_at: [...operationalEvents].reverse().find((event) => event.status !== "success")?.created_at || null,
    latest_http_status: latestOperational?.http_status || null,
    recent_failure_rate: recent.length ? Number((recentFailures / recent.length).toFixed(2)) : null,
    circuit_breaker: {
      active: circuitActive,
      reason: circuitActive ? "recent_runtime_failures" : null,
      recent_window: recent.length,
      recent_failures: recentFailures
    }
  };
}

export function summarizeProvenance(record) {
  const claim = record.manifest.data_source_claim || {};
  const level = claim.source_provenance_level || inferProvenanceLevel(claim);
  return {
    provenance_version: "agent_data_source_provenance_v1",
    source_provenance_level: level,
    source_type: claim.source_type || "unknown",
    authorization_status: claim.authorization_status || "unknown",
    redistribution_status: claim.redistribution_status || "unknown",
    credential_custody: claim.credential_custody || "unknown",
    platform_stores_credentials: Boolean(claim.platform_stores_credentials),
    verified_by_platform: level === "official_verified"
  };
}

export function summarizeBadges(record) {
  const trust = summarizeTrust(record);
  const quality = summarizeQuality(record);
  const health = summarizeHealth(record);
  const provenance = summarizeProvenance(record);
  const badges = [];
  if (record.verification_status === "verified") {
    badges.push({ code: "verified_live_endpoint", label: "Verified live endpoint", level: "positive" });
  }
  if (health.status === "healthy") {
    badges.push({ code: "healthy", label: "Healthy", level: "positive" });
  }
  if ((record.manifest.freshness?.max_data_lag_seconds || 0) > 0 && record.manifest.freshness.max_data_lag_seconds <= 3600) {
    badges.push({ code: "fresh_data", label: "Fresh data", level: "positive" });
  }
  if (provenance.source_provenance_level && provenance.source_provenance_level !== "unknown") {
    badges.push({ code: "source_declared", label: "Source declared", level: "neutral" });
  }
  if (provenance.source_provenance_level === "official_verified") {
    badges.push({ code: "official_verified", label: "Official verified", level: "positive" });
  }
  if (trust.consumer_feedback_count > 0 && (trust.average_consumer_score ?? trust.usefulness_rate ?? 0) >= 0.8) {
    badges.push({ code: "agent_useful", label: "Agent useful", level: "positive" });
  }
  if (quality.business_error_count > 0 || health.status === "degraded") {
    badges.push({ code: "needs_attention", label: "Needs attention", level: "warning" });
  }
  return badges;
}

export function summarizeRegistryStats(store, { ownerKey = "" } = {}) {
  const records = [...store.services.values()]
    .filter((record) => !ownerKey || record.manifest?.registration?.owner?.user_key === ownerKey);
  const services = records.map((record) => {
    const trust = summarizeTrust(record);
    const publicRecord = publicServiceRecord(record);
    return {
      service_id: record.manifest.service_id,
      title: record.manifest.title,
      provider_id: record.manifest.provider.provider_id,
      capabilities: record.manifest.capabilities || [],
      price: record.manifest.pricing?.amount || "0",
      currency: record.manifest.pricing?.currency || "USDC",
      verification_status: record.verification_status,
      feedback_event_count: trust.feedback_count,
      total_calls: trust.operational_feedback_count,
      consumer_feedback_count: trust.consumer_feedback_count,
      trust_score: trust.feedback_state === "no_feedback_yet" ? null : trust.trust_score,
      trust_score_confidence: trust.trust_score_confidence,
      feedback_state: trust.feedback_state,
      success_rate: trust.success_rate,
      average_latency_ms: trust.average_latency_ms,
      estimated_revenue: Number((Number(record.manifest.pricing?.amount || 0) * trust.operational_feedback_count).toFixed(8)),
      created_at: record.created_at || null,
      updated_at: record.updated_at || null,
      source_provenance_level: summarizeProvenance(record).source_provenance_level,
      health_status: summarizeHealth(record).status,
      reputation: publicReputation(record, trust),
      erc8004: publicErc8004(record),
      badges: publicRecord.badges
    };
  });
  const calls = canonicalOperationalFeedback(store);
  return {
    stats_version: "agent_router_registry_stats_v1",
    metric_scope: {
      total_calls: ownerKey ? "registered services owned by this account" : "all canonical AgentRouter calls, including built-in external and local connectors",
      total_registered_service_calls: "calls attached to registered provider services",
      services: "compact per-service summaries; use the service detail endpoint for evidence and validation records"
    },
    registered_services: services.length,
    verified_services: services.filter((service) => service.verification_status === "verified").length,
    total_calls: ownerKey ? services.reduce((sum, service) => sum + service.total_calls, 0) : calls.length,
    total_registered_service_calls: services.reduce((sum, service) => sum + service.total_calls, 0),
    total_feedback_events: ownerKey ? services.reduce((sum, service) => sum + service.feedback_event_count, 0) : (store.feedbackEvents || []).length,
    total_consumer_feedback: services.reduce((sum, service) => sum + service.consumer_feedback_count, 0),
    estimated_revenue: Number(services.reduce((sum, service) => sum + Number(service.estimated_revenue || 0), 0).toFixed(8)),
    providers: summarizeProviders(services),
    route_observations: store.routeObservations?.length || 0,
    quote_feedback_events: store.quoteFeedbackEvents?.length || 0,
    evidence_events: store.evidenceEvents?.length || 0,
    feedback_delivery: feedbackDeliveryMetrics(store),
    services
  };
}

export function feedbackDeliveryMetrics(store) {
  const calls = canonicalOperationalFeedback(store);
  const states = new Map();
  for (const event of store.feedbackEvents || []) {
    const key = `${event.service_id || ""}:${event.request_id || ""}`;
    const state = event.consumer_feedback_trust_anchor?.state || event.trust_anchor?.state;
    if (state) states.set(key, state);
  }
  const received = calls.filter((event) => Boolean(event.consumer_feedback)).length;
  const countState = (state) => [...states.values()].filter((value) => value === state).length;
  return {
    expected: calls.length,
    received,
    completion_rate: calls.length ? Number((received / calls.length).toFixed(2)) : null,
    onchain_submitted: countState("onchain_submitted"),
    onchain_pending: countState("onchain_pending"),
    onchain_failed: countState("onchain_failed"),
    offchain_recorded: countState("offchain_recorded")
  };
}

export function summarizeHomeStats(store) {
  const records = [...store.services.values()];
  const services = records.map((record) => publicServiceSummary(record));
  const serviceById = new Map(services.map((service) => [service.service_id, service]));
  const calls = canonicalOperationalFeedback(store);
  const featured = [...services]
    .sort((a, b) => Number(b.trust_score || 0) + Number(b.total_calls || 0) - Number(a.trust_score || 0) - Number(a.total_calls || 0))
    .slice(0, 8);
  const recentCalls = [...calls]
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 8);
  const recentCallSummaries = recentCalls.map((event) => {
    const service = serviceById.get(event.service_id);
    return {
      service_id: event.service_id,
      title: service?.title || readableServiceId(event.service_id),
      provider_id: event.provider_id || service?.provider_id || "provider",
      status: event.status || "unknown",
      schema_valid: event.schema_valid ?? null,
      latency_ms: typeof event.latency_ms === "number" ? event.latency_ms : null,
      called_at: event.created_at || null
    };
  });
  return {
    stats_version: "agent_router_home_stats_v2",
    metric_scope: "all canonical AgentRouter calls, matching /agent-router/stats total_calls",
    generated_at: new Date().toISOString(),
    registered_services: services.length,
    verified_services: services.filter((service) => service.verification_status === "verified").length,
    total_calls: calls.length,
    total_feedback_events: (store.feedbackEvents || []).length || records.reduce((sum, record) => sum + (record.feedback_events || []).length, 0),
    total_consumer_feedback: services.reduce((sum, service) => sum + Number(service.consumer_feedback_count || 0), 0),
    rated_services_count: services.filter((service) => service.reputation?.has_agent_ratings).length,
    featured_services: featured,
    recent_calls: recentCallSummaries,
    services: featured
  };
}

const OPERATIONAL_FEEDBACK_VERSIONS = new Set([
  "agent_service_feedback_v1",
  "agent_external_api_feedback_v1",
  "agent_local_connector_feedback_v1"
]);

function canonicalOperationalFeedback(store) {
  const globalEvents = (store.feedbackEvents || []).filter((event) =>
    OPERATIONAL_FEEDBACK_VERSIONS.has(event.event_version) && event.status !== "consumer_feedback_only"
  );
  const registeredEvents = [...store.services.values()].flatMap((record) =>
    (record.feedback_events || []).filter((event) => event.status !== "consumer_feedback_only")
  );
  const calls = new Map();
  for (const event of [...registeredEvents, ...globalEvents]) {
    const key = event.request_id
      ? `${event.service_id || ""}:${event.request_id}`
      : `${event.service_id || ""}:${event.created_at || ""}:${event.payment_tx || ""}`;
    if (!calls.has(key)) calls.set(key, { ...event });
    else Object.assign(calls.get(key), event);
  }
  return [...calls.values()];
}

function readableServiceId(serviceId) {
  return String(serviceId || "service")
    .replace(/^external_api_/, "")
    .replace(/^local_social_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function listServiceSummaries(store, {
  query = "",
  capabilities = [],
  maxPrice,
  verifiedOnly = false,
  category = "All",
  pack = "",
  sort = "relevance",
  limit = 24,
  offset = 0
} = {}) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const normalizedCategory = String(category || "All");
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 24));
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const services = [];

  for (const record of store.services.values()) {
    if (verifiedOnly && record.verification_status !== "verified") continue;
    const manifest = record.manifest;
    if (max != null && Number(manifest.pricing?.amount || 0) > max) continue;
    if (capabilities.length && !capabilities.every((capability) => (manifest.capabilities || []).includes(capability))) continue;
    if (pack && !serviceMatchesCapabilityPack(manifest, pack)) continue;
    if (!serviceCategoryMatches(manifest, normalizedCategory)) continue;

    const match = serviceSummaryMatch(manifest, terms);
    if (terms.length && match.score === 0) continue;

    services.push({
      ...publicServiceSummary(record),
      match_score: terms.length ? match.score / (terms.length * 4) : 1,
      match_reasons: match.reasons
    });
  }

  services.sort((a, b) => compareServiceSummaries(a, b, sort));
  return {
    service_list_version: "agent_router_service_list_v2",
    total: services.length,
    limit: boundedLimit,
    offset: boundedOffset,
    has_more: boundedOffset + boundedLimit < services.length,
    services: services.slice(boundedOffset, boundedOffset + boundedLimit)
  };
}

const AGENT_HUB_CATEGORIES = ["Data", "Crypto", "Market Data", "On-chain", "Derivatives", "Wallet"];

export function listServiceCategoryCounts(store) {
  const counts = new Map();
  for (const record of store.services.values()) {
    const category = servicePrimaryCategory(record.manifest);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const categories = [
    ...AGENT_HUB_CATEGORIES,
    ...[...counts.keys()].filter((category) => !AGENT_HUB_CATEGORIES.includes(category)).sort()
  ];
  return categories
    .map((category) => ({ category, count: counts.get(category) || 0 }))
    .filter((entry) => entry.count > 0);
}

export function publicServiceSummary(record) {
  const trust = summarizeTrust(record);
  const health = summarizeHealth(record);
  const displayTitle = displayTitleForRecord(record);
  return {
    service_id: record.manifest.service_id,
    title: displayTitle,
    raw_title: record.manifest.title,
    description_for_agent: record.manifest.description_for_agent,
    provider_id: record.manifest.provider.provider_id,
    capabilities: record.manifest.capabilities || [],
    price: record.manifest.pricing?.amount || "0",
    currency: record.manifest.pricing?.currency || "USDC",
    verification_status: record.verification_status,
    total_calls: trust.operational_feedback_count,
    consumer_feedback_count: trust.consumer_feedback_count,
    trust_score: trust.feedback_state === "no_feedback_yet" ? null : trust.trust_score,
    trust_score_confidence: trust.trust_score_confidence,
    feedback_state: trust.feedback_state,
    success_rate: trust.success_rate,
    average_latency_ms: trust.average_latency_ms,
    estimated_revenue: Number((Number(record.manifest.pricing?.amount || 0) * trust.operational_feedback_count).toFixed(8)),
    health_status: health.status,
    source_provenance_level: summarizeProvenance(record).source_provenance_level,
    reputation: publicReputation(record, trust, health),
    erc8004: publicErc8004(record),
    erc8004_status: publicErc8004Status(record),
    created_at: record.created_at || null,
    updated_at: record.updated_at || null
  };
}

// Buyer-facing reputation. Rates are meaningless without the sample they came
// from — one happy call is not a 100% service — so the count travels with them,
// and a service with no feedback says so instead of showing a flattering
// default. Aggregates only: never buyer identity or the queries they ran.
// On-chain identity for the card. A service can advertise ERC-8004 support and
// still not be registered, so this is null until an agentId actually exists —
// a badge for an unminted identity would be a claim we cannot back.
export function publicErc8004(record) {
  const registration = record?.manifest?.registration?.erc8004;
  const agentId = registration?.agent_id || record?.manifest?.provider?.erc8004_agent_id || null;
  if (!agentId) return null;
  const chain = registration?.network || settlementChain().network;
  if (chain !== settlementChain().network) return null;
  return {
    agent_id: String(agentId),
    chain,
    chain_id: registration?.chain_id || settlementChain().id,
    registry: registration?.identity_registry || erc8004Registries(chain).identityRegistry,
    // Null off BSC: 8004scan indexes nothing else, and a link that 404s is
    // worse than no link.
    explorer_url: erc8004ExplorerUrl(String(agentId), chain)
  };
}

export function publicErc8004Status(record) {
  const registration = record?.manifest?.registration?.erc8004;
  const agentId = registration?.agent_id || record?.manifest?.provider?.erc8004_agent_id || null;
  const activeChain = settlementChain().network;
  const registeredChain = registration?.network || (agentId ? activeChain : null);
  if (!agentId) {
    return { state: "not_registered", active_chain: activeChain, registered_chain: null, agent_id: null };
  }
  if (registeredChain !== activeChain) {
    return {
      state: "legacy_other_chain",
      active_chain: activeChain,
      registered_chain: registeredChain,
      agent_id: String(agentId)
    };
  }
  return {
    state: registration?.status === "submitted" ? "submitted" : "registered",
    active_chain: activeChain,
    registered_chain: registeredChain,
    agent_id: String(agentId)
  };
}

export function publicReputation(record, trust = null, health = null) {
  const resolvedTrust = trust || summarizeTrust(record);
  const resolvedHealth = health || (record?.manifest ? summarizeHealth(record) : { status: "unknown", circuit_breaker: null });
  const sampleSize = resolvedTrust.consumer_feedback_count || 0;
  const callCount = resolvedTrust.operational_feedback_count || 0;
  const quarantine = resolvedHealth.circuit_breaker?.active
    ? { active: true, reason: resolvedHealth.circuit_breaker.reason || null }
    : { active: false, reason: null };
  const successPct = resolvedTrust.success_rate == null ? null : Math.round(resolvedTrust.success_rate * 100);
  // Two different things get called "feedback": agents rating a result, and the
  // calls themselves succeeding or failing. A service with calls but no ratings
  // has a real track record, so report it rather than claiming nothing is known.
  const display = sampleSize
    ? `${Math.round((resolvedTrust.intent_fit_rate ?? 0) * 100)}% intent fit (${sampleSize} rating${sampleSize === 1 ? "" : "s"})`
    : callCount
      ? `${successPct == null ? "--" : `${successPct}%`} success (${callCount} call${callCount === 1 ? "" : "s"}) · no agent ratings yet`
      : "No calls yet";
  return {
    has_feedback: sampleSize > 0 || callCount > 0,
    has_agent_ratings: sampleSize > 0,
    sample_size: sampleSize,
    intent_fit_rate: sampleSize ? resolvedTrust.intent_fit_rate : null,
    usefulness_rate: sampleSize ? resolvedTrust.usefulness_rate : null,
    average_consumer_score: sampleSize ? resolvedTrust.average_consumer_score : null,
    call_count: callCount,
    success_rate: resolvedTrust.success_rate,
    recent_failure_rate: resolvedTrust.recent_failure_rate,
    health_status: resolvedHealth.status,
    quarantined: quarantine.active,
    quarantine_reason: quarantine.reason,
    last_updated: record?.updated_at || record?.created_at || null,
    display
  };
}


function displayTitleForRecord(record) {
  const manifest = record.manifest || {};
  const derived = displayTitleFromServiceId(manifest.service_id);
  const title = cleanDisplayTitle(manifest.title);
  if (derived && shouldPreferDerivedDisplayTitle(title, manifest.service_id, derived)) return derived;
  return title || derived || manifest.service_id;
}

function cleanDisplayTitle(value) {
  return String(value || "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldPreferDerivedDisplayTitle(title, serviceId, derived) {
  const value = String(title || "").toLowerCase();
  const id = String(serviceId || "").toLowerCase();
  if (!value) return true;
  if (value.length < 4) return true;
  if (/^(\(?up to \d+\)?|\(?no pagination\)?|request example\b|triggers?\b|copy|responses?|body|parameters?)/i.test(title)) return true;
  if (/^(mportant|ain)$/i.test(title)) return true;
  if (/^(original|important|first-report)$/i.test(title) && /_(newsflash|article)_/.test(id)) return true;
  if (/_(article|newsflash)_[a-z0-9]+$/.test(id) && /^all (articles|newsflashes)$/i.test(title)) return true;
  if (/^get v\d+ /.test(value)) return true;
  return false;
}

function displayTitleFromServiceId(serviceId) {
  const id = String(serviceId || "").toLowerCase();
  const methodPrefix = id.match(/^(get|post|put|patch)_(.+)$/);
  if (!methodPrefix) return "";
  const parts = methodPrefix[2].split("_").filter(Boolean).filter((part) => !/^api$/.test(part) && !/^v\d+$/.test(part));
  if (!parts.length) return "";
  const [head, ...rest] = parts;
  if (head === "article") return displayTitleForArticle(rest);
  if (head === "newsflash") return displayTitleForNewsflash(rest);
  if (head === "search") return "Search articles and news";
  if (head === "data" && rest.length) return `${titleCaseEndpointWords(rest)} data`;
  return "";
}

function displayTitleForArticle(parts) {
  const key = parts.join("_");
  if (!key) return "All articles";
  if (key === "24h") return "Articles from last 24h";
  if (key === "important") return "Important articles";
  if (key === "original") return "Original articles";
  return `${titleCaseEndpointWords(parts)} articles`;
}

function displayTitleForNewsflash(parts) {
  const key = parts.join("_");
  if (!key) return "All newsflashes";
  if (key === "24h") return "Newsflashes from last 24h";
  if (key === "important") return "Important newsflashes";
  if (key === "first") return "First important newsflash";
  if (key === "onchain") return "On-chain newsflashes";
  if (key === "financing") return "Financing newsflashes";
  if (key === "prediction") return "Prediction market newsflashes";
  if (key === "original") return "Original newsflashes";
  if (key === "ai") return "AI newsflashes";
  return `${titleCaseEndpointWords(parts)} newsflashes`;
}

function titleCaseEndpointWords(parts) {
  return parts
    .flatMap((part) => String(part).split(/[-_]+/))
    .filter(Boolean)
    .map(endpointWord)
    .join(" ");
}

function endpointWord(word) {
  const upper = new Set(["ai", "api", "aum", "btc", "dxy", "eth", "etf", "fbtc", "ibit", "m2", "pnl", "us", "usd"]);
  const normalized = String(word || "").toLowerCase();
  if (/^top\d+$/.test(normalized)) return `Top ${normalized.slice(3)}`;
  if (/^\d+h$/.test(normalized)) return normalized;
  if (upper.has(normalized)) return normalized.toUpperCase();
  return normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : normalized;
}

function compareServiceSummaries(a, b, sort) {
  if (sort === "calls") return Number(b.total_calls || 0) - Number(a.total_calls || 0);
  if (sort === "trust") return Number(b.trust_score || 0) - Number(a.trust_score || 0);
  if (sort === "price") return Number(a.price || 0) - Number(b.price || 0);
  return (
    Number(b.match_score || 0) - Number(a.match_score || 0) ||
    Number(b.trust_score || 0) - Number(a.trust_score || 0) ||
    Number(b.total_calls || 0) - Number(a.total_calls || 0)
  );
}

function serviceSummaryMatch(manifest, terms) {
  if (!terms.length) return { score: 1, reasons: [] };
  const fields = [
    ["service ID", String(manifest.service_id || "").toLowerCase(), 4],
    ["title", String(manifest.title || "").toLowerCase(), 4],
    ["capability", (manifest.capabilities || []).join(" ").toLowerCase(), 3],
    ["description", String(manifest.description_for_agent || "").toLowerCase(), 1],
    ["contract", [manifest.agent_contract?.summary, manifest.agent_contract?.request_shape_summary, manifest.agent_contract?.response_shape_summary].join(" ").toLowerCase(), 1]
  ];
  let score = 0;
  const reasons = new Set();
  for (const term of terms) {
    const matches = fields.filter(([, value]) => value.includes(term));
    if (!matches.length) continue;
    const best = matches.sort((left, right) => right[2] - left[2])[0];
    score += best[2];
    reasons.add(best[0]);
  }
  return { score, reasons: [...reasons] };
}

function serviceCategoryMatches(manifest, category) {
  if (!category || category === "All") return true;
  return servicePrimaryCategory(manifest) === category;
}

function servicePrimaryCategory(manifest) {
  const catalogCategory = publicApiCatalogCategory(manifest);
  if (catalogCategory) return catalogCategory;
  const text = [manifest.title, manifest.description_for_agent, ...(manifest.capabilities || [])].join(" ").toLowerCase();
  if (/derivative|perp|liquidation|funding|options/.test(text)) return "Derivatives";
  if (/wallet|address|profiler/.test(text)) return "Wallet";
  if (/onchain|chain|fund[_\s-]?flow|smart[_\s-]?money/.test(text)) return "On-chain";
  if (/market|price|etf|ohlcv/.test(text)) return "Market Data";
  if (/crypto|btc|eth|nansen/.test(text)) return "Crypto";
  return "Data";
}

function publicApiCatalogCategory(manifest) {
  const provenance = manifest.source_provenance || {};
  const sourceType = provenance.source_type || manifest.source_type;
  const category = provenance.catalog_category || manifest.catalog_category || manifest.public_api_category;
  return sourceType === "public_api_catalog" && String(category || "").trim()
    ? String(category).trim()
    : null;
}

function summarizeProviders(services) {
  const providers = new Map();
  for (const service of services) {
    const provider = providers.get(service.provider_id) || {
      provider_id: service.provider_id,
      service_count: 0,
      verified_services: 0,
      total_calls: 0,
      estimated_revenue: 0,
      average_trust_score: 0
    };
    provider.service_count += 1;
    if (service.verification_status === "verified") provider.verified_services += 1;
    provider.total_calls += Number(service.total_calls || 0);
    provider.estimated_revenue += Number(service.estimated_revenue || 0);
    provider.average_trust_score += Number(service.trust_score || 0);
    providers.set(service.provider_id, provider);
  }
  return [...providers.values()].map((provider) => ({
    ...provider,
    estimated_revenue: Number(provider.estimated_revenue.toFixed(8)),
    average_trust_score: provider.service_count
      ? Number((provider.average_trust_score / provider.service_count).toFixed(4))
      : 0
  }));
}

function inferProvenanceLevel(claim = {}) {
  if (claim.source_provenance_level) return claim.source_provenance_level;
  if (claim.authorization_status === "official_verified") return "official_verified";
  if (claim.authorization_status === "provider_owned") return "provider_owned";
  if (claim.authorization_status === "authorized_reseller") return "authorized_reseller";
  if (/scrap|crawl/i.test(claim.source_type || "")) return "scraped";
  if (claim.source_type === "static_dataset") return "provider_owned";
  if (claim.source_type === "provider_declared_data_service" || claim.source_type === "api_wrapper") return "wrapped_api";
  return "unknown";
}

function summarizeShape(value) {
  if (Array.isArray(value)) return `array(${value.length} sample items)`;
  if (value && typeof value === "object") return `object keys: ${Object.keys(value).slice(0, 12).join(", ") || "none"}`;
  return typeof value;
}

function collectFieldPaths(value, limit = 16, prefix = "") {
  if (limit <= 0) return [];
  if (Array.isArray(value)) return value.length ? collectFieldPaths(value[0], limit, prefix) : [];
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (paths.length >= limit) break;
    if (child && typeof child === "object") {
      for (const nested of collectFieldPaths(child, limit - paths.length, path)) {
        paths.push(nested);
        if (paths.length >= limit) break;
      }
    }
    if (paths.length >= limit) break;
  }
  return paths;
}

function latencyScore(averageLatencyMs) {
  if (averageLatencyMs == null) return 0.8;
  if (averageLatencyMs <= 250) return 1;
  if (averageLatencyMs <= 1000) return 0.75;
  if (averageLatencyMs <= 3000) return 0.45;
  return 0.2;
}
