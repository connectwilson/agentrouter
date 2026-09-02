import crypto from "node:crypto";
import {
  localBrowserSearchHandoffRequest,
  runLocalSocialSearch
} from "./local-social-search.js";

export async function handleLocalStructuredSocialBatchRequest(message, {
  runLocalSearch = runLocalSocialSearch,
  now = () => Date.now()
} = {}) {
  if (message?.method !== "tools/call" || message?.params?.name !== "agentrouter_request") return null;
  const args = message.params?.arguments || {};
  if (String(args.capability || "") !== "social_user_voice_research") return null;
  const params = args.params && typeof args.params === "object" ? args.params : {};
  const requestedPlatforms = normalizeStructuredSocialPlatforms(params.platforms || params.sources);
  const platforms = requestedPlatforms.supported;
  const unavailablePlatforms = requestedPlatforms.unavailable;
  const unsupportedPlatforms = requestedPlatforms.unsupported;
  const query = String(params.query || params.keyword || params.question || params.task || "").trim();
  if (!requestedPlatforms.requested.length || !query) return null;

  const request = {
    capability: "social_user_voice_research",
    params: {
      ...params,
      platforms: requestedPlatforms.requested
    },
    constraints: args.constraints && typeof args.constraints === "object" ? { ...args.constraints } : {},
    budget: args.budget && typeof args.budget === "object" ? { ...args.budget } : {}
  };
  const blockedPlatforms = unavailablePlatforms.length ? unavailablePlatforms : unsupportedPlatforms;
  if (blockedPlatforms.length) {
    const status = unavailablePlatforms.length ? "source_not_callable" : "unsupported_source";
    const routePlan = localStructuredSocialRoutePlan(request, requestedPlatforms.requested, {
      blockedSources: blockedPlatforms,
      abstainReason: status
    });
    const observation = localStructuredSocialObservation({
      now,
      routePlan,
      platforms: requestedPlatforms.requested,
      action: "no_match",
      selectedServiceId: null,
      authorizationSource: null,
      partialFailure: false
    });
    return {
      ok: false,
      status,
      must_not_execute: true,
      source: blockedPlatforms[0],
      request,
      route_plan: routePlan,
      routing_observation: publicLocalObservation(observation),
      result: { items: [], item_count: 0, platforms: requestedPlatforms.requested },
      coverage: {
        completed_platforms: [],
        failed_platforms: blockedPlatforms,
        unavailable_platforms: unavailablePlatforms,
        unsupported_platforms: unsupportedPlatforms,
        empty_platforms: [],
        evidence_platforms: []
      },
      results: [],
      error: {
        code: status === "source_not_callable" ? "SOURCE_NOT_CALLABLE" : "UNSUPPORTED_SOURCE",
        message: `${blockedPlatforms[0]} cannot be called by the local AgentRouter bridge.`
      }
    };
  }
  const routePlan = localStructuredSocialRoutePlan(request, platforms);
  const results = [];
  const operation = String(params.operation || "search").trim().toLowerCase() || "search";
  for (const platform of platforms) {
    const localRequest = {
      platform,
      operation,
      query,
      quality_context: query,
      capability: "social_user_voice_research",
      limit: params.limit,
      handle: params.handle || params.username || params.account,
      from: params.from || params.since,
      to: params.to || params.until,
      entity: params.entity || {
        required_terms: params.required_terms || (params.domain ? [params.domain] : []),
        excluded_terms: params.excluded_terms
      },
      supplement_on_insufficient: true
    };
    const nativeHandoff = localBrowserSearchHandoffRequest(message, localRequest);
    results.push(decorateStandaloneLocalResult(
      nativeHandoff || await runLocalSearch(localRequest),
      { maxPrice: localRequestMaxPrice(request) }
    ));
  }
  const succeeded = results.filter((item) => item?.ok !== false && item?.status !== "auth_required" && item?.status !== "browser_connector_offline" && item?.status !== "local_connector_unavailable");
  const failed = results.filter((item) =>
    item?.ok === false
    || item?.status === "auth_required"
    || item?.status === "browser_connector_offline"
    || item?.status === "local_connector_unavailable"
    || item?.status === "unsupported_platform"
  );
  const items = results.flatMap((item) => Array.isArray(item?.result?.items) ? item.result.items : []);
  const completedPlatforms = succeeded.map((item) => item?.request?.params?.platform).filter(Boolean);
  const failedPlatforms = failed.map((item) => item?.request?.params?.platform).filter(Boolean);
  const emptyPlatforms = succeeded
    .filter((item) => Number(item?.result?.item_count || 0) === 0)
    .map((item) => item?.request?.params?.platform)
    .filter(Boolean);
  const evidencePlatforms = succeeded
    .filter((item) => Number(item?.result?.item_count || 0) > 0)
    .map((item) => item?.request?.params?.platform)
    .filter(Boolean);
  const action = succeeded.length === 0 ? "browser_handoff" : "route";
  const observation = localStructuredSocialObservation({
    now,
    routePlan,
    platforms,
    action,
    selectedServiceId: succeeded[0]?.service_id || null,
    authorizationSource: failedPlatforms[0] || platforms[0] || null,
    partialFailure: failed.length > 0
  });
  return {
    ok: succeeded.length > 0,
    status: succeeded.length === 0
      ? "local_connector_required"
      : failed.length > 0
        ? "partial_data_returned"
        : "completed",
    request,
    route_plan: routePlan,
    routing_observation: publicLocalObservation(observation),
    result: {
      items,
      item_count: items.length,
      platforms
    },
    coverage: {
      completed_platforms: completedPlatforms,
      failed_platforms: failedPlatforms,
      unsupported_platforms: unsupportedPlatforms,
      empty_platforms: emptyPlatforms,
      evidence_platforms: evidencePlatforms
    },
    results
  };
}
function normalizeStructuredSocialPlatforms(value) {
  const aliases = {
    x: "x",
    twitter: "x",
    reddit: "reddit",
    xiaohongshu: "xiaohongshu",
    xhs: "xiaohongshu",
    rednote: "xiaohongshu",
    bilibili: "bilibili",
    bili: "bilibili",
    youtube: "youtube",
    yt: "youtube",
    zhihu: "zhihu",
    weibo: "weibo"
  };
  const knownUnavailable = new Set(["bright_data", "largitdata", "linkedin", "parallel", "socialcrawl"]);
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const requested = [];
  const supported = [];
  const unavailable = [];
  const unsupported = [];
  const seen = new Set();
  for (const item of values) {
    const raw = String(item || "").trim().toLowerCase();
    const normalized = aliases[raw] || null;
    const key = normalized || raw;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requested.push(key);
    if (normalized) supported.push(normalized);
    else if (knownUnavailable.has(raw)) unavailable.push(raw);
    else unsupported.push(raw);
  }
  return { requested, supported, unavailable, unsupported };
}

function localStructuredSocialRoutePlan(request, platforms, {
  blockedSources = [],
  abstainReason = null
} = {}) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  const blockedSet = new Set(blockedSources);
  const candidateScores = platforms.map((source, index) => {
    const blocked = blockedSet.has(source);
    return {
      source,
      rank: index + 1,
      routing_score: Math.max(0.5, Number((1 - index * 0.05).toFixed(4))),
      semantic_fit: 1,
      routing_trust_score: null,
      trust_score_confidence: 0,
      recent_failure_rate: null,
      estimated_price_usdc: blocked ? null : 0,
      connected: !blocked,
      key_free: !blocked
    };
  });
  return {
    schema_version: "agentrouter_route_plan_v1",
    task_family: platforms.length > 1 ? "structured_batch" : "social_research",
    data_family: "public_social_content",
    route_family: abstainReason ? "external_api" : "local_browser",
    capability: "social_user_voice_research",
    source_constraint: blockedSources[0] || null,
    provider_constraint: null,
    candidate_sources: [...platforms],
    candidate_scores: candidateScores,
    params: {
      ...params,
      platforms: [...platforms],
      ...(blockedSources.length ? { blocked_sources: [...blockedSources] } : {})
    },
    estimated_price_usdc: abstainReason ? null : 0,
    confidence: 1,
    top1_top2_margin: candidateScores.length > 1 ? 0.05 : 1,
    auth_requirement: abstainReason
      ? { required: false, kind: "none", source: null }
      : {
          required: true,
          kind: "local_browser_session",
          source: platforms.length === 1 ? platforms[0] : null
        },
    budget_gate: {
      max_price_usdc: localRequestMaxPrice(request),
      paid_calls_allowed: true,
      status: "allowed"
    },
    abstain_reason: abstainReason,
    must_not_fallback: true
  };
}

function localStructuredSocialObservation({
  now,
  routePlan,
  platforms,
  action,
  selectedServiceId,
  authorizationSource,
  partialFailure
}) {
  return {
    observation_id: `route_obs_local_${now()}_${crypto.randomBytes(6).toString("hex")}`,
    request_id: `route_req_local_${now()}_${crypto.randomBytes(6).toString("hex")}`,
    action,
    route_family: routePlan.route_family,
    capability: routePlan.capability,
    durability_status: "memory_only",
    feedback_endpoint: null,
    observation_version: "agent_router_route_observation_v2",
    entrypoint: "mcp_request",
    task_family: routePlan.task_family,
    source_family: "social",
    selected_service_id: selectedServiceId,
    candidates: (routePlan.candidate_scores || []).map((candidate) => ({
      service_id: candidate.source,
      source_family: "local_browser",
      routing_score: candidate.routing_score,
      price_usdc: candidate.estimated_price_usdc
    })),
    confidence: routePlan.confidence,
    fallback: {
      used: partialFailure,
      from: partialFailure ? "local_browser_batch" : null,
      to: null,
      reason: partialFailure ? "partial_platform_failure" : null
    },
    authorization: action === "browser_handoff"
      ? { required: true, action: "browser_handoff", source: authorizationSource }
      : { required: false, action: "none", source: null },
    budget: {
      max_price_usdc: routePlan.budget_gate?.max_price_usdc ?? "0.05",
      selected_price_usdc: "0",
      compliant: true
    },
    routing_policy_version: routePlan.schema_version,
    diagnostics: {
      candidate_count: platforms.length,
      eligible_candidate_count: platforms.length,
      abstain_reason: routePlan.abstain_reason,
      policy_gate: routePlan.budget_gate?.status
    }
  };
}

function publicLocalObservation(observation) {
  return {
    observation_version: observation.observation_version,
    observation_id: observation.observation_id,
    request_id: observation.request_id,
    action: observation.action,
    route_family: observation.route_family,
    capability: observation.capability,
    durability_status: observation.durability_status,
    feedback_endpoint: null
  };
}

export function decorateStandaloneLocalResult(result, { maxPrice = null } = {}) {
  if (!result || typeof result !== "object" || result.route_plan || !result.request?.capability) return result;
  const platform = String(result.request?.params?.platform || "").trim().toLowerCase() || null;
  if (!platform) return result;
  const routePlan = {
    schema_version: "agentrouter_route_plan_v1",
    task_family: result.request.capability === "social_post_read" ? "social_post_read" : "social_research",
    data_family: "public_social_content",
    route_family: "local_browser",
    capability: result.request.capability,
    source_constraint: platform,
    provider_constraint: null,
    candidate_sources: [platform],
    candidate_scores: [{
      source: platform,
      rank: 1,
      routing_score: 1,
      semantic_fit: 1,
      routing_trust_score: null,
      trust_score_confidence: 0,
      recent_failure_rate: null,
      estimated_price_usdc: 0,
      connected: true,
      key_free: true
    }],
    params: { ...(result.request?.params || {}) },
    estimated_price_usdc: 0,
    confidence: 1,
    top1_top2_margin: 1,
    auth_requirement: localResultNeedsBrowser(result)
      ? { required: true, kind: "local_browser_session", source: platform }
      : { required: false, kind: "none", source: null },
    budget_gate: {
      max_price_usdc: maxPrice ?? localRequestMaxPrice(result.request),
      paid_calls_allowed: true,
      status: "allowed"
    },
    abstain_reason: null,
    must_not_fallback: true
  };
  const action = localResultNeedsBrowser(result) ? "browser_handoff" : "route";
  const observation = localStructuredSocialObservation({
    now: () => Date.now(),
    routePlan,
    platforms: [platform],
    action,
    selectedServiceId: action === "route" ? result.service_id || `local_social_${platform}` : null,
    authorizationSource: platform,
    partialFailure: false
  });
  return {
    ...result,
    route_plan: routePlan,
    routing_observation: publicLocalObservation(observation)
  };
}

function localResultNeedsBrowser(result) {
  return ["auth_required", "browser_connector_offline", "local_connector_required", "local_connector_unavailable", "local_connector_runtime_unavailable"].includes(result?.status);
}

function localRequestMaxPrice(request = {}) {
  const constraints = request?.constraints && typeof request.constraints === "object" ? request.constraints : {};
  const budget = request?.budget && typeof request.budget === "object" ? request.budget : {};
  const value = Object.hasOwn(constraints, "max_price_usdc")
    ? constraints.max_price_usdc
    : Object.hasOwn(budget, "max_amount")
      ? budget.max_amount
      : "0.05";
  return String(value);
}

export function localFeedbackRoutingSummary(result) {
  if (!result || typeof result !== "object") return null;
  const routePlan = result.route_plan || null;
  const observation = result.routing_observation || null;
  const platform = String(result.request?.params?.platform || routePlan?.source_constraint || "").trim().toLowerCase() || null;
  const maxPrice = routePlan?.budget_gate?.max_price_usdc ?? "0.05";
  return {
    task_family: routePlan?.task_family || (result.request?.capability === "social_post_read" ? "social_post_read" : "social_research"),
    route_family: routePlan?.route_family || "local_browser",
    capability: routePlan?.capability || result.request?.capability || "social_search",
    source_family: "social",
    action: observation?.action || (localResultNeedsBrowser(result) ? "browser_handoff" : "route"),
    source: platform,
    selected_service_id: result.service_id || (platform ? `local_social_${platform}` : null),
    candidate_sources: platform ? [platform] : [],
    budget: {
      max_price_usdc: maxPrice,
      selected_price_usdc: "0",
      compliant: true
    },
    authorization: localResultNeedsBrowser(result)
      ? { required: true, action: "browser_handoff", source: platform }
      : { required: false, action: "none", source: null }
  };
}
