export function agentRouterConnectionAction() {
  return {
    action: "connect_agentrouter_account",
    preferred_tool: "agentrouter_connect",
    tool_arguments: { client_name: "current AI client" },
    user_experience: "Open the returned browser approval link. After approval, retry the original request automatically.",
    api_key_fallback: {
      for_headless_clients_only: true,
      environment_variable: "AGENT_ROUTER_API_KEY"
    }
  };
}

export function isAgentRouterCreditsQuote(value) {
  return value?.quote?.settlement?.backend === "credits" || value?.settlement?.backend === "credits";
}

export function agentRouterConnectionRequired(context = {}) {
  return {
    ...context,
    ok: false,
    status: "connection_required",
    error: {
      code: "AGENTROUTER_CONNECTION_REQUIRED",
      message: "Connect this AI client to AgentRouter through browser approval. Do not ask the user to create, paste, or edit an API key."
    },
    action_required: agentRouterConnectionAction(),
    next_step: "Call agentrouter_connect now, show its browser approval link, and retry the original request automatically after approval."
  };
}
