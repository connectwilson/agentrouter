import { agentRouterConnectionRequired, isAgentRouterCreditsQuote } from "../agentrouter-connection.js";
import { currentPaymentBackend } from "../payment-adapter.js";

export function externalApiStatusCode(result) {
  if (result?.ok !== false) return 200;
  if (result.status === "local_browser_handoff_required") return 200;
  if (["invalid_request", "unsupported_source", "unsupported_operation", "source_not_callable"].includes(result.status)) return 422;
  if (result.status === "connection_required" || result.status === "auth_required") return 401;
  if (result.status === "quote_required") return 402;
  if (result.status === "rate_limited") return 429;
  if (result.status === "provider_error") return 502;
  return 400;
}

export function requestPaymentRequired(result) {
  if (!result.ok && result.status !== "quote_blocked") return result;
  const response = {
    ...result,
    ok: false,
    status: result.status === "quote_blocked" ? "quote_blocked" : "payment_required",
    protocol: {
      protocol_version: "agent_router_request_v1",
      invocation_policy: "quote_only_no_server_side_payment"
    },
    next_step: result.status === "quote_blocked"
      ? "Increase the max_price budget or choose a lower-cost service."
      : paymentRequiredNextStep(result)
  };
  return response.status === "payment_required" && isAgentRouterCreditsQuote(result)
    ? agentRouterConnectionRequired(response)
    : response;
}

export function paymentRequiredNextStep(result) {
  if (isAgentRouterCreditsQuote(result)) return "Call agentrouter_connect to approve this AI client in the browser, then retry automatically.";
  return "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof.";
}

export function paymentBoundaryStatusCode(payload) {
  if (payload?.status === "invalid_request") return 422;
  if (payload?.status === "connection_required") return 401;
  if (["payment_required", "quote_required", "quote_blocked"].includes(payload?.status)) return 402;
  if (payload?.status === "no_data_returned") {
    const statuses = (payload.results || []).map((result) => result?.status);
    if (statuses.some((status) => ["unsupported_source", "unsupported_operation", "invalid_request"].includes(status))) return 422;
    if (statuses.some((status) => status === "rate_limited")) return 429;
    if (statuses.some((status) => status === "provider_error")) return 502;
  }
  return 200;
}

export function routePaymentRequired(resolved, body) {
  if (resolved.status === "needs_clarification" || resolved.status === "no_match") return resolved;
  const response = {
    ...resolved,
    ok: false,
    status: "payment_required",
    protocol: {
      protocol_version: "agent_router_route_v1",
      invocation_policy: "resolve_only_no_server_side_payment"
    },
    budget: body.budget || {},
    next_step: "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof."
  };
  return currentPaymentBackend() === "credits"
    ? agentRouterConnectionRequired(response)
    : response;
}
