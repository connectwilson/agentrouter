const localBrowserContextSchema = {
  type: "object",
  properties: {
    local_browser: {
      type: "object",
      description: "Capabilities exposed by the AI client's built-in, user-authenticated browser.",
      properties: {
        adapter: { enum: ["codex_browser", "claude_in_chrome", "opencli"] },
        available: { type: "boolean" },
        operations: { type: "array", items: { enum: ["read_post"] } },
        session_mode: { enum: ["existing_user_session", "isolated_session", "shared_profile", "isolated_profile"] }
      },
      additionalProperties: false
    },
    source: { type: "string" }
  },
  additionalProperties: true
};

export const remoteMcpTools = [
  {
    name: "agentrouter_fetch",
    description: "Default first hop for external information. Use this single tool first for research, search, URLs, platforms, current information, and API/data questions. AgentRouter selects public web, local read-only connectors, or specialist services and handles budget, authorization, invocation, verification, evidence, and feedback internally. Pass the original task or structured data_requirements; use max_price 0 for free-only research. Use another acquisition backend only when this response names a handoff, or when the user explicitly requests direct mode.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        data_requirements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              capability: { type: "string" },
              type: { type: "string" },
              params: { type: "object" },
              constraints: { type: "object" }
            }
          }
        },
        constraints: { type: "object" },
        budget: { type: "object" },
        max_price: { type: "string", default: "0.05" },
        currency: { type: "string", default: "USDC" },
        consumer_context: localBrowserContextSchema
      }
    }
  },
  {
    name: "agentrouter_connect_source",
    description: "Open AgentRouter's browser authorization flow for one upstream API/data source after a result returns action_required: connect_api_source. This is distinct from agentrouter_connect, which connects the AI client to the AgentRouter account. Never ask the user to paste an upstream API key into chat. After the browser flow is complete, call this tool again and retry the original AgentRouter request.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: { type: "string", description: "AgentRouter source id returned by the failed request, for example openalex or exa." }
      }
    }
  },
  {
    name: "agentrouter_request",
    description: "Advanced structured route call. Prefer agentrouter_fetch for normal user questions. Use this only when the caller intentionally wants to invoke exactly one structured capability request.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example token_smart_money_activity." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc and freshness_seconds." },
        budget: { type: "object", description: "Optional budget object." },
        consumer_context: localBrowserContextSchema
      }
    }
  },
  {
    name: "agentrouter_quote",
    description: "Advanced/debug only. Preview service selection and price without invoking. Normal user data questions should use agentrouter_fetch.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string" },
        params: { type: "object" },
        constraints: { type: "object" },
        budget: { type: "object" }
      }
    }
  },
  {
    name: "agentrouter_quote_feedback",
    description: "Submit this when the main agent received an AgentRouter quote but decided not to invoke. This records whether the agent skipped due to free source, price, wallet, low confidence, user decline, or another reason.",
    inputSchema: {
      type: "object",
      required: ["quote_id", "decision", "reason_code", "reason"],
      properties: {
        quote_id: { type: "string" },
        service_id: { type: "string" },
        consumer_id: { type: "string" },
        decision: { enum: ["not_invoked", "invoked_elsewhere", "user_declined", "deferred"] },
        reason_code: { enum: ["free_source_used", "price_too_high", "wallet_empty", "low_confidence", "user_declined", "other"] },
        reason: { type: "string" }
      }
    }
  },
  {
    name: "agentrouter_capabilities",
    description: "Advanced/debug only. List capability schemas for integrations. Normal user data questions should use agentrouter_fetch.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "agentrouter_feedback",
    description: "Submit post-call consumer feedback after deciding whether an AgentRouter result helped answer the user's task.",
    inputSchema: {
      type: "object",
      required: ["request_id", "feedback"],
      properties: {
        request_id: { type: "string" },
        consumer_id: { type: "string" },
        feedback_token: { type: "string", description: "Opaque one-time grant returned for a local connector result; the MCP bridge normally supplies this automatically." },
        feedback: { type: "object" }
      }
    }
  },
  {
    name: "agentrouter_ask",
    description: "Compatibility alias for natural-language fetch. Prefer agentrouter_fetch for new clients.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        max_price: { type: "string", default: "0.05" },
        currency: { type: "string", default: "USDC" }
      }
    }
  }
];

export const agentRouterConnectTool = {
  name: "agentrouter_connect",
  description: "Connect this AI client to the user's AgentRouter account through one browser approval. Use this when a paid call reports that no AgentRouter payment credential is available. Never ask the user to copy an API key or edit an MCP configuration file.",
  inputSchema: {
    type: "object",
    properties: {
      client_name: { type: "string", description: "Human-readable AI client name." },
      wait_seconds: { type: "integer", minimum: 0, maximum: 55, default: 45, description: "How long to wait for browser approval before returning pending status." },
      restart: { type: "boolean", default: false, description: "Start a new authorization if the previous code expired." }
    }
  }
};

export const agentRouterCompleteHandoffTool = {
  name: "agentrouter_complete_handoff",
  description: "Return a read-only result produced by the AI client's built-in browser for an AgentRouter local_browser_execution handoff. Send only public page evidence; never include cookies, tokens, credentials, or raw browser state. AgentRouter validates origin and target, normalizes provenance, and creates the normal feedback request.",
  inputSchema: {
    type: "object",
    required: ["handoff", "result"],
    properties: {
      handoff: { type: "object", description: "The unchanged handoff object returned by AgentRouter." },
      result: {
        type: "object",
        description: "Structured public evidence from the built-in browser.",
        properties: {
          canonical_url: { type: "string" },
          post_id: { type: "string" },
          text: { type: "string" },
          author_handle: { type: "string" },
          published_at: { type: "string" },
          engagement: { type: "object" }
        }
      }
    }
  }
};

remoteMcpTools.push(agentRouterCompleteHandoffTool);

export const bridgeMcpTools = [agentRouterConnectTool, ...remoteMcpTools];
