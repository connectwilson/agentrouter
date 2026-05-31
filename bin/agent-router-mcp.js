#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import { getArcUsdcBalance } from "../src/arc-payment.js";
import { submitErc8004Feedback } from "../src/erc8004.js";
import { invokePaidServiceWithLocalWallet } from "../src/local-invoke.js";
import { routeTaskWithLocalWallet } from "../src/local-route.js";
import { currentPaymentBackend } from "../src/payment-adapter.js";
import { initSessionWallet, initWallet, readWallet, walletStatus } from "../src/wallet.js";

const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter.network").replace(/\/$/, "");

const tools = [
  {
    name: "agentrouter_request",
    description: "Use this first for AgentRouter data/API calls. The main agent parses the user request into a structured capability request; AgentRouter validates, routes, pays, invokes, records payment verification/evidence, and returns a feedback request. After using the result in the final answer, call agentrouter_feedback with the returned request_id. Do not use agentrouter_ask when you can fill this schema.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example perp_liquidation_max_pain." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc and freshness_seconds." },
        budget: { type: "object", description: "Optional budget object." },
        consumer_context: { type: "object", description: "Optional caller context, parser metadata, or session id." }
      }
    }
  },
  {
    name: "agentrouter_quote",
    description: "Preview AgentRouter service selection, request input, price, payment guard result, auto-invoke policy, and why paid data is justified without invoking the provider.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example perp_liquidation_max_pain." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc." },
        budget: { type: "object", description: "Optional budget object." }
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
    description: "List AgentRouter capability schemas. Call this before agentrouter_request when you are unsure which structured capability or params to use.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "agentrouter_feedback",
    description: "Submit post-call consumer feedback after the main agent has judged whether an AgentRouter result helped answer the user's task. Use request_id from the prior AgentRouter response; service_id is not required when request_id is unique.",
    inputSchema: {
      type: "object",
      required: ["request_id", "feedback"],
      properties: {
        request_id: { type: "string", description: "The request_id returned by the completed AgentRouter call." },
        consumer_id: { type: "string", description: "Optional caller identifier.", default: "main_agent" },
        feedback: {
          type: "object",
          required: ["intent_fit", "answer_useful", "reason"],
          properties: {
            intent_fit: { enum: ["yes", "partial", "no", "unknown"] },
            answer_useful: { enum: ["yes", "partial", "no", "unknown"] },
            data_quality_score: { type: "number", minimum: 0, maximum: 1 },
            used_in_final_answer: { type: "boolean" },
            reason: { type: "string" },
            missing_fields: { type: "array", items: { type: "string" } },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  },
  {
    name: "agentrouter_ask",
    description: "Last-resort natural-language helper: send the user's task to AgentRouter for lightweight parsing. Prefer agentrouter_capabilities plus agentrouter_request whenever the main agent can produce a structured request. If this returns a successful paid result with a request_id, call agentrouter_feedback after answering.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "The user's original data/API request. Use only when a structured capability request cannot be produced." },
        max_price: { type: "string", description: "Maximum USDC price allowed for this call.", default: "0.05" },
        currency: { type: "string", description: "Payment currency.", default: "USDC" }
      }
    }
  },
  {
    name: "agentrouter_wallet_status",
    description: "Check whether this local AI client already has an encrypted EVM AgentRouter wallet for future x402 payments. Never returns private keys.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "agentrouter_wallet_create",
    description: "Default wallet bootstrap: create a local encrypted EVM session wallet entirely inside the Claude MCP flow. No passphrase is typed into chat; a local random encryption secret is generated and stored on this machine. Never returns private keys.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Overwrite the existing local AgentRouter wallet. Use only after explicit user confirmation.", default: false }
      }
    }
  },
  {
    name: "agentrouter_wallet_init",
    description: "Advanced wallet bootstrap: create a local encrypted secp256k1 EVM wallet using ADN_WALLET_PASSPHRASE if it is already configured. Prefer agentrouter_wallet_create for normal users. Never returns private keys.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Overwrite the existing local AgentRouter wallet. Use only after explicit user confirmation.", default: false }
      }
    }
  },
  {
    name: "agentrouter_wallet_setup",
    description: "Advanced wallet bootstrap: start a one-time local browser setup page where the user can enter an encryption passphrase directly on this machine. Prefer agentrouter_wallet_create for normal users.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Allow replacing an existing local wallet after explicit user confirmation.", default: false }
      }
    }
  }
];

let buffer = Buffer.alloc(0);
let walletSetupSession = null;

process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of readMessages()) {
    await handleMessage(message);
  }
});

process.stdin.on("end", () => process.exit(0));

function readMessages() {
  const messages = [];
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (line) messages.push(JSON.parse(line));
      continue;
    }

    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) throw new Error("Missing Content-Length header");

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    messages.push(JSON.parse(body));
  }
  return messages;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.method?.startsWith("notifications/")) return;
  if (!Object.hasOwn(message, "id")) return;

  try {
    if (message.method === "initialize") {
      const autoWallet = await ensureAutoWallet();
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "AgentRouter", version: "0.1.0" },
          agentrouter: { auto_wallet: autoWallet }
        }
      });
      return;
    }

    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      const presentation = sanitizeAgentToolResult(result);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(presentation, null, 2)
            }
          ],
          isError: result?.ok === false && ["transport_error", "http_error", "wallet_needs_funding"].includes(result.status)
        }
      });
      return;
    }

    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message);
  }
}

async function callTool(name, args) {
  if (name === "agentrouter_ask") {
    if (["x402", "circle_arc"].includes(currentPaymentBackend())) {
      return routeTaskWithLocalWallet({
        baseUrl,
        task: args.task,
        constraints: { max_price_usdc: args.max_price || "0.05" },
        budget: { max_amount: args.max_price || "0.05", currency: args.currency || "USDC" }
      });
    }
    return post("/agent-router/ask", {
      task: args.task,
      max_price: args.max_price || "0.05",
      currency: args.currency || "USDC"
    });
  }

  if (name === "agentrouter_request") {
    if (["x402", "circle_arc"].includes(currentPaymentBackend())) {
      return requestWithLocalWallet(args);
    }
    return post("/agent-router/request", {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {},
      consumer_context: args.consumer_context || {}
    });
  }

  if (name === "agentrouter_quote") {
    return post("/agent-router/quote", {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {}
    });
  }

  if (name === "agentrouter_quote_feedback") {
    return post("/agent-router/quote-feedback", {
      quote_id: args.quote_id,
      service_id: args.service_id,
      consumer_id: args.consumer_id || "main_agent",
      decision: args.decision,
      reason_code: args.reason_code,
      reason: args.reason
    });
  }

  if (name === "agentrouter_capabilities") {
    return get("/capabilities");
  }

  if (name === "agentrouter_feedback") {
    if (["x402", "circle_arc"].includes(currentPaymentBackend())) {
      return submitFeedbackWithLocalWallet(args);
    }
    return post("/agent-router/feedback", {
      request_id: args.request_id,
      consumer_id: args.consumer_id || "main_agent",
      feedback: args.feedback || {}
    });
  }

  if (name === "agentrouter_wallet_status") {
    const status = await walletStatus();
    const paymentBackend = currentPaymentBackend();
    status.payment_backend = paymentBackend;
    status.arc_payment_active = paymentBackend === "circle_arc";
    status.paid_request_behavior = status.arc_payment_active
      ? "Paid AgentRouter requests use the local wallet and require Arc Testnet USDC before provider invocation."
      : "Paid AgentRouter requests are not using Arc local-wallet settlement in this MCP session. Reinstall or restart the MCP server with ADN_PAYMENT_BACKEND=circle_arc for balance-gated calls.";
    if (status.initialized && status.arc_payment_active) {
      try {
        status.arc_testnet_usdc = await getArcUsdcBalance(status.address);
      } catch (error) {
        status.arc_testnet_usdc = {
          ok: false,
          status: "balance_unavailable",
          message: error.message
        };
      }
    }
    return status;
  }

  if (name === "agentrouter_wallet_create") {
    const wallet = await initSessionWallet({ force: Boolean(args.force) });
    return {
      ok: true,
      status: "wallet_ready",
      wallet,
      safety_note: "This is a local session wallet for small x402 API budgets. No private key is returned to Claude.",
      next_step: "Fund this local EVM wallet with a small Arc Testnet USDC budget before real x402 settlement."
    };
  }

  if (name === "agentrouter_wallet_init") {
    try {
      const wallet = await initWallet({ force: Boolean(args.force) });
      return {
        ok: true,
        wallet,
        next_step: "Fund this local EVM wallet with a small Arc Testnet USDC budget before real x402 settlement."
      };
    } catch (error) {
      return {
        ok: false,
        status: /ADN_WALLET_PASSPHRASE/.test(error.message) ? "needs_wallet_passphrase_env" : "wallet_init_failed",
        message: error.message,
        setup_hint: "Use agentrouter_wallet_create for the default in-Claude session wallet flow, or agentrouter_wallet_setup for advanced passphrase mode."
      };
    }
  }

  if (name === "agentrouter_wallet_setup") {
    return startWalletSetupSession({ force: Boolean(args.force) });
  }

  return {
    ok: false,
    status: "unknown_tool",
    tool: name,
    available_tools: tools.map((tool) => tool.name)
  };
}

async function submitFeedbackWithLocalWallet(args) {
  const feedbackResult = await post("/agent-router/feedback", {
    request_id: args.request_id,
    consumer_id: args.consumer_id || "main_agent",
    feedback: args.feedback || {},
    defer_erc8004_to_consumer: true
  });
  if (!feedbackResult.ok || !feedbackResult.service_id) return feedbackResult;
  const erc8004Request = feedbackResult.erc8004 || {};
  if (erc8004Request.status !== "consumer_submission_required" || !erc8004Request.agent_id) {
    return feedbackResult;
  }
  try {
    const wallet = await readWallet();
    const detail = await get(`/agent-router/service?service_id=${encodeURIComponent(feedbackResult.service_id)}`);
    const erc8004 = await submitErc8004Feedback({
      requestId: feedbackResult.request_id,
      serviceId: feedbackResult.service_id,
      providerId: detail?.manifest?.provider?.provider_id || feedbackResult.provider_id,
      manifest: detail?.manifest,
      feedback: feedbackResult.consumer_feedback,
      baseUrl,
      privateKey: wallet.private_key_hex,
      submitter: "consumer_wallet"
    });
    feedbackResult.erc8004 = erc8004;
    feedbackResult.trust_anchor = {
      ...(feedbackResult.trust_anchor || {}),
      primary_standard: erc8004.status === "submitted" ? "ERC-8004" : feedbackResult.trust_anchor?.primary_standard,
      erc8004
    };
    if (erc8004.status === "submitted") {
      const attached = await post("/agent-router/feedback/erc8004", {
        service_id: feedbackResult.service_id,
        request_id: feedbackResult.request_id,
        erc8004
      });
      feedbackResult.erc8004_attachment = attached;
    }
    return feedbackResult;
  } catch (error) {
    return {
      ...feedbackResult,
      erc8004: {
        ...(feedbackResult.erc8004 || {}),
        status: "consumer_submission_failed",
        submitter: "consumer_wallet",
        error: error.message
      }
    };
  }
}

async function requestWithLocalWallet(args) {
  const originalParams = args.params || {};
  let params = originalParams;
  let tokenResolution = null;
  try {
    tokenResolution = await resolveTokenForLocalWalletRequest({
      capability: args.capability,
      params,
      constraints: args.constraints || {},
      budget: args.budget || {},
      consumerContext: args.consumer_context || {}
    });
    if (tokenResolution?.ok && tokenResolution.intent) {
      params = tokenResolution.intent;
    } else if (tokenResolution && tokenResolution.ok === false) {
      return tokenResolution;
    }
  } catch (error) {
    if (error.code === "WALLET_INSUFFICIENT_ARC_USDC") {
      return fundingRequiredResponse({ error, selectedService: tokenResolution?.resolver_service || null, quote: null });
    }
    throw error;
  }

  const quote = await post("/agent-router/quote", {
    capability: args.capability,
    params,
    constraints: args.constraints || {},
    budget: args.budget || {},
    consumer_context: args.consumer_context || {}
  });
  if (!quote.ok) return quote;
  let invocation;
  try {
    invocation = await invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId: quote.selected_service.service_id,
      input: quote.input,
      budget: {
        max_amount: args.constraints?.max_price_usdc || args.budget?.max_amount || "0.05",
        currency: args.budget?.currency || "USDC"
      },
      request: {
        capability: args.capability,
        params,
        constraints: quote.request?.constraints || args.constraints || {},
        consumer_context: {
          ...(args.consumer_context || {}),
          source: "agentrouter_mcp_local_wallet",
          token_resolution: tokenResolution ? {
            status: tokenResolution.status,
            token_symbol: tokenResolution.token_symbol,
            token_address: tokenResolution.token_address,
            chain: tokenResolution.chain,
            matched_symbol: tokenResolution.matched_symbol || null,
            matched_name: tokenResolution.matched_name || null,
            resolution_type: tokenResolution.resolution_type || null,
            requires_disclosure: Boolean(tokenResolution.requires_disclosure),
            disclosure: tokenResolution.disclosure || null
          } : null
        }
      }
    });
  } catch (error) {
    if (error.code === "WALLET_INSUFFICIENT_ARC_USDC") {
      return fundingRequiredResponse({ error, selectedService: quote.selected_service, quote: quote.quote });
    }
    throw error;
  }
  return {
    ok: true,
    status: "paid_with_local_wallet",
    request: quote.request,
    selected_service: quote.selected_service,
    token_resolution: publicTokenResolution(tokenResolution),
    input: quote.input,
    quote: quote.quote,
    result: invocation.result,
    feedback: invocation.feedback,
    local_payment: invocation.local_payment,
    evidence_recording: invocation.evidence_recording,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    feedback_required: Boolean(invocation.evidence_recording?.consumer_feedback_request),
    next_required_action: invocation.evidence_recording?.consumer_feedback_request
      ? "After using this result in the final answer, call agentrouter_feedback with this request_id."
      : null
  };
}

async function resolveTokenForLocalWalletRequest({ capability, params, constraints, budget, consumerContext }) {
  if (capability !== "token_smart_money_activity") return null;
  if (params.token_address) return null;
  const tokenSymbol = params.token_symbol || params.asset;
  if (!tokenSymbol) {
    return {
      ok: false,
      status: "token_symbol_required",
      message: "token_smart_money_activity requires token_symbol or token_address."
    };
  }

  const maxPrice = constraints.max_price_usdc || budget.max_amount || "0.05";
  const verifiedServices = await post("/connector/search_services", {
    query: "token search",
    verified_only: true,
    max_price: maxPrice
  });
  if (!Array.isArray(verifiedServices)) {
    return {
      ok: false,
      status: "token_resolver_search_failed",
      token_symbol: tokenSymbol,
      search_response: verifiedServices
    };
  }

  let resolver = pickTokenResolver(verifiedServices);
  let resolverVerificationMode = "verified";
  if (!resolver) {
    const fallbackServices = await post("/connector/search_services", {
      query: "token search",
      verified_only: false,
      max_price: maxPrice
    });
    if (!Array.isArray(fallbackServices)) {
      return {
        ok: false,
        status: "token_resolver_search_failed",
        token_symbol: tokenSymbol,
        search_response: fallbackServices
      };
    }
    resolver = pickTokenResolver(fallbackServices);
    resolverVerificationMode = "trusted_pending";
  }
  if (!resolver) {
    return {
      ok: false,
      status: "token_resolver_not_found",
      token_symbol: tokenSymbol,
      message: "No token resolver service is registered."
    };
  }

  const chain = normalizeProviderChain(params.chain || "ethereum");
  const resolverInput = {
    search_query: tokenSymbol,
    result_type: "token",
    chain,
    limit: 5
  };
  const invocation = await invokePaidServiceWithLocalWallet({
    baseUrl,
    serviceId: resolver.service_id,
    input: resolverInput,
    budget: {
      max_amount: maxPrice,
      currency: budget.currency || "USDC"
    },
    request: {
      capability: "token_resolution",
      params: resolverInput,
      constraints: {
        max_price_usdc: maxPrice,
        currency: budget.currency || "USDC"
      },
      consumer_context: {
        ...consumerContext,
        source: "agentrouter_mcp_local_wallet",
        parent_capability: capability
      }
    }
  });
  const match = findTokenMatch(invocation.result?.data, { tokenSymbol, chain });
  if (!match?.address) {
    return {
      ok: false,
      status: "token_not_found",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_verification_mode: resolverVerificationMode,
      resolver_input: resolverInput,
      message: "Token resolver did not return a matching contract address."
    };
  }

  const resolution = describeTokenResolution({
    requestedSymbol: tokenSymbol,
    matchedSymbol: match.symbol,
    matchedName: match.name,
    chain: match.chain || chain
  });
  if (!resolution.auto_pay_allowed) {
    return {
      ok: false,
      status: "token_resolution_ambiguous",
      token_symbol: tokenSymbol,
      token_address: match.address,
      chain: match.chain || chain,
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
  }
  return {
    ok: true,
    status: "resolved",
    token_symbol: tokenSymbol,
    token_address: match.address,
    chain: match.chain || chain,
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
    resolver_evidence_recording: invocation.evidence_recording,
    resolver_service: resolver,
    intent: {
      ...params,
      token_symbol: tokenSymbol,
      token_address: match.address,
      chain: match.chain || chain
    }
  };
}

function pickTokenResolver(services) {
  return services
    .map((service) => ({ service, score: tokenResolverScore(service) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.service;
}

function fundingRequiredResponse({ error, selectedService, quote }) {
  return {
    ok: false,
    status: error.status || "wallet_needs_funding",
    action_required: "fund_local_agentrouter_wallet",
    final_answer_available: false,
    data_returned: false,
    do_not_use_cached_or_previous_results: true,
    stop_reason: "The selected paid provider requires Arc Testnet USDC before returning fresh data. AgentRouter did not receive the requested paid result.",
    message: error.message,
    selected_service: selectedService,
    quote,
    wallet: error.wallet,
    funding_instruction: {
      instruction_version: "agentrouter_funding_instruction_v1",
      network: "Arc Testnet",
      chain_id: error.wallet?.chain_id,
      token: error.wallet?.asset || "USDC",
      token_address: error.wallet?.token_address,
      wallet_address: error.wallet?.address,
      current_balance: error.wallet?.balance,
      required_amount: error.wallet?.required,
      minimum_top_up: error.wallet?.required,
      rpc_url: "https://rpc.testnet.arc.network",
      after_funding: "Retry the same agentrouter_request. Do not answer this data question from cached data."
    },
    user_message: `AgentRouter needs funding before it can fetch fresh paid data. Send at least ${error.wallet?.required || "0.01"} Arc Testnet USDC to ${error.wallet?.address} on Arc Testnet, then retry the same request.`,
    next_step: "Show the funding_instruction to the user and stop. Do not answer with old validation samples, cached provider results, web search, or unrelated data."
  };
}

function publicTokenResolution(tokenResolution) {
  if (!tokenResolution) return null;
  return {
    ok: tokenResolution.ok,
    status: tokenResolution.status,
    token_symbol: tokenResolution.token_symbol,
    token_address: tokenResolution.token_address,
    chain: tokenResolution.chain,
    matched_name: tokenResolution.matched_name || null,
    matched_symbol: tokenResolution.matched_symbol || null,
    asset_resolution: tokenResolution.asset_resolution || null,
    requested_symbol: tokenResolution.requested_symbol || tokenResolution.token_symbol || null,
    resolved_symbol: tokenResolution.resolved_symbol || tokenResolution.matched_symbol || null,
    resolution_type: tokenResolution.resolution_type || null,
    auto_pay_allowed: tokenResolution.asset_resolution?.auto_pay_allowed ?? null,
    blocking_reason: tokenResolution.asset_resolution?.blocking_reason || null,
    requires_disclosure: Boolean(tokenResolution.requires_disclosure),
    disclosure: tokenResolution.disclosure || null,
    resolver_verification_mode: tokenResolution.resolver_verification_mode || null,
    resolver_request_id: tokenResolution.resolver_evidence_recording?.request_id || null,
    resolver_input: tokenResolution.resolver_input || null
  };
}

function tokenResolverScore(service) {
  const text = [
    service.service_id,
    service.title,
    service.description_for_agent,
    ...(service.capabilities || [])
  ].join(" ").toLowerCase();
  let score = 0;
  if (/token[_\s-]?search|entity[_\s-]?search|token[_\s-]?resolver|resolve.*token/.test(text)) score += 8;
  if (/token[_\s-]?metadata|contract[_\s-]?address|token[_\s-]?address/.test(text)) score += 4;
  if ((service.capabilities || []).some((capability) => /token_search|entity_search|token_metadata/.test(capability))) score += 8;
  if ((service.capabilities || []).some((capability) => /news|article|rss|macro|etf/.test(capability))) score -= 8;
  if (/news|article|rss|search articles/.test(text)) score -= 8;
  return score;
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

function normalizeProviderChain(chain) {
  const normalized = String(chain || "").toLowerCase();
  if (normalized === "bsc") return "bnb";
  if (["hyperliquid", "hyper-evm", "hyper evm", "hype"].includes(normalized)) return "hyperevm";
  return normalized || "ethereum";
}

function sanitizeAgentToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const sanitized = sanitizeProviderFields(result);
  if (result.selected_service) {
    sanitized.service_match = {
      matched: true,
      trust_score: result.selected_service.trust_score,
      health_status: result.selected_service.health_status,
      source_provenance_level: result.selected_service.source_provenance_level,
      price: result.selected_service.pricing
        ? {
            amount: result.selected_service.pricing.amount,
            currency: result.selected_service.pricing.currency
          }
        : undefined
    };
  }
  sanitized.presentation_policy = {
    hide_provider_details: true,
    user_visible_rule: "Do not mention provider names, provider API brands, service IDs, internal service titles, or implementation route details unless the user explicitly asks for debugging details.",
    preferred_attribution: "via AgentRouter",
    response_flow: "Answer directly from this JSON result. Do not write temp files or run jq/Python just to inspect or reformat normal AgentRouter responses.",
    allow_extra_processing_only_when: [
      "The returned dataset is too large for direct inspection.",
      "The user explicitly asks for a file, chart, table export, or custom calculation.",
      "A numeric aggregation is required and cannot be read directly from the returned fields."
    ]
  };
  return sanitized;
}

function sanitizeProviderFields(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderFields(item));
  if (!value || typeof value !== "object") return value;
  const hiddenKeys = new Set([
    "selected_service",
    "service_id",
    "provider_id",
    "selected_service_id",
    "resolver_service_id",
    "data_sources"
  ]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKeys.has(key)) continue;
    output[key] = sanitizeProviderFields(item);
  }
  return output;
}

async function get(path) {
  return request(path, { method: "GET" });
}

async function post(path, body) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function request(path, options) {
  try {
    const started = Date.now();
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(httpTimeoutMs())
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      return {
        ok: false,
        status: "http_error",
        http_status: response.status,
        base_url: baseUrl,
        elapsed_ms: Date.now() - started,
        payload
      };
    }
    return payload;
  } catch (error) {
    return {
      ok: false,
      status: error.name === "TimeoutError" || error.name === "AbortError" ? "transport_timeout" : "transport_error",
      base_url: baseUrl,
      timeout_ms: httpTimeoutMs(),
      message: error.name === "TimeoutError" || error.name === "AbortError"
        ? `AgentRouter HTTP request timed out after ${httpTimeoutMs()}ms.`
        : error.message
    };
  }
}

function httpTimeoutMs() {
  return Number(process.env.AGENT_ROUTER_HTTP_TIMEOUT_MS || 15000);
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}

async function ensureAutoWallet() {
  if (process.env.AGENT_ROUTER_AUTO_WALLET === "0") {
    return {
      enabled: false,
      status: "disabled"
    };
  }
  const status = await walletStatus();
  if (status.initialized) {
    return {
      enabled: true,
      created: false,
      status: "wallet_ready",
      address: status.address,
      address_type: status.address_type,
      network_hint: status.network_hint,
      key_management: status.key_management
    };
  }
  const wallet = await initSessionWallet();
  return {
    enabled: true,
    created: true,
    status: "wallet_ready",
    address: wallet.address,
    address_type: wallet.address_type,
    network_hint: wallet.network_hint,
    key_management: wallet.key_management
  };
}

async function startWalletSetupSession({ force = false } = {}) {
  if (walletSetupSession && Date.now() < walletSetupSession.expiresAtMs) {
    return walletSetupSession.publicPayload;
  }
  if (walletSetupSession) closeWalletSetupSession();

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const server = http.createServer(async (request, response) => {
    try {
      await handleWalletSetupRequest({ request, response, token, force, expiresAtMs });
    } catch (error) {
      sendSetupHtml(response, 500, renderSetupPage({
        title: "Setup failed",
        message: error.message,
        token,
        force,
        isError: true
      }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const setupUrl = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
  const publicPayload = {
    ok: true,
    status: "wallet_setup_pending",
    setup_url: setupUrl,
    expires_at: new Date(expiresAtMs).toISOString(),
    instructions: "Open this local URL in a browser and enter a wallet encryption passphrase there. Do not paste the passphrase into Claude or any chat."
  };
  walletSetupSession = { server, token, expiresAtMs, publicPayload };
  server.on("close", () => {
    if (walletSetupSession?.token === token) walletSetupSession = null;
  });
  return publicPayload;
}

async function handleWalletSetupRequest({ request, response, token, force, expiresAtMs }) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.searchParams.get("token") !== token || Date.now() > expiresAtMs) {
    sendSetupHtml(response, 403, renderSetupPage({
      title: "Setup link expired",
      message: "Ask Claude to start wallet setup again.",
      token,
      force,
      isError: true
    }));
    return;
  }

  if (request.method === "GET") {
    sendSetupHtml(response, 200, renderSetupPage({ token, force }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/setup") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const body = await readSetupBody(request);
  const form = new URLSearchParams(body);
  const passphrase = form.get("passphrase") || "";
  const confirm = form.get("confirm") || "";
  if (passphrase.length < 8) {
    sendSetupHtml(response, 400, renderSetupPage({
      title: "Use a longer passphrase",
      message: "The wallet encryption passphrase must be at least 8 characters.",
      token,
      force,
      isError: true
    }));
    return;
  }
  if (passphrase !== confirm) {
    sendSetupHtml(response, 400, renderSetupPage({
      title: "Passphrases do not match",
      message: "Please re-enter the same passphrase in both fields.",
      token,
      force,
      isError: true
    }));
    return;
  }

  const wallet = await createOrUnlockWalletWithPassphrase({ passphrase, force });
  sendSetupHtml(response, 200, renderSuccessPage(wallet));
  setTimeout(closeWalletSetupSession, 500);
}

async function createOrUnlockWalletWithPassphrase({ passphrase, force }) {
  const previous = process.env.ADN_WALLET_PASSPHRASE;
  process.env.ADN_WALLET_PASSPHRASE = passphrase;
  try {
    const status = await walletStatus();
    if (status.initialized && !force) {
      const wallet = await readWallet();
      return {
        ok: true,
        status: "wallet_unlocked",
        wallet: publicWalletFromUnlocked(wallet)
      };
    }
    const wallet = await initWallet({ force });
    return {
      ok: true,
      status: status.initialized ? "wallet_replaced" : "wallet_created",
      wallet
    };
  } catch (error) {
    if (previous === undefined) delete process.env.ADN_WALLET_PASSPHRASE;
    else process.env.ADN_WALLET_PASSPHRASE = previous;
    throw error;
  }
}

function publicWalletFromUnlocked(wallet) {
  return {
    wallet_version: wallet.wallet_version,
    address_type: wallet.address_type,
    network_hint: wallet.network_hint,
    address: wallet.address,
    public_key_hex: wallet.public_key_hex,
    public_key_pem: wallet.public_key_pem,
    created_at: wallet.created_at
  };
}

function closeWalletSetupSession() {
  if (!walletSetupSession) return;
  const session = walletSetupSession;
  walletSetupSession = null;
  session.server.close();
}

function readSetupBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error("Setup form is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendSetupHtml(response, status, html) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function renderSetupPage({ title = "Create AgentRouter wallet", message = "", token, force, isError = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f3; color: #17231d; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(520px, 100%); background: #fff; border: 1px solid #d9dfd7; border-radius: 12px; padding: 28px; box-shadow: 0 18px 45px rgba(23, 35, 29, 0.08); }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; }
    p { color: #5f6b62; line-height: 1.5; }
    .notice { border-left: 4px solid ${isError ? "#c0392b" : "#89b8b2"}; background: ${isError ? "#fff1ee" : "#edf6f4"}; padding: 12px 14px; border-radius: 8px; margin: 18px 0; color: #24352c; }
    label { display: block; font-weight: 700; margin-top: 18px; }
    input { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 13px 14px; border: 1px solid #cbd4ca; border-radius: 8px; font: inherit; }
    button { margin-top: 22px; width: 100%; border: 0; border-radius: 8px; padding: 14px 18px; font: inherit; font-weight: 800; color: #fff; background: #17231d; cursor: pointer; }
    small { display: block; margin-top: 14px; color: #68736b; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>This creates or unlocks a local encrypted EVM wallet for future x402 payments. The passphrase is submitted only to the local AgentRouter MCP process on this machine.</p>
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/setup?token=${encodeURIComponent(token)}">
      <label for="passphrase">Encryption passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="new-password" minlength="8" required autofocus>
      <label for="confirm">Confirm passphrase</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
      <button type="submit">${force ? "Replace wallet" : "Create or unlock wallet"}</button>
      <small>Do not use this page for a wallet that already holds meaningful funds. This MVP wallet is intended for small x402 budgets.</small>
    </form>
  </main>
</body>
</html>`;
}

function renderSuccessPage(result) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wallet ready</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f3; color: #17231d; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(560px, 100%); background: #fff; border: 1px solid #d9dfd7; border-radius: 12px; padding: 28px; box-shadow: 0 18px 45px rgba(23, 35, 29, 0.08); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #5f6b62; line-height: 1.5; }
    code { display: block; overflow-wrap: anywhere; background: #102019; color: #eff8f2; padding: 14px; border-radius: 8px; margin-top: 16px; }
  </style>
</head>
<body>
  <main>
    <h1>Wallet ready</h1>
    <p>AgentRouter can now use this local encrypted EVM wallet in the current MCP session. You can close this tab and return to Claude.</p>
    <code>${escapeHtml(result.wallet.address)}</code>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
