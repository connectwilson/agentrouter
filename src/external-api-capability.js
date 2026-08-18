import { readProviderSecret } from "./provider-secrets.js";
import { writePersistentServiceEvent } from "./persistence.js";
import { publicReputation, summarizeTrust } from "./store.js";

const AI_SEARCH_SOURCES = new Set([
  "brave_search", "tavily", "serper", "exa", "firecrawl", "jina",
  "github", "gdelt", "sec_edgar", "openalex", "perplexity"
]);

// Reviewed upstream prices for the exact read-only operations used below.
// These are provider costs paid through the user's connected account, not an
// AgentRouter surcharge. Keep the source URL and review date visible so a
// variable/token/credit price is never presented as a made-up flat fee.
const AI_SEARCH_PRICING = Object.freeze({
  brave_search: upstreamPrice("$0.005/call", 0.005, "per_request", "https://api-dashboard.search.brave.com/documentation/pricing", {
    note: "Search API base rate; monthly credits may offset usage."
  }),
  tavily: upstreamPrice("$0.008/call", 0.008, "per_request", "https://help.tavily.com/articles/8816424538-pricing", {
    note: "PAYG price for one basic-search credit; plan credits may offset usage."
  }),
  serper: upstreamPrice("$0.001/call", 0.001, "per_request", "https://serper.dev/", {
    note: "Starter top-up rate; larger credit packs have lower unit prices."
  }),
  exa: upstreamPrice("$0.007/call", 0.007, "per_request", "https://exa.ai/pricing?tab=api", {
    note: "Base search with up to 10 results; additional contents or results may cost more."
  }),
  firecrawl: upstreamPrice("2 credits/10 results", null, "credits", "https://www.firecrawl.dev/pricing", {
    unit_amount: 2,
    unit: "credits_per_10_results",
    note: "Search usage; the USD value of a credit depends on the connected plan."
  }),
  jina: upstreamPrice("From 10k tokens/call", null, "tokens", "https://jina.ai/reader/", {
    unit_amount: 10000,
    unit: "tokens_per_search",
    note: "Jina Search charges a fixed token amount starting at 10,000 tokens per request."
  }),
  github: upstreamPrice("FREE", 0, "free", "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api", {
    note: "No per-request fee; GitHub rate limits apply."
  }),
  gdelt: upstreamPrice("FREE", 0, "free", "https://www.gdeltproject.org/", {
    note: "Public GDELT API; usage and availability limits apply."
  }),
  sec_edgar: upstreamPrice("FREE", 0, "free", "https://www.sec.gov/search-filings/edgar-application-programming-interfaces", {
    note: "Public SEC EDGAR API; fair-access limits apply."
  }),
  openalex: upstreamPrice("$0.001/call", 0.001, "per_request", "https://developers.openalex.org/api-reference/authentication", {
    note: "Search endpoint price; every API key currently receives a daily free allowance."
  }),
  perplexity: upstreamPrice("From $0.005 + tokens", 0.005, "request_plus_tokens", "https://docs.perplexity.ai/docs/getting-started/pricing", {
    note: "Sonar request fee at low context plus input and output token charges."
  })
});

function upstreamPrice(label, amount, model, sourceUrl, extra = {}) {
  return Object.freeze({
    label,
    amount,
    currency: amount == null ? null : "USD",
    model,
    source_url: sourceUrl,
    checked_at: "2026-08-15",
    ...extra
  });
}

const SOURCE_CATALOG = [
  source("brave_search", "搜索", "Brave Search", "available", "brave_api", ["search"]),
  source("tavily", "搜索", "Tavily", "available", "tavily_api", ["search"]),
  source("serper", "搜索", "Serper", "available", "serper_api", ["search"]),
  source("exa", "搜索", "Exa", "available", "exa_api", ["search"]),
  source("firecrawl", "抓取", "Firecrawl", "available", "firecrawl_api", ["search"]),
  source("jina", "抓取", "Jina", "available", "jina_api", ["search"]),
  source("github", "开发者", "GitHub Public", "available", null, ["search"]),
  source("gdelt", "新闻", "GDELT", "available", null, ["search"]),
  source("sec_edgar", "公司与监管", "SEC EDGAR", "available", null, ["filings"]),
  source("open_meteo", "天气与环境", "Open-Meteo", "available", null, ["forecast"]),
  source("youtube", "社交媒体", "YouTube Data API", "available", "youtube_api", ["search"]),
  source("virus_total", "安全", "VirusTotal", "available", "virustotal_api", ["inspect"]),
  source("google_places", "地点", "Google Places", "available", "google_places_api", ["search"]),
  source("amadeus", "旅行", "Amadeus", "available", "amadeus_api", ["flight_search"]),
  source("easy_post", "物流", "EasyPost", "available", "easypost_api", ["track"]),
  source("openalex", "学术", "OpenAlex", "available", "openalex_api", ["search"]),
  source("perplexity", "搜索", "Perplexity", "available", "perplexity_api", ["search"]),
  source("parallel", "搜索", "Parallel", "planned", null, []),
  source("bright_data", "抓取", "Bright Data", "requires_partner_api", null, []),
  source("x", "社交媒体", "X / Twitter", "available", "x_api", ["search"]),
  source("reddit", "社交媒体", "Reddit", "available", "reddit_api", ["search"]),
  source("xiaohongshu", "社交媒体", "小红书", "browser_only", "local_browser", ["search", "post_read"]),
  source("linkedin", "社交媒体", "LinkedIn", "requires_partner_api", null, []),
  source("tiktok", "社交媒体", "TikTok", "browser_only", "local_browser", ["post_read"]),
  source("douyin", "社交媒体", "抖音", "requires_partner_api", null, []),
  source("zhihu", "社交媒体", "知乎", "browser_only", "local_browser", ["post_read"]),
  source("weibo", "社交媒体", "微博", "browser_only", "local_browser", ["post_read"]),
  source("bilibili", "社交媒体", "Bilibili", "browser_only", "local_browser", ["search", "post_read"]),
  source("tushare", "金融", "Tushare", "available", "tushare_api", ["search"]),
  source("yahoo_finance", "金融", "Yahoo Finance", "available", null, ["search", "quote"]),
  source("fred", "金融", "FRED", "available", "fred_api", ["search"]),
  source("finnhub", "金融", "Finnhub", "available", "finnhub_api", ["search", "quote"])
];

export function getExternalApiCatalog(store, ownerKey) {
  const accountStateKnown = Boolean(ownerKey);
  const connections = new Set([...(store?.socialConnections || new Map()).values()]
    .filter((item) => item.owner_key === ownerKey)
    .map((item) => item.platform));
  return SOURCE_CATALOG.map((item) => {
    const service = externalApiService(item, store);
    const availableToAgents = item.implementation_status === "available";
    const connected = item.connection_required
      ? (accountStateKnown ? connections.has(item.source) : null)
      : availableToAgents;
    return {
      ...item,
      ...service,
      available_to_agents: availableToAgents,
      connected,
      connection_state: !item.connection_required
        ? "not_required"
        : !accountStateKnown
          ? "unknown"
          : connected
            ? "connected"
            : "not_connected",
      // Steer agents to the key-free path before they try the API and stall on
      // a credential the user does not have.
      ...(connected === true || !FREE_LOCAL_ALTERNATIVES[item.source]
        ? {}
        : {
          preferred_path: "local_browser",
          free_alternative: freeLocalAlternative(item.source)
        })
    };
  });
}

export function getExternalApiServiceDetail(store, serviceId, ownerKey) {
  const sourceItem = getExternalApiCatalog(store, ownerKey)
    .find((item) => item.service_id === serviceId);
  if (!sourceItem || sourceItem.implementation_status !== "available") return null;
  const feedbackEvents = externalApiEvents(store, serviceId);
  const manifest = {
    manifest_type: "agentrouter_external_api_source",
    service_id: sourceItem.service_id,
    version: "1.0.0",
    title: sourceItem.title,
    description_for_agent: sourceItem.description_for_agent,
    provider: { provider_id: sourceItem.provider_id },
    capabilities: sourceItem.capabilities,
    endpoint: { method: "POST", url: "/agent-router/request" },
    sample_request: {
      capability: "external_api_query",
      params: { source: sourceItem.source, operation: sourceItem.operations[0] || "search", query: "<query>", limit: 10 }
    },
    input_schema: {
      type: "object",
      required: ["source", "operation", "query"],
      properties: {
        source: { const: sourceItem.source },
        operation: { enum: sourceItem.operations },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 25 }
      }
    },
    output_schema: {
      type: "object",
      required: ["items", "count"],
      properties: { items: { type: "array" }, count: { type: "integer" } }
    },
    pricing: { amount: "0", currency: "USDC", model: "agentrouter_no_surcharge" },
    upstream_pricing: sourceItem.upstream_pricing,
    pre_call_context: {
      buyer_requirements: {
        payment_required: false,
        needs_buyer_api_key: sourceItem.connection_required,
        credential_setup: sourceItem.connection_required ? "Connect the source once in AgentRouter." : "none"
      },
      limitations: ["Read-only connector", "Results depend on the upstream provider and current account quota."]
    }
  };
  return {
    service_detail_version: "agent_router_service_detail_v1",
    data_context: {
      page_role: "service_capability_detail",
      result_preview_role: "none",
      result_preview_is_live_user_query: false,
      explanation: "Metrics are calculated from real AgentRouter calls to this source; no sample result is presented as live data."
    },
    service: {
      ...sourceItem,
      display_title: sourceItem.title,
      verification_status: "verified",
      pricing: manifest.pricing,
      trust: sourceItem.trust,
      health: sourceItem.health,
      pre_call_context: manifest.pre_call_context,
      request_data: manifest.input_schema,
      response_data: manifest.output_schema,
      source_provenance: { source_provenance_level: "connected_upstream_api", upstream_source: sourceItem.source }
    },
    manifest,
    latest_validation: null,
    recent_evidence_events: [],
    recent_quality_events: [],
    recent_feedback_events: feedbackEvents.slice(-20),
    recent_health_checks: []
  };
}

// Naming the source was the only way to reach these APIs, so an ordinary
// question ("find remote crypto PM jobs") routed nowhere while the same question
// written as "search Exa for ..." worked. Match on what the question is about
// instead, and let a named source still win when the caller specifies one.
//
// Boundaries are lookarounds, not consumed characters: the old form ate the
// separator, so in "track my package" a scan could match `track` and then miss
// `package` because the space it needed had already been consumed. That matters
// now that terms are counted rather than merely detected. Lookarounds also work
// against CJK, which has no \b.
function termPattern(latin, cjk = "", flags = "i") {
  const parts = [];
  if (latin) parts.push(`(?<![a-z0-9])(?:${latin})(?![a-z0-9])`);
  if (cjk) parts.push(`(?:${cjk})`);
  return new RegExp(parts.join("|"), flags);
}

// Terms are split by how much they mean on their own.
//
// `strong` names the domain and nothing else: "parcel", "arxiv", "nasdaq". One
// is enough to route.
//
// `weak` is ordinary English that only suggests the domain in company:
// "track", "package", "near", "issues", "video". Routing on one of these is how
// "AltLayer hackathon track submission rules" became a parcel lookup — the
// first intent whose pattern matched won outright, with nothing comparing how
// well it matched. A weak term now needs a second signal from the same domain,
// and every intent is scored so the best one wins instead of the earliest.
const SOURCE_INTENTS = [
  { sources: ["gdelt"], operation: "search",
    strong: ["news|headlines?|news coverage", "新闻|新聞|报道|報道|舆情|輿情"],
    weak: "press|coverage|media|reported" },
  { sources: ["sec_edgar"], operation: "filings",
    strong: ["edgar|10-k|10k|8-k|prospectus|sec filings?", "财报|財報|备案|備案|招股"],
    weak: "sec|filings?|filed|disclosure" },
  { sources: ["open_meteo"], operation: "forecast",
    strong: ["weather|temperature|rainfall|snowfall", "天气|天氣|气温|氣溫|预报|預報"],
    weak: "forecast|rain|snow|humidity|wind" },
  { sources: ["yahoo_finance", "finnhub"], operation: "search",
    strong: ["share price|stock price|nasdaq|nyse|ticker", "股价|股價|股票|行情"],
    weak: "stock|earnings|shares?|dividend" },
  { sources: ["github"], operation: "search",
    strong: ["github|repository|pull request|source code", "开源|開源|仓库|倉庫"],
    weak: "repo|issues?|commit|branch" },
  { sources: ["openalex"], operation: "search",
    strong: ["papers?|publications?|citations?|doi|arxiv|peer.reviewed", "论文|論文|文献|文獻"],
    weak: "study|studies|research|journal|authors?" },
  { sources: ["google_places"], operation: "search",
    strong: ["restaurants?|cafes?|coffee shops?|hotels?|nearby", "附近|餐厅|餐廳|咖啡"],
    weak: "near|around|places?|open now" },
  { sources: ["amadeus"], operation: "flight_search",
    strong: ["flights?|airfare|airline", "机票|機票|航班"],
    weak: "fly|departure|arrival|layover" },
  { sources: ["easy_post"], operation: "track",
    strong: ["parcel|shipment|waybill|courier|easypost|tracking number", "快递|快遞|物流|包裹"],
    weak: "track|tracking|package|delivery|shipping" },
  { sources: ["virus_total"], operation: "inspect",
    strong: ["malicious|malware|virus|phishing", "恶意|惡意|病毒|钓鱼|釣魚"],
    weak: "suspicious|scam|infected|threat" },
  { sources: ["youtube"], operation: "search",
    strong: ["youtube|vlog", "视频|視頻"],
    weak: "video|channel|watch|subscribers?" }
].map((intent) => ({
  ...intent,
  strongPattern: termPattern(intent.strong[0], intent.strong[1]),
  weakPattern: termPattern(intent.weak, "", "gi")
}));

const INTENT_ROUTE_THRESHOLD = 2;

// A strong term is worth the threshold on its own; weak terms have to add up.
// Counts distinct terms, so "tracking a tracking number" is still one signal.
function intentScore(text, intent) {
  let score = intent.strongPattern.test(text) ? INTENT_ROUTE_THRESHOLD : 0;
  const seen = new Set((text.toLowerCase().match(intent.weakPattern) || []));
  return score + seen.size;
}

// Anything else that is plainly a lookup goes to whichever web search is usable.
const WEB_SEARCH_SOURCES = ["exa", "tavily", "brave_search", "serper", "perplexity", "firecrawl", "jina"];
const WEB_SEARCH_PATTERN = termPattern(
  "jobs?|hiring|openings?|roles?|vacanc\\w*|careers?|search|find|look up|latest|what is|who is|how to|compare|reviews?",
  "招聘|岗位|崗位|职位|職位|最新|查一下|搜一下|了解|怎么|怎樣"
);

// A question is a lookup even when it uses none of those verbs. "How does
// 8004scan.io index ERC-8004 agents?" reached no service at all, because the
// fallback only recognised a request phrased as a command.
const QUESTION_PATTERN = /[?？]\s*$|^\s*(?:who|what|whats|when|where|which|why|how|is|are|was|were|does|do|did|can|could|should|would|will)(?![a-z0-9])|(?:吗|嗎|呢|如何|什么|什麼|哪些|为什么|為什麼)/i;

// ...but only if it asks about something. "how are you" is a greeting, and
// paying a search provider for it would be worse than answering directly.
const CHATTER_WORDS = new Set([
  "a", "an", "am", "and", "are", "as", "at", "be", "can", "could", "did", "do", "does", "doing",
  "evening", "for", "good", "hello", "help", "hey", "hi", "how", "i", "in", "is", "it", "its",
  "me", "morning", "my", "of", "ok", "okay", "on", "or", "please", "should", "so", "tell", "thank",
  "thanks", "that", "the", "there", "this", "to", "today", "us", "was", "we", "were", "what",
  "whats", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your", "yours"
]);

function asksAboutSomething(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return true;
  return text.toLowerCase().split(/[^a-z0-9.\-_]+/i).some((word) => word && !CHATTER_WORDS.has(word));
}

function pickAvailableSource(sourceIds, connectedSources, operation) {
  const usable = sourceIds
    .map((id) => SOURCE_CATALOG.find((item) => item.source === id))
    .filter((item) => item && item.implementation_status === "available" && item.operations.includes(operation));
  // Prefer a source the user has actually connected, then one needing no key.
  return usable.find((item) => connectedSources.has(item.source))
    || usable.find((item) => !item.connection_required)
    || usable[0]
    || null;
}

// `tier` controls how hard this tries, because the answer depends on what has
// already been ruled out:
//   "specialized" — only the domain sources, for the pass that runs BEFORE the
//                   registered-service router. Nothing generic, so a web search
//                   cannot preempt a service that would have matched.
//   "web"         — the pass that runs AFTER the router found nothing. At that
//                   point a web search is the only remaining answer, so any
//                   substantive question qualifies.
//   default       — both, conservatively: for callers with no router around them.
export function inferExternalApiRequest(task, { connectedSources = [], tier = "all" } = {}) {
  const text = clean(task, 1000);
  if (!text) return null;
  const connected = new Set(connectedSources);
  if (tier === "web") {
    if (!asksAboutSomething(text)) return null;
    const source = pickAvailableSource(WEB_SEARCH_SOURCES, connected, "search");
    return source
      ? { capability: "external_api_query", params: { source: source.source, operation: "search", query: extractSearchQuery(text), limit: 10 } }
      : null;
  }
  let definition = SOURCE_CATALOG.find((item) =>
    item.implementation_status === "available"
      && item.operations.includes("search")
      && sourceMentioned(text, item));
  let operation = "search";
  if (!definition) {
    // Best score, not first match: one incidental keyword used to win outright.
    const best = SOURCE_INTENTS
      .map((entry) => ({ entry, score: intentScore(text, entry) }))
      .filter((candidate) => candidate.score >= INTENT_ROUTE_THRESHOLD)
      .sort((a, b) => b.score - a.score)[0];
    if (best) {
      definition = pickAvailableSource(best.entry.sources, connected, best.entry.operation);
      if (definition) operation = best.entry.operation;
    }
  }
  if (!definition && tier !== "specialized"
    && (WEB_SEARCH_PATTERN.test(text) || QUESTION_PATTERN.test(text)) && asksAboutSomething(text)) {
    definition = pickAvailableSource(WEB_SEARCH_SOURCES, connected, "search");
  }
  if (!definition) return null;
  if (!definition.operations.includes(operation)) operation = definition.operations[0] || "search";
  return {
    capability: "external_api_query",
    params: {
      source: definition.source,
      operation,
      query: extractSearchQuery(text),
      limit: 10
    }
  };
}

// Callers asking for more results should get them; 10 was only ever a default.
// Each upstream has its own ceiling, so clamp per source instead of applying one
// pessimistic cap to every provider.
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 100;
const SOURCE_MAX_LIMIT = {
  brave_search: 20,
  tavily: 20,
  google_places: 20,
  amadeus: 20,
  youtube: 50,
  gdelt: 250,
  openalex: 200
};

export function resolveResultLimit(sourceId, requested) {
  const ceiling = SOURCE_MAX_LIMIT[sourceId] ?? MAX_RESULT_LIMIT;
  const value = Number(requested) || DEFAULT_RESULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), ceiling);
}

// Several sources have a free path that needs no API key at all: the MCP bridge
// drives the user's own logged-in browser. Without this, an agent that reaches
// for the API source hits connection_required and stops, even though the data
// is available to it for free one capability over.
const FREE_LOCAL_ALTERNATIVES = {
  x: "x",
  reddit: "reddit",
  xiaohongshu: "xiaohongshu",
  bilibili: "bilibili",
  youtube: "youtube",
  zhihu: "zhihu",
  weibo: "weibo"
};

export function freeLocalAlternative(sourceId, params = {}) {
  const platform = FREE_LOCAL_ALTERNATIVES[sourceId];
  if (!platform) return null;
  return {
    reason: "This source needs a paid platform API key, but the same data is readable for free through your own signed-in browser.",
    capability: "social_search",
    execution_location: "user_device",
    requires_api_key: false,
    call: {
      capability: "social_search",
      params: { platform, query: params.query || "", ...(params.limit ? { limit: params.limit } : {}) }
    },
    requires: "The AgentRouter MCP bridge (local stdio), with the OpenCLI browser extension connected."
  };
}

export async function runExternalApiQuery(store, ownerKey, params = {}, options = {}) {
  const sourceId = clean(params.source, 64).toLowerCase();
  const query = clean(params.query, 500);
  const operation = clean(params.operation || "search", 32).toLowerCase();
  const limit = resolveResultLimit(sourceId, params.limit);
  const definition = SOURCE_CATALOG.find((item) => item.source === sourceId);
  if (!definition) return failure("unsupported_source", `Unknown source: ${sourceId || "(missing)"}`);
  if (definition.implementation_status !== "available") {
    return { ...failure("source_not_callable", `${definition.title} is not available through a server API connector.`), source: publicSource(definition), action_required: definition.implementation_status };
  }
  if (!query) return failure("invalid_request", "params.query is required");
  if (!definition.operations.includes(operation)) {
    return {
      ...failure("unsupported_operation", `${operation} is not supported for ${sourceId}`),
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: `${operation} is not supported for ${sourceId}`,
        allowed_operations: definition.operations
      }
    };
  }
  const parameterError = validateSourceParams(sourceId, operation, params);
  if (parameterError) return parameterError;

  let secret = "";
  if (definition.connection_required) {
    const connection = [...(store?.socialConnections || new Map()).values()].find((item) =>
      item.owner_key === ownerKey && item.platform === sourceId && item.provider_type === definition.provider_type);
    if (!connection) {
      const alternative = freeLocalAlternative(sourceId, { query, limit: params.limit });
      return {
        ...failure(
          "connection_required",
          alternative
            ? `${definition.title} needs a paid platform API key. Use the free local browser path instead: call social_search with platform "${alternative.call.params.platform}".`
            : `Connect ${definition.title} before invoking this source.`
        ),
        action_required: alternative ? "use_free_local_alternative" : "connect_api_source",
        ...(alternative ? { free_alternative: alternative } : {}),
        source: publicSource(definition)
      };
    }
    const readSecret = options.readSecret || readProviderSecret;
    secret = await readSecret(connection.secret_ref);
    if (!secret) return { ...failure("auth_required", "The connected credential is unavailable."), action_required: "reconnect_api_source" };
  }

  const startedAt = Date.now();
  const response = await invokeSource(sourceId, {
    operation,
    query,
    limit,
    params,
    secret,
    fetchImpl: options.fetchImpl || globalThis.fetch
  });
  const invocation = recordExternalApiInvocation(store, definition, response, Date.now() - startedAt, options);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      request_id: invocation.requestId,
      service_id: invocation.serviceId,
      source: publicSource(definition),
      error: { code: response.status.toUpperCase(), message: response.error },
      consumer_feedback_request: consumerFeedbackRequest(invocation, { source: sourceId, operation, query })
    };
  }
  const noResults = response.items.length === 0;
  return {
    ok: true,
    status: noResults ? "no_results" : "completed",
    protocol: { protocol_version: "agent_router_external_api_v1", write_access: false },
    // The call is already recorded under this id; returning it is what lets an
    // agent rate a result it was happy with, not only one that failed.
    request_id: invocation.requestId,
    service_id: invocation.serviceId,
    request: { capability: "external_api_query", params: { source: sourceId, operation, query, limit } },
    source: publicSource(definition),
    result: { items: response.items, count: response.items.length },
    consumer_feedback_request: consumerFeedbackRequest(invocation, { source: sourceId, operation, query }),
    ...(noResults ? {
      diagnostics: {
        code: "PROVIDER_RETURNED_NO_RESULTS",
        message: `${definition.title} completed the request but returned no matching items.`,
        source: sourceId,
        operation,
        query
      }
    } : {}),
    verification: {
      source_urls_present: response.items.every((item) => /^https?:\/\//.test(item.url || "")),
      credential_redacted: true,
      provider_response_normalized: true
    }
  };
}

function externalApiService(definition, store) {
  const serviceId = `external_api_${definition.source}`;
  const providerId = `provider_${definition.provider_type || definition.source}`;
  const feedbackEvents = externalApiEvents(store, serviceId);
  const trust = summarizeTrust({
    manifest: { provider: { provider_id: providerId } },
    verification_status: definition.implementation_status === "available" ? "verified" : "unverified",
    feedback_events: feedbackEvents
  });
  const measuredTrust = trust.operational_feedback_count > 0
    ? trust
    : { ...trust, trust_score: null };
  const observedCalls = trust.operational_feedback_count > 0;
  const upstreamPricing = AI_SEARCH_PRICING[definition.source]
    || upstreamPrice(definition.connection_required ? "BYOK" : "FREE", definition.connection_required ? null : 0, definition.connection_required ? "provider_defined" : "free", definition.connection_required ? null : definition.docs_url || null);
  return {
    service_id: serviceId,
    provider_id: providerId,
    display_title: definition.title,
    description_for_agent: `Use ${definition.title} as a read-only ${(definition.hub_category || "data").toLowerCase()} source through AgentRouter.`,
    price: 0,
    price_label: upstreamPricing.label,
    price_scope: "upstream_api",
    agentrouter_price: 0,
    upstream_pricing: upstreamPricing,
    pricing_model: upstreamPricing.model === "free" ? "public_free" : "bring_your_own_key_upstream_billed",
    currency: "USDC",
    total_calls: observedCalls ? trust.operational_feedback_count : null,
    success_rate: trust.success_rate,
    trust_score: measuredTrust.trust_score,
    trust: measuredTrust,
    // Registered services and external API sources are both things an agent can
    // call and rate, so they must report reputation the same way.
    reputation: publicReputation(
      { updated_at: null, created_at: null, feedback_events: feedbackEvents },
      trust,
      { status: definition.implementation_status === "available" ? "healthy" : "unavailable", circuit_breaker: null }
    ),
    metrics_available: observedCalls,
    health: {
      status: definition.implementation_status !== "available"
        ? "unavailable"
        : trust.recent_failure_rate != null && trust.recent_failure_rate >= 0.5
          ? "degraded"
          : "healthy",
      last_validation_at: feedbackEvents.at(-1)?.created_at || null
    },
    capabilities: [definition.source, "ai_search", ...definition.operations, ...(definition.connection_required ? ["byok"] : [])],
    detail_href: `/agent-router/service?service_id=${encodeURIComponent(serviceId)}`
  };
}

function externalApiEvents(store, serviceId) {
  return (store?.feedbackEvents || []).filter((event) => event.service_id === serviceId);
}

// Reputation only means something if good results can be rated too, so every
// outcome carries the handle needed to rate it.
  // Matches the paid path's contract: an agent that only rates failures leaves a
  // service's reputation made of complaints. Successful calls are exactly the
  // ones that need rating, so the request says so in the same shape.
function consumerFeedbackRequest(invocation, { source, operation, query }) {
  return {
    feedback_request_version: "agent_consumer_feedback_request_v1",
    must_submit: true,
    timing: "after_final_answer_or_after_deciding_result_usability",
    endpoint: "/agent-router/feedback",
    method: "POST",
    request_id: invocation.requestId,
    service_id: invocation.serviceId,
    tool: "agentrouter_feedback",
    instructions: [
      "Submit after deciding whether these results helped answer the user's task.",
      "Judge intent fit and usefulness for this call only; do not infer domain truth beyond the returned data.",
      "If another source was needed, set answer_useful to partial or no and list missing_fields.",
      "Do not skip this for successful calls — reputation built only from failures is misleading."
    ],
    // Copyable as-is: reason is required, so an example without it would be
    // rejected the moment an agent followed it.
    example: {
      request_id: invocation.requestId,
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        confidence: 0.9,
        reason: "Results matched the question and were used in the answer."
      }
    },
    required_fields: ["intent_fit", "answer_useful", "reason"],
    context: { source, operation, query }
  };
}

function recordExternalApiInvocation(store, definition, response, latencyMs, options) {
  const serviceId = `external_api_${definition.source}`;
  const requestId = `external_${definition.source}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const successful = response.ok === true;
  const event = {
    event_version: "agent_external_api_feedback_v1",
    request_id: requestId,
    service_id: serviceId,
    provider_id: `provider_${definition.provider_type || definition.source}`,
    source: definition.source,
    status: successful ? "success" : "error",
    http_status: Number.isFinite(Number(response.http_status)) ? Number(response.http_status) : null,
    provider_status: response.status || null,
    schema_valid: successful,
    verification: successful ? {
      coverage_valid: Array.isArray(response.items),
      freshness_valid: null,
      agent_friendly_score: 1
    } : null,
    latency_ms: latencyMs,
    created_at: new Date().toISOString()
  };
  if (store?.feedbackEvents) store.feedbackEvents.push(event);
  if (store?.invocationLogs) store.invocationLogs.push({
    request_id: requestId,
    service_id: serviceId,
    provider_id: event.provider_id,
    status: event.status,
    latency_ms: latencyMs,
    created_at: event.created_at
  });
  const writer = options.writeServiceEvent || writePersistentServiceEvent;
  Promise.resolve(writer({ eventType: "operational_feedback", serviceId, requestId, event })).catch(() => {});
  return { requestId, serviceId };
}

function validateSourceParams(sourceId, operation, params) {
  if (sourceId !== "amadeus" || operation !== "flight_search") return null;
  const missingFields = [];
  if (!/^[A-Za-z]{3}$/.test(String(params.origin || "").trim())) missingFields.push("origin");
  if (!/^[A-Za-z]{3}$/.test(String(params.destination || "").trim())) missingFields.push("destination");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.departure_date || "").trim())) missingFields.push("departure_date");
  if (!missingFields.length) return null;
  return {
    ok: false,
    status: "invalid_request",
    error: {
      code: "INVALID_PROVIDER_PARAMETERS",
      message: "Amadeus flight_search requires three-letter origin and destination IATA codes plus departure_date in YYYY-MM-DD format.",
      missing_fields: missingFields
    }
  };
}

async function invokeSource(sourceId, context) {
  try {
    if (sourceId === "open_meteo") return invokeOpenMeteo(context);
    if (sourceId === "sec_edgar") return invokeSecEdgar(context);
    const request = buildRequest(sourceId, context);
    if (!request) return { ok: false, status: "provider_error", error: "Connector is not implemented.", items: [] };
    const fetched = await fetchJson(context.fetchImpl, request.url, request.options);
    if (!fetched.ok) return fetched;
    return { ok: true, status: "completed", items: normalizeItems(sourceId, fetched.payload, context).slice(0, context.limit) };
  } catch (error) {
    return { ok: false, status: "provider_error", error: clean(error.message, 300), items: [] };
  }
}

const YAHOO_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function operationOf(context) {
  return context.operation || "search";
}

function buildRequest(sourceId, context) {
  const { query, limit, secret, params } = context;
  if (sourceId === "brave_search") {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    return get(url, { accept: "application/json", "x-subscription-token": secret });
  }
  if (sourceId === "tavily") return post("https://api.tavily.com/search", { query, max_results: limit }, { authorization: `Bearer ${secret}` });
  if (sourceId === "serper") return post("https://google.serper.dev/search", { q: query, num: limit }, { "x-api-key": secret });
  if (sourceId === "exa") return post("https://api.exa.ai/search", { query, numResults: limit, contents: { text: { maxCharacters: 1200 } } }, { "x-api-key": secret });
  if (sourceId === "firecrawl") return post("https://api.firecrawl.dev/v2/search", { query, limit }, { authorization: `Bearer ${secret}` });
  if (sourceId === "jina") {
    const url = new URL("https://s.jina.ai/");
    url.searchParams.set("q", query);
    return get(url, { accept: "application/json", authorization: `Bearer ${secret}`, "x-respond-with": "no-content" });
  }
  if (sourceId === "github") {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(limit));
    return get(url, { accept: "application/vnd.github+json", "user-agent": "AgentRouter/0.1" });
  }
  if (sourceId === "gdelt") {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    url.searchParams.set("query", query);
    url.searchParams.set("mode", "artlist");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", String(limit));
    return get(url);
  }
  if (sourceId === "youtube") {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(limit));
    url.searchParams.set("key", secret);
    return get(url);
  }
  if (sourceId === "virus_total") {
    const target = virusTotalTarget(query);
    return get(`https://www.virustotal.com/api/v3/${target.type}/${encodeURIComponent(target.id)}`, { accept: "application/json", "x-apikey": secret });
  }
  if (sourceId === "google_places") {
    return post("https://places.googleapis.com/v1/places:searchText", { textQuery: query, maxResultCount: limit }, {
      "x-goog-api-key": secret,
      "x-goog-fieldmask": "places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.websiteUri,places.rating,places.userRatingCount,places.currentOpeningHours"
    });
  }
  if (sourceId === "amadeus") {
    const origin = clean(params.origin, 3).toUpperCase();
    const destination = clean(params.destination, 3).toUpperCase();
    const departureDate = clean(params.departure_date, 10);
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
      throw new Error("Amadeus flight_search requires origin, destination, and departure_date.");
    }
    const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
    url.searchParams.set("originLocationCode", origin);
    url.searchParams.set("destinationLocationCode", destination);
    url.searchParams.set("departureDate", departureDate);
    url.searchParams.set("adults", String(Math.max(Number(params.adults) || 1, 1)));
    url.searchParams.set("max", String(limit));
    return get(url, { authorization: `Bearer ${secret}`, accept: "application/json" });
  }
  if (sourceId === "easy_post") {
    const url = new URL("https://api.easypost.com/v2/trackers");
    url.searchParams.append("tracking_codes[]", query);
    if (params.carrier) url.searchParams.set("carrier", clean(params.carrier, 40));
    return get(url, { authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`, accept: "application/json" });
  }
  if (sourceId === "yahoo_finance") {
    if (operationOf(context) === "quote") {
      const symbol = clean(query, 20).toUpperCase();
      const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
      url.searchParams.set("range", clean(params.range, 10) || "1d");
      url.searchParams.set("interval", clean(params.interval, 10) || "1d");
      return get(url, { "user-agent": YAHOO_USER_AGENT, accept: "application/json" });
    }
    const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
    url.searchParams.set("q", query);
    url.searchParams.set("quotesCount", String(limit));
    url.searchParams.set("newsCount", "0");
    return get(url, { "user-agent": YAHOO_USER_AGENT, accept: "application/json" });
  }
  if (sourceId === "fred") {
    const url = new URL("https://api.stlouisfed.org/fred/series/search");
    url.searchParams.set("search_text", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("file_type", "json");
    url.searchParams.set("api_key", secret);
    return get(url, { accept: "application/json" });
  }
  if (sourceId === "finnhub") {
    if (operationOf(context) === "quote") {
      const url = new URL("https://finnhub.io/api/v1/quote");
      url.searchParams.set("symbol", clean(query, 20).toUpperCase());
      return get(url, { accept: "application/json", "x-finnhub-token": secret });
    }
    const url = new URL("https://finnhub.io/api/v1/search");
    url.searchParams.set("q", query);
    return get(url, { accept: "application/json", "x-finnhub-token": secret });
  }
  if (sourceId === "perplexity") {
    return post("https://api.perplexity.ai/chat/completions", {
      model: clean(params.model, 60) || "sonar",
      messages: [{ role: "user", content: query }]
    }, { authorization: `Bearer ${secret}` });
  }
  if (sourceId === "tushare") {
    return post("https://api.tushare.pro", {
      api_name: clean(params.api_name, 60) || "stock_basic",
      token: secret,
      params: { ts_code: clean(query, 20) },
      fields: clean(params.fields, 200) || "ts_code,name,area,industry,list_date"
    }, {});
  }
  if (sourceId === "openalex") {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(limit));
    url.searchParams.set("api_key", secret);
    return get(url, { "user-agent": "AgentRouter/0.1" });
  }
  return null;
}

async function invokeOpenMeteo({ query, fetchImpl }) {
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.searchParams.set("name", query);
  geocodeUrl.searchParams.set("count", "1");
  geocodeUrl.searchParams.set("language", "en");
  const geocoded = await fetchJson(fetchImpl, geocodeUrl, {});
  if (!geocoded.ok) return geocoded;
  const location = geocoded.payload.results?.[0];
  if (!location) return { ok: true, status: "completed", items: [] };
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(location.latitude));
  forecastUrl.searchParams.set("longitude", String(location.longitude));
  forecastUrl.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
  forecastUrl.searchParams.set("timezone", location.timezone || "auto");
  const forecast = await fetchJson(fetchImpl, forecastUrl, {});
  if (!forecast.ok) return forecast;
  const current = forecast.payload.current || {};
  const units = forecast.payload.current_units || {};
  const place = [location.name, location.country].filter(Boolean).join(", ");
  return {
    ok: true,
    status: "completed",
    items: [{
      title: `${place} weather`,
      url: `https://open-meteo.com/en/docs#latitude=${location.latitude}&longitude=${location.longitude}`,
      snippet: `Current temperature ${current.temperature_2m ?? "unknown"}${units.temperature_2m || ""}; weather code ${current.weather_code ?? "unknown"}.`,
      published_at: validDate(current.time),
      metadata: {
        location: place,
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: location.timezone || null,
        temperature: current.temperature_2m ?? null,
        apparent_temperature: current.apparent_temperature ?? null,
        precipitation: current.precipitation ?? null,
        weather_code: current.weather_code ?? null,
        wind_speed: current.wind_speed_10m ?? null
      }
    }]
  };
}

async function invokeSecEdgar({ query, limit, fetchImpl }) {
  const tickerResponse = await fetchJson(fetchImpl, "https://www.sec.gov/files/company_tickers.json", {
    headers: { accept: "application/json", "user-agent": "AgentRouter research contact@example.com" }
  });
  if (!tickerResponse.ok) return tickerResponse;
  const normalizedQuery = query.toLowerCase();
  const company = Object.values(tickerResponse.payload || {}).find((item) =>
    String(item.ticker || "").toLowerCase() === normalizedQuery
    || String(item.cik_str || "") === query.replace(/^0+/, "")
    || String(item.title || "").toLowerCase().includes(normalizedQuery));
  if (!company) return { ok: true, status: "completed", items: [] };
  const cik = String(company.cik_str).padStart(10, "0");
  const submission = await fetchJson(fetchImpl, `https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { accept: "application/json", "user-agent": "AgentRouter research contact@example.com" }
  });
  if (!submission.ok) return submission;
  const recent = submission.payload.filings?.recent || {};
  const items = [];
  for (let index = 0; index < Math.min(recent.accessionNumber?.length || 0, limit); index += 1) {
    const accession = String(recent.accessionNumber[index] || "");
    const document = recent.primaryDocument?.[index];
    if (!accession || !document) continue;
    const form = recent.form?.[index] || "Filing";
    const filingDate = recent.filingDate?.[index] || null;
    items.push({
      title: `${submission.payload.name || company.title} ${form}`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik_str)}/${accession.replace(/-/g, "")}/${document}`,
      snippet: recent.primaryDocDescription?.[index] || `${form} filed ${filingDate || ""}`.trim(),
      published_at: validDate(filingDate),
      metadata: { company: submission.payload.name || company.title, cik, ticker: company.ticker, form, accession_number: accession }
    });
  }
  return { ok: true, status: "completed", items };
}

async function fetchJson(fetchImpl, url, options) {
  let response;
  let payload;
  try {
    response = await fetchImpl(url, options);
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, status: "provider_error", error: clean(error.message, 300), items: [] };
  }
  if (!response.ok) return {
    ok: false,
    status: response.status === 401 || response.status === 403 ? "auth_required" : response.status === 429 ? "rate_limited" : "provider_error",
    error: clean(payload?.message || payload?.detail || payload?.error?.message || payload?.error || `Provider returned HTTP ${response.status}`, 300),
    items: []
  };
  return { ok: true, payload };
}

function normalizeItems(sourceId, payload, context = {}) {
  let rows = [];
  if (sourceId === "brave_search") rows = payload.web?.results || [];
  else if (sourceId === "tavily") rows = payload.results || [];
  else if (sourceId === "serper") rows = payload.organic || [];
  else if (sourceId === "exa") rows = payload.results || [];
  else if (sourceId === "firecrawl") rows = payload.data?.web || payload.data || [];
  else if (sourceId === "jina") rows = payload.data || [];
  else if (sourceId === "github") return (payload.items || []).map((row) => item(row.title, row.html_url, row.body, row.created_at, { author: row.user?.login || null, comments: row.comments ?? null, score: row.score ?? null }));
  else if (sourceId === "gdelt") return (payload.articles || []).map((row) => item(row.title, row.url, row.domain, gdeltDate(row.seendate), { domain: row.domain || null, language: row.language || null, source_country: row.sourcecountry || null }));
  else if (sourceId === "youtube") return (payload.items || []).map((row) => item(row.snippet?.title, row.id?.videoId ? `https://www.youtube.com/watch?v=${row.id.videoId}` : "", row.snippet?.description, row.snippet?.publishedAt, { channel: row.snippet?.channelTitle || null, video_id: row.id?.videoId || null }));
  else if (sourceId === "virus_total") {
    const row = payload.data || {};
    const type = row.type || "domain";
    const guiType = type === "ip_address" ? "ip-address" : type === "file" ? "file" : type === "url" ? "url" : "domain";
    const stats = row.attributes?.last_analysis_stats || {};
    return [item(`VirusTotal ${type}: ${row.id}`, `https://www.virustotal.com/gui/${guiType}/${encodeURIComponent(row.id || "")}`, `Malicious: ${stats.malicious ?? 0}; suspicious: ${stats.suspicious ?? 0}; harmless: ${stats.harmless ?? 0}.`, null, { type, reputation: row.attributes?.reputation ?? null, analysis_stats: stats })];
  } else if (sourceId === "google_places") return (payload.places || []).map((row) => item(row.displayName?.text, row.googleMapsUri || row.websiteUri, row.formattedAddress, null, { rating: row.rating ?? null, user_rating_count: row.userRatingCount ?? null, open_now: row.currentOpeningHours?.openNow ?? null }));
  else if (sourceId === "amadeus") return (payload.data || []).map((row) => {
    const first = row.itineraries?.[0]?.segments?.[0] || {};
    const last = row.itineraries?.[0]?.segments?.at(-1) || {};
    return item(`${first.departure?.iataCode || "Flight"} → ${last.arrival?.iataCode || ""} ${row.price?.total || ""} ${row.price?.currency || ""}`.trim(), "https://developers.amadeus.com/", `${first.carrierCode || ""}${first.number || ""} · ${row.itineraries?.[0]?.duration || ""}`.trim(), first.departure?.at, { offer_id: row.id || null, total_price: row.price?.total || null, currency: row.price?.currency || null, duration: row.itineraries?.[0]?.duration || null });
  });
  else if (sourceId === "easy_post") return (payload.trackers || []).map((row) => item(`${row.carrier || "Package"} ${row.tracking_code || ""}: ${row.status || "unknown"}`, row.public_url || "https://www.easypost.com/track", row.status_detail || row.status, row.updated_at, { tracker_id: row.id || null, carrier: row.carrier || null, tracking_code: row.tracking_code || null, status: row.status || null, estimated_delivery_date: row.est_delivery_date || null }));
  else if (sourceId === "yahoo_finance") {
    if (operationOf(context) === "quote") {
      const meta = payload.chart?.result?.[0]?.meta;
      if (!meta) return [];
      const change = meta.regularMarketPrice != null && meta.chartPreviousClose != null
        ? meta.regularMarketPrice - meta.chartPreviousClose
        : null;
      return [item(
        `${meta.symbol} ${meta.regularMarketPrice} ${meta.currency || ""}`.trim(),
        `https://finance.yahoo.com/quote/${encodeURIComponent(meta.symbol || "")}`,
        `${meta.fullExchangeName || meta.exchangeName || ""} · 52w ${meta.fiftyTwoWeekLow ?? "?"}-${meta.fiftyTwoWeekHigh ?? "?"}`.trim(),
        meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        {
          symbol: meta.symbol || null,
          price: meta.regularMarketPrice ?? null,
          currency: meta.currency || null,
          previous_close: meta.chartPreviousClose ?? null,
          change: change === null ? null : Number(change.toFixed(4)),
          fifty_two_week_high: meta.fiftyTwoWeekHigh ?? null,
          fifty_two_week_low: meta.fiftyTwoWeekLow ?? null
        }
      )];
    }
    return (payload.quotes || []).map((row) => item(
      `${row.symbol} · ${row.longname || row.shortname || ""}`.trim(),
      `https://finance.yahoo.com/quote/${encodeURIComponent(row.symbol || "")}`,
      [row.exchDisp, row.sectorDisp, row.industryDisp].filter(Boolean).join(" · "),
      null,
      { symbol: row.symbol || null, quote_type: row.quoteType || null, exchange: row.exchDisp || null, sector: row.sectorDisp || null }
    ));
  }
  else if (sourceId === "fred") return (payload.seriess || []).map((row) => item(
    row.title,
    `https://fred.stlouisfed.org/series/${encodeURIComponent(row.id || "")}`,
    [row.units, row.frequency, row.seasonal_adjustment].filter(Boolean).join(" · ") || row.notes,
    row.last_updated || row.realtime_start,
    { series_id: row.id || null, units: row.units || null, frequency: row.frequency || null, observation_start: row.observation_start || null, observation_end: row.observation_end || null, popularity: row.popularity ?? null }
  ));
  else if (sourceId === "finnhub") {
    if (operationOf(context) === "quote") {
      const symbol = String(context.query || "").toUpperCase();
      if (payload.c === undefined || payload.c === null) return [];
      return [item(
        `${symbol} ${payload.c}`.trim(),
        `https://finnhub.io/`,
        `Open ${payload.o ?? "?"} · High ${payload.h ?? "?"} · Low ${payload.l ?? "?"} · Prev close ${payload.pc ?? "?"}`,
        payload.t ? new Date(payload.t * 1000).toISOString() : null,
        { symbol, price: payload.c ?? null, change: payload.d ?? null, percent_change: payload.dp ?? null, high: payload.h ?? null, low: payload.l ?? null, open: payload.o ?? null, previous_close: payload.pc ?? null }
      )];
    }
    return (payload.result || []).map((row) => item(
      `${row.symbol} · ${row.description || ""}`.trim(),
      `https://finnhub.io/`,
      row.type || null,
      null,
      { symbol: row.symbol || null, display_symbol: row.displaySymbol || null, type: row.type || null }
    ));
  }
  else if (sourceId === "perplexity") {
    const message = payload.choices?.[0]?.message?.content;
    if (!message) return [];
    const citations = payload.citations || payload.search_results || [];
    const answer = item(
      "Perplexity answer",
      citations[0]?.url || citations[0] || "https://www.perplexity.ai/",
      message,
      null,
      { model: payload.model || null, citations: citations.map((row) => (typeof row === "string" ? row : row.url)).filter(Boolean) }
    );
    const sources = citations.map((row, index) => item(
      typeof row === "string" ? `Source ${index + 1}` : (row.title || `Source ${index + 1}`),
      typeof row === "string" ? row : row.url,
      null, null, {}
    ));
    return [answer, ...sources];
  }
  else if (sourceId === "tushare") {
    if (payload.code !== 0) return [];
    const fields = payload.data?.fields || [];
    return (payload.data?.items || []).map((row) => {
      const record = Object.fromEntries(fields.map((name, index) => [name, row[index]]));
      return item(
        `${record.ts_code || ""} ${record.name || ""}`.trim(),
        "https://tushare.pro/",
        [record.industry, record.area].filter(Boolean).join(" · ") || null,
        record.list_date || null,
        record
      );
    });
  }
  else if (sourceId === "openalex") return (payload.results || []).map((row) => item(row.title, row.doi || row.id, row.abstract || null, row.publication_date, { openalex_id: row.id || null, cited_by_count: row.cited_by_count ?? null, authors: (row.authorships || []).map((entry) => entry.author?.display_name).filter(Boolean) }));
  return (Array.isArray(rows) ? rows : []).map((row) => item(
    row.title || row.name,
    row.url || row.link,
    row.description || row.content || row.text || row.snippet,
    row.publishedDate || row.published_at || row.age || row.date
  )).filter((row) => /^https?:\/\//.test(row.url));
}

function item(title, url, snippet, publishedAt, metadata = {}) {
  return {
    title: clean(title, 300) || null,
    url: clean(url, 2048),
    snippet: clean(snippet, 1200) || null,
    published_at: validDate(publishedAt),
    ...(Object.keys(metadata).length ? { metadata } : {})
  };
}

function virusTotalTarget(query) {
  const value = String(query || "").trim();
  if (/^https?:\/\//i.test(value)) return { type: "urls", id: Buffer.from(value).toString("base64url") };
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":")) return { type: "ip_addresses", id: value };
  if (/^[a-f0-9]{32,64}$/i.test(value)) return { type: "files", id: value };
  return { type: "domains", id: value };
}

function gdeltDate(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : value;
}

function source(id, category, title, implementationStatus, providerType, operations) {
  const connectionRequired = Boolean(providerType && providerType !== "local_browser");
  const credentialField = providerType === "amadeus_api" ? "access_token" : connectionRequired ? "api_key" : null;
  return {
    source: id,
    category,
    hub_category: AI_SEARCH_SOURCES.has(id) ? "AI Search" : null,
    title,
    implementation_status: implementationStatus,
    provider_type: providerType,
    operations,
    credential_field: credentialField,
    connection_required: connectionRequired,
    read_only: true
  };
}

function sourceMentioned(text, definition) {
  const aliases = [definition.source.replaceAll("_", " "), definition.title]
    .map((item) => item.toLowerCase());
  const normalized = text.toLowerCase();
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalized);
  });
}

function extractSearchQuery(text) {
  const english = text.match(/\b(?:search|find|research|look\s+up)(?:\s+(?:for|about|on))?\s+(.+)$/i);
  if (english?.[1]) return english[1].trim();
  const chinese = text.match(/(?:搜索|查询|查找|研究)(?:一下|有关|关于)?\s*(.+)$/);
  return chinese?.[1]?.trim() || text;
}

function publicSource(definition) {
  return { source: definition.source, title: definition.title, category: definition.category };
}

function get(url, headers = {}) {
  return { url, options: { headers } };
}

function post(url, body, headers) {
  return { url, options: { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: JSON.stringify(body) } };
}

function failure(status, message) {
  return { ok: false, status, error: { code: status.toUpperCase(), message } };
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
