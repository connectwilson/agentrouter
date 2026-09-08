import crypto from "node:crypto";
import { DiscoveryConnector } from "./connector.js";
import { invokePaidServiceWithLocalWallet } from "./local-invoke.js";
import { createRouteObservationV2 } from "./routing/metrics.js";
import { verifyServiceResult } from "./verifier.js";
import { createCompactResult } from "./compact-result.js";
import { validateBudgetAmount } from "./budget-normalization.js";

export async function routeTaskWithLocalWallet({ baseUrl, task, constraints = {}, budget = {} }) {
  const connector = new DiscoveryConnector({ baseUrl });
  const timing = createRouteTiming();
  const normalizedBudget = normalizedRequestBudget({ constraints, budget });
  const budgetValidation = validateBudgetAmount(normalizedBudget.max_amount, { field: "max_price_usdc" });
  if (!budgetValidation.ok) {
    return withTiming({
      ok: false,
      status: budgetValidation.code,
      data_returned: false,
      error: budgetValidation.message,
      field: budgetValidation.field,
      retryable: false
    }, timing);
  }
  const canonical = await timing.measure("canonical_fetch_ms", () => postJsonAllowPayment(baseUrl, "/agent-router/fetch", {
    task,
    execution_mode: "local_wallet_preflight",
    ...(normalizedBudget.explicitMaxAmount ? { max_price: normalizedBudget.max_amount } : {}),
    ...(normalizedBudget.explicitCurrency ? { currency: normalizedBudget.currency } : {}),
    ...(normalizedBudget.explicitMaxAmount || Object.keys(constraints).length
      ? {
          constraints: {
            ...constraints,
            ...(normalizedBudget.explicitMaxAmount ? { max_price_usdc: normalizedBudget.max_amount } : {})
          }
        }
      : {}),
    ...(normalizedBudget.explicitMaxAmount || normalizedBudget.explicitCurrency || Object.keys(budget).length
      ? {
          budget: {
            ...budget,
            ...(normalizedBudget.explicitMaxAmount ? { max_amount: normalizedBudget.max_amount } : {}),
            ...(normalizedBudget.explicitCurrency ? { currency: normalizedBudget.currency } : {})
          }
        }
      : {}),
    consumer_context: {
      source: "agentrouter_mcp_local_wallet",
      task
    }
  }));
  const plan = canonical?.route_plan || null;
  if (!plan || plan.route_family !== "registered_service" || !plan.capability) {
    return withTiming(canonical, timing);
  }
  if (plan.capability === "token_smart_money_activity"
    && plan.params?.token_symbol
    && !plan.params?.token_address) {
    const routed = await routeTokenSmartMoneyActivityWithLocalWallet({
      baseUrl,
      connector,
      task,
      intent: {
        token: plan.params.token_symbol,
        chain: plan.params.chain,
        input: { ...plan.params }
      },
      constraints: {
        ...constraints,
        max_price_usdc: normalizedBudget.max_amount
      },
      budget: {
        ...budget,
        ...normalizedBudget
      },
      timing
    });
    return {
      ...mergeCanonicalResult(canonical, routed),
      timing: routed.timing || timing.snapshot()
    };
  }
  const compatibilityRoute = await timing.measure("compatibility_resolve_route_ms", () =>
    connector.resolveRoute({ task, constraints })
  ).catch(() => null);
  return executeCanonicalLocalWalletRoute({
    baseUrl,
    request: {
      capability: plan.capability,
      params: plan.params || {},
      constraints: {
        ...constraints,
        max_price_usdc: normalizedBudget.max_amount
      },
      budget: {
        ...budget,
        ...normalizedBudget
      },
      consumer_context: {
        source: "agentrouter_mcp_local_wallet",
        task
      }
    },
    normalizedBudget,
    canonicalResult: canonical,
    compatibilityStatus: compatibilityRoute?.status || null,
    timing
  });
}

export async function routeCapabilityRequestWithLocalWallet({ baseUrl, request = {}, budget = {} }) {
  const timing = createRouteTiming();
  const normalizedBudget = normalizedRequestBudget({ constraints: request.constraints || {}, budget: request.budget || budget });
  const requested = {
    ...request,
    execution_mode: "local_wallet_preflight",
    ...(normalizedBudget.explicitMaxAmount || normalizedBudget.explicitCurrency || request.budget
      ? {
          budget: {
            ...(request.budget || {}),
            ...(normalizedBudget.explicitMaxAmount ? { max_amount: normalizedBudget.max_amount } : {}),
            ...(normalizedBudget.explicitCurrency ? { currency: normalizedBudget.currency } : {})
          }
        }
      : {})
  };
  let canonical;
  try {
    canonical = await timing.measure("canonical_request_ms", () => postJsonAllowPayment(baseUrl, "/agent-router/request", requested));
  } catch (error) {
    return {
      ok: false,
      status: error.status || error.code || "structured_route_failed",
      data_returned: false,
      error: error.message,
      arc_rpc: error.arc_rpc || null,
      action_required: error.status === "arc_payment_unavailable" ? "fix_arc_rpc_or_retry" : undefined,
      payload: error.payload || null,
      timing: timing.snapshot()
    };
  }
  const plan = canonical?.route_plan || null;
  if (!plan || plan.route_family !== "registered_service" || !requested.capability) {
    return withTiming(canonical, timing);
  }
  return executeCanonicalLocalWalletRoute({
    baseUrl,
    request: {
      ...requested,
      constraints: {
        ...(requested.constraints || {}),
        max_price_usdc: normalizedBudget.max_amount
      },
      budget: {
        ...(requested.budget || {}),
        ...normalizedBudget
      },
      consumer_context: {
        ...(requested.consumer_context || {}),
        source: requested.consumer_context?.source || "agentrouter_structured_request_local_wallet"
      }
    },
    normalizedBudget,
    canonicalResult: canonical,
    timing
  });
}

async function executeCanonicalLocalWalletRoute({
  baseUrl,
  request,
  normalizedBudget,
  canonicalResult,
  compatibilityStatus = null,
  timing
}) {
  const connector = new DiscoveryConnector({ baseUrl });
  let quoted;
  try {
    quoted = await timing.measure("resolve_structured_route_ms", () => postJsonAllowPayment(baseUrl, "/agent-router/quote", request));
  } catch (error) {
    return withTiming(mergeCanonicalResult(canonicalResult, {
      ok: false,
      status: error.status || error.code || "structured_route_failed",
      data_returned: false,
      error: error.message,
      wallet: error.wallet || null,
      arc_rpc: error.arc_rpc || null,
      action_required: error.status === "arc_payment_unavailable" ? "fix_arc_rpc_or_retry" : undefined,
      payload: error.payload || null
    }), timing);
  }
  if (quoted.status === "quote_blocked" || quoted.quote?.would_pay === false) {
    return withTiming(mergeCanonicalResult(canonicalResult, {
      ...quoted,
      data_returned: false
    }), timing);
  }
  if (quoted.status !== "payment_required" && quoted.status !== "quoted") {
    return withTiming(mergeCanonicalResult(canonicalResult, {
      ...quoted,
      data_returned: false
    }), timing);
  }
  const serviceId = quoted.selected_service?.service_id;
  if (!serviceId) {
    return withTiming(mergeCanonicalResult(canonicalResult, {
      ...quoted,
      ok: false,
      status: "selected_service_missing",
      data_returned: false
    }), timing);
  }

  let invocation;
  try {
    invocation = await timing.measure("local_paid_invoke_ms", () => invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId,
      input: quoted.input || {},
      budget: normalizedBudget,
      request: {
        capability: request.capability,
        params: request.params || {},
        constraints: quoted.request?.constraints || request.constraints || {},
        budget: normalizedBudget,
        consumer_context: request.consumer_context || {}
      },
      routingObservation: canonicalResult?.routing_observation || null,
      routingSummary: canonicalResult?.routing_observation
        ? terminalRoutingSummary(canonicalResult, quoted, request)
        : null
    }));
  } catch (error) {
    return withTiming(mergeCanonicalResult(canonicalResult, {
      ...quoted,
      ok: false,
      status: error.status || error.code || "local_paid_invocation_failed",
      data_returned: false,
      error: error.message,
      retryable: Boolean(error.retryable),
      wallet: error.wallet || null,
      arc_rpc: error.arc_rpc || null,
      action_required: error.status === "arc_payment_unavailable" ? "fix_arc_rpc_or_retry" : undefined,
      upstream_status: error.upstreamStatus || null,
      payload: error.payload || null
    }), timing);
  }

  const manifest = await timing.measure("get_manifest_ms", () => connector.getManifest(serviceId));
  const verification = timing.measureSync("verify_result_ms", () => verifyServiceResult({
    result: invocation.result,
    manifest,
    intent: request.params || {},
    constraints: request.constraints || {}
  }));
  const compactResult = createCompactResult({
    result: invocation.result,
    verification,
    quote: quoted.quote,
    feedback: invocation.feedback,
    evidence: invocation.evidence_recording?.evidence,
    request,
    input: quoted.input
  });

  const executionStatus = "paid_with_local_wallet";
  return withTiming(mergeCanonicalResult(canonicalResult, {
    ...quoted,
    ok: true,
    status: compatibilityStatus === "route_with_assumption"
      ? compatibilityStatus
      : executionStatus,
    execution_status: executionStatus,
    protocol: {
      protocol_version: "agent_router_request_v1",
      semantic_parser: "external_main_agent",
      router_responsibility: "schema_validation_routing_quote_local_payment_invocation_verification_evidence"
    },
    result: invocation.result,
    compact_result: compactResult,
    local_payment: invocation.local_payment,
    evidence_recording: invocation.evidence_recording,
    routing_observation: invocation.evidence_recording?.routing_observation || undefined,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    feedback_required: Boolean(invocation.evidence_recording?.consumer_feedback_request),
    next_required_action: invocation.evidence_recording?.consumer_feedback_request
      ? "After using this result in the final answer, call agentrouter_feedback with this request_id."
      : null,
    verification,
    data_returned: invocation.result?.status === "success"
  }), timing);
}

function terminalRoutingSummary(canonicalResult, quoted, request) {
  const plan = canonicalResult?.route_plan || {};
  const selectedServiceId = quoted?.selected_service?.service_id || null;
  return {
    task_family: plan.task_family || "unknown",
    route_family: plan.route_family || "registered_service",
    capability: plan.capability || request?.capability || "unknown",
    source_family: plan.route_family === "registered_service" ? "registry" : "unknown",
    action: "route",
    selected_service_id: selectedServiceId,
    candidate_sources: Array.isArray(plan.candidate_sources) ? plan.candidate_sources : [],
    budget: {
      max_price_usdc: plan.budget_gate?.max_price_usdc ?? request?.constraints?.max_price_usdc ?? null,
      selected_price_usdc: quoted?.quote?.amount || quoted?.quote?.pricing?.amount || null,
      compliant: true
    },
    authorization: { required: false, action: "none", source: null }
  };
}

function mergeCanonicalResult(canonicalResult = {}, payload = {}) {
  const routedPlan = mergedRoutePlan(canonicalResult.route_plan, payload.route_plan, payload);
  const routedObservation = mergedRoutingObservation(canonicalResult.routing_observation, routedPlan, payload);
  return {
    ...canonicalResult,
    ...payload,
    route_plan: routedPlan,
    routing_observation: routedObservation
  };
}

function normalizedRequestBudget({ constraints = {}, budget = {} } = {}) {
  const explicitMaxAmount = Object.hasOwn(constraints, "max_price_usdc") || Object.hasOwn(budget, "max_amount");
  const explicitCurrency = Object.hasOwn(budget, "currency");
  return {
    max_amount: constraints.max_price_usdc ?? budget.max_amount ?? "0.05",
    currency: budget.currency || "USDC",
    explicitMaxAmount,
    explicitCurrency
  };
}

function withTiming(payload, timing) {
  return {
    ...payload,
    timing: timing.snapshot()
  };
}

function mergedRoutePlan(canonicalPlan, payloadPlan, payload = {}) {
  if (payloadPlan) return payloadPlan;
  if (!canonicalPlan) return payloadPlan || null;
  const terminalStatus = payload.execution_status || payload.status;
  if (!isLocalWalletTerminalStatus(terminalStatus)) return canonicalPlan;
  const quoteBlocked = terminalStatus === "quote_blocked";
  return {
    ...canonicalPlan,
    auth_requirement: {
      required: false,
      kind: "none",
      source: null
    },
    ...(quoteBlocked
      ? {
          budget_gate: {
            ...(canonicalPlan.budget_gate || {}),
            paid_calls_allowed: false,
            status: "blocked"
          },
          abstain_reason: "budget_exceeded",
          must_not_fallback: true
        }
      : {})
  };
}

function mergedRoutingObservation(canonicalObservation, routePlan, payload = {}) {
  if (payload.routing_observation) return payload.routing_observation;
  if (!canonicalObservation) return null;
  const terminalStatus = payload.execution_status || payload.status;
  if (!isLocalWalletTerminalStatus(terminalStatus)) return canonicalObservation;
  return summarizeRouteObservation(createRouteObservationV2({
    observation_id: `route_obs_local_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
    request_id: canonicalObservation.request_id || `route_req_local_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
    created_at: new Date().toISOString(),
    entrypoint: "local_wallet",
    task_family: routePlan?.task_family || "unknown",
    route_family: routePlan?.route_family || canonicalObservation.route_family || "registered_service",
    capability: routePlan?.capability || canonicalObservation.capability || "unknown",
    source_family: routePlan?.route_family === "registered_service" ? "registry" : "unknown",
    action: routeObservationActionForStatus(terminalStatus),
    selected_service_id: payload.selected_service?.service_id || payload.service_id || null,
    candidates: payload.selected_service?.service_id
      ? [{
          service_id: payload.selected_service.service_id,
          source_family: routePlan?.route_family === "registered_service" ? "registry" : "unknown",
          routing_score: 1,
          price_usdc: payload.quote?.amount || payload.quote?.pricing?.amount || null
        }]
      : [],
    confidence: routePlan?.confidence ?? null,
    fallback: {
      used: false,
      from: null,
      to: null,
      reason: null
    },
    authorization: {
      required: false,
      action: "none",
      source: null
    },
    budget: {
      max_price_usdc: routePlan?.budget_gate?.max_price_usdc ?? null,
      selected_price_usdc: payload.quote?.amount || payload.quote?.pricing?.amount || null,
      compliant: terminalStatus === "paid_with_local_wallet" ? true : null
    },
    routing_policy_version: routePlan?.schema_version || null,
    diagnostics: {
      local_wallet_execution: true,
      terminal_status: terminalStatus
    }
  }));
}

function routeObservationActionForStatus(status) {
  if (status === "paid_with_local_wallet") return "route";
  if (status === "quote_blocked" || status === "selected_service_missing" || status === "structured_route_failed") return "no_match";
  return "route";
}

function isLocalWalletTerminalStatus(status) {
  return typeof status === "string" && [
    "paid_with_local_wallet",
    "quote_blocked",
    "selected_service_missing",
    "local_paid_invocation_failed",
    "provider_unavailable_before_payment",
    "payment_challenge_unavailable",
    "provider_prepay_validation_failed",
    "arc_payment_unavailable",
    "wallet_needs_funding",
    "structured_route_failed"
  ].includes(status);
}

function summarizeRouteObservation(observation) {
  if (!observation) return null;
  return {
    observation_id: observation.observation_id,
    request_id: observation.request_id,
    action: observation.action,
    route_family: observation.route_family,
    capability: observation.capability,
    durability_status: "memory_only",
    feedback_endpoint: null
  };
}

async function routeTokenSmartMoneyActivityWithLocalWallet({ baseUrl, connector, task, intent, constraints, budget, timing }) {
  const maxAmount = constraints.max_price_usdc ?? budget.max_amount ?? "0.05";
  const currency = budget.currency || "USDC";
  const tokenResolution = await resolveTokenWithLocalWallet({
    connector,
    baseUrl,
    task,
    intent,
    maxAmount,
    currency,
    timing
  });
  if (tokenResolution?.ok === false) {
    return {
      ok: false,
      status: tokenResolution.status,
      task,
      token_resolution: tokenResolution,
      data_returned: false,
      timing: timing.snapshot()
    };
  }

  const params = {
    ...intent.input,
    token_address: tokenResolution.token_address,
    chain: tokenResolution.chain || intent.input.chain
  };
  const request = {
    capability: "token_smart_money_activity",
    params,
    constraints: {
      ...constraints,
      max_price_usdc: maxAmount,
      freshness_seconds: constraints.freshness_seconds || 300
    },
    budget: {
      max_amount: maxAmount,
      currency
    },
    consumer_context: {
      source: "agentrouter_mcp_local_wallet",
      task,
      token_resolution: publicTokenResolution(tokenResolution)
    }
  };
  const attempted = [];
  const excluded = [];
  let quote;
  let invocation;
  while (attempted.length < 3) {
    quote = await timing.measure(`quote_route_attempt_${attempted.length + 1}_ms`, () => postJson(baseUrl, "/agent-router/quote", {
      ...request,
      constraints: {
        ...request.constraints,
        exclude_service_ids: excluded
      }
    }));
    if (!quote.ok) {
      return {
        ...quote,
        task,
        token_resolution: publicTokenResolution(tokenResolution),
        attempted_services: attempted,
        data_returned: false,
        timing: timing.snapshot()
      };
    }

    const serviceId = quote.selected_service.service_id;
    try {
      invocation = await timing.measure(`local_paid_invoke_attempt_${attempted.length + 1}_ms`, () => invokePaidServiceWithLocalWallet({
        baseUrl,
        serviceId,
        input: quote.input,
        budget: {
          max_amount: maxAmount,
          currency
        },
        request
      }));
      break;
    } catch (error) {
      const failure = {
        service_id: serviceId,
        status: error.status || error.code || "local_paid_invocation_failed",
        error: error.message,
        retryable: Boolean(error.retryable),
        arc_rpc: error.arc_rpc || null,
        upstream_status: error.upstreamStatus || null
      };
      attempted.push(failure);
      if (!error.retryable || excluded.includes(serviceId)) {
        return {
          ...quote,
          ok: false,
          status: failure.status,
          task,
          token_resolution: publicTokenResolution(tokenResolution),
          attempted_services: attempted,
          data_returned: false,
          error: error.message,
          retryable: Boolean(error.retryable),
          arc_rpc: error.arc_rpc || null,
          action_required: error.status === "arc_payment_unavailable" ? "fix_arc_rpc_or_retry" : undefined,
          upstream_status: error.upstreamStatus || null,
          timing: timing.snapshot()
        };
      }
      excluded.push(serviceId);
    }
  }
  if (!invocation) {
    return {
      ...quote,
      ok: false,
      status: "all_candidate_services_failed",
      task,
      token_resolution: publicTokenResolution(tokenResolution),
      attempted_services: attempted,
      data_returned: false,
      timing: timing.snapshot()
    };
  }

  const manifest = await timing.measure("get_manifest_ms", () => connector.getManifest(quote.selected_service.service_id));
  const verification = timing.measureSync("verify_result_ms", () => verifyServiceResult({
    result: invocation.result,
    manifest,
    intent: params,
    constraints
  }));

  return {
    ok: true,
    status: "paid_with_local_wallet",
    execution_status: "paid_with_local_wallet",
    task,
    request: quote.request,
    selected_service: quote.selected_service,
    candidates_considered: quote.candidates_considered,
    candidates: quote.candidates,
    input: quote.input,
    quote: quote.quote,
    token_resolution: publicTokenResolution(tokenResolution),
    result: invocation.result,
    local_payment: invocation.local_payment,
    attempted_services: attempted,
    evidence_recording: invocation.evidence_recording,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    verification,
    timing: timing.snapshot()
  };
}

async function resolveTokenWithLocalWallet({ connector, baseUrl, task, intent, maxAmount, currency, timing }) {
  if (intent.input.token_address) return null;
  const tokenSymbol = intent.input.token_symbol || intent.token;
  if (!tokenSymbol) {
    return {
      ok: false,
      status: "token_symbol_required",
      message: "token_smart_money_activity requires token_symbol or token_address."
    };
  }
  const services = await timing.measure("token_resolver_search_ms", () => connector.searchServices({
    query: "token search",
    verified_only: true,
    max_price: maxAmount
  }));
  const resolver = pickTokenResolver(services);
  if (!resolver) {
    return {
      ok: false,
      status: "token_resolver_not_found",
      token_symbol: tokenSymbol,
      message: "No token resolver service is registered."
    };
  }
  const chain = normalizeProviderChain(intent.input.chain || intent.chain || "ethereum");
  const resolverInput = {
    search_query: tokenSymbol,
    result_type: "token",
    chain,
    limit: 5
  };
  let invocation;
  try {
    invocation = await timing.measure("token_resolve_invoke_ms", () => invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId: resolver.service_id,
      input: resolverInput,
      budget: {
        max_amount: maxAmount,
        currency
      },
      request: {
        capability: "token_resolution",
        params: resolverInput,
        constraints: {
          max_price_usdc: maxAmount,
          currency
        },
        consumer_context: {
          source: "agentrouter_mcp_local_wallet",
          parent_task: task,
          parent_capability: "token_smart_money_activity"
        }
      }
    }));
  } catch (error) {
    return {
      ok: false,
      status: error.status || error.code || "token_resolution_failed",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      error: error.message,
      retryable: Boolean(error.retryable),
      arc_rpc: error.arc_rpc || null,
      action_required: error.status === "arc_payment_unavailable" ? "fix_arc_rpc_or_retry" : undefined,
      upstream_status: error.upstreamStatus || null
    };
  }
  const match = findTokenMatch(invocation.result?.data, { tokenSymbol, chain });
  if (!match?.address) {
    return {
      ok: false,
      status: "token_not_found",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      message: "Token resolver did not return a matching contract address."
    };
  }
  const resolution = describeTokenResolution({
    requestedSymbol: tokenSymbol,
    matchedSymbol: match.symbol,
    matchedName: match.name,
    chain: match.chain || chain
  });
  if (!resolution.auto_pay_allowed) {
    return {
      ok: false,
      status: "token_resolution_ambiguous",
      token_symbol: tokenSymbol,
      token_address: match.address,
      chain: match.chain || chain,
      matched_name: match.name || null,
      matched_symbol: match.symbol || null,
      asset_resolution: resolution,
      requested_symbol: resolution.requested_symbol,
      resolved_symbol: resolution.resolved_symbol,
      resolution_type: resolution.resolution_type,
      confidence: resolution.confidence,
      match_strategy: match.match_strategy || null,
      candidate_count: match.candidate_count ?? null,
      auto_pay_allowed: resolution.auto_pay_allowed,
      blocking_reason: resolution.blocking_reason,
      requires_disclosure: resolution.requires_disclosure,
      disclosure: resolution.disclosure,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      message: resolution.blocking_reason
    };
  }
  return {
    ok: true,
    status: "resolved",
    token_symbol: tokenSymbol,
    token_address: match.address,
    chain: match.chain || chain,
    matched_name: match.name || null,
    matched_symbol: match.symbol || null,
    asset_resolution: resolution,
    requested_symbol: resolution.requested_symbol,
    resolved_symbol: resolution.resolved_symbol,
    resolution_type: resolution.resolution_type,
    confidence: resolution.confidence,
    match_strategy: match.match_strategy || null,
    candidate_count: match.candidate_count ?? null,
    requires_disclosure: resolution.requires_disclosure,
    disclosure: resolution.disclosure,
    resolver_service_id: resolver.service_id,
    resolver_input: resolverInput,
    resolver_evidence_recording: invocation.evidence_recording
  };
}

function pickTokenResolver(services) {
  return [...(services || [])]
    .map((service) => ({ service, score: tokenResolverScore(service) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.service || null;
}

function tokenResolverScore(service) {
  const text = serviceSearchHaystack(service);
  let score = 0;
  if (/token[_\s-]?search|entity[_\s-]?search|resolver/.test(text)) score += 5;
  if (/token[_\s-]?metadata|token[_\s-]?data/.test(text)) score += 2;
  if (/search/.test(text)) score += 1;
  return score;
}

function serviceSearchHaystack(service) {
  return [
    service?.service_id,
    service?.title,
    service?.description_for_agent,
    ...(service?.capabilities || [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function findTokenMatch(data, { tokenSymbol, chain }) {
  const candidates = flattenObjects(data)
    .map((item) => ({
      address: item.token_address || item.address || item.contract_address || item.contract,
      symbol: item.symbol || item.token_symbol || item.ticker,
      name: item.name || item.token_name,
      chain: item.chain || item.network ? normalizeProviderChain(item.chain || item.network) : null
    }))
    .filter((item) => item.address);
  const normalized = String(tokenSymbol || "").toLowerCase();
  const targetChain = normalizeProviderChain(chain);
  // A missing or mismatched chain is not evidence that the returned contract
  // belongs to the requested network. Never pay a second provider based on a
  // guessed cross-chain token match.
  const sameChain = candidates.filter((item) => item.chain === targetChain);
  const exact = sameChain.find((item) => String(item.symbol || "").toLowerCase() === normalized);
  if (exact) return { ...exact, match_strategy: "exact_symbol", candidate_count: candidates.length };
  const wrapped = sameChain.find((item) => String(item.symbol || "").toLowerCase() === `w${normalized}`);
  if (wrapped) return { ...wrapped, match_strategy: "wrapped_symbol", candidate_count: candidates.length };
  const name = sameChain.find((item) => String(item.name || "").toLowerCase().includes(normalized));
  if (name) return { ...name, match_strategy: "name_contains_symbol", candidate_count: candidates.length };
  const fallback = sameChain[0] || null;
  return fallback ? { ...fallback, match_strategy: "first_candidate", candidate_count: candidates.length } : null;
}

function describeTokenResolution({ requestedSymbol, matchedSymbol, matchedName, chain }) {
  const requested = String(requestedSymbol || "").toUpperCase();
  const resolved = String(matchedSymbol || "").toUpperCase() || null;
  const name = String(matchedName || "");
  const exact = Boolean(requested && resolved && requested === resolved);
  const wrappedLike = Boolean(
    requested &&
    !exact &&
    (
      resolved === `W${requested}` ||
      /\bwrapped\b/i.test(name) ||
      new RegExp(`\\bw${escapeRegExp(requested)}\\b`, "i").test(`${resolved} ${name}`)
    )
  );
  const resolutionType = exact
    ? "exact_symbol"
    : wrappedLike
      ? "wrapped_token_substitution"
      : "symbol_substitution";
  const requiresDisclosure = resolutionType !== "exact_symbol";
  const scope = resolutionType === "wrapped_token_substitution"
    ? "wrapped-token / EVM contract data, not native asset, CEX, or perpetual-market data"
    : "a substituted token match, not an exact ticker match";
  return {
    requested_symbol: requested || null,
    resolved_symbol: resolved,
    matched_name: name || null,
    chain: chain || null,
    resolution_type: resolutionType,
    confidence: exact ? 1 : wrappedLike ? 0.92 : 0.45,
    auto_pay_allowed: exact || wrappedLike,
    blocking_reason: exact || wrappedLike
      ? null
      : `Token resolver matched ${resolved || name || "a different token"} for requested ${requested || "token"}. AgentRouter will not auto-pay for symbol substitutions.`,
    requires_disclosure: requiresDisclosure,
    disclosure: requiresDisclosure
      ? `Requested ${requested || "token"}; resolver selected ${resolved || name || "a token candidate"}${chain ? ` on ${chain}` : ""}. Treat the result as ${scope}.`
      : null
  };
}

function publicTokenResolution(tokenResolution) {
  if (!tokenResolution) return null;
  return {
    ok: tokenResolution.ok,
    status: tokenResolution.status,
    token_symbol: tokenResolution.token_symbol,
    token_address: tokenResolution.token_address,
    chain: tokenResolution.chain,
    matched_name: tokenResolution.matched_name || null,
    matched_symbol: tokenResolution.matched_symbol || null,
    asset_resolution: tokenResolution.asset_resolution || null,
    requested_symbol: tokenResolution.requested_symbol || tokenResolution.token_symbol || null,
    resolved_symbol: tokenResolution.resolved_symbol || tokenResolution.matched_symbol || null,
    resolution_type: tokenResolution.resolution_type || null,
    confidence: tokenResolution.asset_resolution?.confidence ?? null,
    match_strategy: tokenResolution.match_strategy || null,
    candidate_count: tokenResolution.candidate_count ?? null,
    auto_pay_allowed: tokenResolution.asset_resolution?.auto_pay_allowed ?? null,
    blocking_reason: tokenResolution.asset_resolution?.blocking_reason || null,
    requires_disclosure: Boolean(tokenResolution.requires_disclosure),
    disclosure: tokenResolution.disclosure || null,
    resolver_service_id: tokenResolution.resolver_service_id || null,
    resolver_request_id: tokenResolution.resolver_evidence_recording?.request_id || null,
    resolver_input: tokenResolution.resolver_input || null
  };
}

function normalizeProviderChain(chain) {
  const normalized = String(chain || "").toLowerCase();
  if (normalized === "bsc") return "bnb";
  if (["hyperliquid", "hyper-evm", "hyper evm", "hype"].includes(normalized)) return "hyperevm";
  return normalized || "ethereum";
}

function flattenObjects(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, out);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) flattenObjects(child, out);
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs())
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function postJsonAllowPayment(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs())
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`HTTP ${response.status} returned non-JSON response.`);
    error.status = response.status;
    error.payload = { raw: text.slice(0, 500) };
    throw error;
  }
  if (!response.ok && response.status !== 402) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function httpTimeoutMs() {
  return Number(process.env.AGENT_ROUTER_HTTP_TIMEOUT_MS || 15000);
}

function createRouteTiming() {
  const started = Date.now();
  const traceId = `trace_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const spans = {};
  return {
    async measure(name, fn) {
      const spanStarted = Date.now();
      try {
        return await fn();
      } finally {
        spans[name] = Date.now() - spanStarted;
      }
    },
    measureSync(name, fn) {
      const spanStarted = Date.now();
      try {
        return fn();
      } finally {
        spans[name] = Date.now() - spanStarted;
      }
    },
    snapshot() {
      const phases = Object.fromEntries(
        Object.entries(spans).map(([name, durationMs]) => [name.replace(/_ms$/, ""), { duration_ms: durationMs }])
      );
      return {
        trace_id: traceId,
        ...spans,
        phases,
        total_ms: Date.now() - started
      };
    }
  };
}
