import { invokePaidService, searchServices, validateBudgetAmount } from "./registry.js";
import { resolveCapabilityPackCall } from "./capability-packs.js";
import { createConsumerFeedbackRequest, verifyServiceResult } from "./verifier.js";
import { createPaymentQuote, effectivePricing } from "./payment-adapter.js";
import { createEvidenceEnvelope } from "./evidence.js";
import { anchorEvidenceOnArc } from "./arc-anchor.js";
import { summarizeHealth, summarizeProvenance, summarizeTrust } from "./store.js";
import { writePersistentServiceEvent } from "./persistence.js";
import { createCompactResult } from "./compact-result.js";
import { validateJsonSchema } from "./schema.js";
import { HOLDER_CHAINS, holderChain, holderInput, matchHolderToken, validateHolderParams } from "./token-holders.js";

export const ROUTER_STATUSES = {
  READY: "ready_to_route",
  NEEDS_CLARIFICATION: "needs_clarification",
  ROUTE_WITH_ASSUMPTION: "route_with_assumption",
  NO_MATCH: "no_match"
};

const CAPABILITY_ALIASES = [
  {
    capability: "token_holders", capabilities: ["token_holders", "holder_distribution"],
    keywords: ["token holders", "持有人", "持币地址"],
    agent_description: "Return the largest token-holder addresses by token balance on an explicit chain. Nansen Holders supports Robinhood. A symbol needs exact-chain contract resolution first; quote both calls before payment. Chain support does not guarantee any particular token is indexed.",
    not_for: ["DEX pools", "profitable trader rankings", "wallet portfolio", "historical holder snapshots"],
    input_schema: { type: "object", required: ["chain"], properties: { chain: { type: "string" }, token_symbol: { type: "string" }, token_address: { type: "string" }, limit: { type: "number" } } },
    examples: [{ user_query: "查robinhood链上PONS代币的前10大 token holder的地址", request: { capability: "token_holders", params: { chain: "robinhood", token_symbol: "PONS", limit: 10 } } }],
    defaultInput: holderInput
  },
  {
    capability: "social_post_read",
    capabilities: ["social_post_read", "social_content", "data_service"],
    keywords: ["x.com", "twitter.com", "read post", "read tweet", "抓取帖子", "读取帖子", "推文"],
    agent_description: "Read a single public social post by URL through an official API or a read-only connector on the user's device.",
    not_for: ["posting", "replying", "liking", "following", "private messages", "non-public content"],
    input_schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Public X status URL." },
        platform: { type: "string", enum: ["x"] }
      }
    },
    examples: [{
      user_query: "读取这个 X 帖子 https://x.com/example/status/123",
      request: {
        capability: "social_post_read",
        params: { url: "https://x.com/example/status/123", platform: "x" }
      }
    }],
    defaultInput: (intent) => ({ url: intent.url || intent.target, platform: "x" })
  },
  {
    capability: "external_api_query",
    capabilities: ["external_api_query", "web_search", "web_scrape", "search_api", "data_service"],
    keywords: ["search api", "搜索 API", "brave", "tavily", "serper", "exa", "firecrawl", "jina", "github", "gdelt", "sec edgar", "weather", "youtube", "virustotal", "places", "amadeus", "tracking", "openalex", "xpoz", "socialdatax"],
    agent_description: "Query a public or user-connected read-only external data provider through AgentRouter without exposing the user's credential.",
    not_for: ["social posting", "external writes", "credential management", "unconnected or unavailable sources"],
    input_schema: {
      type: "object",
      required: ["source", "operation", "query"],
      properties: {
        source: { type: "string", enum: ["brave_search", "tavily", "serper", "exa", "firecrawl", "jina", "github", "gdelt", "sec_edgar", "open_meteo", "youtube", "virus_total", "google_places", "amadeus", "easy_post", "openalex", "xpoz", "socialdatax"] },
        operation: { type: "string", enum: ["search", "forecast", "filings", "inspect", "flight_search", "track"] },
        query: { type: "string" },
        limit: { type: "number" },
        platforms: { type: "array", items: { type: "string" }, description: "Social platforms to query and merge for XPOZ or SocialDataX." },
        origin: { type: "string", description: "IATA origin code for Amadeus flight search." },
        destination: { type: "string", description: "IATA destination code for Amadeus flight search." },
        departure_date: { type: "string", description: "YYYY-MM-DD departure date for Amadeus flight search." },
        adults: { type: "number" },
        carrier: { type: "string", description: "Optional carrier hint for EasyPost tracking." }
      }
    },
    examples: [{
      user_query: "Use my Brave connection to search for AI Web3 products with revenue.",
      request: { capability: "external_api_query", params: { source: "brave_search", operation: "search", query: "AI Web3 products real revenue", limit: 10 } }
    }],
    defaultInput: (intent) => ({ source: intent.source || "brave_search", operation: "search", query: intent.query || intent.question || "", limit: intent.limit || 10 })
  },
  {
    capability: "social_user_voice_research",
    capabilities: ["social_user_voice_research", "social_research", "user_voice", "sentiment_data", "data_service"],
    keywords: ["用户抱怨", "用户反馈", "用户原声", "社交媒体", "reddit", "小红书", "bilibili", "youtube", "facebook", "twitter", "x.com", "complaints", "user voice", "social research"],
    agent_description: "Use this to research real user discussions across X, Reddit, Xiaohongshu, Bilibili, YouTube, Facebook, and configured social sources with source links and platform coverage diagnostics.",
    not_for: ["posting content", "liking or commenting", "private messages"],
    input_schema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        platforms: { type: "array", items: { type: "string", enum: ["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook", "other"] } },
        platform: { type: "string", enum: ["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook", "other"] },
        operation: { type: "string", enum: ["search", "read_user_posts", "read_thread", "read_trends"] },
        handle: { type: "string", description: "Exact public account handle for read_user_posts; omit the leading @ when possible." },
        url: { type: "string", description: "Canonical public post URL for read_thread." },
        from: { type: "string", description: "Inclusive YYYY-MM-DD lower time bound." },
        to: { type: "string", description: "Inclusive YYYY-MM-DD upper time bound." },
        entity: {
          type: "object",
          description: "Strict entity constraints used to prevent lookalike-name contamination.",
          properties: {
            required_terms: { type: "array", items: { type: "string" } },
            excluded_terms: { type: "array", items: { type: "string" } }
          }
        },
        language: { type: "string", enum: ["zh", "en"] },
        location: { type: "string" },
        limit: { type: "number" }
      }
    },
    examples: [
      {
        user_query: "KIMI K3 用户有哪些抱怨？",
        request: {
          capability: "social_user_voice_research",
          params: { question: "KIMI K3 用户有哪些抱怨", platforms: ["x", "reddit", "xiaohongshu"], language: "zh", limit: 10 }
        }
      }
    ],
    defaultInput: (intent) => ({
      question: intent.question || intent.query || "",
      platforms: intent.platforms || ["x", "reddit", "xiaohongshu"],
      language: intent.language || "zh",
      limit: intent.limit || 10
    })
  },
  {
    capability: "token_price",
    capabilities: ["token_price", "crypto_price", "market_data", "token_data", "data_service"],
    keywords: ["price", "价格", "行情", "usd", "market data", "token price", "crypto price"],
    agent_description: "Use this when the user asks for a token or crypto asset price.",
    not_for: ["wallet holdings", "smart-money flows"],
    input_schema: {
      type: "object",
      required: ["ids", "vs_currencies"],
      properties: {
        ids: { type: "string" },
        vs_currencies: { type: "string" }
      }
    },
    examples: [
      {
        user_query: "用 AgentRouter 查询 BTC 当前美元价格",
        request: {
          capability: "token_price",
          params: { ids: "bitcoin", vs_currencies: "usd" }
        }
      }
    ],
    defaultInput: (intent) => ({
      ids: coinGeckoIdForAsset(intent.asset) || "bitcoin",
      vs_currencies: "usd"
    })
  },
  {
    capability: "perp_liquidation_max_pain",
    capabilities: ["perp_liquidation_max_pain", "liquidation_heatmap", "perp_liquidation", "crypto_derivatives"],
    keywords: ["爆仓", "清算", "liquidation", "liq", "heatmap", "合约", "永续", "perp", "perpetual"],
    agent_description: "Use this when the user asks for perpetual futures liquidation clusters, liquidation max-pain, or forced liquidation risk.",
    not_for: ["options max pain", "spot support/resistance"],
    input_schema: {
      type: "object",
      required: ["asset", "market_type", "window"],
      properties: {
        // Actual asset coverage comes from the selected provider's schema.
        // A global BTC/ETH/SOL enum rejected valid pairs before routing.
        asset: { type: "string", pattern: "^[A-Z0-9]{2,15}$" },
        market_type: { type: "string", enum: ["perpetual_futures"] },
        window: { type: "string", enum: ["current", "1h", "4h"] }
      }
    },
    examples: [
      {
        user_query: "BTC 当前最大爆仓痛点是多少？",
        request: {
          capability: "perp_liquidation_max_pain",
          params: { asset: "BTC", market_type: "perpetual_futures", window: "current" }
        }
      }
    ],
    defaultInput: (intent) => ({ asset: intent.asset || "BTC", market_type: intent.market_type || "perpetual_futures", window: intent.window || "current" })
  },
  {
    capability: "options_max_pain",
    capabilities: ["options_max_pain", "options_data"],
    keywords: ["期权", "options", "option", "max pain", "最大痛点"],
    agent_description: "Use this when the user explicitly asks for options max pain.",
    not_for: ["perpetual futures liquidation max-pain"],
    input_schema: {
      type: "object",
      required: ["asset", "expiry"],
      properties: {
        asset: { type: "string", enum: ["BTC", "ETH", "SOL"] },
        expiry: { type: "string" }
      }
    },
    examples: [
      {
        user_query: "BTC 期权最大痛点是多少？",
        request: {
          capability: "options_max_pain",
          params: { asset: "BTC", expiry: "nearest" }
        }
      }
    ],
    defaultInput: (intent) => ({ asset: intent.asset || "BTC", expiry: intent.expiry || "nearest" })
  },
  {
    capability: "onchain_fund_flow",
    capabilities: ["onchain_data", "fund_flow"],
    keywords: ["资金流", "fund flow", "inflow", "outflow", "链上", "onchain"],
    agent_description: "Use this when the user asks for chain-level inflow, outflow, or fund-flow analysis.",
    not_for: ["derivatives liquidation clusters"],
    input_schema: {
      type: "object",
      required: ["chain", "days"],
      properties: {
        chain: { type: "string", enum: ["base", "ethereum", "arbitrum", "optimism", "solana", "bsc", "bnb", "hyperevm"] },
        days: { type: "number" }
      }
    },
    examples: [
      {
        user_query: "Base 过去 7 天链上资金流向如何？",
        request: {
          capability: "onchain_fund_flow",
          params: { chain: "base", days: 7 }
        }
      }
    ],
    defaultInput: (intent) => ({ chain: intent.chain || "base", days: intent.days || 7 })
  },
  {
    capability: "smart_money_netflow",
    capabilities: ["data_service", "smart_money_netflow", "netflow", "smart_money", "onchain_data"],
    keywords: ["smart money netflow", "smart-money netflow", "聪明钱 净流", "聪明钱", "netflow", "net flow", "净流入", "净流出"],
    agent_description: "Use this when the user asks for smart-money inflow, outflow, or netflow by chain or asset.",
    not_for: ["generic exchange spot netflow unless no more specific service exists"],
    input_schema: {
      type: "object",
      required: [],
      properties: {
        chains: { type: "array", items: { type: "string" } },
        pagination: { type: "object" },
        asset: { type: "string" },
        window: { type: "string" }
      }
    },
    examples: [
      {
        user_query: "用 AgentRouter 查询 ETH 近 24 小时 smart money netflow",
        request: {
          capability: "smart_money_netflow",
          params: { chains: ["ethereum"], pagination: { page: 1, per_page: 10 } }
        }
      }
    ],
    defaultInput: (intent) => ({
      chains: [intent.chain || chainFromAsset(intent.asset) || "ethereum"],
      asset: intent.asset,
      window: intent.window,
      pagination: { page: 1, per_page: 10 }
    })
  },
  {
    capability: "smart_money_holdings",
    capabilities: ["data_service", "smart_money_holdings", "smart_money", "onchain_data"],
    keywords: ["smart money holdings", "smart-money holdings", "聪明钱 持仓", "聪明钱", "holdings", "持仓"],
    agent_description: "Use this when the user asks for smart-money holdings or top held assets.",
    not_for: ["netflow or trade history requests"],
    input_schema: {
      type: "object",
      required: [],
      properties: {
        chains: { type: "array", items: { type: "string" } },
        pagination: { type: "object" },
        asset: { type: "string" }
      }
    },
    examples: [
      {
        user_query: "用 AgentRouter 查询 smart money holdings 的前 10 条数据",
        request: {
          capability: "smart_money_holdings",
          params: { chains: ["ethereum"], pagination: { page: 1, per_page: 10 } }
        }
      }
    ],
    defaultInput: (intent) => ({
      chains: [intent.chain || chainFromAsset(intent.asset) || "ethereum"],
      pagination: { page: 1, per_page: 10 }
    })
  },
  {
    capability: "token_smart_money_activity",
    capabilities: ["data_service", "token_god_mode", "token_data", "smart_money"],
    keywords: ["token smart money", "token god mode", "聪明钱", "买", "卖", "bought", "sold", "flow intelligence", "who bought"],
    agent_description: "Use this when the user asks for token-level smart-money activity, buyer/seller movement, recent buys/sells, or token flow intelligence.",
    not_for: ["chain-level smart-money netflow", "generic news search", "market-wide token rankings"],
    input_schema: {
      type: "object",
      required: ["token_symbol"],
      properties: {
        token_symbol: { type: "string", description: "Token ticker or symbol, for example AZTEC." },
        token_address: { type: "string", description: "Optional contract address. AgentRouter may resolve it from token_symbol when omitted." },
        chain: { type: "string", enum: ["ethereum", "base", "arbitrum", "optimism", "solana", "bsc", "bnb", "hyperevm"] },
        window: { type: "string", description: "Requested time window, for example 24h, 1d, 7d." },
        date: { type: "object", description: "Optional date range with from/to ISO dates. AgentRouter fills this from window when the provider expects dates." },
        pagination: { type: "object" }
      }
    },
    examples: [
      {
        user_query: "查询 AZTEC 的聪明钱近24小时动向",
        request: {
          capability: "token_smart_money_activity",
          params: { token_symbol: "AZTEC", chain: "ethereum", window: "24h", pagination: { page: 1, per_page: 24 } }
        }
      }
    ],
    defaultInput: (intent) => tokenSmartMoneyInput(intent)
  }
];

export function getCapabilityCatalog() {
  return [
    ...CAPABILITY_ALIASES.map((entry) => ({
    capability: entry.capability,
    agent_description: entry.agent_description,
    provider_capabilities: entry.capabilities,
    input_schema: entry.input_schema,
    not_for: entry.not_for,
    examples: entry.examples,
    ambiguity_notes: ambiguityNotesFor(entry.capability)
    })),
    {
      capability: "<dynamic_data_capability>",
      agent_description: "Use any registered API/data service by naming the desired capability in snake_case, for example smart_money_holdings or funding_rate. AgentRouter will match it against registered service ids, titles, descriptions, tags, and sample shapes.",
      provider_capabilities: ["data_service"],
      input_schema: {
        type: "object",
        required: [],
        additionalProperties: true,
        description: "Pass the provider API request body directly as params. AgentRouter merges params over the service sample_request."
      },
      not_for: ["Ambiguous financial terms that need a domain-specific schema."],
      examples: [
        {
          user_query: "Query smart money holdings for Ethereum, first 10 rows.",
          request: {
            capability: "smart_money_holdings",
            params: { chains: ["ethereum"], pagination: { page: 1, per_page: 10 } }
          }
        }
      ],
      ambiguity_notes: ["If the main agent is unsure which dynamic capability name to use, call agentrouter_ask or search by natural-language task instead."]
    }
  ];
}

export async function routeTask(store, { task = "", intent: providedIntent, constraints = {}, budget = {} } = {}, options = {}) {
  const normalizedConstraints = normalizeRequestConstraints(constraints, budget);
  const budgetValidation = validateBudgetAmount(normalizedConstraints.max_price_usdc);
  if (!budgetValidation.ok) {
    return invalidBudgetRouteResult({ task, intent: providedIntent, constraints: normalizedConstraints }, budgetValidation);
  }
  if (budgetValidation.present) normalizedConstraints.max_price_usdc = String(budgetValidation.amount);
  const resolved = resolveRoute(store, { task, intent: providedIntent, constraints: normalizedConstraints });
  if (resolved.status === ROUTER_STATUSES.NEEDS_CLARIFICATION || resolved.status === ROUTER_STATUSES.NO_MATCH) {
    return resolved;
  }

  const selected = resolved.selected_service;
  const record = store.services.get(selected.service_id);
  const invocation = await invokePaidService(
    store,
    selected.service_id,
    resolved.input,
    { max_amount: normalizedConstraints.max_price_usdc ?? "0.05", currency: budget.currency || "USDC" },
    options
  );
  if (invocation.statusCode >= 400) {
    return {
      ...resolved,
      status: "route_failed",
      selected_service: selected,
      error: invocation.body.error
    };
  }

  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent: resolved.intent,
    constraints
  });

  const routingEvent = {
    event_version: "agent_route_event_v1",
    task,
    normalized_intent: resolved.intent,
    service_id: selected.service_id,
    provider_id: record.manifest.provider.provider_id,
    verification,
    score: selected.routing_score,
    created_at: new Date().toISOString()
  };
  attachVerificationToLatestFeedback(record, invocation.body.result.request_id, verification);
  const consumer_feedback_request = createConsumerFeedbackRequest({
    request: { task, intent: resolved.intent, constraints },
    selectedService: selected,
    result: invocation.body.result,
    verification
  });
  store.feedbackEvents.push(routingEvent);

  return {
    ...resolved,
    result: invocation.body.result,
    payment_feedback: invocation.body.feedback,
    verification,
    consumer_feedback_request,
    routing_event: routingEvent
  };
}

function publicCapabilityPackResolution(resolution) {
  return {
    id: resolution.pack.id,
    title: resolution.pack.title,
    contract: resolution.contract,
    resolved_capability: resolution.resolved_capability || null,
    dispatch_reason: resolution.dispatch_reason || null,
    service_count: resolution.pack.service_count,
    verified_service_count: resolution.pack.verified_service_count,
    starting_price_usdc: resolution.pack.starting_price_usdc
  };
}

function canonicalPackRequest(result, resolution, original) {
  return {
    ...(result?.request || {}),
    capability: original.capability,
    params: original.params,
    resolved_capability: resolution.resolved_capability
  };
}

function decorateCapabilityPackResult(result, resolution, original) {
  const capabilityPack = publicCapabilityPackResolution(resolution);
  const request = canonicalPackRequest(result, resolution, original);
  return {
    ...result,
    protocol: result?.protocol ? {
      ...result.protocol,
      external_contract: resolution.contract
    } : result?.protocol,
    request,
    capability_pack: capabilityPack,
    route_decision: result?.route_decision ? {
      ...result.route_decision,
      request,
      capability_pack: capabilityPack
    } : result?.route_decision
  };
}

function capabilityPackFailure(resolution, { capability, params, constraints, consumerContext }) {
  const capabilityPack = publicCapabilityPackResolution(resolution);
  const request = { capability, params, constraints, consumer_context: consumerContext };
  const status = resolution.status === "invalid_request" ? "invalid_request" : ROUTER_STATUSES.NO_MATCH;
  return {
    ok: false,
    status,
    ...(resolution.error ? { error: resolution.error } : {}),
    ...(resolution.expected_schema ? { expected_schema: resolution.expected_schema } : {}),
    request,
    capability_pack: capabilityPack,
    candidates_considered: 0,
    exact_match: false,
    message: resolution.message,
    route_decision: createRouteDecision({
      status,
      request,
      exactMatch: false,
      diagnostics: { message: resolution.message, capability_pack: capabilityPack }
    })
  };
}

export async function routeCapabilityRequest(store, {
  capability,
  params = {},
  constraints = {},
  budget = {},
  consumer_context: consumerContext = {}
} = {}, options = {}) {
  const writeArtifact = options.writeServiceEvent || writePersistentServiceEvent;
  const packResolution = resolveCapabilityPackCall([...store.services.values()], { contract: capability, params });
  if (packResolution) {
    if (!packResolution.ok) return capabilityPackFailure(packResolution, { capability, params, constraints, consumerContext });
    const routed = await routeCapabilityRequest(store, {
      capability: packResolution.resolved_capability,
      params: packResolution.params,
      constraints,
      budget,
      consumer_context: {
        ...consumerContext,
        capability_pack_contract: capability,
        capability_pack_id: packResolution.pack.id
      }
    }, options);
    return decorateCapabilityPackResult(routed, packResolution, { capability, params });
  }
  const validation = validateCapabilityRequest({ capability, params });
  if (!validation.ok) {
    const request = { capability, params, constraints, consumer_context: consumerContext };
    const alternatives = suggestCapabilityAlternatives(store, { capability, params, constraints });
    return {
      ok: false,
      status: "invalid_request",
      ...validation,
      request,
      route_decision: createRouteDecision({
        status: "invalid_request",
        request,
        exactMatch: false,
        validation,
        alternatives
      }),
      alternatives,
      retry_plan: createRetryPlan({
        status: "invalid_request",
        request,
        error: validation
      })
    };
  }

  let intent = {
    capability,
    ...params,
    consumer_context: consumerContext
  };
  const normalizedConstraints = normalizeRequestConstraints(constraints, budget);
  const budgetValidation = validateBudgetAmount(normalizedConstraints.max_price_usdc);
  if (!budgetValidation.ok) {
    return invalidBudgetRouteResult({
      capability,
      params,
      constraints: normalizedConstraints,
      consumer_context: consumerContext
    }, budgetValidation);
  }
  if (budgetValidation.present) normalizedConstraints.max_price_usdc = String(budgetValidation.amount);
  const holderWorkflow = capability === "token_holders" ? planHolderWorkflow(store, intent, normalizedConstraints) : null;
  if (holderWorkflow?.ok === false) return { ...holderWorkflow, request: { capability, params, constraints: normalizedConstraints } };
  const tokenResolution = holderWorkflow?.resolver
    ? await resolveHolderToken(store, intent, holderWorkflow, options)
    : await resolveStructuredTokenIfNeeded(store, intent, normalizedConstraints, budget, options);
  if (tokenResolution?.ok === false) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    const observation = await recordRouteObservation(store, {
      status: tokenResolution.status,
      request,
      error: tokenResolution,
      writeEvent: writeArtifact
    });
    return {
      ok: false,
      status: tokenResolution.status,
      request,
      observation,
      token_resolution: tokenResolution,
      retry_plan: createRetryPlan({
        status: tokenResolution.status,
        request,
        error: tokenResolution
      })
    };
  }
  if (tokenResolution?.intent) intent = tokenResolution.intent;
  const candidates = holderWorkflow ? [holderWorkflow.selected] : rankCandidates(store, intent, normalizedConstraints);
  if (!candidates.length) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    const diagnostics = diagnoseNoMatch(store, { capability, params, constraints: normalizedConstraints });
    const alternatives = suggestCapabilityAlternatives(store, { capability, params, constraints: normalizedConstraints });
    const observation = await recordRouteObservation(store, {
      status: ROUTER_STATUSES.NO_MATCH,
      request,
      candidates,
      error: diagnostics,
      writeEvent: writeArtifact
    });
    return {
      ok: false,
      status: ROUTER_STATUSES.NO_MATCH,
      request,
      candidates_considered: 0,
      observation,
      message: diagnostics.message,
      diagnostics,
      exact_match: false,
      alternatives,
      route_decision: createRouteDecision({
        status: ROUTER_STATUSES.NO_MATCH,
        request,
        exactMatch: false,
        alternatives,
        diagnostics
      }),
      retry_plan: createRetryPlan({
        status: ROUTER_STATUSES.NO_MATCH,
        request,
        error: diagnostics
      })
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  const input = buildInput(record.manifest, intent);
  const preflight = validateManifestInput(record.manifest, input);
  if (!preflight.ok) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    return {
      ok: false,
      status: "preflight_validation_failed",
      request,
      selected_service: selected,
      candidates_considered: candidates.length,
      candidates: summarizeCandidates(candidates),
      input,
      preflight_validation: preflight,
      exact_match: true,
      route_decision: createRouteDecision({
        status: "preflight_validation_failed",
        request,
        exactMatch: true,
        selected,
        candidates,
        input,
        preflight
      }),
      retry_plan: createRetryPlan({
        status: "preflight_validation_failed",
        request,
        selected,
        input,
        error: preflight,
        candidates
      })
    };
  }
  const quote = createPaymentQuote({
    manifest: record.manifest,
    constraints: normalizedConstraints,
    selectedService: selected
  });
  if (!quote.would_pay) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    return {
      ok: false,
      status: "quote_blocked",
      request,
      selected_service: selected,
      exact_match: true,
      candidates_considered: candidates.length,
      candidates: summarizeCandidates(candidates),
      input,
      preflight_validation: preflight,
      quote,
      route_decision: createRouteDecision({
        status: "quote_blocked",
        request,
        exactMatch: true,
        selected,
        candidates,
        input,
        quote,
        preflight
      }),
      retry_plan: createRetryPlan({
        status: "quote_blocked",
        request,
        selected,
        input,
        error: { code: "BUDGET_TOO_LOW", message: quote.reason },
        candidates
      })
    };
  }
  const invocation = await invokePaidService(
    store,
    selected.service_id,
    input,
    { max_amount: holderWorkflow?.holder_price ?? normalizedConstraints.max_price_usdc ?? "0.05", currency: budget.currency || "USDC" },
    options
  );
  if (invocation.statusCode >= 400) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    const error = invocation.body.error || invocation.body.result?.error || invocation.body;
    const observation = await recordRouteObservation(store, {
      status: "route_failed",
      request,
      candidates,
      selected,
      quote,
      invocation,
      error,
      writeEvent: writeArtifact
    });
    return {
      ok: false,
      status: "route_failed",
      request,
      selected_service: selected,
      input,
      quote,
      observation,
      error,
      failure_explanation: explainRouteFailure({ error, selected, input }),
      retry_plan: createRetryPlan({
        status: "route_failed",
        request,
        selected,
        input,
        error,
        candidates
      })
    };
  }

  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent,
    constraints: normalizedConstraints
  });
  attachVerificationToLatestFeedback(record, invocation.body.result?.request_id, verification);
  const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
  const evidence = createEvidenceEnvelope({
    request,
    input,
    selectedService: selected,
    manifest: record.manifest,
    quote,
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification
  });
  evidence.arc_anchor = await anchorEvidenceOnArc(evidence);
  store.evidenceEvents.push(evidence);
  const evidenceDurability = await persistRouterArtifact(writeArtifact, {
    eventType: "evidence",
    serviceId: selected.service_id,
    requestId: invocation.body.result?.request_id,
    event: evidence
  });
  const qualityFailure = verification.schema_valid === false
    || verification.coverage_valid === false
    || verification.data_non_empty === false
    || verification.sanity_valid === false
    || invocation.body.result?.status !== "success";
  const qualityWarning = !qualityFailure && verification.freshness_valid === false;
  const routeStatus = qualityFailure
    ? "data_quality_failed"
    : qualityWarning
      ? "routed_with_quality_warning"
      : "routed";
  const observation = await recordRouteObservation(store, {
    status: routeStatus,
    request,
    candidates,
    selected,
    quote,
    invocation,
    verification,
    evidence,
    writeEvent: writeArtifact
  });
  const consumer_feedback_request = createConsumerFeedbackRequest({
    request,
    selectedService: selected,
    result: invocation.body.result,
    verification
  });
  const compactResult = createCompactResult({
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification,
    quote,
    evidence,
    request,
    input
  });
  const retryPlan = qualityFailure || qualityWarning
    ? createRetryPlan({
        status: qualityFailure ? "data_quality_failed" : "data_quality_warning",
        request,
        selected,
        input,
        verification,
        candidates
      })
    : null;
  const durabilityArtifacts = [
    { event_type: "evidence", ...evidenceDurability },
    {
      event_type: "route_observation",
      status: observation.durability_status,
      ...(observation.durability_error ? { error: observation.durability_error } : {})
    }
  ];
  const durabilityErrors = durabilityArtifacts.flatMap((artifact) => artifact.error ? [{
    event_type: artifact.event_type,
    code: artifact.error.code,
    message: artifact.error.message
  }] : []);
  const durabilityStatus = durabilityErrors.length
    ? "degraded"
    : durabilityArtifacts.some((artifact) => artifact.status === "memory_only")
      ? "memory_only"
      : "durable";

  return {
    ok: !qualityFailure,
    status: routeStatus,
    ...(holderWorkflow ? { workflow_quote: holderWorkflow.quote } : {}),
    protocol: {
      protocol_version: "agent_router_request_v1",
      semantic_parser: "external_main_agent",
      router_responsibility: "schema_validation_routing_quote_payment_invocation_verification_evidence"
    },
    request,
    selected_service: selected,
    token_resolution: tokenResolution || null,
    exact_match: true,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    preflight_validation: preflight,
    route_decision: createRouteDecision({
      status: routeStatus,
      request,
      exactMatch: true,
      selected,
      candidates,
      input,
      quote,
      preflight,
      verification
    }),
    quote,
    input,
    result: invocation.body.result,
    compact_result: compactResult,
    feedback: invocation.body.feedback,
    verification,
    consumer_feedback_request,
    evidence,
    observation,
    durability_status: durabilityStatus,
    ...(durabilityErrors.length ? { durability_errors: durabilityErrors } : {}),
    retry_plan: retryPlan
  };
}

export function quoteCapabilityRequest(store, {
  capability,
  params = {},
  constraints = {},
  budget = {},
  consumer_context: consumerContext = {}
} = {}, {
  actorKey = "",
  writeServiceEvent: writeEvent = writePersistentServiceEvent
} = {}) {
  const packResolution = resolveCapabilityPackCall([...store.services.values()], { contract: capability, params });
  if (packResolution) {
    if (!packResolution.ok) return capabilityPackFailure(packResolution, { capability, params, constraints, consumerContext });
    const quoted = quoteCapabilityRequest(store, {
      capability: packResolution.resolved_capability,
      params: packResolution.params,
      constraints,
      budget,
      consumer_context: {
        ...consumerContext,
        capability_pack_contract: capability,
        capability_pack_id: packResolution.pack.id
      }
    }, { actorKey, writeServiceEvent: writeEvent });
    return decorateCapabilityPackResult(quoted, packResolution, { capability, params });
  }
  const validation = validateCapabilityRequest({ capability, params });
  if (!validation.ok) {
    const request = { capability, params, constraints, consumer_context: consumerContext };
    const alternatives = suggestCapabilityAlternatives(store, { capability, params, constraints });
    return {
      ok: false,
      status: "invalid_request",
      ...validation,
      request,
      alternatives,
      route_decision: createRouteDecision({
        status: "invalid_request",
        request,
        exactMatch: false,
        validation,
        alternatives
      })
    };
  }

  const intent = {
    capability,
    ...params,
    consumer_context: consumerContext
  };
  const normalizedConstraints = normalizeRequestConstraints(constraints, budget);
  const budgetValidation = validateBudgetAmount(normalizedConstraints.max_price_usdc);
  if (!budgetValidation.ok) {
    return invalidBudgetRouteResult({
      capability,
      params,
      constraints: normalizedConstraints,
      consumer_context: consumerContext
    }, budgetValidation);
  }
  if (budgetValidation.present) normalizedConstraints.max_price_usdc = String(budgetValidation.amount);
  if (capability === "token_holders") {
    const planned = planHolderWorkflow(store, intent, normalizedConstraints);
    if (planned.quote) recordIssuedQuote(store, planned.quote, actorKey, writeEvent);
    return { ...planned, request: { capability, params, constraints: normalizedConstraints }, selected_service: planned.selected,
      input: holderInput(intent), ...(planned.resolver ? { token_resolution: { status: "required", resolver_service_id: planned.resolver.service_id, exact_chain_required: true } } : {}) };
  }
  const candidateConstraints = constraintsWithoutBudgetGuard(normalizedConstraints);
  const candidates = rankCandidates(store, intent, candidateConstraints);
  if (!candidates.length) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    const diagnostics = diagnoseNoMatch(store, { capability, params, constraints: normalizedConstraints });
    const alternatives = suggestCapabilityAlternatives(store, { capability, params, constraints: normalizedConstraints });
    return {
      ok: false,
      status: ROUTER_STATUSES.NO_MATCH,
      request,
      candidates_considered: 0,
      message: diagnostics.message,
      diagnostics,
      exact_match: false,
      alternatives,
      route_decision: createRouteDecision({
        status: ROUTER_STATUSES.NO_MATCH,
        request,
        exactMatch: false,
        alternatives,
        diagnostics
      })
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  const input = buildInput(record.manifest, intent);
  const preflight = validateManifestInput(record.manifest, input);
  if (!preflight.ok) {
    const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
    return {
      ok: false,
      status: "preflight_validation_failed",
      request,
      selected_service: selected,
      candidates_considered: candidates.length,
      candidates: summarizeCandidates(candidates),
      input,
      preflight_validation: preflight,
      exact_match: true,
      route_decision: createRouteDecision({
        status: "preflight_validation_failed",
        request,
        exactMatch: true,
        selected,
        candidates,
        input,
        preflight
      })
    };
  }
  const quote = createPaymentQuote({
    manifest: record.manifest,
    constraints: normalizedConstraints,
    selectedService: selected
  });
  recordIssuedQuote(store, quote, actorKey, writeEvent);
  const quoteFeedbackRequest = createQuoteFeedbackRequest({ quote, selectedService: selected, request: { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext } });
  return {
    ok: quote.would_pay,
    status: quote.would_pay ? "quoted" : "quote_blocked",
    request: { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext },
    selected_service: selected,
    exact_match: true,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    input,
    preflight_validation: preflight,
    route_decision: createRouteDecision({
      status: quote.would_pay ? "quoted" : "quote_blocked",
      request: { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext },
      exactMatch: true,
      selected,
      candidates,
      input,
      quote,
      preflight
    }),
    quote,
    quote_feedback_request: quoteFeedbackRequest
  };
}

function recordIssuedQuote(store, quote, actorKey = "", writeEvent = writePersistentServiceEvent) {
  store.issuedQuotes ||= new Map();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  for (const [quoteId, issued] of store.issuedQuotes) {
    if (Number(issued.expires_at || 0) <= now || store.issuedQuotes.size > 10_000) {
      store.issuedQuotes.delete(quoteId);
    }
  }
  const event = {
    quote_id: quote.quote_id,
    service_id: quote.service_id,
    actor_key: actorKey,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt
  };
  store.issuedQuotes.set(quote.quote_id, event);
  const entry = {
    eventType: "issued_quote",
    serviceId: quote.service_id,
    requestId: quote.quote_id,
    event
  };
  Promise.resolve()
    .then(() => writeEvent(entry))
    .catch((error) => recordRouterDurabilityFailure(store, entry, error));
}

function recordRouterDurabilityFailure(store, entry, error) {
  const failure = {
    event_type: entry.eventType,
    service_id: entry.serviceId || null,
    request_id: entry.requestId || null,
    code: error?.code || "PERSISTENCE_WRITE_FAILED",
    created_at: new Date().toISOString()
  };
  store.routerDurabilityFailures ||= [];
  store.routerDurabilityFailures.push(failure);
  console.error("[router-durability] degraded", JSON.stringify(failure));
}

function createQuoteFeedbackRequest({ quote, selectedService, request }) {
  return {
    request_version: "agentrouter_quote_feedback_request_v1",
    recommended_if_not_invoked: true,
    must_submit_if_not_invoked: false,
    endpoint: "/agent-router/quote-feedback",
    quote_id: quote.quote_id,
    service_id: selectedService?.service_id || quote.service_id,
    instructions: [
      "Submit this only if the main agent decides not to invoke AgentRouter after receiving this quote.",
      "Use this to improve routing, pricing, and trigger rules for future calls."
    ],
    body_template: {
      quote_id: quote.quote_id,
      service_id: selectedService?.service_id || quote.service_id,
      consumer_id: "<main_agent_or_client_id>",
      decision: "not_invoked",
      reason_code: "<free_source_used|price_too_high|wallet_empty|low_confidence|user_declined|other>",
      reason: "<brief explanation>"
    },
    request
  };
}

export function resolveRoute(store, { task = "", intent: providedIntent, constraints = {} } = {}) {
  const normalized = normalizeTaskIntent({ task, providedIntent, constraints });
  if (normalized.status === ROUTER_STATUSES.NEEDS_CLARIFICATION) {
    return normalized;
  }

  const candidates = rankCandidates(store, normalized.intent, constraints);
  if (!candidates.length) {
    return {
      ...normalized,
      status: ROUTER_STATUSES.NO_MATCH,
      candidates_considered: 0,
      candidates: [],
      message: "No registered service matched the normalized intent and constraints."
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  return {
    ...normalized,
    selected_service: selected,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    input: buildInput(record.manifest, normalized.intent)
  };
}

export function normalizeTaskIntent({ task = "", providedIntent, constraints = {} } = {}) {
  const rawText = String(task || "");
  const text = rawText.toLowerCase();
  const intent = sanitizeProvidedIntent(providedIntent);
  const detected = detectIntent(text, rawText);
  const merged = {
    ...detected.intent,
    ...intent
  };

  const ambiguities = detectAmbiguities(text, merged);
  const status = chooseStatus({ text, intent: merged, ambiguities, constraints });
  return {
    status,
    task,
    normalized_intent: merged,
    intent: merged,
    intent_confidence: confidenceFor(status, detected.score, ambiguities),
    assumptions: assumptionsFor(status, text, merged, ambiguities),
    ambiguities,
    parse_reasoning_summary: summarizeParse({ text, intent: merged, status, ambiguities })
  };
}

export function rankCandidates(store, intent, constraints = {}) {
  const requiredCapabilities = capabilityRequirements(intent.capability);
  const minimumTrustScore = constraints.min_trust_score == null || constraints.min_trust_score === ""
    ? null
    : Number(constraints.min_trust_score);
  const excludedServiceIds = new Set([
    ...(constraints.exclude_service_ids || []),
    ...(constraints.exclude_services || [])
  ].filter(Boolean));
  const searchResults = searchServices(store, {
    query: buildSearchQuery(intent),
    capabilities: [],
    maxPrice: constraints.max_price_usdc,
    verifiedOnly: true
  });

  return searchResults
    .filter((service) => !excludedServiceIds.has(service.service_id))
    .map((service) => scoreCandidate(store.services.get(service.service_id), intent, requiredCapabilities, constraints, service.match_score))
    .filter((candidate) => candidate.routing_score > 0)
    .filter((candidate) => minimumTrustScore == null || !Number.isFinite(minimumTrustScore) || candidate.trust_score >= minimumTrustScore)
    .sort((a, b) => b.routing_score - a.routing_score);
}

function detectIntent(text, rawText = text) {
  const asset = detectAsset(text, rawText);
  const tradingPair = detectTradingPair(text);
  const chain = detectChain(text);
  const days = detectDays(text);
  const tokenSmartMoneyActivity = Boolean(asset) && /smart[\s_-]?money|聪明钱/i.test(text) && /动向|动态|activity|movement|flow|flows|买|卖|bought|sold|近|过去|24\s*h|24\s*小时/i.test(text);
  const matches = CAPABILITY_ALIASES.map((entry) => {
    const keywordHits = entry.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
    return { entry, keywordHits };
  }).sort((a, b) => b.keywordHits - a.keywordHits);

  const best = matches[0];
  const capability = tokenSmartMoneyActivity ? "token_smart_money_activity" : best?.keywordHits ? best.entry.capability : null;
  return {
    score: tokenSmartMoneyActivity ? Math.max(3, best?.keywordHits || 0) : best?.keywordHits || 0,
    intent: {
      capability,
      asset,
      quote_asset: tradingPair?.quote_asset,
      trading_pair: tradingPair?.symbol,
      token_symbol: capability === "token_smart_money_activity" ? asset : undefined,
      window: capability === "token_smart_money_activity" ? "24h" : undefined,
      chain,
      days,
      market_type: capability === "perp_liquidation_max_pain" ? "perpetual_futures" : undefined,
      time_sensitivity: /当前|现在|实时|latest|current|now/.test(text) ? "realtime" : undefined
    }
  };
}

function detectAmbiguities(text, intent) {
  const ambiguities = [];
  const saysMaxPain = text.includes("最大痛点") || text.includes("max pain");
  const saysLiquidation = text.includes("爆仓") || text.includes("清算") || text.includes("liquidation");
  const saysOptions = text.includes("期权") || text.includes("options");

  if (saysMaxPain && !saysLiquidation && !saysOptions) {
    ambiguities.push({
      field: "capability",
      question: "你说的最大痛点，是永续合约爆仓集中区，还是期权 max pain？",
      options: [
        { value: "perp_liquidation_max_pain", label: "合约/永续合约爆仓集中区" },
        { value: "options_max_pain", label: "期权最大痛点" }
      ],
      default_if_no_answer: "perp_liquidation_max_pain",
      blocking: true
    });
  }

  if (intent.capability === "perp_liquidation_max_pain" && !intent.asset) {
    ambiguities.push({
      field: "asset",
      question: "需要查询哪个资产的爆仓集中区？",
      options: [{ value: "BTC", label: "BTC" }, { value: "ETH", label: "ETH" }],
      blocking: true
    });
  }

  return ambiguities;
}

function chooseStatus({ text, intent, ambiguities }) {
  if (!intent.capability) return ROUTER_STATUSES.NEEDS_CLARIFICATION;
  if (ambiguities.some((item) => item.blocking)) return ROUTER_STATUSES.NEEDS_CLARIFICATION;
  if ((text.includes("爆仓") || text.includes("liquidation")) && text.includes("痛点")) {
    return ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION;
  }
  return ROUTER_STATUSES.READY;
}

function assumptionsFor(status, text, intent) {
  if (status !== ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION) return [];
  const assumptions = [];
  if (intent.capability === "perp_liquidation_max_pain") {
    assumptions.push("将“爆仓痛点”理解为永续合约/合约清算集中价格，而不是期权 max pain。");
  }
  if (intent.time_sensitivity === "realtime") {
    assumptions.push("按实时或最近可用数据处理。");
  }
  return assumptions;
}

function confidenceFor(status, score, ambiguities) {
  if (status === ROUTER_STATUSES.NEEDS_CLARIFICATION) return 0.45;
  if (status === ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION) return 0.74;
  return Math.min(0.95, 0.7 + score * 0.08 - ambiguities.length * 0.1);
}

function summarizeParse({ intent, status, ambiguities }) {
  if (status === ROUTER_STATUSES.NEEDS_CLARIFICATION) {
    return `Router could not safely normalize the task without clarification: ${ambiguities[0]?.question || "capability is unclear"}`;
  }
  if (intent.capability === "perp_liquidation_max_pain") {
    return "Router mapped the request to perpetual futures liquidation max-pain because the task uses liquidation/burst-position language.";
  }
  if (intent.capability === "onchain_fund_flow") {
    return "Router mapped the request to on-chain fund flow based on fund-flow and chain language.";
  }
  return "Router normalized the task with the configured capability taxonomy.";
}

function sanitizeProvidedIntent(intent) {
  if (!intent || typeof intent !== "object") return {};
  const allowedCapabilities = new Set(CAPABILITY_ALIASES.map((entry) => entry.capability));
  return {
    capability: allowedCapabilities.has(intent.capability) ? intent.capability : undefined,
    asset: intent.asset,
    chain: intent.chain,
    days: intent.days,
    market_type: intent.market_type,
    time_sensitivity: intent.time_sensitivity
  };
}

function capabilityRequirements(capability) {
  return CAPABILITY_ALIASES.find((entry) => entry.capability === capability)?.capabilities || ["data_service"];
}

function buildSearchQuery(intent) {
  if (intent.capability === "token_price") return `${intent.asset || "bitcoin"} price usd market data`;
  if (intent.capability === "perp_liquidation_max_pain") return `${intent.asset || "BTC"} liquidation max pain`;
  if (intent.capability === "options_max_pain") return `${intent.asset || "BTC"} options max pain`;
  if (intent.capability === "onchain_fund_flow") return `${intent.chain || ""} fund flow`;
  if (intent.capability === "smart_money_netflow") return `${intent.chain || chainFromAsset(intent.asset) || ""} smart money netflow`;
  if (intent.capability === "smart_money_holdings") return `${intent.chain || chainFromAsset(intent.asset) || ""} smart money holdings`;
  if (intent.capability === "token_smart_money_activity") return `${intent.token_symbol || intent.asset || ""} token god mode who bought sold flow intelligence smart money`;
  return [
    String(intent.capability || "").replace(/[_-]/g, " "),
    ...Object.values(intent).flatMap((value) => searchableValues(value))
  ].filter(Boolean).join(" ");
}

// Scales with both the share and the number of mismatch reports, so one unhappy
// agent nudges the ranking while a repeated pattern pushes the service down hard
// enough that any adequate alternative outranks it.
export function intentMismatchPenalty(trust, { weight = 0.35, cap = 0.45 } = {}) {
  const rate = trust?.intent_mismatch_rate;
  const count = Number(trust?.intent_mismatch_count || 0);
  if (!rate || !count) return 0;
  const confidence = Math.min(1, count / 3);
  return Number(Math.min(cap, rate * confidence * weight).toFixed(4));
}

function scoreCandidate(record, intent, requiredCapabilities, constraints, matchScore) {
  const manifest = record.manifest;
  if (intent.capability === "token_holders") {
    const chain = holderChain(intent.chain);
    const declared = manifest.input_schema?.properties?.chain?.enum;
    if (chain && (!HOLDER_CHAINS.includes(chain) || (declared && !declared.map(holderChain).includes(chain)))) return { service_id: manifest.service_id, routing_score: 0 };
  }
  const capabilityHits = requiredCapabilities.filter((capability) => manifest.capabilities.includes(capability)).length;
  if (!capabilityHits) return { service_id: manifest.service_id, routing_score: 0 };

  const sampleText = JSON.stringify(manifest.sample_request || {}).toLowerCase() + JSON.stringify(manifest.sample_response || {}).toLowerCase();
  const surfaceText = [
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    ...(manifest.capabilities || []),
    sampleText
  ].join(" ").toLowerCase();
  if (!serviceCoversCapability(surfaceText, intent.capability)) {
    return { service_id: manifest.service_id, routing_score: 0 };
  }
  if (!serviceCoversRequestedAsset(manifest, intent)) {
    return { service_id: manifest.service_id, routing_score: 0 };
  }
  const trust = summarizeTrust(record);
  const trustScore = trust.routing_trust_score ?? trust.trust_score;
  const health = summarizeHealth(record);
  if (health.circuit_breaker?.active && !constraints.include_circuit_broken_services) {
    return {
      service_id: manifest.service_id,
      title: manifest.title,
      provider_id: manifest.provider.provider_id,
      health_status: health.status,
      circuit_breaker: health.circuit_breaker,
      routing_score: 0,
      selection_reason: `Excluded by circuit breaker: ${health.circuit_breaker.reason}.`
    };
  }
  const assetFit = intent.asset ? Number(sampleText.includes(String(intent.asset).toLowerCase())) : 1;
  const provenance = summarizeProvenance(record);
  const freshnessLimit = Number(constraints.freshness_seconds || 0);
  const serviceFreshness = Number(manifest.freshness?.max_data_lag_seconds || 0);
  const freshnessFit = !freshnessLimit || (serviceFreshness && serviceFreshness <= freshnessLimit) ? 1 : 0.35;
  const maxPrice = Number(constraints.max_price_usdc || 0);
  const price = Number(manifest.pricing.amount);
  const priceFit = !maxPrice ? 1 : Math.max(0, 1 - price / Math.max(maxPrice, price));
  const consumerSignal = trust.average_consumer_score ?? trust.usefulness_rate ?? trust.intent_fit_rate ?? 0.5;
  const recentFailurePenalty = trust.recent_failure_rate == null ? 0 : trust.recent_failure_rate * 0.18;
  // Agents reporting "this did not answer my question" is the only signal that
  // catches a service which answers every call successfully with the wrong data.
  // Averaged into consumerSignal it barely registered, so it is subtracted
  // directly and scales with how many agents said it.
  const mismatchPenalty = intentMismatchPenalty(trust);
  const healthFit = health.status === "healthy" ? 1 : health.status === "degraded" ? 0.35 : 0.7;
  const provenanceFit = provenanceScore(provenance.source_provenance_level);
  const score =
    (capabilityHits / requiredCapabilities.length) * 0.28 +
    assetFit * 0.12 +
    trustScore * 0.14 +
    consumerSignal * 0.16 +
    freshnessFit * 0.11 +
    priceFit * 0.08 +
    matchScore * 0.03 +
    healthFit * 0.05 +
    provenanceFit * 0.03 -
    mismatchPenalty -
    recentFailurePenalty;

  return {
    service_id: manifest.service_id,
    title: manifest.title,
    provider_id: manifest.provider.provider_id,
    candidate_group: candidateGroupForManifest(manifest),
    // Expose the active settlement network, not a provider's stale default.
    pricing: effectivePricing(manifest),
    trust_score: Number(trustScore.toFixed(4)),
    consumer_feedback_count: trust.consumer_feedback_count,
    recent_failure_rate: trust.recent_failure_rate,
    health_status: health.status,
    circuit_breaker: health.circuit_breaker,
    source_provenance_level: provenance.source_provenance_level,
    selection_badges: selectionBadges({ trust, health, provenance, record }),
    routing_score: Number(Math.max(0, score).toFixed(4)),
    selection_reason: `Matched ${capabilityHits}/${requiredCapabilities.length} required capabilities, verification=${record.verification_status}, trust=${trustScore.toFixed(2)}, consumer_feedback=${trust.consumer_feedback_count}, recent_failure=${trust.recent_failure_rate ?? "n/a"}, health=${health.status}, provenance=${provenance.source_provenance_level}, price=${manifest.pricing.amount} ${manifest.pricing.currency}.`
  };
}

function provenanceScore(level) {
  if (level === "official_verified") return 1;
  if (level === "provider_owned") return 0.85;
  if (level === "authorized_reseller") return 0.75;
  if (level === "wrapped_api") return 0.55;
  if (level === "scraped") return 0.35;
  return 0.25;
}

function selectionBadges({ trust, health, provenance, record }) {
  const badges = [];
  if (record.verification_status === "verified") badges.push("verified_live_endpoint");
  if (health.status === "healthy") badges.push("healthy");
  if (health.circuit_breaker?.active) badges.push("circuit_breaker_active");
  if (provenance.source_provenance_level && provenance.source_provenance_level !== "unknown") badges.push(`source_${provenance.source_provenance_level}`);
  if (trust.consumer_feedback_count > 0) badges.push("has_agent_feedback");
  if ((trust.average_consumer_score ?? trust.usefulness_rate ?? 0) >= 0.8) badges.push("agent_useful");
  if ((trust.recent_failure_rate ?? 0) > 0.3) badges.push("recent_failures");
  return badges;
}

function attachVerificationToLatestFeedback(record, requestId, verification) {
  const event = [...(record.feedback_events || [])].reverse().find((item) => !requestId || item.request_id === requestId);
  if (!event) return;
  event.verification = verification;
  event.schema_valid = verification.schema_valid;
  event.updated_at = new Date().toISOString();
}

function serviceCoversCapability(surfaceText, capability) {
  if (capability === "perp_liquidation_max_pain") {
    return /liquidation|max_liquidation|max[\s_-]?pain|爆仓|清算/.test(surfaceText);
  }
  if (capability === "options_max_pain") {
    return /options?|期权/.test(surfaceText) && /max[\s_-]?pain|最大痛点/.test(surfaceText);
  }
  if (capability === "onchain_fund_flow") {
    return /fund[\s_-]?flow|inflow|outflow|资金流|onchain|链上/.test(surfaceText);
  }
  if (capability === "smart_money_netflow") {
    return /smart[\s_-]?money|聪明钱/.test(surfaceText) && /net[\s_-]?flow|netflow|inflow|outflow|净流/.test(surfaceText);
  }
  if (capability === "smart_money_holdings") {
    return /smart[\s_-]?money|聪明钱/.test(surfaceText) && /holdings?|持仓|balance/.test(surfaceText);
  }
  if (capability === "token_smart_money_activity") {
    return /token[\s_-]?god[\s_-]?mode|flow[\s_-]?intelligence|who[\s_-]?bought|bought[\s_-]?sold|buyer[\s_-]?seller|token[\s_-]?flow/.test(surfaceText);
  }
  const terms = dynamicCapabilityTerms(capability);
  return terms.length > 0 && terms.every((term) => surfaceText.includes(term));
}

function serviceCoversRequestedAsset(manifest, intent) {
  const asset = String(intent.token_symbol || intent.asset || "").toUpperCase();
  if (!asset) return true;
  const schemaProperties = manifest.input_schema?.properties || {};
  for (const field of ["asset", "token", "token_symbol", "symbol"]) {
    const allowed = schemaProperties[field]?.enum;
    if (Array.isArray(allowed) && allowed.length) {
      return allowed.map((item) => String(item).toUpperCase()).includes(asset);
    }
  }
  return true;
}

export function summarizeCandidates(candidates = []) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = [
      candidate.provider_id || "",
      candidate.candidate_group || candidate.service_id,
      candidate.pricing?.amount || "",
      candidate.pricing?.currency || "",
      candidate.pricing?.network || ""
    ].join("|");
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const best = group[0];
    const equivalentServiceIds = group.slice(1).map((item) => item.service_id);
    return {
      service_id: best.service_id,
      title: best.title,
      provider_id: best.provider_id,
      pricing: best.pricing,
      trust_score: best.trust_score,
      health_status: best.health_status,
      circuit_breaker: best.circuit_breaker,
      source_provenance_level: best.source_provenance_level,
      recent_failure_rate: best.recent_failure_rate,
      consumer_feedback_count: best.consumer_feedback_count,
      selection_badges: best.selection_badges,
      routing_score: best.routing_score,
      selection_reason: best.selection_reason,
      equivalent_service_count: group.length,
      equivalent_service_ids: equivalentServiceIds
    };
  });
}

function candidateGroupForManifest(manifest = {}) {
  const capabilities = manifest.capabilities || [];
  if (capabilities.some((capability) => /liquidation|heatmap|crypto_derivatives/.test(capability))) {
    return "crypto_liquidation";
  }
  return capabilities.filter((capability) => capability !== "data_service").sort().join(",") || manifest.service_id;
}

function createRouteDecision({
  status,
  request,
  exactMatch,
  selected = null,
  candidates = [],
  input = null,
  quote = null,
  preflight = null,
  validation = null,
  alternatives = [],
  diagnostics = null,
  verification = null
} = {}) {
  return {
    decision_version: "agent_router_route_decision_v1",
    status,
    exact_match: Boolean(exactMatch),
    next_action: routeNextAction({ status, exactMatch, quote, alternatives, preflight, validation }),
    requested_capability: request?.capability || null,
    selected_service_id: selected?.service_id || null,
    selected_title: selected?.title || null,
    candidates_considered: candidates.length,
    input_ready: Boolean(input && (!preflight || preflight.ok)),
    preflight_validation: preflight || null,
    validation: validation || null,
    quote: quote ? {
      would_pay: quote.would_pay,
      amount: quote.amount || quote.price,
      currency: quote.pricing?.currency || quote.currency || "USDC"
    } : null,
    alternatives,
    diagnostics,
    verification_summary: verification ? {
      schema_valid: verification.schema_valid,
      freshness_valid: verification.freshness_valid,
      coverage_valid: verification.coverage_valid,
      data_non_empty: verification.data_non_empty,
      intent_fit: verification.intent_fit || null
    } : null,
    main_agent_policy: {
      do_not_guess_service_names: true,
      do_not_blind_invoke_alternatives: true,
      payment_required_is_not_failure: true,
      ask_user_before_weak_alternative: true
    }
  };
}

function routeNextAction({ status, exactMatch, quote, alternatives, preflight, validation }) {
  if (validation && !validation.ok) return "fix_structured_request";
  if (preflight && !preflight.ok) return "fix_input_before_payment";
  if (!exactMatch) {
    return alternatives?.some((item) => item.fit_score >= 0.7)
      ? "ask_user_to_confirm_alternative"
      : "report_no_exact_match";
  }
  if (quote?.would_pay && !quote?.agent_decision?.execution_available) {
    return "connect_credits_or_configure_local_payment";
  }
  if (quote?.would_pay) return "invoke_agentrouter_request";
  if (status === "quote_blocked") return "increase_budget_or_choose_lower_cost_service";
  return "invoke_or_return_result";
}

function validateManifestInput(manifest = {}, input = {}) {
  const schema = manifest.input_schema || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing_fields = required.filter((field) => input[field] === undefined || input[field] === null || input[field] === "");
  const schema_errors = validateJsonSchema(input, schema);
  const invalid_fields = schema_errors
    .filter((message) => !message.endsWith(" is required"))
    .map((message) => ({ message }));
  return {
    ok: missing_fields.length === 0 && schema_errors.length === 0,
    validation_version: "agent_router_preflight_validation_v1",
    service_id: manifest.service_id,
    missing_fields,
    invalid_fields,
    schema_errors,
    input_schema: schema
  };
}

function suggestCapabilityAlternatives(store, { capability, params = {}, constraints = {} } = {}) {
  const requestedTerms = new Set([
    ...dynamicCapabilityTerms(capability),
    ...Object.values(params || {}).flatMap((value) => searchableValues(value)),
    ...expandedAlternativeTerms(capability, params)
  ].map((term) => String(term).toLowerCase()).filter(Boolean));
  if (!requestedTerms.size) return [];

  return [...store.services.values()]
    .map((record) => alternativeFit(record.manifest, requestedTerms, constraints))
    .filter((item) => item.fit_score > 0.18)
    .sort((a, b) => b.fit_score - a.fit_score)
    .slice(0, 5);
}

function alternativeFit(manifest, requestedTerms, constraints = {}) {
  const text = [
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    manifest.agent_contract?.summary,
    ...(manifest.capabilities || []),
    JSON.stringify(manifest.sample_request || {}),
    JSON.stringify(manifest.sample_response || {})
  ].join(" ").toLowerCase();
  const hits = [...requestedTerms].filter((term) => term.length > 1 && text.includes(term));
  const price = Number(manifest.pricing?.amount || 0);
  const maxPrice = Number(constraints.max_price_usdc || 0);
  const priceOk = !maxPrice || !price || price <= maxPrice;
  const raw = requestedTerms.size ? hits.length / requestedTerms.size : 0;
  const fit_score = Number(Math.min(0.95, raw * (priceOk ? 1 : 0.75)).toFixed(2));
  return {
    service_id: manifest.service_id,
    title: manifest.title,
    capability_tags: (manifest.capabilities || []).slice(0, 8),
    fit_score,
    relationship: fit_score >= 0.75 ? "near_alternative" : fit_score >= 0.45 ? "related_signal" : "weak_related_signal",
    requires_user_confirmation: fit_score < 0.75,
    reason: hits.length
      ? `Shares ${hits.slice(0, 6).join(", ")} with the requested capability, but it is not an exact capability match.`
      : "Related by broad data domain, not by exact metric.",
    price: manifest.pricing || null
  };
}

function expandedAlternativeTerms(capability, params = {}) {
  const terms = [];
  const haystack = [
    capability,
    ...Object.values(params || {}).map((value) => JSON.stringify(value))
  ].join(" ").toLowerCase();
  if (/nupl|unrealized|profit|loss|pnl/.test(haystack)) {
    terms.push("pnl", "profit", "loss", "profitability", "unrealized", "holder", "address");
  }
  if (/netflow|inflow|outflow|flow/.test(haystack)) {
    terms.push("netflow", "inflow", "outflow", "flow", "fund");
  }
  if (/holder|holders|持仓/.test(haystack)) {
    terms.push("holder", "holders", "balance", "holding");
  }
  return terms;
}

async function recordRouteObservation(store, {
  status,
  request,
  candidates = [],
  selected = null,
  quote = null,
  invocation = null,
  verification = null,
  evidence = null,
  error = null,
  writeEvent = writePersistentServiceEvent
}) {
  if (!store.routeObservations) store.routeObservations = [];
  const observation = {
    observation_version: "agent_router_route_observation_v1",
    observation_id: `route_obs_${Date.now()}_${store.routeObservations.length + 1}`,
    created_at: new Date().toISOString(),
    route_type: "structured_capability_request",
    status,
    request,
    score_model: {
      name: "heuristic_weighted_ranker",
      version: "2026-05-20",
      features: ["capability_fit", "asset_fit", "trust_score", "consumer_feedback", "recent_failure_rate", "health_status", "source_provenance", "freshness_fit", "price_fit", "text_match"]
    },
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    selected_service_id: selected?.service_id || null,
    selected_routing_score: selected?.routing_score ?? null,
    quote: quote ? {
      quote_version: quote.quote_version,
      would_pay: quote.would_pay,
      price: quote.price,
      guard: quote.guard,
      payment_backend: quote.payment_backend
    } : null,
    outcome: {
      invocation_status_code: invocation?.statusCode ?? null,
      feedback_status: invocation?.body?.feedback?.status || null,
      schema_valid: verification?.schema_valid ?? invocation?.body?.feedback?.schema_valid ?? null,
      agent_friendly_score: verification?.agent_friendly_score ?? null,
      evidence_trace_hash: evidence?.trace_hash || null,
      result_hash: evidence?.result_hash || null,
      error
    }
  };
  store.routeObservations.push(observation);
  const durability = await persistRouterArtifact(writeEvent, {
    eventType: "route_observation",
    serviceId: selected?.service_id || null,
    requestId: invocation?.body?.result?.request_id || null,
    event: observation
  });
  observation.durability_status = durability.status;
  if (durability.error) observation.durability_error = durability.error;
  return observation;
}

async function persistRouterArtifact(writeEvent, entry) {
  try {
    const written = await writeEvent(entry);
    return { status: written === false ? "memory_only" : "durable" };
  } catch (error) {
    const failure = {
      code: error.code || "PERSISTENCE_WRITE_FAILED",
      message: "AgentRouter could not durably store this routing artifact."
    };
    console.error("[router-durability] degraded", JSON.stringify({
      event_type: entry.eventType,
      service_id: entry.serviceId || null,
      request_id: entry.requestId || null,
      code: failure.code
    }));
    return { status: "degraded", error: failure };
  }
}

export function buildInput(manifest, intent) {
  if (intent.capability === "token_holders") return holderInput(intent);
  const entry = CAPABILITY_ALIASES.find((item) => item.capability === intent.capability);
  if (!entry) {
    return {
      ...(manifest.sample_request || {}),
      ...dynamicInputParams(intent, manifest.sample_request || {})
    };
  }
  const input = {
    ...(manifest.sample_request || {}),
    ...(entry ? entry.defaultInput(intent) : {})
  };
  if (intent.capability === "token_smart_money_activity") {
    return filterInputToManifestShape(input, manifest, providerInputAllowlist(manifest, intent));
  }
  if (intent.capability === "perp_liquidation_max_pain") {
    const properties = manifest.input_schema?.properties || {};
    const allowed = new Set([
      ...Object.keys(manifest.sample_request || {}),
      ...Object.keys(properties)
    ]);
    const asset = String(intent.asset || "").toUpperCase();
    const tradingPair = String(intent.trading_pair || asset).toUpperCase();
    if (allowed.has("symbol")) input.symbol = tradingPair;
    if (allowed.has("asset")) input.asset = asset;
    if (allowed.has("trading_pair")) input.trading_pair = tradingPair;
    if (allowed.has("pair")) input.pair = tradingPair;
    return filterInputToManifestShape(input, manifest);
  }
  return input;
}

function filterInputToManifestShape(input, manifest, extraAllowed = []) {
  const sampleKeys = new Set(Object.keys(manifest.sample_request || {}));
  const schemaKeys = new Set(Object.keys(manifest.input_schema?.properties || {}));
  const allowed = new Set([...sampleKeys, ...schemaKeys, ...extraAllowed]);
  if (!allowed.size) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => allowed.has(key))
  );
}

function tokenSmartMoneyInput(intent) {
  const window = intent.window || "24h";
  const input = {
    chain: normalizeProviderChain(intent.chain || "ethereum"),
    pagination: intent.pagination || { page: 1, per_page: 24 }
  };
  if (intent.token_address) input.token_address = intent.token_address;
  if (intent.token_symbol) input.token_symbol = intent.token_symbol;
  if (intent.date) input.date = intent.date;
  else if (/^\d+\s*h$/i.test(window) || window === "24h" || window === "1d") input.date = recentDateRange(1);
  else if (/^\d+\s*d$/i.test(window)) input.date = recentDateRange(Number(window.match(/\d+/)?.[0] || 1));
  else input.timeframe = window;
  return input;
}

function providerInputAllowlist(manifest = {}, intent = {}) {
  if (intent.capability !== "token_smart_money_activity") return [];
  const surface = [
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    manifest.provider?.provider_id,
    ...(manifest.capabilities || [])
  ].join(" ").toLowerCase();
  const extra = [];
  if (/nansen|\/api\/v1\/tgm|who[-_\s]?bought|bought[-_\s]?sold/.test(surface)) {
    extra.push("date", "pagination", "chain", "token_address", "token_symbol");
  }
  return extra;
}

async function resolveStructuredTokenIfNeeded(store, intent, constraints = {}, budget = {}, options = {}) {
  if (intent.capability !== "token_smart_money_activity") return null;
  if (intent.token_address) return null;
  const tokenSymbol = intent.token_symbol || intent.asset;
  if (!tokenSymbol) return {
    ok: false,
    status: "token_symbol_required",
    message: "token_smart_money_activity requires token_symbol or token_address."
  };

  const resolver = pickTokenResolver(searchServices(store, {
    query: "token search",
    verifiedOnly: true,
    maxPrice: constraints.max_price_usdc ?? budget.max_amount
  }));

  if (!resolver) return {
    ok: false,
    status: "token_resolver_not_found",
    token_symbol: tokenSymbol,
    message: "No token resolver service is registered."
  };

  const resolverVerificationMode = "verified";

  const resolverInput = {
    search_query: tokenSymbol,
    result_type: "token",
    chain: normalizeProviderChain(intent.chain || "ethereum"),
    limit: 5
  };
  const invocation = await invokePaidService(store, resolver.service_id, resolverInput, {
    max_amount: constraints.max_price_usdc ?? budget.max_amount ?? "0.05",
    currency: budget.currency || "USDC"
  }, options);
  if (invocation.statusCode >= 400) {
    return {
      ok: false,
      status: "token_resolution_failed",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_verification_mode: resolverVerificationMode,
      resolver_input: resolverInput,
      error: invocation.body.error
    };
  }

  const match = findTokenMatch(invocation.body.result?.data, {
    tokenSymbol,
    chain: normalizeProviderChain(intent.chain || "ethereum")
  });
  if (!match?.address) return {
    ok: false,
    status: "token_not_found",
    token_symbol: tokenSymbol,
    resolver_service_id: resolver.service_id,
    resolver_verification_mode: resolverVerificationMode,
    resolver_input: resolverInput,
    message: "Token resolver did not return a matching contract address."
  };

  const resolution = describeTokenResolution({
    requestedSymbol: tokenSymbol,
    matchedSymbol: match.symbol,
    matchedName: match.name,
    chain: match.chain || normalizeProviderChain(intent.chain || "ethereum")
  });
  if (!resolution.auto_pay_allowed) return {
    ok: false,
    status: "token_resolution_ambiguous",
    token_symbol: tokenSymbol,
    token_address: match.address,
    chain: match.chain || normalizeProviderChain(intent.chain || "ethereum"),
    matched_name: match.name || null,
    matched_symbol: match.symbol || null,
    asset_resolution: resolution,
    requested_symbol: resolution.requested_symbol,
    resolved_symbol: resolution.resolved_symbol,
    resolution_type: resolution.resolution_type,
    auto_pay_allowed: resolution.auto_pay_allowed,
    blocking_reason: resolution.blocking_reason,
    requires_disclosure: resolution.requires_disclosure,
    disclosure: resolution.disclosure,
    resolver_service_id: resolver.service_id,
    resolver_verification_mode: resolverVerificationMode,
    resolver_input: resolverInput,
    message: resolution.blocking_reason
  };
  return {
    ok: true,
    status: "resolved",
    token_symbol: tokenSymbol,
    token_address: match.address,
    chain: match.chain || normalizeProviderChain(intent.chain || "ethereum"),
    matched_name: match.name || null,
    matched_symbol: match.symbol || null,
    asset_resolution: resolution,
    requested_symbol: resolution.requested_symbol,
    resolved_symbol: resolution.resolved_symbol,
    resolution_type: resolution.resolution_type,
    requires_disclosure: resolution.requires_disclosure,
    disclosure: resolution.disclosure,
    resolver_service_id: resolver.service_id,
    resolver_verification_mode: resolverVerificationMode,
    resolver_input: resolverInput,
    intent: {
      ...intent,
      token_symbol: tokenSymbol,
      token_address: match.address,
      chain: match.chain || normalizeProviderChain(intent.chain || "ethereum")
    }
  };
}

function planHolderWorkflow(store, intent, constraints) {
  const selected = rankCandidates(store, intent, constraintsWithoutBudgetGuard(constraints))[0];
  if (!selected) return { ok: false, status: "no_match", message: "No verified holder endpoint covers the requested chain." };
  const manifest = store.services.get(selected.service_id).manifest;
  const holderPrice = effectivePricing(manifest);
  let resolver = null;
  if (!intent.token_address) {
    // Prefer a resolver owned by the chosen data provider. Never substitute a
    // broad web/news search for a token identity lookup.
    resolver = pickTokenResolver(searchServices(store, { query: "token search", verifiedOnly: true }).filter(service => {
      const candidate = store.services.get(service.service_id).manifest;
      const chainEnum = candidate.input_schema?.properties?.chain?.enum;
      return candidate.provider.provider_id === manifest.provider.provider_id
        && (!chainEnum || chainEnum.map(holderChain).includes(holderChain(intent.chain)));
    }));
    if (!resolver) return { ok: false, status: "token_resolver_not_found", message: "No verified same-provider token resolver is available; supply the exact contract address." };
  }
  const resolverPrice = resolver ? effectivePricing(store.services.get(resolver.service_id).manifest) : null;
  const prices = [holderPrice, resolverPrice].filter(Boolean);
  if (manifest.pricing.currency !== "USDC" || (resolver && store.services.get(resolver.service_id).manifest.pricing.currency !== "USDC")
      || prices.some(price => !Number.isFinite(Number(price.amount)) || Number(price.amount) < 0)) return { ok: false, status: "price_unknown" };
  const total = String(Number(prices.reduce((sum, price) => sum + Number(price.amount), 0).toFixed(8)));
  const quote = createPaymentQuote({ manifest: { ...manifest, pricing: { ...holderPrice, amount: total } }, constraints, selectedService: selected });
  quote.steps = [
    ...(resolver ? [{ service_id: resolver.service_id, operation: "resolve_token", amount: resolverPrice.amount }] : []),
    { service_id: selected.service_id, operation: "token_holders", amount: holderPrice.amount }
  ];
  quote.prerequisites = resolver ? ["Exact chain + symbol must resolve to one contract; indexed holder availability is not guaranteed."] : [];
  if (resolver) {
    quote.agent_decision.can_answer = false;
    quote.agent_decision.can_attempt = quote.would_pay;
  }
  return { ok: quote.would_pay, status: quote.would_pay ? "quoted" : "quote_blocked", quote, selected, resolver, holder_price: holderPrice.amount };
}

async function resolveHolderToken(store, intent, workflow, options) {
  const resolver = workflow.resolver;
  const resolverInput = { search_query: intent.token_symbol, result_type: "token", chain: holderChain(intent.chain), limit: 50 };
  const record = store.services.get(resolver.service_id);
  const preflight = validateManifestInput(record.manifest, resolverInput);
  if (!preflight.ok) return { ok: false, status: "token_resolution_failed", preflight_validation: preflight };
  const invocation = await invokePaidService(store, resolver.service_id, resolverInput, { max_amount: workflow.quote.steps[0].amount, currency: "USDC" }, options);
  const evidence = { resolver_service_id: resolver.service_id, resolver_input: resolverInput, request_id: invocation.body.result?.request_id, billing: invocation.body.result?.metadata?.billing || null };
  if (invocation.statusCode >= 400 || invocation.body.result?.status !== "success" || invocation.body.result?.sample_type) return { ok: false, status: "token_resolution_failed", ...evidence, error: invocation.body.error };
  const match = matchHolderToken(invocation.body.result?.data, intent);
  if (!match.ok) return { ...match, ...evidence };
  return { ok: true, status: "resolved", ...evidence, resolution_type: "exact_symbol_and_chain", token_address: match.address,
    intent: { ...intent, chain: holderChain(intent.chain), token_address: match.address } };
}

function pickTokenResolver(services) {
  return services.map((service) => ({
    service,
    score: tokenResolverScore(service)
  })).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.service;
}

function findTokenMatch(data, { tokenSymbol, chain }) {
  const rows = flattenObjects(data);
  const normalized = String(tokenSymbol || "").toLowerCase();
  const chainNormalized = String(chain || "").toLowerCase();
  const candidates = rows.map((row) => ({
    address: row.token_address || row.contract_address || row.contractAddress || row.address,
    symbol: row.symbol || row.token_symbol || row.ticker,
    name: row.name || row.token_name,
    chain: row.chain || row.network || row.blockchain
  })).filter((row) => /^0x[a-fA-F0-9]{40}$/.test(String(row.address || "")));
  return candidates.find((row) =>
    String(row.symbol || "").toLowerCase() === normalized &&
    (!row.chain || !chainNormalized || String(row.chain).toLowerCase() === chainNormalized)
  ) || candidates.find((row) => String(row.symbol || "").toLowerCase() === normalized)
    || candidates.find((row) => String(row.name || "").toLowerCase() === normalized)
    || candidates[0] || null;
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function serviceSearchText(service) {
  return [
    service.service_id,
    service.title,
    service.description_for_agent,
    ...(service.capabilities || [])
  ].join(" ").toLowerCase();
}

function tokenResolverScore(service) {
  const text = serviceSearchText(service);
  let score = 0;
  if (/token[_\s-]?search|entity[_\s-]?search|token[_\s-]?resolver|resolve.*token/.test(text)) score += 8;
  if (/token[_\s-]?metadata|contract[_\s-]?address|token[_\s-]?address/.test(text)) score += 4;
  if ((service.capabilities || []).some((capability) => /token_search|entity_search|token_metadata/.test(capability))) score += 8;
  if ((service.capabilities || []).some((capability) => /news|article|rss|macro|etf/.test(capability))) score -= 8;
  if (/news|article|rss|search articles/.test(text)) score -= 8;
  return score;
}

function recentDateRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - Number(days || 1) * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
}

function normalizeProviderChain(chain) {
  const normalized = String(chain || "").toLowerCase();
  if (normalized === "bsc") return "bnb";
  return normalized || "ethereum";
}

function validateCapabilityRequest({ capability, params }) {
  if (capability === "token_holders") return validateHolderParams(params);
  const entry = CAPABILITY_ALIASES.find((item) => item.capability === capability);
  if (!entry) {
    if (isSafeDynamicCapability(capability) && params && typeof params === "object" && !Array.isArray(params)) {
      return { ok: true, dynamic: true };
    }
    return {
      ok: false,
      error: "UNSUPPORTED_CAPABILITY",
      supported_capabilities: [
        ...CAPABILITY_ALIASES.map((item) => item.capability),
        "<dynamic_data_capability>"
      ],
      dynamic_capability_hint: "For registered API/data services, pass a snake_case capability such as smart_money_holdings and put the provider request body in params."
    };
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      ok: false,
      error: "INVALID_PARAMS",
      expected_schema: entry.input_schema
    };
  }
  const missing = (entry.input_schema.required || []).filter((field) => params[field] === undefined || params[field] === null || params[field] === "");
  if (missing.length) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_PARAM",
      missing,
      expected_schema: entry.input_schema
    };
  }
  const invalid = [];
  for (const [field, schema] of Object.entries(entry.input_schema.properties || {})) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    if (schema.enum && !schema.enum.includes(value)) {
      invalid.push({ field, value, allowed: schema.enum });
    }
    if (schema.type === "number" && typeof value !== "number") {
      invalid.push({ field, value, expected_type: "number" });
    }
  }
  if (invalid.length) {
    return {
      ok: false,
      error: "INVALID_PARAM_VALUE",
      invalid,
      expected_schema: entry.input_schema
    };
  }
  return { ok: true };
}

function isKnownCapability(capability) {
  return CAPABILITY_ALIASES.some((entry) => entry.capability === capability);
}

function isSafeDynamicCapability(capability) {
  return /^[a-z][a-z0-9_-]{2,80}$/.test(String(capability || ""));
}

function dynamicCapabilityTerms(capability) {
  return String(capability || "")
    .toLowerCase()
    .split(/[_\-\s/]+/)
    .filter((term) => term.length > 1);
}

function dynamicInputParams(intent, sampleRequest = {}) {
  const ignored = new Set(["capability", "consumer_context"]);
  const entries = Object.entries(intent || {}).filter(([key, value]) => !ignored.has(key) && value !== undefined);
  const sampleKeys = new Set(Object.keys(sampleRequest || {}));
  if (!sampleKeys.size) return Object.fromEntries(entries);
  return Object.fromEntries(
    entries.filter(([key]) => sampleKeys.has(key))
  );
}

// These never run on the hosted server: they need the user's own browser, so a
// hosted no-match is expected and the caller should be told where they do run.
const LOCAL_ONLY_CAPABILITIES = {
  social_search: "Keyword search runs on your device through the AgentRouter MCP bridge, which drives your logged-in browser. The hosted API cannot serve it.",
  social_post_read: "Single-post reads run on your device through the AgentRouter MCP bridge. The hosted API cannot serve it."
};

// Names agents reach for that share no tokens with the real capability.
const CAPABILITY_HINTS = {
  web_search: ["external_api_query"],
  search: ["external_api_query", "social_user_voice_research"],
  web_fetch: ["external_api_query"],
  news_search: ["external_api_query"],
  social_search: ["social_user_voice_research", "social_post_read"],
  tweet_search: ["social_user_voice_research"],
  price: ["token_price"],
  quote: ["token_price"]
};

// Cheap similarity: shared tokens first, then substring overlap. Good enough to
// turn "web_search" into a pointer at "external_api_query".
function nearestCapabilities(capability, known) {
  const hinted = (CAPABILITY_HINTS[capability] || []).filter((name) => known.includes(name));
  if (hinted.length) return hinted;
  const terms = new Set(dynamicCapabilityTerms(capability));
  return known
    .map((name) => {
      const nameTerms = dynamicCapabilityTerms(name);
      const shared = nameTerms.filter((term) => terms.has(term)).length;
      const substring = name.includes(capability) || capability.includes(name) ? 1 : 0;
      return { name, score: shared * 2 + substring };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.name);
}

function diagnoseNoMatch(store, { capability, params, constraints }) {
  const registered = [...store.services.values()].map((record) => record.manifest);
  const capabilityTerms = dynamicCapabilityTerms(capability);
  const related = registered
    .map((manifest) => {
      const text = [
        manifest.service_id,
        manifest.title,
        manifest.description_for_agent,
        ...(manifest.capabilities || [])
      ].join(" ").toLowerCase();
      const hits = capabilityTerms.filter((term) => text.includes(term)).length;
      return {
        service_id: manifest.service_id,
        title: manifest.title,
        capabilities: manifest.capabilities,
        price: manifest.pricing,
        hits
      };
    })
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5);
  // Callers guess capability names ("social_search", "web_search") and get a
  // bare no-match, with nothing to correct against. Say what exists and which
  // known name is closest so the next call can succeed.
  const known = getCapabilityCatalog().map((entry) => entry.capability);
  const unknownCapability = Boolean(capability) && !known.includes(capability);
  const suggestions = unknownCapability ? nearestCapabilities(capability, known) : [];
  const localOnly = LOCAL_ONLY_CAPABILITIES[capability];
  return {
    code: unknownCapability ? "UNKNOWN_CAPABILITY" : "NO_REGISTERED_SERVICE_MATCHED",
    message: unknownCapability
      ? `No capability named "${capability}" exists.${suggestions.length ? ` Closest available: ${suggestions.join(", ")}.` : ""}`
      : related.length
        ? "Registered services exist with related terms, but none satisfied capability, price, and coverage constraints."
        : "No registered service exposes this capability yet.",
    requested_capability: capability,
    requested_params: params,
    constraints,
    available_capabilities: known,
    ...(suggestions.length ? { did_you_mean: suggestions } : {}),
    ...(localOnly ? { runs_locally: localOnly } : {}),
    related_services: related,
    next_actions: unknownCapability
      ? [
        suggestions.length
          ? `Retry with capability "${suggestions[0]}".`
          : "Pass a capability from available_capabilities.",
        "Or drop the capability field and send the natural-language task instead, and let AgentRouter route it."
      ]
      : [
        "Check that the provider service was published to the same remote registry the client is using.",
        "Search /services/search for the expected service id or capability tag.",
        "If Provider Studio showed validation errors, fix the upstream API/auth/request body and publish again."
      ]
  };
}

function explainRouteFailure({ error, selected, input }) {
  const code = error?.code || error?.error?.code || "UNKNOWN_ERROR";
  const upstreamStatus = error?.upstream_status || error?.error?.upstream_status;
  return {
    code,
    selected_service_id: selected?.service_id,
    user_message: code === "UPSTREAM_ERROR"
      ? `AgentRouter found and invoked ${selected?.service_id}, but the provider upstream rejected the request${upstreamStatus ? ` with HTTP ${upstreamStatus}` : ""}. This proves discovery/routing worked; the remaining issue is provider credentials, permission, or request shape.`
      : `AgentRouter found ${selected?.service_id}, but invocation failed with ${code}.`,
    input_sent: input,
    likely_causes: code === "UPSTREAM_ERROR"
      ? ["Provider API key is missing or lacks permission.", "The upstream endpoint requires a different request body.", "The upstream API rejected the provider account or quota."]
      : ["Budget, payment challenge, or provider runtime failed."],
    suggested_next_actions: [
      "Validate the provider secret in Provider Studio.",
      "Compare the input_sent body with the upstream API documentation.",
      "If the upstream returns 403/401, verify the provider account entitlement."
    ]
  };
}

function createRetryPlan({
  status,
  request = {},
  selected = null,
  input = null,
  error = null,
  verification = null,
  candidates = []
} = {}) {
  const code = error?.code || error?.error?.code || error?.error || status || "UNKNOWN";
  const providerInputRejected = /PREPAY_VALIDATION|UNRECOGNIZED_FIELD|INVALID_REQUEST|422/.test(String(code)) ||
    /unrecognized field|invalid request|validation/i.test(JSON.stringify(error || {}));
  const dataQualityFailed = status === "data_quality_failed" || verification?.sanity_valid === false || verification?.data_non_empty === false;
  const dataQualityWarning = status === "data_quality_warning";
  const noMatch = status === ROUTER_STATUSES.NO_MATCH;
  const excluded = selected?.service_id ? [selected.service_id] : [];
  const alternateCandidates = candidates
    .filter((candidate) => candidate.service_id && !excluded.includes(candidate.service_id))
    .slice(0, 3)
    .map((candidate) => candidate.service_id);

  if (providerInputRejected) {
    return {
      retry_plan_version: "agent_router_retry_plan_v1",
      retryable: true,
      reason_code: "provider_input_rejected",
      exclude_service_ids: excluded,
      alternate_service_ids: alternateCandidates,
      adjusted_request: input
        ? { ...request, constraints: { ...(request.constraints || {}), exclude_service_ids: excluded } }
        : request,
      suggested_next_actions: [
        "Retry with the same structured capability while excluding the failed service.",
        "If no alternate service exists, inspect the provider input schema and remove fields rejected by the upstream API.",
        "Do not reuse cached data as a substitute for this paid request."
      ]
    };
  }

  if (dataQualityFailed || dataQualityWarning) {
    return {
      retry_plan_version: "agent_router_retry_plan_v1",
      retryable: true,
      reason_code: dataQualityFailed ? "data_quality_failed" : "data_quality_warning",
      exclude_service_ids: excluded,
      alternate_service_ids: alternateCandidates,
      adjusted_request: { ...request, constraints: { ...(request.constraints || {}), exclude_service_ids: excluded } },
      quality_issues: [
        ...(verification?.data_quality_issues || []),
        ...(verification?.issues || []).filter((issue) => [
          "EMPTY_RESULT",
          "DATA_QUALITY_SANITY_FAILED",
          "STATUS_NOT_SUCCESS",
          "SCHEMA_ERROR",
          "ENVELOPE_ERROR",
          "FRESHNESS_NOT_VERIFIABLE",
          "ASSET_NOT_COVERED"
        ].includes(issue.code))
      ].map((issue) => issue.code).filter(Boolean),
      suggested_next_actions: [
        "Retry against the next ranked service if one is available.",
        "Ask for a narrower asset, venue, chain, or time window if the task was underspecified.",
        "Record consumer feedback marking the returned data as not useful or partial."
      ]
    };
  }

  if (noMatch) {
    return {
      retry_plan_version: "agent_router_retry_plan_v1",
      retryable: false,
      reason_code: "no_registered_service_matched",
      exclude_service_ids: [],
      alternate_service_ids: [],
      suggested_next_actions: [
        "Search available services by provider, domain, or capability before invoking.",
        "Register a provider service that exposes this capability.",
        "Ask the user whether a nearby capability is acceptable."
      ]
    };
  }

  return {
    retry_plan_version: "agent_router_retry_plan_v1",
    retryable: Boolean(error?.retryable || status === "route_failed"),
    reason_code: String(code).toLowerCase(),
    exclude_service_ids: excluded,
    alternate_service_ids: alternateCandidates,
    suggested_next_actions: [
      "Retry later if the provider is unavailable.",
      "Try the next ranked service if available.",
      "Return the failure reason to the user instead of fabricating an answer."
    ]
  };
}

function searchableValues(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => searchableValues(item));
  if (typeof value === "object") return Object.values(value).flatMap((item) => searchableValues(item));
  return [];
}

function normalizeRequestConstraints(constraints = {}, budget = {}) {
  return {
    ...constraints,
    max_price_usdc: constraints.max_price_usdc
      ?? constraints.max_price
      ?? constraints.max_amount
      ?? budget.max_amount
      ?? budget.max_price_usdc
      ?? budget.max_price,
    freshness_seconds: constraints.freshness_seconds,
    min_confidence: constraints.min_confidence
  };
}

function invalidBudgetRouteResult(request, validation) {
  return {
    ok: false,
    status: "invalid_request",
    error: validation.code,
    error_detail: {
      code: validation.code,
      field: validation.field,
      message: validation.message,
      retryable: false
    },
    request,
    route_decision: createRouteDecision({
      status: "invalid_request",
      request,
      exactMatch: false,
      validation: {
        ok: false,
        error: validation.code,
        field: validation.field,
        message: validation.message
      }
    })
  };
}

function constraintsWithoutBudgetGuard(constraints = {}) {
  const relaxed = { ...constraints };
  delete relaxed.max_price_usdc;
  delete relaxed.max_price;
  delete relaxed.max_amount;
  return relaxed;
}

function ambiguityNotesFor(capability) {
  if (capability === "perp_liquidation_max_pain") {
    return ["If the user only says max pain without liquidation/perp context, ask whether they mean options max pain."];
  }
  if (capability === "options_max_pain") {
    return ["Use only when the user explicitly mentions options or confirms options max pain."];
  }
  return [];
}

function detectAsset(text, rawText = text) {
  const pair = detectTradingPair(text);
  if (pair) return pair.base_asset;
  if (/\bbitcoin\b/i.test(text)) return "BTC";
  if (/\bethereum\b/i.test(text)) return "ETH";
  const match = text.match(/\b(btc|eth|sol|bnb|xrp|doge|hype)\b/i);
  if (match) return match[1].toUpperCase();
  const dollarTicker = String(rawText).match(/\$([A-Za-z][A-Za-z0-9]{1,11})(?=$|[^A-Za-z0-9])/);
  const uppercaseTicker = String(rawText).match(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,11})(?=$|[^A-Za-z0-9])/);
  const ticker = (dollarTicker?.[1] || uppercaseTicker?.[1] || "").toUpperCase();
  const nonAssetSymbols = new Set([
    "AI", "API", "HTTP", "JSON", "USD", "USDC", "USDT", "NFT", "TVL", "DEX", "CEX",
    "BSC", "BASE", "SOLANA", "ARBITRUM", "OPTIMISM", "ETHEREUM", "HYPEREVM", "POLYGON", "AVALANCHE"
  ]);
  return ticker && !nonAssetSymbols.has(ticker) ? ticker : undefined;
}

function detectTradingPair(text) {
  const match = String(text || "").toUpperCase().match(/\b([A-Z0-9]{2,15})(USDT|USDC|FDUSD|BUSD)\b/);
  if (!match) return null;
  return {
    symbol: `${match[1]}${match[2]}`,
    base_asset: match[1],
    quote_asset: match[2]
  };
}

function coinGeckoIdForAsset(asset) {
  const normalized = String(asset || "").toUpperCase();
  const ids = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    BNB: "binancecoin",
    XRP: "ripple",
    DOGE: "dogecoin"
  };
  return ids[normalized] || null;
}

function detectChain(text) {
  if (/\beth\b/.test(text) || text.includes("以太坊")) return "ethereum";
  if (/hyper\s?evm|hyperevm|hyperliquid|hype/i.test(text)) return "hyperevm";
  for (const chain of ["base", "ethereum", "arbitrum", "optimism", "solana", "bsc", "hyperevm"]) {
    if (text.includes(chain)) return chain;
  }
  if (text.includes("链")) return "base";
  return undefined;
}

function chainFromAsset(asset) {
  const normalized = String(asset || "").toUpperCase();
  if (normalized === "ETH") return "ethereum";
  if (normalized === "BNB") return "bsc";
  if (normalized === "HYPE") return "hyperevm";
  return undefined;
}

function detectDays(text) {
  const match = text.match(/(\d+)\s*(d|day|days|天|日)/i);
  return match ? Number(match[1]) : undefined;
}
