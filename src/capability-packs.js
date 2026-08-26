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
