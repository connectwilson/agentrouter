import { agentRouterConnectionRequired } from "../agentrouter-connection.js";
import {
  freeLocalAlternative,
  getExternalApiCatalog,
  runExternalApiQuery
} from "../external-api-capability.js";
import { quoteCapabilityRequest, routeCapabilityRequest } from "../router.js";
import { runSocialResearchCapability } from "../research-capability.js";
import { runSocialPostReadCapability } from "../social-post-read.js";
import { socialProvidersForUser } from "../social-connections.js";
import {
  attachCanonicalRouteObservation,
  canonicalStructuredRoutePlan,
  structuredRoutePreflight
} from "./runtime.js";
import { runRemoteAgentRouterFetch } from "./fetch.js";
import {
  externalApiStatusCode,
  paymentBoundaryStatusCode,
  requestPaymentRequired
} from "./http-boundary.js";

export async function executeAgentRouterRequest(store, body, {
  ownerKey = "",
  actorKey = ownerKey,
  invoke = true,
  consumerApiKey = "",
  socialConnectionOptions = {},
  socialProviderFactory = socialProvidersForUser,
  socialResearchRunner = runSocialResearchCapability,
  allowHostedSocialResearchRunner = false,
  writeEvent
} = {}) {
  const invokeRegisteredService = invoke && body.execution_mode !== "local_wallet_preflight";
  const routePlan = canonicalStructuredRoutePlan(store, body, { ownerKey });
  const complete = (result) => attachCanonicalRouteObservation(store, result, {
    plan: routePlan,
    entrypoint: "request",
    actorKey: ownerKey,
    writeEvent
  });

  if (body.capability === "external_api_query") {
    const source = String(body.params?.source || "").toLowerCase();
    const sourceDefinition = getExternalApiCatalog(store, ownerKey).find((item) => item.source === source);
    const preflight = structuredRoutePreflight(routePlan);
    if (preflight) return response(externalApiStatusCode(preflight), await complete(preflight));
    if (!ownerKey && sourceDefinition?.connection_required === true) {
      const alternative = freeLocalAlternative(source, body.params || {});
      const result = {
        ...agentRouterConnectionRequired(),
        ...(alternative ? { free_alternative: alternative, recommended_action: "use_free_local_alternative" } : {})
      };
      return response(401, await complete(result));
    }
    const result = await runExternalApiQuery(store, ownerKey, body.params || {}, socialConnectionOptions);
    return response(externalApiStatusCode(result), await complete(result));
  }

  if (body.capability === "social_user_voice_research") {
    const preflight = structuredRoutePreflight(routePlan);
    if (preflight && !allowHostedSocialResearchRunner) {
      return response(externalApiStatusCode(preflight), await complete(preflight));
    }
    const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
    const result = await socialResearchRunner(body.params || {}, { searchOptions: { localOptions: { providers } } });
    return response(result.status === "invalid_request" ? 422 : 200, await complete(result));
  }

  if (body.capability === "social_post_read") {
    const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
    const result = await runSocialPostReadCapability(body.params || {}, {
      providers,
      consumerContext: body.consumer_context
    });
    return response(result.status === "invalid_request" ? 422 : 200, await complete(result));
  }

  if (!invokeRegisteredService) {
    const payload = requestPaymentRequired(quoteCapabilityRequest(store, body, { actorKey }));
    return response(paymentBoundaryStatusCode(payload), await complete(payload));
  }

  const result = await routeCapabilityRequest(store, body, {
    invoke: invokeRegisteredService,
    consumerApiKey,
    ownerKey
  });
  return response(result.ok === false && result.status === "invalid_request" ? 422 : 200, await complete(result));
}

export async function executeAgentRouterFetch(store, body, options = {}) {
  const payload = await runRemoteAgentRouterFetch(store, body, options);
  return response(paymentBoundaryStatusCode(payload), payload);
}

function response(statusCode, payload) {
  return { statusCode, payload };
}
