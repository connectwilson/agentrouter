import { validateBudgetAmount } from "../budget-normalization.js";
import {
  freeLocalAlternative,
  getExternalApiCatalog,
  inferDataRequirement,
  inferExternalApiRequest,
  isTokenHoldersQuery,
  externalApiCoverageError
} from "../external-api-capability.js";
import { findSocialPostUrl } from "../social-post-read.js";
import { inferIntent, intentToCapabilityRequest } from "../agent-router.js";
import { parseHolderTask, validateHolderParams } from "../token-holders.js";

const ROUTE_PLAN_SCHEMA_VERSION = "agentrouter_route_plan_v1";

// Source matching and connection metadata belong to the external API catalog.
// The planner consumes that catalog instead of growing a second list that can
// silently drift from the connectors agents are actually able to call.
const SOURCE_METADATA = new Map(getExternalApiCatalog().map((item) => [item.source, Object.freeze({
  source: item.source,
  title: item.title,
  category: item.category,
  connection_required: item.connection_required,
  authorization_mode: item.authorization_mode,
  implementation_status: item.implementation_status,
  upstream_price: item.upstream_pricing?.amount,
  upstream_pricing_model: item.upstream_pricing?.model || null
})]));
const SOURCE_ALIASES = new Set([...SOURCE_METADATA.values()].flatMap((item) => [item.source, item.title])
  .map(normalizedAlias));

const SOCIAL_AGGREGATORS = new Set(["xpoz", "socialcrawl", "socialdatax", "largitdata"]);
const CRYPTO_MARKET_SYMBOLS = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "XLM", "HYPE", "ADA", "AVAX", "DOT", "LINK", "LTC"
]);

export function inferRoutePlan(task, context = {}) {
  context = {
    ...context,
    require_price_upper_bound: context.require_price_upper_bound
      ?? Object.hasOwn(context.constraints || {}, "max_price_usdc")
  };
  const text = String(task || "").trim();
  const budget = budgetGate(context.constraints || {});

  if (isInsufficientContext(text)) {
    return finalizePlan(routePlan({
      taskFamily: "clarification",
      dataFamily: "unknown",
      confidence: 0.35,
      abstainReason: "insufficient_context",
      mustNotFallback: true,
      budget
    }), context);
  }

  if (isSelfContainedReasoning(text)) {
    return finalizePlan(routePlan({
      taskFamily: "reasoning",
      dataFamily: "none",
      confidence: 0.95,
      abstainReason: "no_external_data_required",
      mustNotFallback: true,
      budget
    }), context);
  }

  const unsupportedSource = unsupportedExplicitApi(text);
  if (unsupportedSource) {
    return finalizePlan(routePlan({
      taskFamily: "lookup",
      dataFamily: "unknown_external_data",
      capability: "external_data_query",
      confidence: 0.95,
      abstainReason: "unsupported_source",
      mustNotFallback: true,
      budget
    }), context);
  }

  const socialPost = findSocialPostUrl(text);
  if (socialPost) {
    return finalizePlan(routePlan({
      taskFamily: "social_post_read",
      dataFamily: "public_social_post",
      routeFamily: "local_browser",
      capability: "social_post_read",
      sourceConstraint: socialPost.platform,
      candidateSources: [socialPost.platform],
      params: { url: socialPost.canonical_url, platform: socialPost.platform, post_id: socialPost.post_id },
      estimatedPriceUsdc: 0,
      confidence: 0.99,
      margin: 0.4,
      mustNotFallback: true,
      budget
    }), context);
  }

  // A transaction receipt, ERC-8004 Agent ID, or feedback-event audit is not
  // a DEX/pool ranking. Until an audited chain-reader capability is registered,
  // fail closed instead of allowing generic on-chain words to select a market
  // data connector that cannot verify the requested evidence.
  if (isOnchainEvidenceAudit(text)) {
    return finalizePlan(routePlan({
      taskFamily: "onchain_evidence_audit",
      dataFamily: "onchain_execution_evidence",
      capability: "onchain_evidence_audit",
      confidence: 0.99,
      abstainReason: "capability_not_available",
      mustNotFallback: true,
      budget
    }), context);
  }

  const connectedSources = normalizedSet(context.connected_sources);
  if (isTokenHoldersQuery(text)) {
    return finalizePlan(routePlan({
      taskFamily: "lookup", dataFamily: "token_ownership", capability: "token_holders", routeFamily: "registered_service",
      candidateSources: ["agentrouter_registry"], params: parseHolderTask(text), confidence: 0.95,
      abstainReason: /geckoterminal|dexscreener/i.test(text) ? "capability_not_available" : null, mustNotFallback: true, budget
    }), context);
  }
  const inferenceText = normalizeInferenceText(text);
  const explicitRequest = inferExternalApiRequest(inferenceText, {
    connectedSources: [...connectedSources],
    tier: "all"
  });
  const explicitRequestType = explicitRequest?.routing_constraint?.type;
  const researchingSocialVendors = isSocialVendorResearch(text);
  const hasExplicitExternalConstraint = !researchingSocialVendors && (
    explicitRequestType === "explicit_source"
    || explicitRequestType === "explicit_provider"
  );

  const registered = hasExplicitExternalConstraint ? null : inferRegisteredServiceRoute(text);
  if (registered) {
    if (registered.capability === "token_smart_money_activity" && !registered.params?.chain) {
      return finalizePlan(routePlan({
        taskFamily: "clarification",
        dataFamily: "onchain_activity",
        capability: registered.capability,
        confidence: 0.96,
        abstainReason: "needs_clarification",
        mustNotFallback: true,
        budget
      }), context);
    }
    return finalizePlan(routePlan({
      taskFamily: registered.task_family,
      dataFamily: registered.data_family,
      routeFamily: "registered_service",
      capability: registered.capability,
      candidateSources: ["agentrouter_registry"],
      params: registered.params,
      estimatedPriceUsdc: registered.estimated_price_usdc ?? null,
      confidence: registered.confidence,
      margin: registered.margin,
      mustNotFallback: true,
      budget
    }), context);
  }

  let requirement = inferDataRequirement(inferenceText);
  let tier = "all";
  if (!hasExplicitExternalConstraint && (researchingSocialVendors || (
    requirement?.capability === "scholarly_literature"
    && negatesScholarlyIntent(text)
    && !/\bopenalex\b/i.test(text)
  ))) {
    tier = "web";
    requirement = inferDataRequirement(inferenceText, { tier });
  } else if (!hasExplicitExternalConstraint && !requirement && needsCurrentWebEvidence(text)) {
    tier = "web";
    requirement = inferDataRequirement(inferenceText, { tier });
  }
  const request = hasExplicitExternalConstraint
    ? explicitRequest
    : inferExternalApiRequest(inferenceText, {
        connectedSources: [...connectedSources],
        tier
      });
  if (!requirement || !request) {
    return finalizePlan(routePlan({
      taskFamily: "reasoning",
      dataFamily: "none",
      confidence: 0.72,
      abstainReason: "no_external_data_required",
      mustNotFallback: true,
      budget
    }), context);
  }

  const explicitType = request.routing_constraint?.type;
  const explicit = explicitType === "explicit_source" || explicitType === "explicit_provider";
  const inferredSource = request.params?.source || requirement.source_hint || requirement.candidate_sources[0];
  const rankedSources = rankBudgetAwareSources(
    explicit ? [inferredSource] : requirement.candidate_sources,
    inferredSource,
    connectedSources,
    budget,
    context.source_signals
  );
  const selectedSource = rankedSources[0]?.source || inferredSource;
  const metadata = SOURCE_METADATA.get(selectedSource);
  const providerConstraint = explicitType === "explicit_provider" ? selectedSource : null;
  const sourceConstraint = explicitType === "explicit_source" ? selectedSource : null;
  const localAlternative = metadata?.authorization_mode === "local_browser_session"
    ? { call: { params: { platform: selectedSource } } }
    : !connectedSources.has(selectedSource)
      ? freeLocalAlternative(selectedSource, request.params)
      : null;
  const routeFamily = localAlternative ? "local_browser" : "external_api";
  const routedSource = localAlternative?.call?.params?.platform || selectedSource;
  const candidateSources = localAlternative
    ? [routedSource]
    : reorderCandidates(rankedSources.map((entry) => entry.source), selectedSource);
  const candidateScores = localAlternative
    ? [{
        source: routedSource,
        rank: 1,
        routing_score: 1,
        semantic_fit: 1,
        routing_trust_score: null,
        trust_score_confidence: 0,
        recent_failure_rate: null,
        estimated_price_usdc: 0,
        connected: normalizedSet(context.local_browser_sessions).has(routedSource),
        key_free: true
      }]
    : rankedSources.map((entry, index) => publicSourceRanking(entry, index));
  const social = isSocialRoute(routedSource, metadata, providerConstraint);
  const specialist = requirement.evidence_type !== "current_web";
  const confidence = explicit ? 0.96 : social ? 0.92 : specialist ? 0.9 : 0.82;
  const capability = social && requirement.capability === "public_web_research"
    ? "social_search"
    : requirement.capability;

  return finalizePlan(routePlan({
    taskFamily: social ? "social_research" : specialist ? taskFamilyFor(requirement) : "research",
    dataFamily: dataFamilyFor(requirement, social),
    routeFamily,
    capability,
    sourceConstraint: providerConstraint ? null : sourceConstraint || (localAlternative ? routedSource : null),
    providerConstraint,
    candidateSources,
    candidateScores,
    params: routeFamily === "local_browser"
      ? { platform: routedSource, query: request.params?.query || text }
      : { ...request.params, source: selectedSource, query: text },
    estimatedPriceUsdc: estimatedSourcePrice(routeFamily === "local_browser" ? null : selectedSource),
    confidence,
    margin: candidateScores.length === 1
      ? Math.min(confidence, 0.4)
      : Math.max(0, Number((candidateScores[0].routing_score - candidateScores[1].routing_score).toFixed(4))),
    mustNotFallback: explicit || social || specialist,
    budget
  }), context);
}

// Structured callers have already selected a capability, so this adapter does
// not re-run natural-language intent detection or change execution. It only
// expresses the caller's explicit decision in the same canonical envelope used
// by ask/fetch, allowing every runtime entrypoint to emit comparable metrics.
export function inferStructuredRoutePlan(request = {}, context = {}) {
  const capability = String(request.capability || "").trim();
  const params = request.params && typeof request.params === "object" ? request.params : {};
  const budgetExplicit = context.require_price_upper_bound
    ?? (Object.hasOwn(request.constraints || {}, "max_price_usdc")
      || Object.hasOwn(request.budget || {}, "max_amount"));
  const constraints = {
    ...(context.constraints || {}),
    ...(request.constraints || {}),
    max_price_usdc: request.constraints?.max_price_usdc
      ?? request.budget?.max_amount
      ?? context.constraints?.max_price_usdc
      ?? "0.05"
  };
  const planningContext = {
    ...context,
    constraints,
    require_price_upper_bound: budgetExplicit
  };
  const budget = budgetGate(constraints);

  if (!capability) {
    return structuredObservationPlan(routePlan({
      taskFamily: "structured_request",
      dataFamily: "unknown",
      confidence: 1,
      abstainReason: "invalid_request",
      mustNotFallback: true,
      budget
    }), planningContext);
  }

  if (capability === "external_api_query") {
    const sourceId = String(params.source || "").trim().toLowerCase();
    const metadata = SOURCE_METADATA.get(sourceId);
    if (!metadata) {
      return structuredObservationPlan(routePlan({
        taskFamily: "external_api_query",
        dataFamily: "unknown_external_data",
        capability,
        params,
        confidence: 1,
        abstainReason: "unsupported_source",
        mustNotFallback: true,
        budget
      }), planningContext);
    }
    const localBrowser = metadata.authorization_mode === "local_browser_session";
    return structuredExternalExecutionPlan(routePlan({
      taskFamily: isSocialRoute(sourceId, metadata, null) ? "social_research" : "external_api_query",
      dataFamily: structuredSourceDataFamily(sourceId, metadata),
      routeFamily: localBrowser ? "local_browser" : "external_api",
      capability,
      sourceConstraint: sourceId,
      candidateSources: [sourceId],
      candidateScores: [structuredCandidateScore(sourceId, metadata, context)],
      params: { ...params, source: sourceId },
      estimatedPriceUsdc: localBrowser ? 0 : estimatedSourcePrice(sourceId),
      confidence: 1,
      margin: 1,
      mustNotFallback: true,
      budget
    }), planningContext);
  }

  if (capability === "social_post_read") {
    const socialPost = findSocialPostUrl(params.url || params.target || "");
    const platform = String(params.platform || socialPost?.platform || "social").trim().toLowerCase();
    return structuredObservationPlan(routePlan({
      taskFamily: "social_post_read",
      dataFamily: "public_social_post",
      routeFamily: "local_browser",
      capability,
      sourceConstraint: platform,
      candidateSources: [platform],
      candidateScores: [structuredCandidateScore(platform, SOURCE_METADATA.get(platform), context, { free: true })],
      params: { ...params, platform },
      estimatedPriceUsdc: 0,
      confidence: 1,
      margin: 1,
      mustNotFallback: true,
      budget
    }), planningContext, { resolveAuthorization: true });
  }

  if (capability === "social_user_voice_research") {
    const platforms = normalizedStructuredSources(params.platforms || params.sources);
    const candidates = platforms.length ? platforms : ["agentrouter_social_dispatch"];
    const unknownSources = platforms.filter((source) => !SOURCE_METADATA.has(source));
    const unavailableSources = platforms.filter((source) => {
      const status = SOURCE_METADATA.get(source)?.implementation_status;
      return status && !["available", "browser_only"].includes(status);
    });
    const blockedSources = unavailableSources.length ? unavailableSources : unknownSources;
    if (blockedSources.length) {
      const abstainReason = unavailableSources.length ? "source_not_callable" : "unsupported_source";
      return structuredObservationPlan(routePlan({
        taskFamily: platforms.length > 1 ? "structured_batch" : "social_research",
        dataFamily: "public_social_content",
        routeFamily: "external_api",
        capability,
        sourceConstraint: blockedSources[0],
        candidateSources: candidates,
        candidateScores: candidates.map((source, index) => structuredCandidateScore(
          source,
          SOURCE_METADATA.get(source),
          context,
          { score: Math.max(0.5, 1 - index * 0.05) }
        )),
        params: { ...params, platforms, blocked_sources: blockedSources },
        estimatedPriceUsdc: null,
        confidence: 1,
        margin: candidates.length > 1 ? 0.05 : 1,
        abstainReason,
        mustNotFallback: true,
        budget
      }), planningContext);
    }
    const connectedSources = normalizedSet(planningContext.connected_sources);
    const localBrowser = platforms.length > 0 && platforms.every((source) => {
      const metadata = SOURCE_METADATA.get(source);
      return metadata?.authorization_mode === "local_browser_session"
        || (metadata?.connection_required === true
          && !connectedSources.has(source)
          && Boolean(freeLocalAlternative(source, params)));
    });
    return finalizePlan(routePlan({
      taskFamily: platforms.length > 1 ? "structured_batch" : "social_research",
      dataFamily: "public_social_content",
      routeFamily: localBrowser ? "local_browser" : "external_api",
      capability,
      candidateSources: candidates,
      candidateScores: candidates.map((source, index) => structuredCandidateScore(
        source,
        SOURCE_METADATA.get(source),
        context,
        { free: localBrowser, score: Math.max(0.5, 1 - index * 0.05) }
      )),
      params,
      estimatedPriceUsdc: localBrowser ? 0 : null,
      confidence: 1,
      margin: candidates.length > 1 ? 0.05 : 1,
      mustNotFallback: true,
      budget
    }), planningContext);
  }

  return structuredObservationPlan(routePlan({
    taskFamily: "registered_capability",
    dataFamily: "registered_service_data",
    routeFamily: "registered_service",
    capability,
    candidateSources: ["agentrouter_registry"],
    candidateScores: [structuredCandidateScore("agentrouter_registry", null, context)],
    params,
    estimatedPriceUsdc: null,
    confidence: 1,
    margin: 1,
    mustNotFallback: true,
    budget
  }), planningContext);
}

export function inferStructuredBatchRoutePlan(requests = [], context = {}) {
  const plans = (Array.isArray(requests) ? requests : [])
    .map((request) => inferStructuredRoutePlan(request, context));
  if (!plans.length) {
    return inferStructuredRoutePlan({}, context);
  }
  const first = plans[0];
  const sameRouteFamily = plans.every((plan) => plan.route_family === first.route_family);
  const sameDataFamily = plans.every((plan) => plan.data_family === first.data_family);
  const candidates = [];
  const candidateScores = [];
  for (const plan of plans) {
    for (const source of plan.candidate_sources || []) {
      if (!candidates.includes(source)) candidates.push(source);
    }
    for (const candidate of plan.candidate_scores || []) {
      if (!candidateScores.some((item) => item.source === candidate.source)) {
        candidateScores.push({ ...candidate, rank: candidateScores.length + 1 });
      }
    }
  }
  const allRequireSameAuthorization = plans.every((plan) =>
    plan.auth_requirement?.required === true
    && plan.auth_requirement?.kind === first.auth_requirement?.kind
    && plan.auth_requirement?.source === first.auth_requirement?.source
  );
  const allBlockedForSameReason = plans.every((plan) =>
    Boolean(first.abstain_reason) && plan.abstain_reason === first.abstain_reason
  );
  return {
    ...first,
    task_family: "structured_batch",
    data_family: sameDataFamily ? first.data_family : "multi_source_data",
    route_family: sameRouteFamily ? first.route_family : "batch",
    capability: "structured_batch",
    source_constraint: null,
    provider_constraint: null,
    candidate_sources: candidates,
    candidate_scores: candidateScores,
    params: { requirement_count: plans.length },
    confidence: Math.min(...plans.map((plan) => Number(plan.confidence) || 0)),
    top1_top2_margin: candidateScores.length > 1
      ? Math.max(0, Number(((candidateScores[0]?.routing_score || 0) - (candidateScores[1]?.routing_score || 0)).toFixed(4)))
      : first.top1_top2_margin,
    auth_requirement: allRequireSameAuthorization ? first.auth_requirement : noAuth(),
    budget_gate: allBlockedForSameReason ? first.budget_gate : batchBudgetGate(plans),
    abstain_reason: allBlockedForSameReason ? first.abstain_reason : null,
    must_not_fallback: true
  };
}

function structuredExternalExecutionPlan(plan, context) {
  const finalized = finalizePlan(plan, context);
  if (finalized.abstain_reason !== "budget_exceeded") return finalized;
  return {
    ...finalized,
    budget_gate: {
      ...finalized.budget_gate,
      paid_calls_allowed: false,
      status: "quote_required"
    }
  };
}

function batchBudgetGate(plans) {
  const maxPrice = plans[0]?.budget_gate?.max_price_usdc ?? "0";
  const statuses = plans.map((plan) => plan.budget_gate?.status);
  return {
    max_price_usdc: maxPrice,
    paid_calls_allowed: plans.some((plan) => plan.budget_gate?.paid_calls_allowed === true),
    status: statuses.every((status) => status === "free_only") ? "free_only" : "allowed"
  };
}

function structuredObservationPlan(plan, context, { resolveAuthorization = false } = {}) {
  const budget = plan.budget_gate || {};
  const exposed = {
    ...plan,
    budget_gate: {
      max_price_usdc: budget.max_price_usdc,
      paid_calls_allowed: budget.paid_calls_allowed,
      status: budget.valid === false ? "blocked" : Number(budget.max_price_usdc) === 0 ? "free_only" : "allowed"
    }
  };
  return {
    ...exposed,
    auth_requirement: resolveAuthorization ? authRequirement(exposed, context) : noAuth()
  };
}

function structuredCandidateScore(source, metadata, context, { free = false, score = 1 } = {}) {
  const connected = normalizedSet(context.connected_sources).has(source)
    || normalizedSet(context.local_browser_sessions).has(source);
  const price = free ? 0 : estimatedSourcePrice(source);
  return {
    source,
    rank: 1,
    routing_score: clampUnit(score),
    semantic_fit: 1,
    routing_trust_score: null,
    trust_score_confidence: 0,
    recent_failure_rate: null,
    estimated_price_usdc: price,
    connected,
    key_free: free || metadata?.connection_required === false
  };
}

function normalizedStructuredSources(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

function structuredSourceDataFamily(source, metadata) {
  if (isSocialRoute(source, metadata, null)) return "public_social_content";
  const category = String(metadata?.category || "");
  if (category === "搜索" || category === "抓取") return "current_web";
  if (category === "学术") return "scholarly_metadata";
  if (category === "链上数据") return "onchain_data";
  if (category === "加密行情" || category === "金融") return "financial_market_data";
  if (category === "天气与环境") return "weather_data";
  if (category === "新闻") return "news_data";
  if (category === "安全") return "security_data";
  if (category === "地点") return "places_data";
  if (category === "旅行") return "travel_data";
  if (category === "物流") return "logistics_data";
  if (category === "开发者") return "developer_data";
  if (category === "公司与监管") return "regulatory_filings";
  return "external_api_data";
}

function routePlan({
  taskFamily,
  dataFamily,
  routeFamily = "none",
  capability = null,
  sourceConstraint = null,
  providerConstraint = null,
  candidateSources = [],
  candidateScores = [],
  params = {},
  estimatedPriceUsdc = null,
  confidence,
  margin = 0,
  abstainReason = null,
  mustNotFallback = false,
  budget
}) {
  return {
    schema_version: ROUTE_PLAN_SCHEMA_VERSION,
    task_family: taskFamily,
    data_family: dataFamily,
    route_family: routeFamily,
    capability,
    source_constraint: sourceConstraint,
    provider_constraint: providerConstraint,
    candidate_sources: [...new Set(candidateSources.filter(Boolean))],
    candidate_scores: candidateScores.map((entry) => ({ ...entry })),
    params: { ...params },
    estimated_price_usdc: estimatedPriceUsdc,
    confidence: clampUnit(confidence),
    top1_top2_margin: clampUnit(margin),
    auth_requirement: noAuth(),
    budget_gate: budget,
    abstain_reason: abstainReason,
    must_not_fallback: Boolean(mustNotFallback)
  };
}

function finalizePlan(plan, context) {
  const implementationGated = applyImplementationGate(plan, context);
  if (!implementationGated.abstain_reason && plan.capability === "token_holders") {
    const validation = validateHolderParams(plan.params);
    if (!validation.ok) return { ...implementationGated, abstain_reason: validation.missing ? "needs_clarification" : "invalid_request", validation, auth_requirement: noAuth(), must_not_fallback: true };
  }
  if (implementationGated.abstain_reason) {
    return {
      ...implementationGated,
      budget_gate: {
        max_price_usdc: implementationGated.budget_gate?.max_price_usdc ?? "0",
        paid_calls_allowed: false,
        status: "blocked"
      }
    };
  }
  const budgetGated = applyBudgetGate(implementationGated, {
    requirePriceUpperBound: context?.require_price_upper_bound === true
  });
  if (budgetGated.abstain_reason) return budgetGated;
  return { ...budgetGated, auth_requirement: authRequirement(budgetGated, context) };
}

function applyImplementationGate(plan, context = {}) {
  if (plan.route_family === "registered_service") {
    const explicitlyAvailable = Array.isArray(context.registered_capabilities)
      ? normalizedSet(context.registered_capabilities).has(plan.capability)
      : null;
    const runtimeAvailable = typeof context.registered_capability_available === "function"
      ? context.registered_capability_available(plan.capability, plan.params)
      : null;
    if (runtimeAvailable === false || (runtimeAvailable == null && explicitlyAvailable === false)) {
      return {
        ...plan,
        route_family: "none",
        candidate_sources: [],
        candidate_scores: [],
        estimated_price_usdc: null,
        auth_requirement: noAuth(),
        abstain_reason: "capability_not_available",
        must_not_fallback: true
      };
    }
  }
  if (plan.route_family !== "external_api") return plan;
  const coverageError = externalApiCoverageError({ ...plan.params, source: plan.params.source || plan.candidate_sources?.[0] });
  if (coverageError) return {
    ...plan, route_family: "none", candidate_sources: [], candidate_scores: [],
    estimated_price_usdc: null, auth_requirement: noAuth(),
    abstain_reason: "capability_not_available", must_not_fallback: true
  };
  const unavailableSource = (plan.candidate_sources || []).find((source) => {
    const status = SOURCE_METADATA.get(source)?.implementation_status;
    return status && status !== "available";
  });
  if (!unavailableSource) return plan;
  return {
    ...plan,
    source_constraint: plan.source_constraint || unavailableSource,
    auth_requirement: noAuth(),
    abstain_reason: "source_not_callable",
    must_not_fallback: true
  };
}

function authRequirement(plan, context) {
  if (plan.route_family === "none") return noAuth();
  if (plan.route_family === "local_browser") {
    const candidates = plan.candidate_sources?.length
      ? plan.candidate_sources
      : [plan.source_constraint].filter(Boolean);
    const sessions = normalizedSet(context.local_browser_sessions);
    const source = candidates.length === 1 ? candidates[0] : null;
    return candidates.length > 0 && candidates.every((candidate) => sessions.has(candidate))
      ? noAuth()
      : { required: true, kind: "local_browser_session", source };
  }
  if (plan.route_family === "registered_service") {
    return context.agentrouter_authenticated === false
      ? { required: true, kind: "agentrouter_account", source: null }
      : noAuth();
  }

  const source = plan.candidate_sources[0];
  const metadata = SOURCE_METADATA.get(source);
  if (!metadata?.connection_required || normalizedSet(context.connected_sources).has(source)) return noAuth();
  if (context.agentrouter_authenticated === false) {
    return { required: true, kind: "agentrouter_account", source: null };
  }
  return { required: true, kind: "source_connection", source };
}

function applyBudgetGate(plan, { requirePriceUpperBound = false } = {}) {
  const source = plan.candidate_sources[0];
  const metadata = SOURCE_METADATA.get(source);
  const max = Number(plan.budget_gate.max_price_usdc);
  const rawPrice = metadata?.upstream_price;
  const pricingModel = String(metadata?.upstream_pricing_model || "").toLowerCase();
  const knownPrice = rawPrice !== null && rawPrice !== undefined && Number.isFinite(Number(rawPrice))
    ? Number(rawPrice)
    : null;
  const freeRoute = plan.route_family === "local_browser"
    || (plan.route_family === "external_api" && pricingModel === "free" && knownPrice === 0);
  const fixedUpperBound = ["per_request", "fixed", "flat", "flat_rate"].includes(pricingModel)
    && knownPrice != null;
  const legacyUnknownMeteredPrice = knownPrice == null
    && ["credits", "tokens"].includes(pricingModel);
  const unknownMeteredPrice = plan.route_family === "external_api"
    && !freeRoute
    && (legacyUnknownMeteredPrice || (requirePriceUpperBound && !fixedUpperBound));
  const overKnownPrice = knownPrice != null && knownPrice > max;
  const blocksPaidRoute = max === 0 && !freeRoute && plan.route_family !== "none";
  if (!plan.budget_gate.valid || overKnownPrice || blocksPaidRoute || unknownMeteredPrice) {
    const abstainReason = !plan.budget_gate.valid
      ? "invalid_budget"
      : unknownMeteredPrice
        ? "price_unknown"
        : "budget_exceeded";
    return {
      ...plan,
      auth_requirement: noAuth(),
      budget_gate: {
        max_price_usdc: plan.budget_gate.max_price_usdc,
        paid_calls_allowed: unknownMeteredPrice ? false : plan.budget_gate.paid_calls_allowed,
        status: unknownMeteredPrice ? "quote_required" : "blocked"
      },
      abstain_reason: abstainReason,
      must_not_fallback: true
    };
  }
  return {
    ...plan,
    budget_gate: {
      max_price_usdc: plan.budget_gate.max_price_usdc,
      paid_calls_allowed: plan.budget_gate.paid_calls_allowed,
      status: max === 0 ? "free_only" : "allowed"
    }
  };
}

function budgetGate(constraints) {
  const validation = validateBudgetAmount(constraints.max_price_usdc);
  const amount = validation.ok && validation.present ? validation.amount : 0;
  return {
    max_price_usdc: canonicalAmount(amount),
    paid_calls_allowed: validation.ok && amount > 0,
    status: validation.ok ? (amount > 0 ? "allowed" : "free_only") : "blocked",
    // Internal only; stripped by applyBudgetGate for plans that can execute.
    valid: validation.ok
  };
}

function inferRegisteredServiceRoute(text) {
  const legacyIntent = inferIntent(text);
  const structured = intentToCapabilityRequest(legacyIntent);
  if (structured?.capability) {
    const capability = structured.capability;
    const dataFamily = capability === "perp_liquidation_max_pain"
      ? "crypto_derivatives"
      : capability === "wallet_pnl_leaderboard"
        ? "wallet_performance"
      : capability === "smart_money_holdings"
        ? "onchain_portfolio"
        : capability === "token_smart_money_activity"
          ? "onchain_activity"
          : "onchain_flows";
    return {
      task_family: "market_analysis",
      data_family: dataFamily,
      capability,
      params: structured.params,
      confidence: capability === "perp_liquidation_max_pain" ? 0.96 : 0.94,
      margin: capability === "perp_liquidation_max_pain" ? 0.35 : 0.3
    };
  }

  if (legacyIntent.wants_address && (legacyIntent.address || legacyIntent.tag || isWalletProfileIntent(text))) {
    return {
      task_family: "wallet_intelligence",
      data_family: "onchain_identity",
      capability: legacyIntent.wants_related_wallets ? "related_wallets" : "wallet_profile",
      params: legacyIntent.input,
      confidence: 0.94,
      margin: 0.3
    };
  }

  const serviceDiscovery = /(?:data|api|数据|數據).{0,12}(?:services?|providers?|服务|服務)/i.test(text)
    && /(?:high[\s-]?trust|trust(?:ed|worthy)?|cost(?:ing)?|price|budget|no more than|最多收费|最多收費|高可信|可信度|价格|價格|预算|預算|usdc)/i.test(text);
  if (serviceDiscovery) {
    return {
      task_family: "service_discovery",
      data_family: "service_catalog",
      capability: "service_discovery",
      params: { query: text },
      estimated_price_usdc: 0,
      confidence: 0.94,
      margin: 0.3
    };
  }

  return null;
}

function isWalletProfileIntent(text) {
  return /(?:钱包|地址).{0,8}(?:标签|画像|归属|身份|实体|详情|信息|关联)|(?:label|profile|identity|owner|entity|details?).{0,12}(?:wallet|address)|(?:wallet|address).{0,12}(?:label|profile|identity|owner|entity|details?)/i.test(text);
}

function isInsufficientContext(text) {
  const compact = text.replace(/[\s，。,.!?！？]/g, "").toLowerCase();
  if (!/[a-z0-9\u4e00-\u9fff]/i.test(compact)) return true;
  if (/^\s*(?:(?:can|could|would)\s+you\s+|please\s+)?(?:research|investigate|look\s+into|analy[sz]e)\s+(?:this|that|it)(?:\s+for\s+me)?\s*[?!.]*\s*$/i.test(text)) {
    return true;
  }
  return /^(?:帮我|請|请)?(?:研究|调研|調研|查|查找|分析|看看|了解)(?:一下)?(?:这个|這個|那个|那個|它|这东西|這東西|这个东西|這個東西)$/i.test(compact)
    || /^(?:please)?(?:research|investigate|lookinto|analy[sz]e)(?:this|that|it|thisthing)(?:forme)?$/i.test(compact);
}

function isOnchainEvidenceAudit(text) {
  const value = String(text || "");
  const transactionHash = /\b0x[a-fA-F0-9]{64}\b/.test(value);
  const requestId = /\breq_[a-zA-Z0-9_-]+\b/.test(value);
  const agentId = /\b(?:erc[\s-]?8004|agent\s*id|agent_id|agent\s*身份|代理\s*身份)\b/i.test(value);
  const feedback = /\b(?:givefeedback|feedback|reputation\s*(?:event|receipt|transaction)?)\b|反馈(?:是否)?(?:上链|存在|交易|收据)/i.test(value);
  const receipt = /\b(?:transaction|tx|receipt|evidence\s*(?:anchor|audit|verification))\b|交易(?:哈希|收据|证据|验证)|链上(?:证据|审计|验证)/i.test(value);
  return (transactionHash || requestId || agentId) && (feedback || receipt);
}

function isSelfContainedReasoning(text) {
  const symbolic = /\b(?:find|solve(?:\s+for)?)\s+[a-z]\b/i.test(text)
    && /\b[a-z]\b/i.test(text)
    && /[=<>≤≥]/.test(text);
  const externalCue = /https?:\/\/|latest|current|today|news|search\s+(?:on|the web)|research|论文|新闻|最近|当前|网上|网页/i.test(text);
  return symbolic && !externalCue;
}

function dataFamilyFor(requirement, social) {
  if (social) return "public_social_content";
  if (requirement.evidence_type === "current_web") return "current_web";
  if (requirement.evidence_type === "scholarly_metadata") return "scholarly_metadata";
  return requirement.data_object || requirement.evidence_type || "external_data";
}

function taskFamilyFor(requirement) {
  return requirement.evidence_type === "scholarly_metadata" ? "research" : "lookup";
}

function isSocialRoute(source, metadata, providerConstraint) {
  return Boolean(providerConstraint && SOCIAL_AGGREGATORS.has(providerConstraint))
    || metadata?.category === "社交媒体"
    || ["x", "reddit", "xiaohongshu", "tiktok", "douyin", "zhihu", "weibo", "bilibili", "youtube"].includes(source);
}

function normalizeInferenceText(text) {
  let normalized = String(text || "")
    .replace(/\bmarket[-\s]?cap(?:italization)?\b/gi, "market cap")
    .replace(/\brepositor(?:y|ies)\b/gi, "repository")
    .replace(/\bshippments?\b/gi, "shipment");
  if (looksLikeCryptoMarketData(normalized)) {
    normalized = `crypto market cap ranking. ${normalized}`;
  } else if (looksLikeEquityMarketData(normalized)) {
    normalized = `stock price ticker. ${normalized}`;
  }
  return normalized;
}

function looksLikeCryptoMarketData(text) {
  const symbols = uppercaseSymbols(text);
  const cryptoSymbol = symbols.some((symbol) => CRYPTO_MARKET_SYMBOLS.has(symbol));
  const cryptoWords = /\b(?:crypto|cryptocurrency|coin|token|bitcoin|ethereum)\b|加密货币|加密貨幣|币价|幣價/i.test(text);
  return (cryptoSymbol || cryptoWords) && marketMetricCount(text) >= 1;
}

function looksLikeEquityMarketData(text) {
  if (looksLikeCryptoMarketData(text)) return false;
  const symbols = uppercaseSymbols(text).filter((symbol) => !NON_ASSET_SYMBOLS.has(symbol));
  return symbols.length > 0 && marketMetricCount(text) >= 2;
}

function marketMetricCount(text) {
  return [
    /\b(?:live|current|latest)?\s*(?:share|stock)?\s*price\b|股价|股價/i,
    /\bvolume\b|成交量/i,
    /\bmarket cap\b|市值/i,
    /\branking\b|排名|排行/i
  ].filter((pattern) => pattern.test(text)).length;
}

const NON_ASSET_SYMBOLS = new Set([
  "AI", "API", "HTTP", "JSON", "USD", "USDC", "USDT", "NFT", "TVL", "DEX", "CEX",
  "BSC", "L1", "L2", "ERC", "SEC", "DOI"
]);

function uppercaseSymbols(text) {
  return [...String(text || "").matchAll(/\b[A-Z][A-Z0-9]{1,11}\b/g)]
    .map((match) => match[0])
    .filter((symbol) => !NON_ASSET_SYMBOLS.has(symbol));
}

function isSocialVendorResearch(text) {
  return /\b(?:compare|research|evaluate|map)\b.{0,40}\b(?:vendors?|providers?)\b/i.test(text)
    || /\b(?:vendors?|providers?)\b.{0,100}\b(?:data\s+apis?|social\s+(?:data|media|listening))\b/i.test(text)
    || /(?:比较|比較|研究|评估|評估).{0,40}(?:供应商|供應商|服务商|服務商)/i.test(text);
}

function negatesScholarlyIntent(text) {
  return /(?:不要|不只|不仅|不僅|而非|并非).{0,12}(?:论文|論文|文献|文獻|学术|學術)/i.test(text)
    || /(?:不要|不只|不仅|不僅|而非|并非)\s*(?:只)?\s*(?:academic|scholarly|peer-reviewed)?\s*(?:papers?|publications?|literature)\b/i.test(text)
    || /\b(?:not|without)\s+(?:just\s+|only\s+)?(?:academic|scholarly|peer-reviewed)?\s*(?:papers?|publications?|literature)\b/i.test(text);
}

function needsCurrentWebEvidence(text) {
  return /\b(?:track|monitor|follow)\b.{0,60}\b(?:recent|latest|current|updates?|developments?)\b/i.test(text)
    || /\b(?:recent|latest|current)\s+updates?\b/i.test(text);
}

function unsupportedExplicitApi(text) {
  const match = String(text || "").match(/^\s*(?:please\s+)?use\s+([A-Za-z][A-Za-z0-9 _-]{2,63}?)\s+(?:data\s+)?api\b/i);
  if (!match) return null;
  const normalized = normalizedAlias(match[1]);
  if (SOURCE_ALIASES.has(normalized)) return null;
  return normalized;
}

function normalizedAlias(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rankBudgetAwareSources(candidates, inferredSource, connectedSources, budget, sourceSignals = {}) {
  const max = Number(budget.max_price_usdc);
  const ranked = [...new Set(candidates.filter(Boolean))]
    .map((source, index) => {
      const metadata = SOURCE_METADATA.get(source);
      const price = estimatedSourcePrice(source);
      const signal = sourceSignal(sourceSignals, source);
      const connected = connectedSources.has(source);
      const keyFree = metadata?.connection_required === false;
      const semanticFit = Math.max(0.5, 1 - index * 0.08);
      const trust = signal.routing_trust_score ?? 0.7;
      const trustConfidence = signal.trust_score_confidence ?? 0;
      const failureRate = signal.recent_failure_rate ?? 0;
      const priceScore = price == null || !Number.isFinite(max) || max <= 0
        ? 0.5
        : Math.max(0, Math.min(1, 1 - (price / max)));
      const routingScore = clampUnit(
        semanticFit * 0.72
        + trust * 0.2
        + priceScore * 0.08
        - failureRate * trustConfidence * 0.15
      );
      return {
        source,
        index,
        metadata,
        price,
        connected,
        key_free: keyFree,
        semantic_fit: semanticFit,
        routing_trust_score: signal.routing_trust_score,
        trust_score_confidence: trustConfidence,
        recent_failure_rate: signal.recent_failure_rate,
        routing_score: Number(routingScore.toFixed(4))
      };
    })
    .filter((entry) => sourceFitsBudget(entry.metadata, entry.price, max))
    .sort((left, right) => {
      const leftConnected = left.connected ? 1 : 0;
      const rightConnected = right.connected ? 1 : 0;
      if (leftConnected !== rightConnected) return rightConnected - leftConnected;
      const leftFree = left.key_free ? 1 : 0;
      const rightFree = right.key_free ? 1 : 0;
      if (leftFree !== rightFree) return rightFree - leftFree;
      if (left.routing_score !== right.routing_score) return right.routing_score - left.routing_score;
      if (left.index !== right.index) return left.index - right.index;
      return left.source.localeCompare(right.source);
    });
  if (ranked.length) return ranked;
  const metadata = SOURCE_METADATA.get(inferredSource);
  return inferredSource ? [{
    source: inferredSource,
    index: 0,
    metadata,
    price: estimatedSourcePrice(inferredSource),
    connected: connectedSources.has(inferredSource),
    key_free: metadata?.connection_required === false,
    semantic_fit: 1,
    routing_trust_score: null,
    trust_score_confidence: 0,
    recent_failure_rate: null,
    routing_score: 0
  }] : [];
}

function sourceSignal(sourceSignals, source) {
  const raw = sourceSignals && typeof sourceSignals === "object" ? sourceSignals[source] : null;
  if (!raw || typeof raw !== "object") return {};
  return {
    routing_trust_score: finiteUnit(raw.routing_trust_score),
    trust_score_confidence: finiteUnit(raw.trust_score_confidence),
    recent_failure_rate: finiteUnit(raw.recent_failure_rate)
  };
}

function publicSourceRanking(entry, index) {
  return {
    source: entry.source,
    rank: index + 1,
    routing_score: entry.routing_score,
    semantic_fit: Number(entry.semantic_fit.toFixed(4)),
    routing_trust_score: entry.routing_trust_score,
    trust_score_confidence: entry.trust_score_confidence,
    recent_failure_rate: entry.recent_failure_rate,
    estimated_price_usdc: entry.price,
    connected: entry.connected,
    key_free: entry.key_free
  };
}

function sourceFitsBudget(metadata, price, max) {
  if (!Number.isFinite(max) || max < 0) return false;
  if (price !== null) return price <= max;
  if (max === 0) return metadata?.connection_required === false;
  return true;
}

function estimatedSourcePrice(source) {
  if (!source) return 0;
  const price = SOURCE_METADATA.get(source)?.upstream_price;
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return null;
  return Number(price);
}

function finiteUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function reorderCandidates(candidates = [], selected) {
  return [...new Set([selected, ...candidates].filter(Boolean))];
}

function normalizedSet(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function noAuth() {
  return { required: false, kind: "none", source: null };
}

function canonicalAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  return String(amount);
}

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 1);
}
