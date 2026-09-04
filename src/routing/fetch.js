import { askAgentRouter } from "../agent-router.js";
import { agentRouterConnectionRequired } from "../agentrouter-connection.js";
import {
  getExternalApiCatalog,
  inferExternalApiRequest,
  runExternalApiQuery
} from "../external-api-capability.js";
import { writePersistentServiceEvent } from "../persistence.js";
import { quoteCapabilityRequest, routeCapabilityRequest } from "../router.js";
import { findSocialPostUrl, runSocialPostReadCapability } from "../social-post-read.js";
import {
  buildLocalBrowserHandoff,
  hasNativeBrowserCapability
} from "../local-browser-connector.js";
import { socialProvidersForUser } from "../social-connections.js";
import { requestPaymentRequired } from "./http-boundary.js";
import {
  attachCanonicalRouteObservation,
  canonicalRoutePlan,
  canonicalStructuredBatchRoutePlan,
  canonicalStructuredRoutePlan,
  localBrowserRouteRequired,
  requestHasExplicitBudget,
  structuredRoutePreflight
} from "./runtime.js";

export async function runRemoteAgentRouterFetch(store, args = {}, {
  invoke = true,
  consumerApiKey = "",
  ownerKey = "",
  socialConnectionOptions = {},
  socialProviderFactory = socialProvidersForUser,
  writeEvent = writePersistentServiceEvent
} = {}) {
  const invokeRegisteredService = invoke && args.execution_mode !== "local_wallet_preflight";
  let requirements = Array.isArray(args.data_requirements) ? args.data_requirements : [];
  const task = String(args.task || args.query || "").trim();
  const maxPrice = args.max_price ?? args.constraints?.max_price_usdc ?? args.budget?.max_amount ?? "0.05";
  const currency = args.currency || args.budget?.currency || "USDC";
  const outerBudgetExplicit = requestHasExplicitBudget(args);

  const connectedSources = requirements.length ? [] : getExternalApiCatalog(store, ownerKey)
    .filter((item) => item.connected === true)
    .map((item) => item.source);
  let routePlan = !requirements.length && task
    ? canonicalRoutePlan(store, task, { ownerKey, maxPrice, budgetExplicit: outerBudgetExplicit })
    : null;
  routePlan = withDeclaredNativeBrowserSession(routePlan, args.consumer_context);
  if (requirements.length) {
    const structuredRequests = requirements.map((requirement) =>
      requirementToCapabilityRequest(requirement, args, { maxPrice, currency })
    );
    routePlan = canonicalStructuredBatchRoutePlan(store, structuredRequests, {
      ownerKey,
      budgetExplicit: outerBudgetExplicit || requirements.some((requirement) => requestHasExplicitBudget(requirement))
    });
  }
  const complete = (result) => attachCanonicalRouteObservation(store, result, {
    plan: routePlan,
    entrypoint: "fetch",
    actorKey: ownerKey,
    writeEvent
  });

  if (!requirements.length) {
    const socialPost = findSocialPostUrl(task);
    if (socialPost) {
      const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
      return complete(await runSocialPostReadCapability(
        { url: socialPost.canonical_url, platform: socialPost.platform },
        { providers, consumerContext: args.consumer_context }
      ));
    }
    if (routePlan?.abstain_reason === "source_not_callable") {
      return complete(structuredRoutePreflight(routePlan));
    }
    if (routePlan?.route_family === "local_browser") {
      const nativeHandoff = nativeBrowserRouteHandoff(routePlan, args.consumer_context, task);
      if (nativeHandoff) return complete(nativeHandoff);
      return complete(localBrowserRouteRequired(routePlan));
    }
    if (routePlan?.route_family === "external_api" && !routePlan.abstain_reason) {
      const inferredRequest = inferExternalApiRequest(task, {
        connectedSources,
        tier: "all"
      });
      requirements = [{
        ...(inferredRequest || {}),
        capability: "external_api_query",
        params: {
          ...routePlan.params,
          ...(inferredRequest?.params || {}),
          source: routePlan.params?.source || inferredRequest?.params?.source,
          operation: routePlan.params?.operation || inferredRequest?.params?.operation
        }
      }];
    }
    if (!requirements.length && !routePlan) {
      const externalApiRequest = inferExternalApiRequest(task, {
        connectedSources,
        tier: "specialized"
      });
      if (externalApiRequest) requirements = [externalApiRequest];
    }
  }

  if (!requirements.length) {
    const routed = await askAgentRouter(store, {
      task,
      max_price: maxPrice,
      currency,
      invoke: invokeRegisteredService,
      consumerApiKey,
      routePlan
    });
    if (routed?.status !== "no_service_found" || routePlan?.must_not_fallback === true) return complete(routed);
    const webSearch = inferExternalApiRequest(task, {
      connectedSources,
      tier: "web"
    });
    if (!webSearch) return complete(routed);
    requirements = [webSearch];
  }

  const researchPlans = requirements
    .map((requirement) => requirement?.research_plan)
    .filter((plan) => plan && typeof plan === "object");
  const results = [];
  for (const requirement of requirements) {
    const request = requirementToCapabilityRequest(requirement, args, { maxPrice, currency });
    if (!request.capability) {
      results.push({
        ok: false,
        status: "invalid_requirement",
        requirement,
        message: "Each data requirement needs capability or type."
      });
      continue;
    }
    if (request.capability === "social_post_read") {
      const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
      results.push(await runSocialPostReadCapability(request.params, { providers, consumerContext: request.consumer_context }));
      continue;
    }
    if (request.capability === "external_api_query") {
      const requestPlan = canonicalStructuredRoutePlan(store, request, {
        ownerKey,
        budgetExplicit: outerBudgetExplicit || requestHasExplicitBudget(requirement)
      });
      const preflight = structuredRoutePreflight(requestPlan);
      if (preflight) {
        results.push(preflight);
        continue;
      }
      const sourceDefinition = getExternalApiCatalog(store, ownerKey)
        .find((item) => item.source === String(request.params?.source || "").toLowerCase());
      if (!ownerKey && sourceDefinition?.connection_required === true) {
        results.push(agentRouterConnectionRequired());
      } else {
        results.push(await runExternalApiQuery(store, ownerKey, request.params, socialConnectionOptions));
      }
      continue;
    }
    if (invokeRegisteredService) {
      results.push(await routeCapabilityRequest(store, request, { consumerApiKey }));
    } else {
      results.push(requestPaymentRequired(quoteCapabilityRequest(store, request)));
    }
  }
  const successful = results.filter(resultReturnedUsableData);
  const unsatisfied = results.filter((result) => !resultReturnedUsableData(result));
  const allPaymentRequired = unsatisfied.length === results.length && unsatisfied.every((result) => result?.status === "payment_required");
  const allQuoteRequired = unsatisfied.length === results.length && unsatisfied.every((result) => result?.status === "quote_required");
  const connectionRequired = unsatisfied.find((result) => result?.status === "connection_required");
  const sourceRequired = unsatisfied.filter((result) =>
    result?.status === "source_credentials_required" || result?.connection_action?.preferred_tool === "agentrouter_connect_source");
  const sourceActions = sourceRequired.map((result) => ({
    source: result?.source?.source || result?.source || result?.connection_action?.tool_arguments?.source || null,
    status: result.status,
    connection_action: result.connection_action,
    message: result.message || result.error?.message || null
  }));
  const feedbackRequired = results.some((result) => result?.consumer_feedback_request);
  return complete({
    ok: unsatisfied.length === 0,
    status: connectionRequired && !successful.length
      ? "connection_required"
      : sourceRequired.length && !successful.length
        ? "source_credentials_required"
      : allQuoteRequired
        ? "quote_required"
      : allPaymentRequired
        ? "payment_required"
        : unsatisfied.length
          ? (successful.length ? "partial_data_returned" : "no_data_returned")
          : "data_returned",
    protocol: {
      protocol_version: "agentrouter_fetch_v1",
      external_contract: "single_agent_data_call",
      internal_steps: "discovery_routing_quote_payment_invocation_verification_evidence_feedback"
    },
    task: task || null,
    data_requirements_count: requirements.length,
    data_returned_count: successful.length,
    results,
    compact_results: results.map((result) => result?.compact_result || null).filter(Boolean),
    ...(researchPlans.length ? { research_plans: researchPlans } : {}),
    ...(sourceActions.length ? {
      connection_action: sourceActions[0].connection_action,
      source_actions: sourceActions,
      retry_original_request_after_connection: true,
      do_not_fallback_outside_agentrouter: true
    } : {}),
    ...(connectionRequired ? {
      action_required: connectionRequired.action_required,
      retry_original_request_after_connection: true,
      do_not_fallback_outside_agentrouter: true
    } : {}),
    feedback_required: feedbackRequired,
    next_required_action: connectionRequired?.action_required || sourceActions[0]?.connection_action || (feedbackRequired
      ? "After using these results in the final answer, submit agentrouter_feedback for each returned request_id."
      : null)
  });
}

export function nativeBrowserRouteHandoff(routePlan, consumerContext, task) {
  const platform = routePlan.params?.platform
    || routePlan.candidate_sources?.[0]
    || routePlan.source_constraint;
  const operation = String(routePlan.params?.operation || "search").trim().toLowerCase();
  if (!platform || !hasNativeBrowserCapability(consumerContext, operation)) return null;
  const params = {
    ...routePlan.params,
    platform,
    operation,
    query: routePlan.params?.query || (operation === "search" ? task : undefined)
  };
  const target = params.url || params.target;
  const handoff = buildLocalBrowserHandoff({
    platform,
    operation,
    target,
    params,
    consumerContext
  });
  return {
    ok: false,
    status: "local_connector_required",
    request: handoff.request,
    action_required: {
      code: "LOCAL_BROWSER_EXECUTION_REQUIRED",
      interaction_kind: "browser_execution",
      authorization_kind: "none",
      requires_user_authorization: false,
      uses_existing_browser_session: true,
      message: "Use the AI client's built-in browser for this read-only request, then return structured public evidence through agentrouter_complete_handoff.",
      reload_after_bridge_update: false
    },
    handoff,
    fallback_allowed: false,
    local_execution_plan: {
      protocol_version: "agentrouter_local_social_task_v2",
      platform,
      operation,
      params,
      execution_location: "user_device",
      permissions: { access: "read_only", write_actions: "denied" },
      data_policy: { credentials: "never_upload", raw_results: "never_upload" }
    }
  };
}

function withDeclaredNativeBrowserSession(routePlan, consumerContext) {
  if (routePlan?.route_family !== "local_browser") return routePlan;
  const operation = String(routePlan.params?.operation || (routePlan.task_family === "social_post_read" ? "read_post" : "search"));
  if (!hasNativeBrowserCapability(consumerContext, operation)) return routePlan;
  return {
    ...routePlan,
    auth_requirement: { required: false, kind: "none", source: null }
  };
}

export function resultReturnedUsableData(result) {
  if (!result || result.ok === false || result.status === "no_results") return false;
  const value = result.result;
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "object") return true;
  if (Array.isArray(value.items)) return value.items.length > 0;
  if (Number.isFinite(Number(value.count))) return Number(value.count) > 0;
  if (value.data !== undefined) {
    if (Array.isArray(value.data)) return value.data.length > 0;
    return value.data !== null && value.data !== "";
  }
  return Object.keys(value).length > 0;
}

export function requirementToCapabilityRequest(requirement = {}, args = {}, { maxPrice, currency }) {
  const {
    capability,
    type,
    params,
    constraints,
    budget,
    consumer_context: consumerContext,
    research_plan: _researchPlan,
    ...inlineParams
  } = requirement;
  const cleanInlineParams = {};
  for (const [key, value] of Object.entries(inlineParams)) {
    if (value !== undefined && value !== null) cleanInlineParams[key] = value;
  }
  return {
    capability: capability || type,
    params: params && typeof params === "object" ? params : cleanInlineParams,
    constraints: {
      ...(args.constraints || {}),
      ...(constraints || {}),
      max_price_usdc: constraints?.max_price_usdc ?? args.constraints?.max_price_usdc ?? maxPrice
    },
    budget: {
      ...(args.budget || {}),
      ...(budget || {}),
      max_amount: budget?.max_amount ?? args.budget?.max_amount ?? maxPrice,
      currency: budget?.currency || args.budget?.currency || currency
    },
    consumer_context: {
      ...(args.consumer_context || {}),
      ...(consumerContext || {}),
      source: consumerContext?.source || args.consumer_context?.source || "agentrouter_fetch_remote_mcp"
    }
  };
}
