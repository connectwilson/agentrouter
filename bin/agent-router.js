#!/usr/bin/env node
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAgentRouterRemote } from "../src/agent-router.js";
import { compactAgentFacingResult } from "../src/compact-result.js";

const [command = "ask", ...args] = process.argv.slice(2);
const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter.network").replace(/\/$/, "");
const creditApiKey = String(process.env.AGENT_ROUTER_API_KEY || "").trim();
const defaultAdnDir = path.join(os.homedir(), ".agentrouter", "adn");
if (!process.env.ADN_DIR) process.env.ADN_DIR = defaultAdnDir;
const { args: commandArgs, localWalletRequested, quoteOnlyRequested } = parseRuntimeFlags(args);

try {
  if (command === "fetch") {
    const payload = parseFetchPayload(commandArgs);
    if (creditApiKey) {
      print(await post("/agent-router/fetch", payload));
    } else if (!quoteOnlyRequested) {
      const readiness = localPaymentReadiness();
      if (!readiness.ready && !localWalletRequested) {
        print(localPaymentNotReadyResponse(readiness));
      } else {
        print(sanitizeAgentCliResult(await fetchWithLocalWalletCli(payload)));
      }
    } else {
      print(await post("/agent-router/fetch", payload));
    }
  } else if (command === "ask" || command === "find") {
    const task = commandArgs.join(" ");
    if (creditApiKey) {
      print(await post("/agent-router/ask", {
        task,
        max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
        currency: "USDC"
      }));
    } else if (!quoteOnlyRequested) {
      const readiness = localPaymentReadiness();
      if (!readiness.ready && !localWalletRequested) {
        print(localPaymentNotReadyResponse(readiness));
      } else {
        const { routeTaskWithLocalWallet } = await import("../src/local-route.js");
        print(compactAgentFacingResult(await routeTaskWithLocalWallet({
          baseUrl,
          task,
          constraints: {
            max_price_usdc: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
          },
          budget: {
            max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
            currency: "USDC"
          }
        })));
      }
    } else {
      print(await askAgentRouterRemote({
        baseUrl,
        task,
        max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
      }));
    }
  } else if (command === "quote-only" || command === "ask-quote") {
    print(await askAgentRouterRemote({
      baseUrl,
      task: commandArgs.join(" "),
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "diagnose" || command === "doctor") {
    print(localDiagnostics());
  } else if (command === "pay-ask") {
      const { routeTaskWithLocalWallet } = await import("../src/local-route.js");
      print(await routeTaskWithLocalWallet({
        baseUrl,
        task: commandArgs.join(" "),
        constraints: {
          max_price_usdc: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
        },
        budget: {
          max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
          currency: "USDC"
        }
      }));
  } else if (command === "capabilities") {
    print(await get("/capabilities"));
  } else if (command === "request") {
    const request = JSON.parse(requireArg(commandArgs[0], "request_json"));
    if (localWalletRequested && !quoteOnlyRequested) {
      const { routeCapabilityRequestWithLocalWallet } = await import("../src/local-route.js");
      print(await routeCapabilityRequestWithLocalWallet({
        baseUrl,
        request,
        budget: {
          max_amount: request.constraints?.max_price_usdc || request.budget?.max_amount || process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
          currency: request.budget?.currency || "USDC"
        }
      }));
    } else {
      print(await post("/agent-router/request", request));
    }
  } else if (command === "quote") {
    print(await post("/agent-router/quote", JSON.parse(requireArg(commandArgs[0], "request_json"))));
  } else if (command === "search") {
    print(await post("/connector/search_services", {
      query: commandArgs.join(" "),
      verified_only: true,
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "preview") {
    print(await post("/connector/preview_service", { service_id: requireArg(commandArgs[0], "service_id") }));
  } else if (command === "invoke") {
    print(await post("/connector/invoke_paid_service", {
      service_id: requireArg(commandArgs[0], "service_id"),
      input: commandArgs[1] ? JSON.parse(commandArgs[1]) : {},
      budget: {
        max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
        currency: "USDC"
      }
    }));
  } else {
    print({
      usage: [
        'agent-router fetch "查询 LAB 近 24 小时聪明钱动向"',
        'agent-router fetch \'{"task":"Analyze AZTEC smart-money activity","data_requirements":[{"capability":"token_smart_money_activity","params":{"token_symbol":"AZTEC","chain":"ethereum","window":"24h"}}],"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router ask "查询标记为 Matrixport 的地址"',
        'agent-router ask --local-wallet "BTC 当前最大爆仓痛点是多少"',
        'agent-router ask --quote-only "BTC 当前最大爆仓痛点是多少"',
        "agent-router doctor",
        "agent-router capabilities",
        'agent-router request \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router quote \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router search "Lookonchain address"',
        "agent-router preview listlookonchainaddresses",
        'agent-router invoke listlookonchainaddresses \'{"tag":"Matrixport","limit":1}\''
      ],
      base_url: baseUrl,
      local_payment: localDiagnostics()
    });
  }
} catch (error) {
  console.error(JSON.stringify(formatCliError(error), null, 2));
  process.exitCode = 1;
}

function formatCliError(error) {
  const root = rootCause(error);
  if (error.status === "arc_payment_unavailable") {
    return {
      ok: false,
      status: "arc_payment_unavailable",
      code: error.code || "ARC_RPC_UNAVAILABLE",
      error: error.message,
      arc_rpc: error.arc_rpc || null,
      retryable: Boolean(error.retryable),
      payload: error.payload || null,
      hint: "AgentRouter could not complete the local Arc payment step. Check ADN_ARC_RPC_URL, DNS/VPN/proxy, then retry. Do not answer from cached data."
    };
  }
  if (root?.code === "ENOTFOUND") {
    return {
      ok: false,
      status: "transport_dns_failed",
      code: "DNS_ENOTFOUND",
      error: error.message,
      transport: {
        hostname: root.hostname || null,
        error_code: root.code,
        details: root.message
      },
      payload: error.payload || null,
      hint: "The local Node.js process cannot resolve this host. Check DNS/VPN/proxy or set AGENT_ROUTER_URL/ADN_ARC_RPC_URL to a reachable endpoint."
    };
  }
  if (root?.name === "AbortError" || error.name === "AbortError" || /timeout/i.test(String(error.message || ""))) {
    return {
      ok: false,
      status: "transport_timeout",
      error: error.message,
      payload: error.payload || null,
      hint: "The network request timed out. Retry after confirming the AgentRouter URL and Arc RPC are reachable."
    };
  }
  return {
    ok: false,
    status: error.status || "transport_error",
    code: error.code || null,
    error: error.message,
    payload: error.payload || null
  };
}

function rootCause(error) {
  let current = error;
  const seen = new Set();
  while (current?.cause && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  return current || error;
}

function parseRuntimeFlags(values) {
  const parsed = {
    args: [],
    localWalletRequested: false,
    quoteOnlyRequested: false
  };
  for (const value of values) {
    if (value === "--local-wallet" || value === "--pay") {
      parsed.localWalletRequested = true;
    } else if (value === "--quote-only" || value === "--dry-run") {
      parsed.quoteOnlyRequested = true;
    } else {
      parsed.args.push(value);
    }
  }
  return parsed;
}

function parseFetchPayload(values) {
  const raw = values.join(" ").trim();
  if (!raw) return { task: "" };
  if (values.length === 1) {
    try {
      const parsed = JSON.parse(values[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return { task: raw };
}

async function fetchWithLocalWalletCli(payload = {}) {
  const requirements = Array.isArray(payload.data_requirements) ? payload.data_requirements : [];
  const maxPrice = payload.max_price || payload.constraints?.max_price_usdc || payload.budget?.max_amount || process.env.AGENT_ROUTER_MAX_PRICE || "0.05";
  const currency = payload.currency || payload.budget?.currency || "USDC";

  if (!requirements.length) {
    const { routeTaskWithLocalWallet } = await import("../src/local-route.js");
    const routed = await routeTaskWithLocalWallet({
      baseUrl,
      task: payload.task || payload.query || "",
      constraints: {
        ...(payload.constraints || {}),
        max_price_usdc: maxPrice
      },
      budget: {
        ...(payload.budget || {}),
        max_amount: maxPrice,
        currency
      }
    });
    return {
      ...routed,
      protocol: {
        ...(routed.protocol || {}),
        protocol_version: routed.protocol?.protocol_version || "agentrouter_fetch_v1",
        external_contract: "single_agent_data_call",
        internal_steps: routed.protocol?.internal_steps || "discovery_routing_quote_payment_invocation_verification_evidence_feedback"
      },
      data_returned: routed.data_returned ?? (routed.result?.status === "success"),
      feedback_required: routed.feedback_required ?? Boolean(routed.consumer_feedback_request),
      next_required_action: routed.next_required_action || (routed.consumer_feedback_request
        ? "After using this result in the final answer, submit AgentRouter feedback for the returned request_id."
        : null)
    };
  }

  const { routeCapabilityRequestWithLocalWallet } = await import("../src/local-route.js");
  const results = [];
  for (const requirement of requirements) {
    const request = requirementToCapabilityRequest(requirement, payload, { maxPrice, currency });
    if (!request.capability) {
      results.push({
        ok: false,
        status: "invalid_requirement",
        requirement,
        message: "Each data requirement needs capability or type."
      });
      continue;
    }
    results.push(await routeCapabilityRequestWithLocalWallet({
      baseUrl,
      request,
      budget: request.budget
    }));
  }

  const successful = results.filter((result) => result?.ok !== false && result?.result);
  const failed = results.filter((result) => result?.ok === false);
  return {
    ok: failed.length === 0,
    status: failed.length ? (successful.length ? "partial_data_returned" : "no_data_returned") : "data_returned",
    protocol: {
      protocol_version: "agentrouter_fetch_v1",
      external_contract: "single_agent_data_call",
      internal_steps: "discovery_routing_quote_payment_invocation_verification_evidence_feedback"
    },
    task: payload.task || payload.query || null,
    data_requirements_count: requirements.length,
    data_returned_count: successful.length,
    results,
    compact_results: results.map((result) => result?.compact_result || null).filter(Boolean),
    feedback_required: results.some((result) => result?.feedback_required || result?.consumer_feedback_request),
    next_required_action: results.some((result) => result?.feedback_required || result?.consumer_feedback_request)
      ? "After using these results in the final answer, submit AgentRouter feedback for each returned request_id."
      : null
  };
}

function requirementToCapabilityRequest(requirement = {}, payload = {}, { maxPrice, currency }) {
  const { capability, type, params, constraints, budget, consumer_context: consumerContext, ...inlineParams } = requirement;
  const cleanInlineParams = {};
  for (const [key, value] of Object.entries(inlineParams)) {
    if (value !== undefined && value !== null) cleanInlineParams[key] = value;
  }
  return {
    capability: capability || type,
    params: params && typeof params === "object" ? params : cleanInlineParams,
    constraints: {
      ...(payload.constraints || {}),
      ...(constraints || {}),
      max_price_usdc: constraints?.max_price_usdc || payload.constraints?.max_price_usdc || maxPrice
    },
    budget: {
      ...(payload.budget || {}),
      ...(budget || {}),
      max_amount: budget?.max_amount || payload.budget?.max_amount || maxPrice,
      currency: budget?.currency || payload.budget?.currency || currency
    },
    consumer_context: {
      ...(payload.consumer_context || {}),
      ...(consumerContext || {}),
      source: consumerContext?.source || payload.consumer_context?.source || "agentrouter_cli_fetch"
    }
  };
}

function localPaymentReadiness() {
  const walletPath = path.join(process.env.ADN_DIR || defaultAdnDir, "wallet.json");
  const walletFound = fsSync.existsSync(walletPath);
  return {
    ready: walletFound,
    wallet_path: walletPath,
    wallet_found: walletFound,
    payment_backend: process.env.ADN_PAYMENT_BACKEND || "circle_arc",
    agent_router_url: baseUrl
  };
}

function localDiagnostics() {
  const readiness = localPaymentReadiness();
  return {
    ok: readiness.ready,
    status: readiness.ready ? "local_payment_ready" : "local_payment_not_ready",
    local_payment: readiness,
    mcp_hint: {
      server_command: "npx",
      server_args: ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]
    },
    repair_command: "curl -fsSL https://agentrouter.network/update.sh | bash",
    credit_setup_url: `${baseUrl}/account`
  };
}

function localPaymentNotReadyResponse(readiness) {
  return {
    ok: false,
    status: "local_payment_not_ready",
    final_answer_available: false,
    data_returned: false,
    stop_reason: "AgentRouter paid data calls require the local payment wallet/MCP bridge. The CLI did not fall back to quote-only mode.",
    local_payment: readiness,
    repair_command: "curl -fsSL https://agentrouter.network/update.sh | bash",
    credit_setup_url: `${baseUrl}/account`,
    quote_only_command: 'agent-router fetch --quote-only "<task>"',
    next_step: "Run the repair command once, restart or reload the AI client, then retry the same data question."
  };
}

function sanitizeAgentCliResult(result) {
  if (!result || typeof result !== "object") return result;
  const sanitized = sanitizeProviderFields(compactAgentFacingResult(result));
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
    "data_sources",
    "evidence",
    "evidence_recording",
    "local_payment",
    "routing_event",
    "observation",
    "candidates"
  ]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKeys.has(key)) continue;
    output[key] = sanitizeProviderFields(item);
  }
  return output;
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: creditApiKey ? { "x-agentrouter-api-key": creditApiKey } : {},
    signal: AbortSignal.timeout(httpTimeoutMs())
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

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(creditApiKey ? { "x-agentrouter-api-key": creditApiKey } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs())
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`HTTP ${response.status} returned non-JSON response`);
    error.payload = { raw: text.slice(0, 500) };
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpTimeoutMs() {
  return Number(process.env.AGENT_ROUTER_HTTP_TIMEOUT_MS || 15000);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
