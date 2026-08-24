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

const SOURCE_CAPABILITY_MANUALS = Object.freeze({
  exa: Object.freeze({
    best_for: [
      "General web research across public websites",
      "Product, market, company, and competitor research",
      "Current web evidence when no specialist dataset is required"
    ],
    not_for: [
      "DOI, citation-count, author, journal, or other scholarly bibliographic metadata",
      "Tasks that explicitly require a specialist regulatory, market, weather, or security dataset"
    ],
    route_only_when: [
      "The user asks for broad research, investigation, comparison, or current public-web evidence",
      "No more specific source capability matches the requested data object"
    ],
    example_queries: [
      "Research AgentRouter product positioning and competitors",
      "Find current evidence about AI agent API marketplaces"
    ]
  }),
  openalex: Object.freeze({
    best_for: [
      "Scholarly papers, publications, authors, journals, and institutions",
      "DOI lookup, citation counts, and bibliographic metadata",
      "Peer-reviewed or arXiv literature discovery"
    ],
    not_for: [
      "General web research, product research, market research, or competitor research",
      "A vague request to research a topic without asking for papers or scholarly metadata",
      "Current news, company pages, blogs, or broad public-web evidence"
    ],
    route_only_when: [
      "The request explicitly asks for papers, publications, DOI, citations, authors, journals, peer review, arXiv, 论文, or 文献",
      "The requested output is scholarly metadata rather than a general research answer"
    ],
    example_queries: [
      "Find peer-reviewed papers and DOI citations about agent routing",
      "查找 AgentRouter 相关论文的 DOI 和引用次数"
    ]
  }),
  xpoz: Object.freeze({
    best_for: ["Normalized search across public X, Instagram, TikTok, and Reddit content", "Cross-platform social listening and public user-voice research"],
    not_for: ["Chinese domestic platforms such as Xiaohongshu, Douyin, Weibo, or Bilibili", "Posting, messaging, or account actions"],
    route_only_when: ["The task needs public content or engagement data from one or more of X, Instagram, TikTok, and Reddit"],
    example_queries: ["Compare public discussion of AgentRouter across X, TikTok, and Reddit"]
  }),
  socialcrawl: Object.freeze({
    best_for: ["Broad cross-platform public social data through one normalized REST API", "Profiles, posts, comments, transcripts, trends, and multi-platform monitoring"],
    not_for: ["Private account data", "A platform-native write action", "Chinese platforms not explicitly listed in its live endpoint catalog"],
    route_only_when: ["The task spans several mainstream global platforms or needs an endpoint SocialCrawl explicitly documents"],
    example_queries: ["Collect public comments about a launch across YouTube, Reddit, X, LinkedIn, and TikTok"]
  }),
  socialdatax: Object.freeze({
    best_for: ["Chinese social research across Xiaohongshu, Douyin, Kuaishou, Weibo, WeChat, Bilibili, and Zhihu", "Public content, creator, engagement, and comment data through MCP, Skills, or API"],
    not_for: ["Account actions or publishing", "Assuming every platform supports every operation without checking the live capability listing"],
    route_only_when: ["The requested source is a supported Chinese platform, or Chinese and global social evidence must be combined"],
    example_queries: ["研究小红书、抖音和微博上用户对 AI Agent 交易的看法"]
  }),
  largitdata: Object.freeze({
    best_for: ["Taiwan and Greater China social coverage, including PTT, Dcard, Mobile01, Xiaohongshu, Weibo, and Douyin", "Unified REST/JSON access for regional listening workflows"],
    not_for: ["Private content", "Write operations", "Using regional coverage claims without confirming the needed endpoint and commercial rights"],
    route_only_when: ["The task needs Taiwan or Greater China sources that global-only aggregators do not cover"],
    example_queries: ["比较 PTT、Dcard 和小红书对同一消费品牌的讨论"]
  })
});

function capabilityManual(id, category, title, operations) {
  if (SOURCE_CAPABILITY_MANUALS[id]) return SOURCE_CAPABILITY_MANUALS[id];
  const operationList = operations.length ? operations.join(", ") : "listed operations";
  return {
    best_for: [`${title} ${category} data through its supported operations: ${operationList}`],
    not_for: [`Requests outside ${title}'s ${category} domain or unsupported operations`],
    route_only_when: [`The requested data object belongs to the ${category} domain and matches one of: ${operationList}`],
    example_queries: []
  };
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
  source("geckoterminal", "链上数据", "GeckoTerminal", "available", null, ["trending", "pools"]),
  source("dexscreener", "链上数据", "DexScreener", "available", null, ["search"]),
  source("coinmarketcap", "加密行情", "CoinMarketCap", "available", "coinmarketcap_api", ["listings"]),
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
  source("xpoz", "社交媒体", "XPOZ", "available", "xpoz_api", ["search"]),
  source("socialcrawl", "社交媒体", "SocialCrawl", "requires_partner_api", "socialcrawl_api", ["search", "posts", "comments", "profiles", "transcripts"]),
  source("socialdatax", "社交媒体", "SocialDataX", "available", "socialdatax_api", ["search"]),
  source("largitdata", "社交媒体", "LargitData", "requires_partner_api", "largitdata_api", ["search", "posts", "comments", "channels"]),
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
    capability_manual: sourceItem.capability_manual,
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
const DATA_REQUIREMENT_CONTRACTS = [
  { sources: ["gdelt"], operation: "search",
    strong: ["news|headlines?|news coverage", "新闻|新聞|报道|報道|舆情|輿情"],
    weak: "press|coverage|media|reported" },
  { sources: ["sec_edgar"], operation: "filings",
    strong: ["edgar|10-k|10k|8-k|prospectus|sec filings?", "财报|財報|备案|備案|招股"],
    weak: "sec|filings?|filed|disclosure" },
  { sources: ["open_meteo"], operation: "forecast",
    strong: ["weather|temperature|rainfall|snowfall", "天气|天氣|气温|氣溫|预报|預報"],
    weak: "forecast|rain|snow|humidity|wind" },
  // On-chain DEX rankings are their own domain. Routing them to web search
  // returned page snapshots whose scraped tables had lost the token name on
  // exactly the highest-volume rows, so a "top 5 by volume" could not be
  // answered without guessing. Listed before the equities sources so that
  // "volume" on a named chain does not read as a stock question.
  // DexScreener answers about one token's pairs; GeckoTerminal ranks a whole
  // chain. Naming either provider, or asking about a pair, picks the per-token
  // source; otherwise a chain-wide ranking question falls to the next intent.
  { sources: ["dexscreener"], operation: "search",
    strong: ["dexscreener|dex screener|trading pairs?|liquidity for", "交易对|交易對"],
    weak: ["pair|liquidity|slippage|pool|price|dex", "流动性|流動性|价格|價格|滑点|滑點"] },
  { sources: ["geckoterminal"], operation: "trending",
    strong: ["four\\.meme|pancakeswap|dexscreener|geckoterminal|dex pools?|liquidity pools?|on-?chain volume", "链上交易量|链上成交量|鏈上交易量|鏈上成交量"],
    weak: ["dex|on-?chain|volume|pools?|meme|bsc|bnb chain|solana|arbitrum|optimism", "交易量|成交量|代币|代幣|链上|鏈上|币价|幣價"] },
  // Market-wide crypto quotes. Distinct from the on-chain sources: this ranks
  // listed assets across all venues, not pools on one chain.
  { sources: ["coinmarketcap"], operation: "listings",
    strong: ["coinmarketcap|cmc|market cap ranking|crypto market cap", "市值排名|加密货币市值|加密貨幣市值"],
    weak: ["crypto|coin|market cap|ranking|top coins", "市值|加密货币|加密貨幣|排行"] },
  { sources: ["yahoo_finance", "finnhub"], operation: "search",
    strong: ["share price|stock price|nasdaq|nyse|ticker", "股价|股價|股票|行情"],
    weak: "stock|earnings|shares?|dividend" },
  { sources: ["github"], operation: "search",
    strong: ["github|repository|pull request|source code", "开源|開源|仓库|倉庫"],
    weak: "repo|issues?|commit|branch" },
  { sources: ["openalex"], operation: "search",
    strong: ["papers?|publications?|citations?|doi|arxiv|peer.reviewed", "论文|論文|文献|文獻|学术出版物|學術出版物|被引数据|被引數據"],
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
  // weak accepts the same [latin, cjk] pair as strong. It used to be Latin-only,
  // which left Chinese questions with no way to accumulate weak signal at all —
  // they either hit a strong CJK term or fell through.
  weakPattern: Array.isArray(intent.weak)
    ? termPattern(intent.weak[0], intent.weak[1], "gi")
    : termPattern(intent.weak, "", "gi")
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
  "jobs?|hiring|openings?|roles?|vacanc\\w*|careers?|search|find|look up|latest|what is|who is|how to|compare|reviews?|research|investigate|evidence|benchmark|analy[sz]e|assess|evaluate|map|overview",
  "招聘|岗位|崗位|职位|職位|最新|最近|查一下|搜一下|查找|了解|怎么|怎樣|研究|调研|調研|实证|實證|竞品|競品|公开讨论|公開討論|行业报告|行業報告|分析|评估|評估|梳理"
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
  const requirement = inferDataRequirement(text, { tier });
  if (!requirement) return null;
  let definition = requirement.source_hint
    ? SOURCE_CATALOG.find((item) => item.source === requirement.source_hint)
    : pickAvailableSource(requirement.candidate_sources, connected, requirement.operation);
  if (!definition) return null;
  const operation = definition.operations.includes(requirement.operation)
    ? requirement.operation
    : definition.operations[0] || "search";
  return externalApiRequest(definition, operation, text, requirement);
}

export function inferDataRequirement(task, { tier = "all" } = {}) {
  const text = clean(task, 1000);
  if (!text || !asksAboutSomething(text)) return null;
  if (tier === "web") return buildDataRequirement(text, WEB_SEARCH_SOURCES, "search");

  const explicit = SOURCE_CATALOG
    .filter((item) => sourceMentioned(text, item))
    // A named aggregation vendor is the execution constraint; platform names
    // in the same sentence describe its fan-out targets.
    .sort((left, right) => explicitSourcePriority(right) - explicitSourcePriority(left))[0];
  if (explicit) {
    const operation = explicit.operations.includes("search") ? "search" : explicit.operations[0] || "search";
    return buildDataRequirement(text, [explicit.source], operation, explicit.source);
  }

  const best = DATA_REQUIREMENT_CONTRACTS
    .map((entry) => ({ entry, score: intentScore(text, entry) }))
    .filter((candidate) => candidate.score >= INTENT_ROUTE_THRESHOLD)
    .sort((a, b) => b.score - a.score)[0];
  if (best) return buildDataRequirement(text, best.entry.sources, best.entry.operation);
  if (tier !== "specialized" && (WEB_SEARCH_PATTERN.test(text) || QUESTION_PATTERN.test(text))) {
    return buildDataRequirement(text, WEB_SEARCH_SOURCES, "search");
  }
  return null;
}

const NAMED_SOCIAL_AGGREGATORS = new Set(["xpoz", "socialcrawl", "socialdatax", "largitdata"]);

function explicitSourcePriority(definition) {
  return (NAMED_SOCIAL_AGGREGATORS.has(definition.source) ? 1000 : 0) + definition.source.length;
}

function buildDataRequirement(text, candidateSources, operation, sourceHint = null) {
  const metadata = requirementMetadata(candidateSources[0], operation);
  const publicContract = {
    capability: metadata.capability,
    data_object: metadata.data_object,
    evidence_type: metadata.evidence_type,
    operation,
    read_only: true,
    freshness: /latest|recent|current|today|最近|最新|当前|目前|过去|過去/i.test(text) ? "current" : "unspecified"
  };
  return {
    ...publicContract,
    public_contract: publicContract,
    candidate_sources: [...candidateSources],
    source_hint: sourceHint
  };
}

function requirementMetadata(sourceId, operation) {
  const definitions = {
    gdelt: ["news_research", "news_coverage", "current_news"],
    sec_edgar: ["corporate_filings", "regulatory_filing", "specialist_dataset"],
    open_meteo: ["weather_forecast", "weather_forecast", "specialist_dataset"],
    dexscreener: ["dex_pair_search", "dex_pair", "specialist_dataset"],
    geckoterminal: ["onchain_market_ranking", "liquidity_pool", "specialist_dataset"],
    coinmarketcap: ["crypto_market_data", "crypto_asset", "specialist_dataset"],
    yahoo_finance: ["equity_market_data", "public_equity", "specialist_dataset"],
    finnhub: ["equity_market_data", "public_equity", "specialist_dataset"],
    github: ["code_repository_search", "code_repository", "specialist_dataset"],
    openalex: ["scholarly_literature", "scholarly_publication", "scholarly_metadata"],
    google_places: ["place_search", "place", "specialist_dataset"],
    amadeus: ["flight_search", "flight_options", "specialist_dataset"],
    easy_post: ["shipment_tracking", "shipment_status", "specialist_dataset"],
    virus_total: ["domain_security_check", "security_indicator", "specialist_dataset"],
    youtube: ["video_search", "video", "platform_dataset"]
  };
  const [capability, dataObject, evidenceType] = definitions[sourceId]
    || [operation === "search" ? "public_web_research" : "external_data_query", "public_web_evidence", "current_web"];
  return { capability, data_object: dataObject, evidence_type: evidenceType };
}

function externalApiRequest(definition, operation, text, requirement) {
  const params = {
    source: definition.source,
    operation,
    query: extractSearchQuery(text),
    limit: 10,
    ...(definition.source === "amadeus" ? inferFlightParams(text) : {}),
    ...(["xpoz", "socialdatax"].includes(definition.source)
      ? { platforms: inferSocialPlatforms(text, definition.source) }
      : {})
  };
  const researchPlan = inferResearchPlan(text, params);
  return {
    capability: "external_api_query",
    params,
    data_requirement: requirement.public_contract,
    routing_constraint: requirement.source_hint
      ? {
        type: NAMED_SOCIAL_AGGREGATORS.has(requirement.source_hint) ? "explicit_provider" : "explicit_source",
        source: requirement.source_hint
      }
      : { type: "inferred_source" },
    ...(researchPlan ? { research_plan: researchPlan } : {})
  };
}

const SOCIAL_PLATFORM_PATTERNS = {
  xpoz: [
    [/(?:在\s*x\s*上|\bx\.com\b|\btwitter\b|(?:^|[^a-z0-9])x(?:[^a-z0-9]|$))/i, "x"],
    [/\binstagram\b|\binsta\b/i, "instagram"],
    [/\breddit\b/i, "reddit"],
    [/\btiktok\b/i, "tiktok"]
  ],
  socialdatax: [
    [/小红书|xiaohongshu|rednote|\bxhs\b/i, "xiaohongshu"],
    [/抖音|\bdouyin\b/i, "douyin"],
    [/微博|\bweibo\b/i, "weibo"]
  ]
};

function inferSocialPlatforms(text, sourceId) {
  const matches = (SOCIAL_PLATFORM_PATTERNS[sourceId] || [])
    .map(([pattern, platform]) => ({ index: text.search(pattern), platform }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.platform);
  return [...new Set(matches.length ? matches : [sourceId === "xpoz" ? "x" : "xiaohongshu"])];
}

function inferResearchPlan(text, primaryParams) {
  const empiricalStrategy = /量化|quant(?:itative)?|trading strategy|systematic strategy/i.test(text)
    && /实证|實證|表现|表現|performance|backtests?|过去一年|過去一年/i.test(text);
  if (!empiricalStrategy) return null;
  return {
    strategy: "web_evidence_then_specialist_data",
    primary_requirement: { capability: "external_api_query", params: primaryParams },
    supplemental_requirements: [{
      capability: "service_discovery",
      constraints: {
        categories: ["financial", "market_data", "quantitative_data"],
        purpose: "Validate claimed strategy performance with specialist datasets after identifying the exact strategy, assets, and benchmark."
      }
    }],
    merge_policy: "Keep web claims and specialist measurements separately attributed; do not invent a backtest when no matching dataset exists."
  };
}

const FLIGHT_CITY_CODES = [
  [/台北|臺北|taipei/i, "TPE"],
  [/东京|東京|tokyo/i, "TYO"],
  [/香港|hong kong/i, "HKG"],
  [/新加坡|singapore/i, "SIN"],
  [/纽约|紐約|new york/i, "NYC"],
  [/伦敦|倫敦|london/i, "LON"]
];

function inferFlightParams(text) {
  const mentioned = FLIGHT_CITY_CODES
    .map(([pattern, code]) => ({ index: text.search(pattern), code }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  const explicitDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  return {
    ...(mentioned[0] ? { origin: mentioned[0].code } : {}),
    ...(mentioned[1] ? { destination: mentioned[1].code } : {}),
    ...(explicitDate ? { departure_date: explicitDate } : nextWeekdayDate(text)),
    ...(/直飞|直飛|non[ -]?stop|direct flight/i.test(text) ? { non_stop: true } : {})
  };
}

function nextWeekdayDate(text) {
  const weekday = [
    [/下周一|下週一|next monday/i, 1], [/下周二|下週二|next tuesday/i, 2],
    [/下周三|下週三|next wednesday/i, 3], [/下周四|下週四|next thursday/i, 4],
    [/下周五|下週五|next friday/i, 5], [/下周六|下週六|next saturday/i, 6],
    [/下周日|下週日|下周天|下週天|next sunday/i, 7]
  ].find(([pattern]) => pattern.test(text))?.[1];
  if (!weekday) return {};
  const now = new Date();
  const current = now.getUTCDay() || 7;
  const daysUntilNextMonday = 8 - current;
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextMonday + weekday - 1));
  return { departure_date: date.toISOString().slice(0, 10) };
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
  const call = {
    capability: "social_search",
    params: { platform, query: params.query || "", ...(params.limit ? { limit: params.limit } : {}) }
  };
  return {
    reason: "This source needs a paid platform API key, but the same data is readable for free through your own signed-in browser.",
    capability: "social_search",
    execution_location: "user_device",
    requires_api_key: false,
    preferred_tool: "agentrouter_request",
    tool_arguments: call,
    call,
    must_not_execute_via_shell: true,
    do_not_fallback_outside_agentrouter: true,
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
        ...(!alternative ? {
          connection_action: {
            action: "connect_api_source",
            preferred_tool: "agentrouter_connect_source",
            tool_arguments: { source: sourceId },
            instructions: "Call agentrouter_connect_source, open its browser authorization URL, then retry the original request. Never ask the user to paste the source API key into chat."
          },
          retry_original_request_after_connection: true,
          do_not_fallback_outside_agentrouter: true
        } : {}),
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
  const invocation = recordExternalApiInvocation(store, definition, response, Date.now() - startedAt, {
    ...options,
    ownerKey
  });
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
    request: {
      capability: "external_api_query",
      params: {
        source: sourceId,
        operation,
        query,
        limit,
        ...(Array.isArray(params.platforms) ? { platforms: params.platforms } : {})
      }
    },
    source: publicSource(definition),
    result: { items: response.items, count: response.items.length },
    ...(response.coverage ? { coverage: response.coverage } : {}),
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
    description_for_agent: `Use ${definition.title} through AgentRouter for ${definition.capability_manual.best_for.join("; ")}. Do not use it for ${definition.capability_manual.not_for.join("; ")}.`,
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
  return (store?.feedbackEvents || []).filter((event) =>
    event.service_id === serviceId && event.event_version !== "agent_consumer_feedback_v1"
  );
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
    consumer_id: options.ownerKey || "agentrouter_consumer",
    invocation_actor_key: options.ownerKey || undefined,
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

const SOCIAL_MCP_SEARCH = Object.freeze({
  xpoz: Object.freeze({
    x: { url: "https://mcp.xpoz.ai/mcp", tool: "getTwitterPostsByKeywords" },
    instagram: { url: "https://mcp.xpoz.ai/mcp", tool: "getInstagramPostsByKeywords" },
    reddit: { url: "https://mcp.xpoz.ai/mcp", tool: "getRedditPostsByKeywords" },
    tiktok: { url: "https://mcp.xpoz.ai/mcp", tool: "getTiktokPostsByKeywords" }
  }),
  socialdatax: Object.freeze({
    xiaohongshu: { url: "https://mcp.socialdatax.com/xhs/mcp", tool: "xhs_search_notes" },
    douyin: { url: "https://mcp.socialdatax.com/douyin/mcp", tool: "douyin_search_videos" },
    weibo: { url: "https://mcp.socialdatax.com/weibo/mcp", tool: "weibo_search_posts" }
  })
});

async function invokeSocialVendorMcp(sourceId, context) {
  const definitions = SOCIAL_MCP_SEARCH[sourceId];
  const requested = Array.isArray(context.params.platforms) ? context.params.platforms : [];
  const platforms = [...new Set(requested.map((value) => clean(value, 32).toLowerCase()))]
    .filter((platform) => definitions[platform]);
  const selected = platforms.length ? platforms : [sourceId === "xpoz" ? "x" : "xiaohongshu"];
  const perPlatformLimit = Math.max(1, Math.ceil(context.limit / selected.length));
  const calls = await Promise.all(selected.map(async (platform, index) => {
    const definition = definitions[platform];
    const args = sourceId === "xpoz"
      ? { query: context.query, limit: perPlatformLimit, userPrompt: context.query, ...xpozDateRange(context.query) }
      : socialDataXSearchArgs(platform, context.query);
    const response = await callMcpTool(context.fetchImpl, definition.url, context.secret, definition.tool, args, index + 1);
    return { platform, response };
  }));
  const succeeded = calls.filter((call) => call.response.ok);
  if (!succeeded.length) return calls[0]?.response || { ok: false, status: "provider_error", error: "No social platform call completed.", items: [] };
  const groupRecords = succeeded.map(({ platform, response }) => ({
    platform,
    items: normalizeSocialMcpItems(sourceId, platform, response.payload).slice(0, perPlatformLimit)
  }));
  const groups = groupRecords.map((group) => group.items);
  const items = [];
  for (let rowIndex = 0; items.length < context.limit; rowIndex += 1) {
    let found = false;
    for (const group of groups) {
      if (group[rowIndex]) {
        items.push(group[rowIndex]);
        found = true;
        if (items.length === context.limit) break;
      }
    }
    if (!found) break;
  }
  const evidencePlatforms = groupRecords.filter((group) => group.items.length > 0).map((group) => group.platform);
  const emptyPlatforms = groupRecords.filter((group) => group.items.length === 0).map((group) => group.platform);
  const failedPlatforms = calls.filter((call) => !call.response.ok).map((call) => call.platform);
  return {
    ok: true,
    status: "completed",
    items,
    coverage: {
      status: failedPlatforms.length || emptyPlatforms.length ? "insufficient" : "sufficient",
      item_count: items.length,
      requested_platforms: selected,
      completed_platforms: succeeded.map((call) => call.platform),
      evidence_platforms: evidencePlatforms,
      empty_platforms: emptyPlatforms,
      failed_platforms: failedPlatforms
    }
  };
}

function xpozDateRange(query) {
  const days = /最近(?:一|1)?天|过去(?:一|1)?天|last\s+(?:1\s+)?day/i.test(query) ? 1
    : /最近(?:一|1)?周|过去(?:一|1)?周|最近7天|last\s+(?:7\s+days?|week)/i.test(query) ? 7
      : /最近(?:一|1)?个月|過去(?:一|1)?個月|过去(?:一|1)?个月|last\s+(?:30\s+days?|month)/i.test(query) ? 30
        : null;
  if (!days) return {};
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function socialDataXSearchArgs(platform, query) {
  const recentDay = /最近(?:一|1)?天|过去(?:一|1)?天|last\s+(?:1\s+)?day/i.test(query);
  const recentWeek = /最近(?:一|1)?周|过去(?:一|1)?周|最近7天|last\s+(?:7\s+days?|week)/i.test(query);
  const recentHalfYear = /最近半年|过去半年|last\s+(?:6\s+months?|half.year)/i.test(query);
  const supportsTime = platform === "xiaohongshu" || platform === "douyin";
  return {
    keyword: query,
    ...(supportsTime && (recentDay || recentWeek || recentHalfYear) ? {
      publish_time_range: recentDay ? "day" : recentWeek ? "week" : "half_year",
      sort_type: "time_descending"
    } : {})
  };
}

async function callMcpTool(fetchImpl, url, secret, toolName, args, id) {
  let response;
  let raw;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: args } })
    });
    raw = await response.text();
  } catch (error) {
    return { ok: false, status: "provider_error", error: clean(error.message, 300), items: [] };
  }
  const envelope = parseMcpEnvelope(raw);
  if (!response.ok || envelope?.error) {
    const status = response.status === 401 || response.status === 403 ? "auth_required"
      : response.status === 429 ? "rate_limited" : "provider_error";
    return {
      ok: false,
      status,
      error: clean(envelope?.error?.message || `Provider returned HTTP ${response.status}`, 300),
      items: []
    };
  }
  const result = envelope?.result || {};
  if (result.isError) {
    return { ok: false, status: "provider_error", error: clean(mcpContentText(result.content) || "MCP tool call failed.", 300), items: [] };
  }
  return { ok: true, status: "completed", payload: parseMcpContent(result.content), items: [] };
}

function parseMcpEnvelope(raw) {
  const text = String(raw || "").trim();
  const dataLines = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  const candidate = dataLines.at(-1) || text;
  try { return JSON.parse(candidate); } catch { return null; }
}

function mcpContentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseMcpContent(content) {
  const text = mcpContentText(content);
  try { return JSON.parse(text); } catch { return { text }; }
}

function normalizeSocialMcpItems(sourceId, platform, payload) {
  const rows = socialRows(payload);
  return rows.map((row) => {
    const id = clean(row.id || row.note_id || row.aweme_id || row.post_id, 120);
    const author = clean(row.authorUsername || row.username || row.user_name || row.author?.name || row.author?.nickname, 120);
    const title = clean(row.title || row.name || row.caption || row.description || row.text || row.note_title, 300) || `${platform} result`;
    const snippet = clean(row.text || row.selftext || row.caption || row.description || row.content || row.desc || title, 1200);
    return item(
      title,
      socialRowUrl(platform, row, id, author),
      snippet,
      row.createdAtDate || row.created_at || row.publish_time || row.create_time,
      { provider: sourceId, platform, source_id: id || null, author: author || null }
    );
  });
}

function socialRows(payload) {
  if (Array.isArray(payload)) return payload.filter((row) => row && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["data", "items", "results", "notes", "videos", "posts", "list"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter((row) => row && typeof row === "object");
    if (value && typeof value === "object") {
      const nested = socialRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function socialRowUrl(platform, row, id, author) {
  const direct = clean(row.url || row.postUrl || row.post_url || row.note_url || row.share_url || row.permalink || row.codeUrl, 2048);
  if (/^https?:\/\//i.test(direct)) return direct;
  if (direct.startsWith("/r/")) return `https://www.reddit.com${direct}`;
  if (platform === "x" && id) return `https://x.com/${encodeURIComponent(author || "i")}/status/${encodeURIComponent(id)}`;
  if (platform === "reddit" && id) return `https://www.reddit.com/comments/${encodeURIComponent(id)}`;
  if (platform === "tiktok" && id) return `https://www.tiktok.com/@${encodeURIComponent(author || "user")}/video/${encodeURIComponent(id)}`;
  if (platform === "xiaohongshu" && id) return `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`;
  if (platform === "douyin" && id) return `https://www.douyin.com/video/${encodeURIComponent(id)}`;
  if (platform === "weibo" && id) return `https://weibo.com/detail/${encodeURIComponent(id)}`;
  return "";
}

async function invokeSource(sourceId, context) {
  try {
    if (sourceId === "xpoz" || sourceId === "socialdatax") return invokeSocialVendorMcp(sourceId, context);
    if (sourceId === "open_meteo") return invokeOpenMeteo(context);
    if (sourceId === "geckoterminal") return invokeGeckoTerminal(context);
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
  if (sourceId === "dexscreener") {
    const url = new URL("https://api.dexscreener.com/latest/dex/search");
    // DexScreener matches a ticker or a contract address, not prose. Handing it
    // the whole question made "BSC 上 CAKE 的交易对和流动性" return BscCat, BSC
    // and ASTER — everything except the token that was asked about.
    url.searchParams.set("q", dexscreenerTerm(query));
    return get(url, { accept: "application/json" });
  }
  if (sourceId === "coinmarketcap") {
    // Sorted by 24h volume, not market cap: this source is reached by questions
    // about what is trading, and the default listing order answers a different
    // question.
    const url = new URL("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest");
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 5000)));
    url.searchParams.set("sort", "volume_24h");
    url.searchParams.set("sort_dir", "desc");
    return get(url, { accept: "application/json", "X-CMC_PRO_API_KEY": secret });
  }
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
    if (params.non_stop === true) url.searchParams.set("nonStop", "true");
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

// GeckoTerminal's network ids are not our chain names: Ethereum is "eth", and
// Polygon is "polygon_pos". Unmapped chains fall back to BSC only when the
// question named no chain at all.
const GECKOTERMINAL_NETWORKS = {
  ethereum: "eth", eth: "eth",
  bsc: "bsc", bnb: "bsc",
  base: "base",
  solana: "solana",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon_pos",
  avalanche: "avax"
};

function geckoterminalNetwork(text) {
  const lower = String(text || "").toLowerCase();
  if (/bnb\s*chain|\bbsc\b|币安智能链|幣安智能鏈/.test(lower)) return "bsc";
  for (const [name, id] of Object.entries(GECKOTERMINAL_NETWORKS)) {
    if (lower.includes(name)) return id;
  }
  return "bsc";
}

// Two rankings, both the provider's own.
//
// Sorting by raw 24h volume is what the chain literally reports, and on BSC that
// puts wash-traded pools on top: eight-figure volume against single-digit
// liquidity, down 100%. Filtering those out here was the wrong instinct — it
// would make a routing layer carry per-source domain judgement it has no
// standing to make, for every source it ever adds.
//
// GeckoTerminal already does that work and publishes the result as
// trending_pools, which on the same chain and hour returns none of them. So the
// fix is to call the right endpoint, which is routing, not filtering. A question
// that explicitly asks for volume order still gets volume order; every row says
// which ranking produced it.
function geckoterminalRanking(query, operation) {
  if (operation === "pools") return "volume";
  const text = String(query || "").toLowerCase();
  return /by volume|volume ranking|按交易量|交易量排序|成交量排序/.test(text) ? "volume" : "trending";
}

async function invokeGeckoTerminal({ query, limit, fetchImpl, operation }) {
  const network = geckoterminalNetwork(query);
  const ranking = geckoterminalRanking(query, operation);
  const path = ranking === "trending" ? "trending_pools" : "pools";
  const url = new URL(`https://api.geckoterminal.com/api/v2/networks/${network}/${path}`);
  if (ranking === "trending") url.searchParams.set("duration", "24h");
  else url.searchParams.set("sort", "h24_volume_usd_desc");
  url.searchParams.set("page", "1");
  const fetched = await fetchJson(fetchImpl, url, { headers: { accept: "application/json" } });
  if (!fetched.ok) return fetched;
  const rows = Array.isArray(fetched.payload?.data) ? fetched.payload.data : [];
  const items = rows.map((row, index) => {
    const a = row?.attributes || {};
    const volume = Number((a.volume_usd || {}).h24 ?? 0);
    const name = clean(a.name, 120);
    const base = name.split("/")[0].trim();
    const txns = (a.transactions || {}).h24 || {};
    return {
      title: `#${index + 1} ${name}`,
      url: a.address ? `https://www.geckoterminal.com/${network}/pools/${a.address}` : `https://www.geckoterminal.com/${network}/pools`,
      snippet: `${base}: 24h volume $${Math.round(volume).toLocaleString("en-US")}, price $${a.base_token_price_usd ?? "unknown"}.`,
      published_at: validDate(a.pool_created_at),
      metadata: {
        rank: index + 1,
        // The ranking is over every pool on the chain. GeckoTerminal has no
        // category endpoint, so a question about "meme tokens" cannot actually
        // be filtered — saying so beats letting the caller read a category into
        // a list that does not have one.
        ranked_among: ranking === "trending"
          ? `${network} pools trending over 24h, ranked by the provider`
          : `all pools on ${network} by raw 24h volume`,
        pool: name,
        base_token: base,
        network,
        volume_24h_usd: volume,
        price_usd: a.base_token_price_usd ?? null,
        market_cap_usd: a.market_cap_usd ?? null,
        fdv_usd: a.fdv_usd ?? null,
        liquidity_usd: a.reserve_in_usd ?? null,
        price_change_24h_pct: (a.price_change_percentage || {}).h24 ?? null,
        buys_24h: txns.buys ?? null,
        sells_24h: txns.sells ?? null,
        pool_address: a.address ?? null
      }
    };
  }).slice(0, limit);
  return { ok: true, status: "completed", items };
}


// DexScreener answers "what is this token doing", not "what leads the chain":
// search returns every pair matching a symbol across every chain. Ordering by
// 24h volume puts the pair that actually trades first — the raw order buries it
// behind dead pools with the same ticker.
// The symbol or address the question is about. Chain names are excluded for the
// same reason they are excluded from token detection elsewhere: "BSC" in
// "BSC 上 CAKE" names where to look, not what to look for.
const DEXSCREENER_NON_TOKENS = new Set([
  "API", "HTTP", "JSON", "USD", "NFT", "TVL", "DEX", "CEX", "L1", "L2", "AI", "TOP",
  "BSC", "BNB", "BASE", "SOLANA", "ETHEREUM", "ARBITRUM", "OPTIMISM", "POLYGON", "AVALANCHE"
]);

export function dexscreenerTerm(query) {
  const text = String(query || "");
  const address = text.match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}(?![\w])/);
  if (address) return address[0];
  for (const raw of text.match(/\$?[A-Za-z][A-Za-z0-9]{1,11}\b/g) || []) {
    const token = raw.replace(/^\$/, "").toUpperCase();
    if (raw.startsWith("$")) return token;
    if (token.length >= 2 && raw === raw.toUpperCase() && !DEXSCREENER_NON_TOKENS.has(token)) return token;
  }
  // Nothing ticker-shaped: fall back to the text so the caller still gets a
  // fuzzy match rather than an empty query.
  return text.trim().slice(0, 60);
}

function normalizeDexscreener(payload, context = {}) {
  const wanted = geckoterminalNetwork(context.query || "");
  const chainFilter = /bsc|bnb|eth|base|solana|arbitrum|optimism|polygon|avax|链/i.test(context.query || "")
    ? DEXSCREENER_CHAINS[wanted] || null
    : null;
  const pairs = (Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter((pair) => !chainFilter || pair?.chainId === chainFilter)
    .sort((a, b) => volumeOf(b) - volumeOf(a));
  return pairs.map((pair, index) => {
    const base = pair?.baseToken || {};
    const quote = pair?.quoteToken || {};
    const symbol = clean(base.symbol, 40);
    return item(
      `#${index + 1} ${symbol}/${clean(quote.symbol, 40)} on ${clean(pair?.dexId, 40)}`,
      clean(pair?.url, 400),
      `${symbol}: 24h volume $${Math.round(volumeOf(pair)).toLocaleString("en-US")}, price $${pair?.priceUsd ?? "unknown"}, liquidity $${Math.round(Number(pair?.liquidity?.usd || 0)).toLocaleString("en-US")}.`,
      validDate(pair?.pairCreatedAt ? new Date(Number(pair.pairCreatedAt)).toISOString() : null),
      {
        rank: index + 1,
        base_token: symbol,
        base_token_address: clean(base.address, 80) || null,
        quote_token: clean(quote.symbol, 40) || null,
        chain: clean(pair?.chainId, 40) || null,
        dex: clean(pair?.dexId, 40) || null,
        price_usd: pair?.priceUsd ?? null,
        volume_24h_usd: volumeOf(pair),
        liquidity_usd: Number(pair?.liquidity?.usd || 0) || null,
        market_cap_usd: pair?.marketCap ?? null,
        fdv_usd: pair?.fdv ?? null,
        price_change_24h_pct: pair?.priceChange?.h24 ?? null,
        buys_24h: pair?.txns?.h24?.buys ?? null,
        sells_24h: pair?.txns?.h24?.sells ?? null,
        pair_address: clean(pair?.pairAddress, 80) || null
      }
    );
  });
}

function volumeOf(pair) {
  return Number(pair?.volume?.h24 || 0);
}

// DexScreener's chain ids are its own; they mostly agree with GeckoTerminal but
// not for Ethereum, so the mapping is explicit rather than assumed.
const DEXSCREENER_CHAINS = {
  eth: "ethereum", bsc: "bsc", base: "base", solana: "solana",
  arbitrum: "arbitrum", optimism: "optimism", polygon_pos: "polygon", avax: "avalanche"
};

function normalizeCoinmarketcap(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((row, index) => {
    const usd = row?.quote?.USD || {};
    const symbol = clean(row?.symbol, 40);
    return item(
      `#${index + 1} ${clean(row?.name, 80)} (${symbol})`,
      row?.slug ? `https://coinmarketcap.com/currencies/${encodeURIComponent(row.slug)}/` : "https://coinmarketcap.com/",
      `${symbol}: price $${usd.price ?? "unknown"}, 24h volume $${Math.round(Number(usd.volume_24h || 0)).toLocaleString("en-US")}, market cap $${Math.round(Number(usd.market_cap || 0)).toLocaleString("en-US")}.`,
      validDate(usd.last_updated || row?.last_updated),
      {
        rank: index + 1,
        cmc_rank: row?.cmc_rank ?? null,
        name: clean(row?.name, 80) || null,
        symbol: symbol || null,
        price_usd: usd.price ?? null,
        volume_24h_usd: usd.volume_24h ?? null,
        market_cap_usd: usd.market_cap ?? null,
        percent_change_24h: usd.percent_change_24h ?? null,
        percent_change_7d: usd.percent_change_7d ?? null,
        circulating_supply: row?.circulating_supply ?? null
      }
    );
  });
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
  else if (sourceId === "dexscreener") return normalizeDexscreener(payload, context);
  else if (sourceId === "coinmarketcap") return normalizeCoinmarketcap(payload);
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
    capability_manual: capabilityManual(id, category, title, operations),
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
