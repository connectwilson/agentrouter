import { invokePaidService, searchServices } from "./registry.js";
import { quoteCapabilityRequest, routeCapabilityRequest } from "./router.js";
import { createPaymentQuote } from "./payment-adapter.js";
import { createConsumerFeedbackRequest, verifyServiceResult } from "./verifier.js";

export async function askAgentRouter(store, {
  task = "",
  max_price: maxPrice = "0.05",
  currency = "USDC",
  invoke = true,
  consumerApiKey = ""
} = {}) {
  const invocationOptions = { consumerApiKey };
  if (!String(task || "").trim()) {
    const error = new Error("task is required");
    error.statusCode = 422;
    throw error;
  }
  const clarification = detectClarification(task);
  if (clarification) return clarification;
  const intent = inferIntent(task);
  const structuredRequest = intentToCapabilityRequest(intent, { max_price: maxPrice });
  if (structuredRequest) {
    if (!invoke) {
      const quoted = quoteCapabilityRequest(store, {
        ...structuredRequest,
        budget: { max_amount: maxPrice, currency }
      });
      return paymentRequiredFromQuote({
        task,
        quoted,
        protocol: "agent_router_ask_v1"
      });
    }
    const routed = await routeCapabilityRequest(store, {
      ...structuredRequest,
      budget: { max_amount: maxPrice, currency }
    }, invocationOptions);
    return {
      ...routed,
      task,
      selected_service: routed.selected_service ? publicSelectedService(routed.selected_service) : routed.selected_service,
      input: routed.input,
      answer: routed.result ? summarize(task, routed.result) : undefined
    };
  }
  const candidates = searchCandidates(store, intent, maxPrice);
  if (!candidates.length) {
    return {
      ok: false,
      status: "no_service_found",
      task,
      tried: intent.search_queries
    };
  }
  const selected = selectService(candidates, intent);
  const record = store.services.get(selected.service_id);
  const preview = record?.manifest?.sample_response || null;
  if (!invoke) {
    const serviceInput = buildServiceAwareInput(intent, record?.manifest);
    const quote = createPaymentQuote({
      manifest: record.manifest,
      constraints: { max_price_usdc: maxPrice },
      selectedService: selected
    });
    return {
      ok: false,
      status: quote.would_pay ? "payment_required" : "quote_blocked",
      protocol: {
        protocol_version: "agent_router_ask_v1",
        invocation_policy: "quote_only_no_server_side_payment"
      },
      task,
      selected_service: publicSelectedService(selected),
      input: serviceInput,
      preview_sample_type: preview?.sample_type || null,
      quote,
      next_step: quote.would_pay
        ? paymentNextStep(quote)
        : "Increase the max_price budget or choose a lower-cost service."
    };
  }
  const tokenResolution = await maybeResolveTokenAddressLocal(store, intent, record?.manifest, { maxPrice, currency }, invocationOptions);
  if (tokenResolution?.ok === false) {
    return {
      ok: false,
      status: tokenResolution.status,
      task,
      selected_service: publicSelectedService(selected),
      input: buildServiceAwareInput(intent, record?.manifest),
      token_resolution: tokenResolution
    };
  }
  const serviceInput = buildServiceAwareInput(
    tokenResolution?.intent || intent,
    record?.manifest
  );
  const invocation = await invokePaidService(store, selected.service_id, serviceInput, {
    max_amount: maxPrice,
    currency
  }, invocationOptions);
  if (invocation.statusCode >= 400) {
    return {
      ok: false,
      status: "invoke_failed",
      task,
      selected_service: publicSelectedService(selected),
      input: serviceInput,
      error: invocation.body.error
    };
  }
  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent: serviceInput,
    constraints: { max_price_usdc: maxPrice }
  });
  return {
    ok: true,
    task,
    selected_service: publicSelectedService(selected),
    input: serviceInput,
    token_resolution: tokenResolution || null,
    preview_sample_type: preview?.sample_type || null,
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification,
    consumer_feedback_request: createConsumerFeedbackRequest({
      request: { task, input: serviceInput },
      selectedService: selected,
      result: invocation.body.result,
      verification
    }),
    answer: summarize(task, invocation.body.result)
  };
}

function paymentRequiredFromQuote({ task, quoted, protocol }) {
  if (!quoted.ok && quoted.status !== "quote_blocked") return { ...quoted, task };
  return {
    ...quoted,
    ok: false,
    status: quoted.status === "quote_blocked" ? "quote_blocked" : "payment_required",
    protocol: {
      protocol_version: protocol,
      invocation_policy: "quote_only_no_server_side_payment"
    },
    task,
    next_step: quoted.status === "quote_blocked"
      ? "Increase the max_price budget or choose a lower-cost service."
      : paymentNextStep(quoted)
  };
}

function paymentNextStep(quote) {
  if (quote?.quote?.settlement?.backend === "credits" || quote?.settlement?.backend === "credits") {
    return "Sign in to AgentRouter, add credits, then configure an AgentRouter API key in your MCP client environment. Never paste the key into chat.";
  }
  return "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof.";
}

export async function askAgentRouterRemote({
  baseUrl,
  task,
  max_price: maxPrice = "0.05",
  currency = "USDC"
}) {
  const clarification = detectClarification(task);
  if (clarification) return clarification;
  const intent = inferIntent(task);
  const structuredRequest = intentToCapabilityRequest(intent, { max_price: maxPrice });
  if (structuredRequest) {
    const routed = await post(baseUrl, "/agent-router/request", {
      ...structuredRequest,
      budget: { max_amount: maxPrice, currency }
    });
    return {
      ...routed,
      task,
      selected_service: routed.selected_service ? publicSelectedService(routed.selected_service) : routed.selected_service,
      input: routed.input,
      answer: routed.result ? summarize(task, routed.result) : undefined
    };
  }
  const candidates = await searchCandidatesRemote(baseUrl, intent, maxPrice);
  if (!candidates.length) {
    return {
      ok: false,
      status: "no_service_found",
      task,
      tried: intent.search_queries
    };
  }
  const selected = selectService(candidates, intent);
  const selectedManifest = await post(baseUrl, "/connector/get_manifest", { service_id: selected.service_id });
  const preview = await post(baseUrl, "/connector/preview_service", { service_id: selected.service_id });
  const tokenResolution = await maybeResolveTokenAddressRemote(baseUrl, intent, selectedManifest, { maxPrice, currency });
  if (tokenResolution?.ok === false) {
    return {
      ok: false,
      status: tokenResolution.status,
      task,
      selected_service: publicSelectedService(selected),
      input: buildServiceAwareInput(intent, selectedManifest),
      token_resolution: tokenResolution
    };
  }
  const serviceInput = buildServiceAwareInput(tokenResolution?.intent || intent, selectedManifest);
  const invocation = await post(baseUrl, "/connector/invoke_paid_service", {
    service_id: selected.service_id,
    input: serviceInput,
    budget: {
      max_amount: maxPrice,
      currency
    }
  });
  return {
    ok: true,
    task,
    selected_service: publicSelectedService(selected),
    input: serviceInput,
    token_resolution: tokenResolution || null,
    preview_sample_type: preview.sample_type || null,
    result: invocation.result,
    feedback: invocation.feedback,
    answer: summarize(task, invocation.result)
  };
}

export function inferIntent(task) {
  const tagMatch = task.match(/matrixport|binance|jump|wintermute|amber|okx|bybit/i);
  const tradingPair = detectTradingPair(task);
  const token = tradingPair?.base_asset || detectTokenSymbol(task);
  const address = detectAddress(task);
  const chain = detectChain(task);
  const window = detectWindow(task);
  const dynamicTerms = extractDynamicSearchTerms(task);
  const wantsSingle = /一个|一条|任意|first|\bone\b|single/i.test(task);
  const wantsAddress = /地址|钱包|address|wallet/i.test(task);
  const wantsRelatedWallets = /related[\s_-]?wallets?|关联钱包|相关钱包|wallet[\s_-]?cluster|cluster/i.test(task);
  const wantsLiquidation = /爆仓|清算|liquidation|max[\s-]?pain/i.test(task);
  const wantsSmartMoneyHoldings = /smart[\s_-]?money/i.test(task) && /holdings?|持仓/i.test(task);
  const wantsSmartMoneyNetflow = /smart[\s_-]?money/i.test(task) && /net[\s_-]?flow|netflow|净流入|净流出|资金流/i.test(task);
  const wantsSmartMoneyActivity = Boolean(token) && /smart[\s_-]?money|聪明钱/i.test(task) && /动向|动态|activity|flow|flows|买|卖|bought|sold|movement|近|过去|24\s*h|24\s*小时/i.test(task);
  const wantsNetflow = !wantsSmartMoneyNetflow && /net[\s_-]?flow|netflow|净流入|净流出/i.test(task);
  const hasKnownIntent = wantsAddress || wantsLiquidation || wantsSmartMoneyHoldings || wantsSmartMoneyNetflow || wantsSmartMoneyActivity || wantsNetflow;
  const limit = detectLimit(task, wantsSingle);
  const input = {
    limit,
    offset: 0
  };
  if (tagMatch) input.tag = tagMatch[0];
  if (token) input.token = token;
  if (address) {
    input.address = address;
    input.chain = chain || "ethereum";
    input.pagination = { page: 1, per_page: limit };
    delete input.limit;
    delete input.offset;
  }
  if (wantsSmartMoneyHoldings) {
    delete input.limit;
    delete input.offset;
    input.chains = [chain || "ethereum"];
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsSmartMoneyNetflow) {
    delete input.limit;
    delete input.offset;
    input.chains = [chain || "ethereum"];
    input.window = window || "24h";
    input.date = windowToDateRange(input.window);
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsSmartMoneyActivity) {
    delete input.limit;
    delete input.offset;
    input.token_symbol = token;
    input.chain = chain || chainForAsset(token) || "ethereum";
    input.window = window || "24h";
    input.timeframe = windowToTimeframe(input.window);
    input.date = windowToDateRange(input.window);
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsNetflow) {
    delete input.limit;
    delete input.offset;
    delete input.token;
    input.asset = token || undefined;
    input.chain = chain || chainForAsset(input.asset) || "ethereum";
    input.chains = [input.chain];
    input.window = window || "24h";
    input.date = windowToDateRange(input.window);
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsLiquidation) {
    input.asset = token || "BTC";
    if (tradingPair) {
      input.trading_pair = tradingPair.symbol;
      input.quote_asset = tradingPair.quote_asset;
    }
    input.market_type = "perpetual_futures";
    input.window = "current";
    delete input.limit;
    delete input.offset;
  }
  return {
    task,
    wants_address: wantsAddress,
    wants_related_wallets: wantsRelatedWallets,
    wants_liquidation: wantsLiquidation,
    wants_smart_money_holdings: wantsSmartMoneyHoldings,
    wants_smart_money_netflow: wantsSmartMoneyNetflow,
    wants_smart_money_activity: wantsSmartMoneyActivity,
    wants_netflow: wantsNetflow,
    has_known_intent: hasKnownIntent,
    dynamic_terms: dynamicTerms,
    tag: input.tag,
    address,
    chain: input.chain || chain,
    token: input.token || input.token_symbol || input.asset,
    input,
    search_queries: [
      dynamicTerms.length ? dynamicTerms.join(" ") : "",
      task,
      wantsLiquidation ? "perp liquidation max pain" : "",
      wantsLiquidation ? "liquidation heatmap crypto derivatives" : "",
      wantsSmartMoneyHoldings ? "smart money holdings" : "",
      wantsSmartMoneyNetflow ? "smart money netflow" : "",
      wantsSmartMoneyActivity ? `${token} token flow intelligence` : "",
      wantsSmartMoneyActivity ? `${token} who bought sold` : "",
      wantsSmartMoneyActivity ? "token god mode flow intelligence" : "",
      wantsSmartMoneyActivity ? "token search" : "",
      wantsNetflow ? `${input.asset || input.chain || ""} netflow` : "",
      wantsNetflow ? "netflow" : "",
      wantsAddress && address ? `${address} related wallets address profile` : "",
      wantsAddress ? "related wallets address profile" : "",
      wantsRelatedWallets ? "wallet cluster related wallets" : "",
      wantsAddress ? "Lookonchain address wallet" : "",
      wantsAddress ? "address wallet" : "",
      wantsAddress ? "wallet_profile" : ""
    ].filter(Boolean)
  };
}

export function buildServiceAwareInput(intent, manifestOrService = {}) {
  const sample = manifestOrService.sample_request || {};
  const schemaProperties = manifestOrService.input_schema?.properties || {};
  const targetKeys = new Set([
    ...Object.keys(sample || {}),
    ...Object.keys(schemaProperties || {})
  ]);
  const inferred = intent.input || {};
  if (!targetKeys.size) {
    return stripEmptyValues(applyDataServiceInputDefaults({ ...inferred }, intent, manifestOrService, inferred, targetKeys));
  }

  const input = { ...sample };
  for (const [key, value] of Object.entries(inferred)) {
    if (value === undefined || value === null) continue;
    if (targetKeys.has(key)) input[key] = value;
  }

  if (targetKeys.has("chain") && input.chain == null) {
    input.chain = inferred.chain || inferred.chains?.[0] || intent.chain;
  }
  if (targetKeys.has("chains") && input.chains == null) {
    const chain = inferred.chain || inferred.chains?.[0] || intent.chain;
    if (chain) input.chains = [chain];
  }
  if (targetKeys.has("address") && input.address == null && intent.address) {
    input.address = intent.address;
  }
  if (targetKeys.has("asset") && input.asset == null && (inferred.asset || intent.token)) {
    input.asset = inferred.asset || intent.token;
  }
  if (targetKeys.has("token") && input.token == null && intent.token) {
    input.token = intent.token;
  }
  if (targetKeys.has("token_symbol") && input.token_symbol == null && intent.token) {
    input.token_symbol = intent.token;
  }
  if (targetKeys.has("token_address") && inferred.token_address) {
    input.token_address = inferred.token_address;
  }
  if (targetKeys.has("window") && input.window == null && inferred.window) {
    input.window = inferred.window;
  }
  if (targetKeys.has("timeframe") && (input.timeframe == null || isExampleValue(input.timeframe))) {
    input.timeframe = inferred.timeframe || windowToTimeframe(inferred.window);
  }
  if (targetKeys.has("date") && (input.date == null || isExampleValue(input.date))) {
    input.date = inferred.date || windowToDateRange(inferred.window);
  }
  if (targetKeys.has("pagination")) {
    input.pagination = {
      ...(sample.pagination || {}),
      ...(inferred.pagination || {})
    };
    const limit = inferred.limit || input.pagination.per_page;
    input.pagination.page = Number(input.pagination.page || 1);
    input.pagination.per_page = Number(limit || 5);
  }
  if (targetKeys.has("limit") && input.limit == null && inferred.pagination?.per_page) {
    input.limit = inferred.pagination.per_page;
  }
  if (targetKeys.has("offset") && input.offset == null) {
    input.offset = inferred.offset || 0;
  }

  return stripEmptyValues(applyDataServiceInputDefaults(input, intent, manifestOrService, inferred, targetKeys));
}

function applyDataServiceInputDefaults(input, intent, manifestOrService, inferred, targetKeys) {
  const wantsDataWindow = wantsRoutedDataWindow(intent);
  if (!wantsDataWindow) return input;
  const chain = inferred.chain || inferred.chains?.[0] || intent.chain || chainForAsset(intent.token);
  if (chain) {
    if ((targetKeys.has("chain") || shouldForceProviderKey(manifestOrService, "chain")) && input.chain == null) {
      input.chain = chain;
    }
    if ((targetKeys.has("chains") || shouldForceProviderKey(manifestOrService, "chains")) && input.chains == null) {
      input.chains = [chain];
    }
  }
  if (shouldForceProviderKey(manifestOrService, "date") && (input.date == null || isExampleValue(input.date))) {
    input.date = inferred.date || windowToDateRange(inferred.window || input.window || "24h");
  }
  if ((targetKeys.has("pagination") || shouldForceProviderKey(manifestOrService, "pagination")) && input.pagination == null) {
    input.pagination = inferred.pagination || { page: 1, per_page: inferred.limit || 5 };
  }
  if (input.pagination) {
    input.pagination = {
      ...input.pagination,
      page: Number(input.pagination.page || 1),
      per_page: Number(input.pagination.per_page || inferred.limit || 5)
    };
  }
  return input;
}

function wantsRoutedDataWindow(intent = {}) {
  return Boolean(
    intent.wants_smart_money_activity ||
    intent.wants_smart_money_netflow ||
    intent.wants_netflow ||
    ["token_smart_money_activity", "smart_money_netflow", "netflow"].includes(intent.capability)
  );
}

function shouldForceProviderKey(manifestOrService = {}, key) {
  const surface = [
    manifestOrService.service_id,
    manifestOrService.title,
    manifestOrService.description_for_agent,
    ...(manifestOrService.capabilities || []),
    JSON.stringify(manifestOrService.sample_request || {}),
    JSON.stringify(manifestOrService.input_schema?.properties || {})
  ].join(" ").toLowerCase();
  if (key === "date") {
    return /nansen|\/api\/v1\/tgm|\/api\/v1\/smart-money|smart-money\/netflow|who[-_\s]?bought|bought[-_\s]?sold/.test(surface);
  }
  if (key === "pagination") {
    return /nansen|smart[\s_-]?money|token[\s_-]?flow|flow[\s_-]?intelligence|net[\s_-]?flow|netflow/.test(surface);
  }
  if (key === "chain" || key === "chains") {
    return /nansen|onchain|on-chain|token[\s_-]?flow|smart[\s_-]?money|net[\s_-]?flow|netflow/.test(surface);
  }
  return false;
}

function stripEmptyValues(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

async function maybeResolveTokenAddressLocal(store, intent, manifest, { maxPrice, currency }, options = {}) {
  if (!serviceNeedsTokenAddress(manifest) || intent.input?.token_address || !intent.token) return null;
  const resolver = findTokenResolverLocal(store, maxPrice);
  if (!resolver) {
    return {
      ok: false,
      status: "token_address_required",
      message: `The selected service requires token_address, but no token search resolver is registered for ${intent.token}.`
    };
  }
  const resolverRecord = store.services.get(resolver.service_id);
  const resolverInput = buildTokenResolverInput(intent, resolverRecord?.manifest);
  const invocation = await invokePaidService(store, resolver.service_id, resolverInput, {
    max_amount: maxPrice,
    currency
  }, options);
  if (invocation.statusCode >= 400) {
    return {
      ok: false,
      status: "token_resolution_failed",
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      error: invocation.body.error
    };
  }
  const resolved = extractTokenResolution(invocation.body.result, intent.token, intent.chain);
  if (!resolved?.address) {
    return {
      ok: false,
      status: "token_not_found",
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      token_symbol: intent.token
    };
  }
  return withResolvedToken(intent, resolved, {
    resolver_service_id: resolver.service_id,
    resolver_input: resolverInput
  });
}

async function maybeResolveTokenAddressRemote(baseUrl, intent, manifest, { maxPrice, currency }) {
  if (!serviceNeedsTokenAddress(manifest) || intent.input?.token_address || !intent.token) return null;
  const resolvers = await post(baseUrl, "/connector/search_services", {
    query: "token search",
    verified_only: true,
    max_price: maxPrice
  });
  const resolver = resolvers.find((service) => /token[_\s-]?search|entity[_\s-]?search|search/.test(serviceSearchHaystack(service)));
  if (!resolver) {
    return {
      ok: false,
      status: "token_address_required",
      message: `The selected service requires token_address, but no token search resolver is registered for ${intent.token}.`
    };
  }
  const resolverManifest = await post(baseUrl, "/connector/get_manifest", { service_id: resolver.service_id });
  const resolverInput = buildTokenResolverInput(intent, resolverManifest);
  const invocation = await post(baseUrl, "/connector/invoke_paid_service", {
    service_id: resolver.service_id,
    input: resolverInput,
    budget: {
      max_amount: maxPrice,
      currency
    }
  });
  const resolved = extractTokenResolution(invocation.result, intent.token, intent.chain);
  if (!resolved?.address) {
    return {
      ok: false,
      status: "token_not_found",
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      token_symbol: intent.token
    };
  }
  return withResolvedToken(intent, resolved, {
    resolver_service_id: resolver.service_id,
    resolver_input: resolverInput
  });
}

function findTokenResolverLocal(store, maxPrice) {
  return searchServices(store, {
    query: "token search",
    verifiedOnly: true,
    maxPrice
  }).find((service) => /token[_\s-]?search|entity[_\s-]?search|search/.test(serviceSearchHaystack(service)));
}

function buildTokenResolverInput(intent, manifest = {}) {
  const base = buildServiceAwareInput({
    ...intent,
    input: {
      search_query: intent.token,
      query: intent.token,
      q: intent.token,
      keyword: intent.token,
      symbol: intent.token,
      result_type: "token",
      type: "token",
      chain: intent.chain || "ethereum",
      limit: 5,
      pagination: { page: 1, per_page: 5 }
    }
  }, manifest);
  return Object.fromEntries(Object.entries({
    ...base,
    search_query: base.search_query ?? (hasInputKey(manifest, "search_query") ? intent.token : undefined),
    query: base.query ?? (hasInputKey(manifest, "query") ? intent.token : undefined),
    q: base.q ?? (hasInputKey(manifest, "q") ? intent.token : undefined),
    result_type: base.result_type ?? (hasInputKey(manifest, "result_type") ? "token" : undefined),
    type: base.type ?? (hasInputKey(manifest, "type") ? "token" : undefined),
    chain: base.chain ?? (hasInputKey(manifest, "chain") ? intent.chain || "ethereum" : undefined),
    limit: base.limit ?? (hasInputKey(manifest, "limit") ? 5 : undefined)
  }).filter(([, value]) => value !== undefined && value !== null));
}

function withResolvedToken(intent, resolved, meta) {
  const resolution = describeTokenResolution({
    requestedSymbol: intent.token,
    matchedSymbol: resolved.symbol,
    matchedName: resolved.name,
    chain: resolved.chain || intent.chain
  });
  const nextIntent = {
    ...intent,
    chain: resolved.chain || intent.chain,
    input: {
      ...(intent.input || {}),
      chain: resolved.chain || intent.input?.chain || intent.chain || "ethereum",
      token_symbol: intent.token,
      token_address: resolved.address
    }
  };
  return {
    ok: resolution.auto_pay_allowed,
    status: resolution.auto_pay_allowed ? "resolved" : "token_resolution_ambiguous",
    message: resolution.blocking_reason,
    token_symbol: intent.token,
    token_address: resolved.address,
    chain: resolved.chain || intent.chain || null,
    matched_name: resolved.name || null,
    matched_symbol: resolved.symbol || null,
    asset_resolution: resolution,
    requested_symbol: resolution.requested_symbol,
    resolved_symbol: resolution.resolved_symbol,
    resolution_type: resolution.resolution_type,
    auto_pay_allowed: resolution.auto_pay_allowed,
    blocking_reason: resolution.blocking_reason,
    requires_disclosure: resolution.requires_disclosure,
    disclosure: resolution.disclosure,
    intent: nextIntent,
    ...meta
  };
}

function serviceNeedsTokenAddress(manifestOrService = {}) {
  return hasInputKey(manifestOrService, "token_address");
}

function hasInputKey(manifestOrService = {}, key) {
  const sample = manifestOrService.sample_request || {};
  const schemaProperties = manifestOrService.input_schema?.properties || {};
  return Object.prototype.hasOwnProperty.call(sample, key) || Object.prototype.hasOwnProperty.call(schemaProperties, key);
}

function extractTokenResolution(result, tokenSymbol, preferredChain) {
  const symbol = String(tokenSymbol || "").toUpperCase();
  const candidates = [];
  walkJson(result, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const address = firstString(value, ["token_address", "contract_address", "contractAddress", "address"]);
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return;
    const candidate = {
      address: address.toLowerCase(),
      symbol: firstString(value, ["symbol", "ticker", "token_symbol"]),
      name: firstString(value, ["name", "token_name", "label"]),
      chain: normalizeChain(firstString(value, ["chain", "network", "blockchain"]))
    };
    const haystack = [candidate.symbol, candidate.name].filter(Boolean).join(" ").toUpperCase();
    const exactSymbol = String(candidate.symbol || "").toUpperCase() === symbol;
    const nameMatch = haystack.split(/[^A-Z0-9]+/).includes(symbol);
    const chainMatch = !preferredChain || !candidate.chain || candidate.chain === preferredChain;
    candidates.push({
      ...candidate,
      score: (exactSymbol ? 4 : 0) + (nameMatch ? 2 : 0) + (chainMatch ? 1 : 0)
    });
  });
  return candidates.sort((a, b) => b.score - a.score)[0] || null;
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

function walkJson(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) walkJson(item, visitor);
  }
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeChain(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  if (text === "eth" || text === "ethereum mainnet") return "ethereum";
  if (text === "bnb" || text === "binance smart chain") return "bsc";
  return text;
}

function detectTokenSymbol(task) {
  const text = String(task || "");
  const known = text.match(/\$?(ETH|BTC|USDC|USDT|HYPE|SOL|BNB)\b/i);
  if (known) return known[1].toUpperCase();
  const stopwords = new Set(["API", "HTTP", "JSON", "USDC", "USD", "NFT", "TVL", "DEX", "CEX", "L1", "L2", "AI"]);
  const matches = text.match(/\$?[A-Z][A-Z0-9]{2,11}\b/g) || [];
  for (const raw of matches) {
    const token = raw.replace(/^\$/, "").toUpperCase();
    if (!stopwords.has(token)) return token;
  }
  return null;
}

function detectTradingPair(task) {
  const compactPair = String(task || "").toUpperCase().match(/\b([A-Z0-9]{2,15})(USDT|USDC|FDUSD|BUSD)\b/);
  if (!compactPair) return null;
  return {
    base_asset: compactPair[1],
    quote_asset: compactPair[2],
    symbol: compactPair[0]
  };
}

function isExampleValue(value) {
  if (value === "example") return true;
  if (typeof value === "string" && /^1970-/.test(value)) return true;
  return false;
}

function windowToTimeframe(window) {
  if (!window) return undefined;
  const text = String(window).toLowerCase();
  if (text === "24h") return "1d";
  return text;
}

function windowToDateRange(window) {
  const text = String(window || "").toLowerCase();
  const now = new Date();
  const from = new Date(now);
  const hourMatch = text.match(/^(\d+)h$/);
  const dayMatch = text.match(/^(\d+)d$/);
  if (hourMatch) from.setHours(from.getHours() - Number(hourMatch[1]));
  else if (dayMatch) from.setDate(from.getDate() - Number(dayMatch[1]));
  else from.setDate(from.getDate() - 1);
  return {
    from: from.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10)
  };
}

function extractDynamicSearchTerms(task) {
  const stopwords = new Set([
    "agentrouter",
    "agent",
    "router",
    "use",
    "using",
    "query",
    "search",
    "find",
    "data",
    "service",
    "api",
    "with",
    "the",
    "to",
    "for",
    "from"
  ]);
  return [...new Set(String(task || "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((term) => !stopwords.has(term))
    .slice(0, 8);
}

function detectClarification(task) {
  const text = String(task || "").toLowerCase();
  const saysMaxPain = /最大痛点|max[\s-]?pain/.test(text);
  const saysLiquidation = /爆仓|清算|liquidation|perp|永续|合约/.test(text);
  const saysOptions = /期权|options?/.test(text);
  if (saysMaxPain && !saysLiquidation && !saysOptions) {
    return {
      ok: false,
      status: "needs_clarification",
      question: "你说的最大痛点，是永续合约爆仓集中区，还是期权 max pain？",
      options: [
        {
          label: "永续合约爆仓痛点",
          request: {
            capability: "perp_liquidation_max_pain",
            params: { asset: "BTC", market_type: "perpetual_futures", window: "current" }
          }
        },
        {
          label: "期权最大痛点",
          request: {
            capability: "options_max_pain",
            params: { asset: "BTC", expiry: "nearest" }
          }
        }
      ]
    };
  }
  return null;
}

function intentToCapabilityRequest(intent, { max_price: maxPrice } = {}) {
  if (intent.wants_smart_money_activity) {
    return {
      capability: "token_smart_money_activity",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_smart_money_netflow) {
    return {
      capability: "smart_money_netflow",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_netflow) {
    return {
      capability: "netflow",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_smart_money_holdings) {
    return {
      capability: "smart_money_holdings",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_liquidation) {
    return {
      capability: "perp_liquidation_max_pain",
      params: {
        asset: intent.input.asset || intent.token || "BTC",
        trading_pair: intent.input.trading_pair,
        quote_asset: intent.input.quote_asset,
        market_type: "perpetual_futures",
        window: intent.input.window || "current"
      },
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300,
        min_confidence: 0.7
      }
    };
  }
  return null;
}

function detectLimit(task, wantsSingle) {
  if (wantsSingle) return 1;
  const text = String(task || "").replace(/0x[a-fA-F0-9]{40}/g, " ");
  const match = text.match(/(?:前|top\s*)?(\d{1,3})\s*(?:条|个|rows?|records?|data)?/i);
  if (!match) return 5;
  return Math.max(1, Math.min(100, Number(match[1])));
}

function detectAddress(task) {
  return String(task || "").match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || null;
}

function detectChain(task) {
  const text = String(task || "").toLowerCase();
  if (/\beth\b/.test(text) || text.includes("以太坊")) return "ethereum";
  if (/hyper\s?evm|hyperevm|hyperliquid|hype/i.test(text)) return "hyperevm";
  for (const chain of ["ethereum", "base", "arbitrum", "optimism", "solana", "bsc", "hyperevm"]) {
    if (text.includes(chain)) return chain;
  }
  return null;
}

function chainForAsset(asset) {
  const normalized = String(asset || "").toUpperCase();
  if (normalized === "ETH") return "ethereum";
  if (normalized === "SOL") return "solana";
  if (normalized === "BNB") return "bsc";
  if (normalized === "HYPE") return "hyperevm";
  return null;
}

function detectWindow(task) {
  const text = String(task || "").toLowerCase();
  const hourMatch = text.match(/(?:近|过去|last\s*)?(\d{1,3})\s*(?:小时|h|hours?)/i);
  if (hourMatch) return `${Number(hourMatch[1])}h`;
  const dayMatch = text.match(/(?:近|过去|last\s*)?(\d{1,3})\s*(?:天|d|days?)/i);
  if (dayMatch) return `${Number(dayMatch[1])}d`;
  if (/当前|现在|current|now|latest/.test(text)) return "current";
  return null;
}

function searchCandidates(store, intent, maxPrice) {
  const seen = new Map();
  for (const query of intent.search_queries) {
    const items = searchServices(store, {
      query,
      verifiedOnly: true,
      maxPrice
    });
    for (const item of items) seen.set(item.service_id, item);
  }
  return filterDynamicCandidates([...seen.values()], intent);
}

async function searchCandidatesRemote(baseUrl, intent, maxPrice) {
  const seen = new Map();
  const queries = [...new Set(intent.search_queries)]
    .filter(Boolean)
    .slice(0, intent.has_known_intent ? 4 : 8);
  const batches = await Promise.all(queries.map((query) => post(baseUrl, "/connector/search_services", {
      query,
      verified_only: true,
      max_price: maxPrice
    }).catch(() => [])));
  for (const items of batches) {
    for (const item of items) seen.set(item.service_id, item);
  }
  return filterDynamicCandidates([...seen.values()], intent);
}

function filterDynamicCandidates(candidates, intent) {
  if (intent.wants_smart_money_activity) {
    return candidates.filter((service) => {
      const haystack = serviceSearchHaystack(service);
      return /token god mode|token_god_mode|flow intelligence|flow_intelligence|who bought|who_bought|bought_sold|buyer_seller|token flow|token_flow/.test(haystack);
    });
  }
  if (intent.has_known_intent) return candidates;
  const terms = intent.dynamic_terms || [];
  if (terms.length < 2) return candidates;
  return candidates.filter((service) => {
    const haystack = serviceSearchHaystack(service);
    return terms.every((term) => haystack.includes(term));
  });
}

export function selectService(candidates, intent) {
  const scored = candidates.map((service) => {
    const haystack = serviceSearchHaystack(service);
    let score = service.match_score || 0;
    if (intent.wants_address && /address|wallet/.test(haystack)) score += 3;
    if (intent.wants_related_wallets && /related[\s_-]?wallets?|wallet[\s_-]?cluster|cluster/.test(haystack)) score += 6;
    if (intent.wants_liquidation && /liquidation|max pain|max-pain|derivatives|perp/.test(haystack)) score += 4;
    if ((intent.wants_netflow || intent.wants_smart_money_netflow) && /net[\s_-]?flow|netflow|净流入|净流出/.test(haystack)) score += 4;
    if (intent.wants_smart_money_activity && /token god mode|token_god_mode|flow intelligence|flow_intelligence|who bought|who_bought|bought_sold|buyer_seller|token flow|token_flow/.test(haystack)) score += 8;
    if (intent.wants_smart_money_activity && /who bought|who_bought|bought_sold|buyer_seller|buyer seller|smart money/.test(haystack)) score += 5;
    if (intent.wants_smart_money_activity && /flow intelligence|flow_intelligence|token flow|token_flow/.test(haystack)) score += 3;
    if (intent.wants_smart_money_activity && /dex[\s_-]?trades?|trades? data/.test(haystack)) score -= 2;
    if (intent.wants_smart_money_activity && /capital_flow_analysis|chain fund flow|chain_fund_flow|market-wide|chain-level/.test(haystack)) score -= 8;
    if (intent.wants_smart_money_activity && /token[_\s-]?search|entity[_\s-]?search/.test(haystack)) score -= 2;
    if (intent.wants_related_wallets && /leaderboard|ranking|rank|points/.test(haystack)) score -= 4;
    if (intent.wants_address && (/^list/.test(service.service_id) || /listlookonchainaddresses/.test(service.service_id))) score += 2;
    if (/getlookonchainaddress/.test(service.service_id) && !intent.input.address) score -= 2;
    if (/lookonchain/.test(haystack)) score += 1;
    return { service, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].service;
}

function serviceSearchHaystack(service) {
  return [
    service.service_id,
    service.title,
    service.description_for_agent,
    ...(service.capabilities || []),
    service.sample_response?.summary,
    JSON.stringify(service.sample_response?.data || {}),
    JSON.stringify(service.validation_result_preview || {})
  ].join(" ").toLowerCase();
}

export function summarize(_task, envelope) {
  const rows = Array.isArray(envelope?.data?.data) ? envelope.data.data : [];
  if (rows.length) {
    const first = rows[0];
    return [
      `Found ${rows.length} matching record${rows.length === 1 ? "" : "s"}.`,
      first.address ? `Address: ${first.address}.` : "",
      first.tag ? `Tag: ${first.tag}.` : "",
      Array.isArray(first.tokens) ? `Tokens: ${first.tokens.join(", ")}.` : ""
    ].filter(Boolean).join(" ");
  }
  if (envelope?.data?.max_liquidation_pain_price) {
    const data = envelope.data;
    return [
      `BTC perp liquidation max-pain is ${data.max_liquidation_pain_price}.`,
      data.direction ? `Direction: ${data.direction}.` : "",
      data.estimated_liquidation_notional_usd ? `Estimated notional: ${data.estimated_liquidation_notional_usd} USD.` : ""
    ].filter(Boolean).join(" ");
  }
  if (envelope?.data?.address) {
    return `Found address: ${envelope.data.address}${envelope.data.tag ? ` (${envelope.data.tag})` : ""}.`;
  }
  return envelope?.summary || "AgentRouter completed the request.";
}

function publicSelectedService(service) {
  return {
    service_id: service.service_id,
    title: service.title,
    price: service.pricing
  };
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 402 && (payload?.status === "payment_required" || payload?.status === "quote_blocked")) {
      return payload;
    }
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    error.http_status = response.status;
    throw error;
  }
  return payload;
}
