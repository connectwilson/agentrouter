import crypto from "node:crypto";
import { getExternalApiCatalog } from "../external-api-capability.js";
import { writePersistentServiceEvent } from "../persistence.js";
import { recordRouteObservationV2 } from "./metrics.js";
import { inferRoutePlan, inferStructuredBatchRoutePlan, inferStructuredRoutePlan } from "./planner.js";
import { rankCandidates } from "../router.js";

export function canonicalRoutePlan(store, task, {
  ownerKey = "",
  maxPrice = "0.05",
  localBrowserSessions = [],
  budgetExplicit = false
} = {}) {
  const sourceCatalog = getExternalApiCatalog(store, ownerKey);
  const connectedSources = sourceCatalog
    .filter((source) => source.connected === true)
    .map((source) => source.source);
  const sourceSignals = Object.fromEntries(sourceCatalog.map((source) => [source.source, {
    routing_trust_score: source.trust?.routing_trust_score ?? null,
    trust_score_confidence: source.trust?.trust_score_confidence ?? 0,
    recent_failure_rate: source.trust?.recent_failure_rate ?? null
  }]));
  return inferRoutePlan(task, {
    agentrouter_authenticated: Boolean(ownerKey),
    connected_sources: connectedSources,
    local_browser_sessions: localBrowserSessions,
    source_signals: sourceSignals,
    registered_capability_available: registeredCapabilityAvailable(store),
    constraints: { max_price_usdc: maxPrice },
    require_price_upper_bound: budgetExplicit
  });
}

export function requestHasExplicitBudget(request = {}) {
  return Object.hasOwn(request, "max_price")
    || Object.hasOwn(request, "maxPrice")
    || Object.hasOwn(request.constraints || {}, "max_price_usdc")
    || Object.hasOwn(request.budget || {}, "max_amount");
}

export function canonicalStructuredRoutePlan(store, request = {}, {
  ownerKey = "",
  budgetExplicit = requestHasExplicitBudget(request)
} = {}) {
  return inferStructuredRoutePlan(request, canonicalStructuredRouteContext(store, request, ownerKey, { budgetExplicit }));
}

export function canonicalStructuredBatchRoutePlan(store, requests = [], {
  ownerKey = "",
  budgetExplicit = requests.some((request) => requestHasExplicitBudget(request))
} = {}) {
  const representative = requests[0] || {};
  return inferStructuredBatchRoutePlan(
    requests,
    canonicalStructuredRouteContext(store, representative, ownerKey, { budgetExplicit })
  );
}

function canonicalStructuredRouteContext(store, request, ownerKey, { budgetExplicit = requestHasExplicitBudget(request) } = {}) {
  const connectedSources = getExternalApiCatalog(store, ownerKey)
    .filter((source) => source.connected === true)
    .map((source) => source.source);
  const requestedSources = [
    request.params?.source,
    request.params?.platform,
    ...(Array.isArray(request.params?.sources) ? request.params.sources : []),
    ...(Array.isArray(request.params?.platforms) ? request.params.platforms : [])
  ].map((source) => String(source || "").trim().toLowerCase()).filter(Boolean);
  const localBrowser = request.consumer_context?.local_browser;
  const localBrowserSessions = localBrowser?.available === true ? [...new Set(requestedSources)] : [];
  return {
    agentrouter_authenticated: Boolean(ownerKey),
    connected_sources: connectedSources,
    local_browser_sessions: localBrowserSessions,
    registered_capability_available: registeredCapabilityAvailable(store),
    require_price_upper_bound: budgetExplicit,
    constraints: {
      max_price_usdc: request.constraints?.max_price_usdc
        ?? request.budget?.max_amount
        ?? "0.05"
    }
  };
}

function registeredCapabilityAvailable(store) {
  return (capability, params = {}) => rankCandidates(store, {
    capability,
    ...(params && typeof params === "object" ? params : {})
  }).length > 0;
}

export function structuredRoutePreflight(plan) {
  if (plan?.abstain_reason === "capability_not_available") {
    return {
      ok: false,
      status: "capability_not_available",
      capability: plan.capability || null,
      execution_available: false,
      must_not_execute: true,
      must_not_request_payment_authorization: true,
      fallback_allowed: false,
      error: {
        code: "CAPABILITY_NOT_AVAILABLE",
        message: `${plan.capability || "The requested capability"} has no verified callable AgentRouter service yet.`
      }
    };
  }
  if (["source_not_callable", "unsupported_source"].includes(plan?.abstain_reason)) {
    const source = plan.source_constraint || plan.candidate_sources?.[0] || null;
    const unsupported = plan.abstain_reason === "unsupported_source";
    return {
      ok: false,
      status: plan.abstain_reason,
      must_not_execute: true,
      source,
      error: {
        code: unsupported ? "UNSUPPORTED_SOURCE" : "SOURCE_NOT_CALLABLE",
        message: unsupported
          ? `${source || "The requested source"} is not supported by AgentRouter.`
          : `${source || "The requested source"} is known to AgentRouter but has no callable connector yet.`
      }
    };
  }
  if (plan?.route_family === "local_browser") return localBrowserRouteRequired(plan);
  if (plan?.capability !== "external_api_query") return null;
  if (!["budget_exceeded", "price_unknown"].includes(plan.abstain_reason)) return null;
  return {
    ok: false,
    status: "quote_required",
    must_not_execute: true,
    source: plan.source_constraint || plan.candidate_sources?.[0] || null,
    quote_requirement: {
      reason: plan.abstain_reason,
      max_price_usdc: plan.budget_gate?.max_price_usdc ?? null,
      estimated_price_usdc: plan.estimated_price_usdc ?? null,
      requires_proven_upper_bound: true
    },
    error: {
      code: plan.abstain_reason === "price_unknown" ? "EXTERNAL_API_PRICE_UNKNOWN" : "EXTERNAL_API_BUDGET_TOO_LOW",
      message: plan.abstain_reason === "price_unknown"
        ? "This source has no provable per-call price upper bound. Obtain a bounded quote before executing it."
        : "The source's known minimum call price exceeds the request budget. Obtain an acceptable quote before executing it."
    }
  };
}

export async function attachCanonicalRouteObservation(store, result, {
  plan,
  entrypoint,
  actorKey = "",
  writeEvent = writePersistentServiceEvent
} = {}) {
  if (!plan) return result;
  const effectivePlan = reconcileCanonicalPlan(plan, result);
  const requestId = canonicalRouteRequestId(result);
  const observationId = `route_obs_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const candidates = canonicalRouteCandidates(effectivePlan, result);
  const action = canonicalRouteAction(effectivePlan, result);
  const selectedServiceId = action === "route"
    ? result?.selected_service?.service_id
      || result?.selected_service_id
      || candidates[0]?.service_id
      || null
    : null;
  const selectedPrice = canonicalSelectedPrice(effectivePlan, result);
  const maxPrice = Number(effectivePlan.budget_gate?.max_price_usdc);
  const budgetCompliant = effectivePlan.budget_gate?.status === "blocked"
    ? false
    : selectedPrice == null || !Number.isFinite(maxPrice)
      ? null
      : selectedPrice <= maxPrice;
  try {
    const observation = await recordRouteObservationV2(store, {
      observation_id: observationId,
      request_id: requestId,
      created_at: new Date().toISOString(),
      entrypoint,
      task_family: effectivePlan.task_family,
      route_family: effectivePlan.route_family,
      capability: effectivePlan.capability,
      source_family: canonicalSourceFamily(effectivePlan),
      action,
      candidates,
      selected_service_id: selectedServiceId,
      confidence: effectivePlan.confidence,
      fallback: canonicalFallback(result),
      authorization: {
        required: effectivePlan.auth_requirement?.required === true,
        action: canonicalAuthorizationAction(effectivePlan.auth_requirement),
        source: effectivePlan.auth_requirement?.source || null
      },
      budget: {
        max_price_usdc: effectivePlan.budget_gate?.max_price_usdc ?? null,
        selected_price_usdc: selectedPrice == null ? null : String(selectedPrice),
        compliant: budgetCompliant
      },
      actor_key: actorKey || null,
      routing_policy_version: effectivePlan.schema_version,
      diagnostics: {
        intent_confidence: effectivePlan.confidence,
        candidate_count: candidates.length,
        eligible_candidate_count: candidates.length,
        abstain_reason: effectivePlan.abstain_reason,
        policy_gate: effectivePlan.budget_gate?.status
      }
    }, { writeEvent });
    return {
      ...result,
      route_plan: effectivePlan,
      routing_observation: {
        observation_id: observation.observation_id,
        request_id: observation.request_id,
        action: observation.action,
        route_family: observation.route_family,
        capability: observation.capability,
        durability_status: observation.durability_status,
        feedback_endpoint: actorKey ? "/agent-router/routing-feedback" : null
      }
    };
  } catch (error) {
    console.error("[routing-observation] degraded", JSON.stringify({
      entrypoint,
      code: safeRoutingDiagnosticToken(error?.code, "ROUTING_OBSERVATION_WRITE_FAILED")
    }));
    return {
      ...result,
      route_plan: effectivePlan,
      routing_observation: {
        observation_id: observationId,
        request_id: requestId,
        action,
        route_family: effectivePlan.route_family,
        capability: effectivePlan.capability,
        durability_status: "degraded",
        feedback_endpoint: null
      }
    };
  }
}

function reconcileCanonicalPlan(plan, result) {
  if (!result || typeof result !== "object") return plan;
  if (plan.capability === "social_post_read"
    && result.ok === true
    && result.status === "completed"
    && result.source?.backend_id) {
    const backendId = String(result.source.backend_id);
    return {
      ...plan,
      task_family: "social_post_read",
      data_family: "public_social_post",
      route_family: "external_api",
      capability: "social_post_read",
      source_constraint: result.request?.params?.platform || plan.source_constraint || "x",
      provider_constraint: null,
      candidate_sources: [backendId],
      candidate_scores: [{
        source: backendId,
        rank: 1,
        routing_score: 1,
        semantic_fit: 1,
        routing_trust_score: null,
        trust_score_confidence: 0,
        recent_failure_rate: null,
        estimated_price_usdc: null,
        connected: true,
        key_free: false
      }],
      params: { ...(result.request?.params || plan.params) },
      estimated_price_usdc: null,
      confidence: 1,
      top1_top2_margin: 1,
      auth_requirement: { required: false, kind: "none", source: null },
      abstain_reason: null,
      must_not_fallback: true
    };
  }
  if (["needs_clarification", "clarification_required"].includes(result.status)) {
    return {
      ...plan,
      task_family: "clarification",
      data_family: "unknown",
      route_family: "none",
      capability: null,
      source_constraint: null,
      provider_constraint: null,
      candidate_sources: [],
      params: {},
      confidence: Math.min(Number(plan.confidence) || 0.5, 0.5),
      top1_top2_margin: 0,
      auth_requirement: { required: false, kind: "none", source: null },
      abstain_reason: "insufficient_context",
      must_not_fallback: true
    };
  }
  const selectedService = result.selected_service;
  if (!selectedService?.service_id) return plan;
  return {
    ...plan,
    task_family: plan.task_family === "reasoning" ? "registered_capability" : plan.task_family,
    data_family: "registered_service_data",
    route_family: "registered_service",
    capability: result.request?.capability || result.capability || plan.capability,
    source_constraint: null,
    provider_constraint: null,
    candidate_sources: ["agentrouter_registry"],
    // Keep the semantic request in the route plan. Provider-ready input lives
    // separately on the result and may contain schema defaults/placeholders
    // (for example a zero token_address before local token resolution). Using
    // it here used to erase token_symbol and bypass the resolver/retry path.
    params: plan.params && typeof plan.params === "object"
      ? { ...plan.params }
      : result.input && typeof result.input === "object"
        ? { ...result.input }
        : {},
    auth_requirement: { required: false, kind: "none", source: null },
    abstain_reason: null,
    must_not_fallback: true
  };
}

function canonicalRouteCandidates(plan, result) {
  const sourceFamily = canonicalSourceFamily(plan);
  const resultCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (resultCandidates.length) {
    return resultCandidates.slice(0, 10).map((candidate) => ({
      service_id: candidate.service_id,
      source_family: sourceFamily,
      routing_score: candidate.routing_score,
      price_usdc: candidate.pricing?.amount ?? candidate.price_usdc ?? null
    }));
  }
  if (Array.isArray(plan.candidate_scores) && plan.candidate_scores.length) {
    return plan.candidate_scores.slice(0, 10).map((candidate) => ({
      service_id: candidate.source,
      source_family: sourceFamily,
      routing_score: candidate.routing_score,
      price_usdc: candidate.estimated_price_usdc
    }));
  }
  return (plan.candidate_sources || []).slice(0, 10).map((source, index) => ({
    service_id: source,
    source_family: sourceFamily,
    routing_score: Math.max(0, Number(plan.confidence || 0) - (index === 0 ? 0 : Number(plan.top1_top2_margin || 0) + (index - 1) * 0.05)),
    price_usdc: index === 0 && plan.estimated_price_usdc != null ? String(plan.estimated_price_usdc) : null
  }));
}

function canonicalSourceFamily(plan) {
  if (plan.route_family === "local_browser") return "local_browser";
  if (plan.route_family === "registered_service") return "service_marketplace";
  if (plan.data_family === "current_web") return "web_search";
  if (plan.data_family === "scholarly_metadata") return "academic";
  if (String(plan.data_family || "").startsWith("public_social")) return "social";
  return plan.data_family || plan.route_family || "none";
}

function canonicalRouteAction(plan, result) {
  if (plan.abstain_reason === "insufficient_context") return "clarify";
  if (plan.abstain_reason) return ["budget_exceeded", "price_unknown", "unsupported_source", "source_not_callable", "capability_not_available"].includes(plan.abstain_reason)
    ? "no_match"
    : "abstain";
  if (plan.auth_requirement?.required) return canonicalAuthorizationAction(plan.auth_requirement);
  if (plan.route_family === "local_browser" || result?.status === "local_browser_handoff_required") return "browser_handoff";
  if (["source_credentials_required", "connection_required"].includes(result?.status)) return "connect_source";
  if (result?.status === "no_service_found" && result?.handoff?.kind === "agentrouter_route") return "route";
  if (["no_match", "no_service_found"].includes(result?.status)) return "no_match";
  return "route";
}

function canonicalAuthorizationAction(requirement = {}) {
  if (!requirement.required) return "none";
  if (requirement.kind === "local_browser_session") return "browser_handoff";
  if (requirement.kind === "agentrouter_account") return "connect_account";
  return "connect_source";
}

function canonicalRouteRequestId(result) {
  return result?.result?.request_id
    || result?.consumer_feedback_request?.request_id
    || result?.results?.find((item) => item?.result?.request_id)?.result?.request_id
    || `route_req_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function canonicalSelectedPrice(plan, result) {
  const value = result?.quote?.price?.amount
    ?? result?.selected_service?.pricing?.amount
    ?? plan.estimated_price_usdc;
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function canonicalFallback(result) {
  const handoff = result?.handoff;
  return {
    used: Boolean(handoff || result?.fallback_used),
    from: handoff ? "primary_route" : null,
    to: handoff?.backend || handoff?.tool || result?.fallback_to || null,
    reason: handoff?.reason || result?.fallback_reason || null
  };
}

export function localBrowserRouteRequired(plan) {
  const source = plan.candidate_sources?.[0] || plan.source_constraint || plan.params?.platform || null;
  const call = {
    capability: plan.capability || "social_search",
    params: {
      ...plan.params,
      ...(source && !plan.params?.platform && !Array.isArray(plan.params?.platforms) ? { platform: source } : {})
    }
  };
  const browserAction = {
    action: "execute_local_browser_handoff",
    preferred_tool: "agentrouter_request",
    authorization_kind: "local_browser_session",
    user_facing_label: source
      ? `Continue to ${source} in your signed-in browser`
      : "Continue in your signed-in browser",
    requires_agentrouter_login: false,
    tool_arguments: call
  };
  return {
    ok: false,
    status: "local_browser_handoff_required",
    action_required: browserAction,
    local_route: call,
    free_alternative: {
      capability: call.capability,
      execution_location: "user_device",
      requires_api_key: false,
      preferred_tool: "agentrouter_request",
      tool_arguments: call,
      call,
      must_not_execute_via_shell: true,
      do_not_fallback_outside_agentrouter: true
    },
    retry_original_request_after_connection: false,
    complete_through_local_bridge: true,
    do_not_fallback_outside_agentrouter: true,
    fallback_allowed: false,
    message: "Use the AgentRouter MCP bridge with the user's signed-in local browser. Do not ask for an API key and do not replace this route with generic web search."
  };
}

function safeRoutingDiagnosticToken(value, fallback) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(token) ? token : fallback;
}
