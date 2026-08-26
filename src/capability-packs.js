const CAPABILITY_PACKS = Object.freeze([
  {
    id: "research",
    title: "Research",
    contract: "research.find_evidence",
    description: "Find current web evidence, publications, filings, repositories, and cited source material.",
    sample_task: "Research a company, market, or technical topic with traceable sources.",
    signals: [
      "web_search", "search_general", "paper_search", "citation_metadata", "academic_search",
      "news_search", "industry_research", "company_research", "sec_filing", "github_search",
      "openalex", "scholarly", "peer_reviewed", "doi_lookup", "arxiv"
    ]
  },
  {
    id: "social",
    title: "Social",
    contract: "social.research_discussion",
    description: "Read public conversations, posts, creator activity, and user sentiment across social platforms.",
    sample_task: "Compare how users discuss a product across X, Reddit, YouTube, and other communities.",
    signals: [
      "social_search", "social_research", "social_post", "social_user_voice", "user_voice_research",
      "reddit", "twitter", "youtube", "xiaohongshu", "bilibili", "weibo", "zhihu",
      "stocktwits", "social_sentiment", "creator_research", "community_discussion"
    ]
  },
  {
    id: "markets",
    title: "Markets",
    contract: "markets.get_market_data",
    description: "Retrieve price, volume, ranking, fundamentals, and time-series data for financial markets.",
    sample_task: "Get current prices and market metrics for an equity, token, commodity, or currency pair.",
    signals: [
      "market_price", "stock_quote", "crypto_price", "market_data", "market_cap", "price_history",
      "ohlcv", "ticker", "equity_quote", "forex_rate", "commodity_price", "etf_data",
      "financial_fundamentals", "coinmarketcap", "coingecko"
    ]
  },
  {
    id: "onchain",
    title: "Onchain",
    contract: "onchain.analyze_activity",
    description: "Inspect wallets, transactions, DEX liquidity, smart-money activity, and protocol state onchain.",
    sample_task: "Analyze wallet activity, token flows, or DEX liquidity on a specific blockchain.",
    signals: [
      "onchain_data", "onchain_analysis", "wallet_activity", "wallet_profiler", "dex_liquidity",
      "dex_pair", "smart_money", "fund_flow", "blockchain_transaction", "chain_activity",
      "token_holder", "rpc_query", "liquidation_data", "geckoterminal", "dexscreener"
    ]
  },
  {
    id: "operations",
    title: "Operations",
    contract: "operations.lookup_real_world",
    description: "Look up real-world operational data such as weather, places, travel, shipping, and domain risk.",
    sample_task: "Check a forecast, nearby place, flight, shipment, or domain safety status.",
    signals: [
      "weather_forecast", "place_search", "flight_search", "shipping_tracking", "parcel_tracking",
      "domain_reputation", "domain_risk", "malware_check", "phishing_check", "travel_search",
      "open_meteo", "google_places", "amadeus", "easypost", "virustotal"
    ]
  }
]);

const PACK_DEFAULT_CAPABILITIES = Object.freeze({
  research: ["web_search", "search_general", "news_search", "paper_search", "citation_metadata", "academic_search"],
  social: ["social_search", "social_user_voice_research", "social_post_read", "social_sentiment", "creator_research"],
  markets: ["market_price", "stock_quote", "crypto_price", "market_data", "ohlcv", "ticker"],
  onchain: ["onchain_data", "onchain_analysis", "dex_liquidity", "wallet_activity", "smart_money", "fund_flow"],
  operations: ["weather_forecast", "place_search", "flight_search", "shipping_tracking", "domain_reputation"]
});

const PACK_DISPATCH_RULES = Object.freeze({
  research: [
    { pattern: /peer[\s_-]?review|papers?|论文|文献|citation|引用|doi|arxiv|scholarly|academic/i, capabilities: ["paper_search", "academic_search", "citation_metadata"] },
    { pattern: /news|report|current|latest|最近|最新|行业报告/i, capabilities: ["news_search", "web_search", "search_general"] }
  ],
  social: [
    { pattern: /reddit/i, capabilities: ["reddit_search", "social_search", "social_user_voice_research"] },
    { pattern: /x\.com|twitter|tweets?|推特/i, capabilities: ["twitter_search", "social_search", "social_post_read"] },
    { pattern: /youtube|视频/i, capabilities: ["youtube_search", "social_search", "creator_research"] }
  ],
  markets: [
    { pattern: /stock|equity|shares?|股票|市值|10-k|8-k/i, capabilities: ["stock_quote", "equity_quote", "market_price", "financial_fundamentals"] },
    { pattern: /btc|eth|crypto|token|加密|币价/i, capabilities: ["crypto_price", "market_price", "market_cap"] }
  ],
  onchain: [
    { pattern: /dex|pool|liquidity|流动性|trading pair/i, capabilities: ["dex_liquidity", "dex_pair", "onchain_data"] },
    { pattern: /wallet|address|钱包|地址/i, capabilities: ["wallet_activity", "wallet_profiler", "onchain_data"] },
    { pattern: /smart[\s_-]?money|聪明钱/i, capabilities: ["smart_money", "wallet_activity", "onchain_analysis"] }
  ],
  operations: [
    { pattern: /weather|forecast|temperature|rain|天气|气温|降雨/i, capabilities: ["weather_forecast"] },
    { pattern: /flight|航班/i, capabilities: ["flight_search"] },
    { pattern: /shipping|parcel|tracking|快递|物流/i, capabilities: ["shipping_tracking", "parcel_tracking"] },
    { pattern: /malware|phishing|domain|恶意|钓鱼|域名/i, capabilities: ["domain_reputation", "domain_risk", "malware_check"] }
  ]
});

const CAPABILITY_PACK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["task"],
  properties: {
    task: {
      type: "string",
      minLength: 1,
      description: "Describe the data or evidence the agent needs. AgentRouter selects a provider capability inside the pack."
    }
  },
  additionalProperties: true
});

function normalizedManifestText(manifest = {}) {
  return [
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    ...(Array.isArray(manifest.capabilities) ? manifest.capabilities : []),
    manifest.agent_contract?.summary,
    manifest.agent_contract?.request_shape_summary,
    manifest.agent_contract?.response_shape_summary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function packDefinition(packId) {
  return CAPABILITY_PACKS.find((pack) => pack.id === packId) || null;
}

function packDefinitionByContract(contract) {
  return CAPABILITY_PACKS.find((pack) => pack.contract === contract) || null;
}

export function serviceMatchesCapabilityPack(manifest, packId) {
  const pack = packDefinition(packId);
  if (!pack || !manifest) return false;
  const text = `_${normalizedManifestText(manifest)}_`;
  return pack.signals.some((signal) => text.includes(`_${signal}_`));
}

function publicPack(pack, records) {
  const matches = records.filter((record) => serviceMatchesCapabilityPack(record?.manifest, pack.id));
  const prices = matches
    .map((record) => Number(record.manifest?.pricing?.amount))
    .filter((price) => Number.isFinite(price) && price >= 0);
  return {
    id: pack.id,
    title: pack.title,
    contract: pack.contract,
    description: pack.description,
    sample_task: pack.sample_task,
    input_schema: CAPABILITY_PACK_INPUT_SCHEMA,
    service_count: matches.length,
    verified_service_count: matches.filter((record) => record.verification_status === "verified").length,
    starting_price_usdc: prices.length ? String(Math.min(...prices)) : null
  };
}

export function listCapabilityPacks(records = []) {
  const safeRecords = Array.isArray(records) ? records : [];
  return CAPABILITY_PACKS.map((pack) => publicPack(pack, safeRecords));
}

export function getCapabilityPack(packId, records = []) {
  const pack = packDefinition(packId);
  return pack ? publicPack(pack, Array.isArray(records) ? records : []) : null;
}

export function resolveCapabilityPackCall(records = [], { contract, params = {} } = {}) {
  const pack = packDefinitionByContract(contract);
  if (!pack) return null;
  const safeRecords = Array.isArray(records) ? records : [];
  const publicDefinition = publicPack(pack, safeRecords);
  const safeParams = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
  const task = String(safeParams.task || safeParams.query || safeParams.prompt || "").trim();
  if (!task) {
    return {
      ok: false,
      status: "invalid_request",
      error: "MISSING_TASK",
      contract,
      pack: publicDefinition,
      expected_schema: CAPABILITY_PACK_INPUT_SCHEMA,
      message: `${contract} requires a non-empty task.`
    };
  }
  const matchingRecords = safeRecords.filter((record) => serviceMatchesCapabilityPack(record?.manifest, pack.id));
  if (!matchingRecords.length) {
    return {
      ok: false,
      status: "no_match",
      contract,
      pack: publicDefinition,
      message: `No live service currently implements ${contract}.`
    };
  }

  if (task && !safeParams.query) safeParams.query = task;

  const availableCapabilities = [...new Set(matchingRecords.flatMap((record) => record.manifest?.capabilities || []))]
    .filter((capability) => capability !== "data_service");
  const dispatch = (PACK_DISPATCH_RULES[pack.id] || []).find((rule) => rule.pattern.test(task));
  const preference = [
    ...(dispatch?.capabilities || []),
    ...(PACK_DEFAULT_CAPABILITIES[pack.id] || []),
    ...pack.signals
  ];
  const resolvedCapability = preference.find((capability) => availableCapabilities.includes(capability))
    || availableCapabilities[0];

  return {
    ok: true,
    status: "resolved",
    contract,
    pack: publicDefinition,
    resolved_capability: resolvedCapability,
    params: safeParams,
    dispatch_reason: dispatch
      ? `Task matched the ${pack.id} pack's specialist dispatch rule.`
      : `Task used the ${pack.id} pack's default provider capability order.`
  };
}
