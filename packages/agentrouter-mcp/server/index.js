#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  localBrowserCompletionRequest,
  localBrowserHandoffRequest,
  localSocialPostRequest,
  runLocalSocialPostRead
} from "./local-social-post.js";
import {
  localBrowserSearchHandoffRequest,
  localSocialSearchRequest,
  runLocalSocialSearch
} from "./local-social-search.js";
import { readStoredCredential, writeStoredCredential } from "./credential-store.js";
import { submitSponsoredFeedback } from "./bsc-feedback.js";
import { readOrCreateFeedbackSigner } from "./feedback-wallet.js";
import { decorateBrowserAuthorization, resolveMcpClientAction } from "./action-state.js";
import {
  agentRouterCompleteHandoffTool,
  agentRouterConnectTool,
  bridgeMcpTools
} from "./tool-catalog.js";
import { completeLocalBrowserHandoff } from "./local-browser-connector.js";
import { createExpiringTokenCache } from "./feedback-token-cache.js";
import { launchBrowserAuthorization } from "./browser-launcher.js";
import {
  decorateStandaloneLocalResult,
  handleLocalStructuredSocialBatchRequest,
  localFeedbackRoutingSummary
} from "./local-routing.js";

export {
  decorateStandaloneLocalResult,
  handleLocalStructuredSocialBatchRequest
} from "./local-routing.js";

const baseUrl = String(process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\/$/, "");
const remoteOrigins = parseRemoteOrigins(baseUrl, process.env.AGENT_ROUTER_FALLBACK_URLS);
const configuredCreditApiKey = String(process.env.AGENT_ROUTER_API_KEY || "").trim();
const remoteAttempts = boundedInteger(process.env.AGENT_ROUTER_REMOTE_ATTEMPTS, 3, 1, 5);
const remoteRetryMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_RETRY_MS, 250, 10, 5_000);
const remoteTimeoutMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_TIMEOUT_MS, 15_000, 250, 60_000);
const remoteDiscoveryTimeoutMs = boundedInteger(process.env.AGENT_ROUTER_DISCOVERY_TIMEOUT_MS, 1_500, 250, 5_000);
const remoteCooldownMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_COOLDOWN_MS, 30_000, 100, 300_000);
const transientHttpStatuses = new Set([408, 425, 429, 502, 503, 504]);
const remoteSessionIds = new Map();
const remoteCircuitOpenUntil = new Map();
const localFeedbackTokens = createExpiringTokenCache();
let preferredRemoteOrigin = baseUrl;
let preferredRemoteOriginUntil = 0;
let deviceAuthorization = null;
let buffer = Buffer.alloc(0);
let processing = Promise.resolve();

// Wire stdio only when the bin calls start(); importing the module (e.g. tests)
// must not hijack stdin or exit the process.
export function start() {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processing = processing.then(processBufferedMessages).catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
    });
  });

  process.stdin.on("end", () => {
    processing.finally(() => process.exit(0));
  });
}

async function processBufferedMessages() {
  for (const message of readMessages()) {
    if (message?.method?.startsWith("notifications/")) {
      if (message.method !== "notifications/initialized") await forwardNotification(message);
      continue;
    }
    if (!Object.hasOwn(message || {}, "id")) continue;
    await forwardRequest(message);
  }
}

// MCP stdio replies MUST be newline-delimited JSON (see send/encodeMessage) —
// Content-Length framing never completes the client handshake. Input is read
// liberally: newline-delimited (real MCP clients) with a Content-Length
// fallback for LSP-style callers.
function readMessages() {
  const messages = [];
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    const lineEnd = buffer.indexOf("\n");
    if (headerEnd === -1 || (lineEnd !== -1 && lineEnd < headerEnd)) {
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
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
    buffer = buffer.subarray(bodyEnd);
  }
  return messages;
}

async function forwardRequest(message) {
  try {
    const localControlResult = handleLocalControlPlane(message);
    if (localControlResult) {
      send({ jsonrpc: "2.0", id: message.id, result: localControlResult });
      return;
    }
    if (message?.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: await discoverTools(message) });
      return;
    }
    if (isConnectRequest(message)) {
      send({ jsonrpc: "2.0", id: message.id, result: await handleConnectRequest(message) });
      return;
    }
    const browserCompletion = localBrowserCompletionRequest(message);
    if (browserCompletion) {
      let result = decorateStandaloneLocalResult(completeLocalBrowserHandoff(browserCompletion));
      await attachLocalFeedbackGrant(result);
      result = await autoSubmitStandaloneFeedback(message, result);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false
        }
      });
      return;
    }
    const localStructuredSocial = await handleLocalStructuredSocialBatchRequest(message);
    if (localStructuredSocial) {
      await attachLocalFeedbackGrant(localStructuredSocial);
      const result = await autoSubmitStandaloneFeedback(message, localStructuredSocial);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false
        }
      });
      return;
    }
    // Keyword search only works where a browser is: the hosted server has none.
    const localSearch = localSocialSearchRequest(message);
    if (localSearch) {
      const nativeHandoff = localBrowserSearchHandoffRequest(message, localSearch);
      if (nativeHandoff) {
        const result = decorateStandaloneLocalResult(nativeHandoff);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false
          }
        });
        return;
      }
      let result = decorateStandaloneLocalResult(await runLocalSocialSearch(localSearch));
      await attachLocalFeedbackGrant(result);
      result = await autoSubmitStandaloneFeedback(message, result);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.status === "invalid_request"
        }
      });
      return;
    }
    const localSocialPost = localSocialPostRequest(message);
    if (localSocialPost) {
      const nativeHandoff = localBrowserHandoffRequest(message, localSocialPost);
      if (nativeHandoff) {
        const result = decorateStandaloneLocalResult(nativeHandoff);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false
          }
        });
        return;
      }
      let result = decorateStandaloneLocalResult(await runLocalSocialPostRead(localSocialPost.canonical_url));
      await attachLocalFeedbackGrant(result);
      result = await autoSubmitStandaloneFeedback(message, result);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.status === "invalid_request"
        }
      });
      return;
    }
    await resumePendingDeviceAuthorization();
    const attachedFeedbackRequestId = attachLocalFeedbackToken(message);
    const response = await postRemote(message);
    const text = await response.text();
    if (!response.ok) {
      if (isToolCall(message) && transientHttpStatuses.has(response.status)) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: remoteUnavailableToolResult(response.agentRouterRemoteDiagnostic || {
            category: "upstream_http",
            httpStatus: response.status,
            attempts: response.agentRouterRemoteAttempts || 1,
            retry_after_seconds: circuitRetryAfterSeconds()
          })
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `AgentRouter remote MCP returned HTTP ${response.status}`,
          data: safeJson(text)
        }
      });
      return;
    }

    const payload = safeJson(text);
    if (!payload || typeof payload !== "object") {
      throw new Error("AgentRouter remote MCP returned an invalid JSON response");
    }
    const clientAction = resolveMcpClientAction(payload);
    if (clientAction.state === "authorize_account") {
      const authorization = await handleConnectRequest({
        method: "tools/call",
        params: {
          name: "agentrouter_connect",
          arguments: { client_name: "current AI client", wait_seconds: 0 }
        }
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: decorateBrowserAuthorization(authorization, message)
      });
      return;
    }
    if (clientAction.state === "authorize_source") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: await openSourceAccessPage(clientAction, message)
      });
      return;
    }
    await autoSubmitConsumerFeedback(message, payload);
    await completeSponsoredFeedback(message, payload);
    if (attachedFeedbackRequestId && !payload.error && payload.result?.isError !== true) {
      localFeedbackTokens.delete(attachedFeedbackRequestId);
    }
    send(payload);
  } catch (error) {
    if (isToolCall(message) && error?.agentRouterRemoteDiagnostic) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: remoteUnavailableToolResult(error.agentRouterRemoteDiagnostic)
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32001,
        message: `AgentRouter remote MCP unavailable: ${error.message}`
      }
    });
  }
}

async function autoSubmitStandaloneFeedback(message, result) {
  const payload = {
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: result?.ok === false
    }
  };
  await autoSubmitConsumerFeedback(message, payload);
  return safeJson(payload.result.content[0].text) || result;
}

async function autoSubmitConsumerFeedback(message, payload) {
  const toolName = message?.params?.name;
  if (message?.method !== "tools/call" || !automaticFeedbackSourceTools.has(toolName)) return;
  const block = payload?.result?.content?.find((item) => item?.type === "text" && item.text);
  if (!block) return;
  const value = safeJson(block.text);
  if (!value || typeof value !== "object") return;
  const targets = feedbackTargets(value);
  if (!targets.length) return;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const request = target.consumer_feedback_request;
    if (!request || request.must_submit === false || target.automatic_feedback?.ok === true) continue;
    const feedbackArguments = automaticFeedbackArguments(target, request);
    if (!feedbackArguments) {
      // The invocation is already recorded by the server. Unknown semantic
      // fit must not create a rating (or an irreversible on-chain reputation).
      target.automatic_feedback = {
        status: "assessment_unavailable", rating_recorded: false,
        reason: "Invocation recorded; task relevance has not been verified, so no consumer rating was inferred."
      };
      target.consumer_feedback_request = completedFeedbackRequest(request, "assessment_unavailable");
      continue;
    }
    const feedbackMessage = {
      jsonrpc: "2.0",
      id: `${message.id}:automatic-feedback:${index + 1}`,
      method: "tools/call",
      params: {
        name: "agentrouter_feedback",
        arguments: feedbackArguments
      }
    };
    try {
      const response = await postRemote(feedbackMessage);
      const feedbackPayload = safeJson(await response.text());
      if (!response.ok || feedbackPayload?.error || feedbackPayload?.result?.isError === true) {
        throw new Error(feedbackPayload?.error?.message || `HTTP ${response.status}`);
      }
      await completeSponsoredFeedback(feedbackMessage, feedbackPayload);
      const feedbackBlock = feedbackPayload?.result?.content?.find((item) => item?.type === "text" && item.text);
      const recorded = safeJson(feedbackBlock?.text || "");
      if (!recorded || recorded.ok === false) throw new Error(recorded?.error?.message || recorded?.status || "feedback_not_recorded");
      target.automatic_feedback = recorded;
      target.consumer_feedback_request = completedFeedbackRequest(request, "auto_submitted");
    } catch (error) {
      target.automatic_feedback = {
        ok: false,
        status: "auto_feedback_deferred",
        recorded_offchain: false,
        retryable: true,
        error: String(error?.message || error).slice(0, 240)
      };
      target.consumer_feedback_request = completedFeedbackRequest(request, "auto_deferred");
    }
  }

  const settled = targets.every((target) => target.consumer_feedback_request?.must_submit === false);
  if (settled) {
    if (Object.hasOwn(value, "feedback_required")) value.feedback_required = false;
    if (typeof value.next_required_action === "string" && /agentrouter_feedback/i.test(value.next_required_action)) {
      value.next_required_action = null;
    }
  }
  block.text = JSON.stringify(value, null, 2);
}

const automaticFeedbackSourceTools = new Set([
  "agentrouter_fetch",
  "agentrouter_request",
  "agentrouter_ask",
  "agentrouter_complete_handoff"
]);

function feedbackTargets(value) {
  const targets = [];
  const seen = new Set();
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    const requestId = candidate.consumer_feedback_request?.request_id || candidate.request_id;
    if (candidate.consumer_feedback_request && requestId && !seen.has(requestId)) {
      seen.add(requestId);
      targets.push(candidate);
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (["consumer_feedback_request", "automatic_feedback"].includes(key)) continue;
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(value);
  return targets;
}

function automaticFeedbackArguments(target, request) {
  const usable = automaticResultUsable(target);
  const verification = target.verification || {};
  const mismatch = verification.intent_fit_valid === false || verification.schema_valid === false;
  const partial = verification.coverage_valid === false;
  const confirmed = verification.intent_fit_valid === true && verification.coverage_valid === true;
  if (usable && !mismatch && !partial && !confirmed) return null;
  const qualityScore = typeof verification.overall_quality_score === "number"
    ? verification.overall_quality_score : NaN;
  return {
    request_id: request.request_id || target.request_id,
    service_id: request.service_id || target.service_id,
    ...(request.feedback_token ? { feedback_token: request.feedback_token } : {}),
    feedback: {
      intent_fit: mismatch || !usable ? "no" : partial ? "partial" : "yes",
      answer_useful: mismatch || !usable ? "no" : partial ? "unknown" : "yes",
      ...(Number.isFinite(qualityScore) ? { data_quality_score: qualityScore } : {}),
      used_in_final_answer: null,
      confidence: Number.isFinite(qualityScore) ? 0.85 : 0.7,
      reason: mismatch ? "Verification rejected the result schema or task relevance."
        : partial ? "Verification found incomplete coverage of the requested task."
        : usable ? "Verification confirmed task relevance and coverage."
        : "Automatic post-call assessment found no usable data for the routed request."
    }
  };
}

function automaticResultUsable(target) {
  if (target?.ok === false || ["no_results", "no_data_returned", "invoke_failed", "route_failed"].includes(target?.status)) return false;
  const result = target?.result;
  if (result === undefined || result === null) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result !== "object") return true;
  if (Array.isArray(result.items)) return result.items.length > 0;
  if (Number.isFinite(Number(result.count))) return Number(result.count) > 0;
  if (Number.isFinite(Number(result.item_count))) return Number(result.item_count) > 0;
  if (Object.hasOwn(result, "data")) return Array.isArray(result.data) ? result.data.length > 0 : result.data != null;
  return Object.keys(result).length > 0;
}

function completedFeedbackRequest(request, status) {
  const completed = {
    ...request,
    must_submit: false,
    timing: "submitted_with_original_call",
    status
  };
  delete completed.tool;
  delete completed.instructions;
  delete completed.example;
  delete completed.submit_to;
  return completed;
}

async function openSourceAccessPage(clientAction, originalRequest) {
  const value = clientAction.value || {};
  const source = value.action_required?.tool_arguments?.source
    || value.connection_action?.tool_arguments?.source
    || value.source?.source
    || value.source;
  if (!source || typeof source !== "string") return toolResult(value);

  const response = await postRemote({
    jsonrpc: "2.0",
    id: originalRequest?.id,
    method: "tools/call",
    params: { name: "agentrouter_connect_source", arguments: { source } }
  });
  const rpc = safeJson(await response.text());
  const result = rpc?.result;
  const block = result?.content?.find((item) => item?.type === "text" && item.text);
  const access = safeJson(block?.text || "");
  if (!response.ok || !access) return result || toolResult(value);

  const target = access.verification_uri_complete || access.verification_uri;
  const browserOpen = target
    ? await launchBrowserAuthorization(target, {
      allowedOrigins: remoteOrigins,
      disabled: process.env.AGENTROUTER_DISABLE_BROWSER_OPEN === "1"
    })
    : { attempted: false, opened: false, status: "missing_url" };
  block.text = JSON.stringify({
    ...access,
    browser_open: browserOpen,
    retry_original_request: true,
    original_tool: originalRequest?.params?.name || null,
    do_not_fallback_outside_agentrouter: true
  }, null, 2);
  return result;
}

export async function attachLocalFeedbackGrant(result, {
  registerGrant = (body) => postAuthenticatedJson("/agent-router/feedback/grant", body),
  tokenCache = localFeedbackTokens
} = {}) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.results)) {
    for (const item of result.results) {
      await attachLocalFeedbackGrant(item, { registerGrant, tokenCache });
    }
    return result;
  }
  if (!result?.request_id || !result?.service_id || !result?.consumer_feedback_request) return result;
  const params = result.request?.params || {};
  try {
    const response = await registerGrant({
      request_id: result.request_id,
      service_id: result.service_id,
      operation: params.operation || (result.request_id.includes("_post_") ? "post" : "search"),
      capability: result.request?.capability || "social_search",
      result_status: result.status,
      routing_summary: localFeedbackRoutingSummary(result)
    });
    if (!response.ok || !response.payload?.feedback_token) {
      result.consumer_feedback_request.registration = {
        status: "registration_failed",
        error: response.payload?.error?.message || response.payload?.error || `HTTP ${response.status}`
      };
      return result;
    }
    const token = response.payload.feedback_token;
    tokenCache.set(result.request_id, token);
    result.consumer_feedback_request.feedback_token_required = true;
    result.consumer_feedback_request.registration = { status: "registered", service_id: result.service_id };
    return result;
  } catch (error) {
    result.consumer_feedback_request.registration = { status: "registration_failed", error: error.message };
    return result;
  }
}

function attachLocalFeedbackToken(message) {
  if (message?.method !== "tools/call" || message?.params?.name !== "agentrouter_feedback") return null;
  const args = message.params.arguments || {};
  const requestId = String(args.request_id || "");
  if (args.feedback_token) return null;
  const token = localFeedbackTokens.get(requestId);
  if (!token) return null;
  args.feedback_token = token;
  return requestId;
}

function handleLocalControlPlane(message) {
  if (message?.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "AgentRouter", version: "0.14.2" }
    };
  }
  if (message?.method === "ping") return {};
  return null;
}

async function discoverTools(message) {
  try {
    const response = await postRemote(message, { timeoutMs: remoteDiscoveryTimeoutMs });
    if (!response.ok) return { tools: bridgeMcpTools };
    const payload = safeJson(await response.text());
    const tools = payload?.result?.tools;
    if (!Array.isArray(tools)) return { tools: bridgeMcpTools };
    for (const tool of [agentRouterCompleteHandoffTool, agentRouterConnectTool]) {
      if (!tools.some((candidate) => candidate?.name === tool.name)) tools.unshift(tool);
    }
    return { tools };
  } catch {
    return { tools: bridgeMcpTools };
  }
}

async function forwardNotification(message) {
  try {
    await postRemote(message);
  } catch {
    // Notifications never produce a JSON-RPC response.
  }
}

async function postRemote(message, { timeoutMs = remoteTimeoutMs } = {}) {
  const orderedOrigins = orderedRemoteOrigins();
  const availableOrigins = isToolCall(message)
    ? orderedOrigins.filter((origin) => circuitOpenUntil(origin) <= Date.now())
    : orderedOrigins;
  if (isToolCall(message) && !availableOrigins.length) {
    throw remoteDiagnosticError({
      category: "circuit_open",
      attempts: 0,
      timeout_ms: remoteTimeoutMs,
      attempted_origins: orderedOrigins.map(originLabel),
      failover_attempted: orderedOrigins.length > 1,
      retry_after_seconds: circuitRetryAfterSeconds(orderedOrigins)
    });
  }
  const credential = await currentCredential();
  const attemptLimit = availableOrigins.length > 1
    ? Math.min(remoteAttempts, availableOrigins.length)
    : remoteAttempts;
  const attemptedOrigins = [];
  let lastResponse = null;
  let lastCategory = "network";
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const origin = availableOrigins.length > 1 ? availableOrigins[attempt - 1] : availableOrigins[0];
    attemptedOrigins.push(originLabel(origin));
    try {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: remoteHeaders(origin, credential),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs)
      });
      response.agentRouterRemoteAttempts = attempt;
      response.agentRouterRemoteOrigin = origin;
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) remoteSessionIds.set(origin, nextSessionId);
      if (isRetryableHttpResponse(message, response)) {
        lastResponse = response;
        lastCategory = "upstream_http";
        openRemoteCircuit(origin);
        if (attempt >= attemptLimit) break;
        await response.body?.cancel().catch(() => {});
        await delay(retryDelay(attempt));
        continue;
      }
      if (isToolCall(message) && transientHttpStatuses.has(response.status)) openRemoteCircuit(origin);
      else if (!transientHttpStatuses.has(response.status)) markRemoteOriginHealthy(origin);
      response.agentRouterRemoteDiagnostic = remoteDiagnostic({
        category: transientHttpStatuses.has(response.status) ? "upstream_http" : "http",
        httpStatus: response.status,
        attempts: attempt,
        attemptedOrigins
      });
      return response;
    } catch (error) {
      if (error?.agentRouterRemoteDiagnostic) throw error;
      lastCategory = classifyRemoteNetworkError(error);
      if (isSafePreConnectFailure(error)) openRemoteCircuit(origin);
      if (isSafePreConnectFailure(error) && attempt < attemptLimit) {
        await delay(retryDelay(attempt));
        continue;
      }
      if (isToolCall(message)) openRemoteCircuit(origin);
      throw remoteDiagnosticError({
        ...remoteDiagnostic({ category: lastCategory, attempts: attempt, attemptedOrigins }),
        retry_after_seconds: circuitRetryAfterSeconds(attemptedOriginsToOrigins(attemptedOrigins))
      });
    }
  }
  if (lastResponse) {
    lastResponse.agentRouterRemoteDiagnostic = remoteDiagnostic({
      category: lastCategory,
      httpStatus: lastResponse.status,
      attempts: attemptedOrigins.length,
      attemptedOrigins
    });
    return lastResponse;
  }
  throw remoteDiagnosticError(remoteDiagnostic({
    category: lastCategory,
    attempts: attemptedOrigins.length,
    attemptedOrigins
  }));
}

function remoteHeaders(origin, credential = "") {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (credential) {
    headers["x-agentrouter-api-key"] = credential;
    headers.authorization = `Bearer ${credential}`;
  }
  const sessionId = remoteSessionIds.get(origin);
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

function remoteDiagnostic({ category, httpStatus = null, attempts, attemptedOrigins = [] }) {
  return {
    category,
    httpStatus,
    attempts,
    timeout_ms: remoteTimeoutMs,
    attempted_origins: [...attemptedOrigins],
    failover_attempted: attemptedOrigins.length > 1,
    retry_after_seconds: circuitRetryAfterSeconds(attemptedOriginsToOrigins(attemptedOrigins))
  };
}

function attemptedOriginsToOrigins(labels) {
  const wanted = new Set(labels);
  return remoteOrigins.filter((origin) => wanted.has(originLabel(origin)));
}

function orderedRemoteOrigins() {
  const usePreferred = preferredRemoteOrigin !== baseUrl && Date.now() < preferredRemoteOriginUntil;
  const first = usePreferred ? preferredRemoteOrigin : baseUrl;
  return [first, ...remoteOrigins.filter((origin) => origin !== first)];
}

function originLabel(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function markRemoteOriginHealthy(origin) {
  remoteCircuitOpenUntil.delete(origin);
  preferredRemoteOrigin = origin;
  preferredRemoteOriginUntil = origin === baseUrl ? 0 : Date.now() + remoteCooldownMs;
}

function circuitOpenUntil(origin) {
  return remoteCircuitOpenUntil.get(origin) || 0;
}

function parseRemoteOrigins(primary, configuredFallbacks) {
  const defaults = primary === "https://agentrouter.network"
    ? ["https://agentrouter-markets-sg.onrender.com"]
    : [];
  const requested = String(configuredFallbacks || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = [];
  for (const candidate of [primary, ...(requested.length ? requested : defaults)]) {
    try {
      const parsed = new URL(candidate);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const normalized = parsed.origin.replace(/\/$/, "");
      if (!origins.includes(normalized)) origins.push(normalized);
    } catch {
      // Invalid operator-provided fallback origins are ignored safely.
    }
  }
  return origins.length ? origins : [primary];
}

function isToolCall(message) {
  return message?.method === "tools/call";
}

function remoteUnavailableToolResult({
  category = "network",
  httpStatus = null,
  attempts = 1,
  timeout_ms: timeoutMs = remoteTimeoutMs,
  attempted_origins: attemptedOrigins = [],
  failover_attempted: failoverAttempted = false,
  retry_after_seconds: retryAfterSeconds = 5
} = {}) {
  return toolResult({
    ok: false,
    status: "temporarily_unavailable",
    error: {
      code: "AGENTROUTER_REMOTE_UNAVAILABLE",
      category,
      http_status: httpStatus,
      attempts,
      timeout_ms: timeoutMs,
      attempted_origins: attemptedOrigins,
      failover_attempted: failoverAttempted
    },
    retryable: true,
    retry_original_request: true,
    retry_after_seconds: retryAfterSeconds,
    do_not_fallback_outside_agentrouter: true,
    message: "AgentRouter is temporarily unreachable. Retry the original AgentRouter request; do not replace it with an untracked data source."
  });
}

function isRetryableHttpResponse(message, response) {
  if (!transientHttpStatuses.has(response.status)) return false;
  if (!isToolCall(message)) return true;
  return response.headers.get("x-agentrouter-retry-safe")?.toLowerCase() === "true";
}

function openRemoteCircuit(origin) {
  remoteCircuitOpenUntil.set(origin, Date.now() + remoteCooldownMs);
}

function circuitRetryAfterSeconds(origins = remoteOrigins) {
  const active = origins.map(circuitOpenUntil).filter((value) => value > Date.now());
  if (!active.length) return 1;
  return Math.max(1, Math.ceil((Math.min(...active) - Date.now()) / 1_000));
}

function remoteDiagnosticError(diagnostic) {
  const error = new Error("AgentRouter remote MCP request failed.");
  error.agentRouterRemoteDiagnostic = diagnostic;
  return error;
}

function retryDelay(attempt) {
  return Math.min(remoteRetryMs * (2 ** Math.max(0, attempt - 1)), 5_000);
}

function classifyRemoteNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return "connect";
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return "connection_reset";
  if (code.startsWith("CERT_") || code.includes("TLS")) return "tls";
  return "network";
}

function isSafePreConnectFailure(error) {
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  return new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]).has(code);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function isConnectRequest(message) {
  return message?.method === "tools/call" && message?.params?.name === "agentrouter_connect";
}

async function handleConnectRequest(message) {
  const args = message?.params?.arguments || {};
  const stored = await currentCredential();
  if (stored && !args.restart) {
    return toolResult({ status: "connected", auth_method: configuredCreditApiKey ? "api_key" : "device", message: "AgentRouter is connected and ready for paid calls." });
  }
  if (args.restart) deviceAuthorization = null;
  if (!deviceAuthorization) {
    const clientName = String(args.client_name || "AI agent").slice(0, 120);
    const started = await postJson("/auth/device/start", {
      client_name: clientName
    });
    if (!started.ok) return toolResult({ status: "connection_failed", error: started.payload?.error || `HTTP ${started.status}` }, true);
    deviceAuthorization = { ...started.payload, client_name: clientName };
    deviceAuthorization.browser_open = await launchBrowserAuthorization(
      deviceAuthorization.verification_uri_complete || deviceAuthorization.verification_uri,
      {
        allowedOrigins: remoteOrigins,
        disabled: process.env.AGENTROUTER_DISABLE_BROWSER_OPEN === "1"
      }
    );
  }

  const waitSeconds = Math.max(0, Math.min(55, Number(args.wait_seconds ?? 45) || 0));
  const deadline = Date.now() + waitSeconds * 1000;
  let tokenResult = await pollDeviceToken();
  while (tokenResult.error === "authorization_pending" && Date.now() < deadline) {
    await delay(Math.max(1, Number(deviceAuthorization.interval) || 3) * 1000);
    tokenResult = await pollDeviceToken();
  }
  if (await acceptDeviceCredential(tokenResult, args.client_name)) {
    return toolResult({
      status: "connected",
      auth_method: "device",
      message: "AgentRouter is connected. The credential was saved privately on this device; no API key was added to the MCP configuration."
    });
  }
  if (tokenResult.error === "expired_token") {
    const expired = deviceAuthorization;
    deviceAuthorization = null;
    return toolResult({ status: "authorization_expired", user_code: expired.user_code, action: "Call agentrouter_connect again to create a new code." }, true);
  }
  return toolResult({
    status: "authorization_required",
    user_code: deviceAuthorization.user_code,
    verification_uri: deviceAuthorization.verification_uri,
    verification_uri_complete: deviceAuthorization.verification_uri_complete,
    expires_in: deviceAuthorization.expires_in,
    browser_open: deviceAuthorization.browser_open,
    message: "Open the authorization link and approve this agent. Then call agentrouter_connect again if this call returns before approval."
  });
}

async function resumePendingDeviceAuthorization() {
  if (!deviceAuthorization) return false;
  const tokenResult = await pollDeviceToken();
  if (await acceptDeviceCredential(tokenResult)) return true;
  if (tokenResult.error === "expired_token") deviceAuthorization = null;
  return false;
}

async function acceptDeviceCredential(tokenResult, clientName) {
  if (!tokenResult?.access_token) return false;
  await writeStoredCredential({
    origin: baseUrl,
    accessToken: tokenResult.access_token,
    keyId: tokenResult.key_id,
    clientName: String(clientName || deviceAuthorization?.client_name || "AI agent").slice(0, 120)
  });
  deviceAuthorization = null;
  return true;
}

async function pollDeviceToken() {
  const response = await postJson("/auth/device/token", { device_code: deviceAuthorization.device_code });
  return response.payload || { error: "connection_failed" };
}

async function postJson(pathname, body) {
  const response = await fetchRemotePath(pathname, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  return { ok: response.ok, status: response.status, payload: await response.json().catch(() => null) };
}

async function postAuthenticatedJson(pathname, body) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const credential = await currentCredential();
  if (credential) {
    headers["x-agentrouter-api-key"] = credential;
    headers.authorization = `Bearer ${credential}`;
  }
  const response = await fetchRemotePath(pathname, { method: "POST", headers, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, payload: await response.json().catch(() => null) };
}

async function fetchRemotePath(pathname, init) {
  const ordered = orderedRemoteOrigins();
  const available = ordered.filter((origin) => circuitOpenUntil(origin) <= Date.now());
  const candidates = (available.length ? available : ordered).slice(0, Math.max(1, remoteAttempts));
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const origin = candidates[index];
    try {
      const response = await fetch(`${origin}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(remoteTimeoutMs)
      });
      const retrySafe = response.headers.get("x-agentrouter-retry-safe")?.toLowerCase() === "true";
      if (transientHttpStatuses.has(response.status) && retrySafe && index < candidates.length - 1) {
        openRemoteCircuit(origin);
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (transientHttpStatuses.has(response.status)) openRemoteCircuit(origin);
      else markRemoteOriginHealthy(origin);
      return response;
    } catch (error) {
      lastError = error;
      if (isSafePreConnectFailure(error)) openRemoteCircuit(origin);
      if (isSafePreConnectFailure(error) && index < candidates.length - 1) continue;
      throw error;
    }
  }
  throw lastError || new Error("AgentRouter remote origins are unavailable.");
}

async function completeSponsoredFeedback(message, payload) {
  if (message?.method !== "tools/call" || message?.params?.name !== "agentrouter_feedback") return;
  const block = payload?.result?.content?.find((item) => item?.type === "text");
  if (!block?.text) return;
  const feedback = safeJson(block.text);
  if (feedback?.erc8004?.status !== "consumer_submission_required") return;
  try {
    const account = await readOrCreateFeedbackSigner();
    const erc8004 = await submitSponsoredFeedback({
      descriptor: feedback.erc8004,
      account,
      paymasterRpc: async (method, params) => {
        const response = await postAuthenticatedJson("/agent-router/paymaster", {
          method,
          params,
          service_id: feedback.service_id,
          request_id: feedback.request_id
        });
        if (!response.ok) throw new Error(response.payload?.error || `AgentRouter Paymaster proxy returned HTTP ${response.status}.`);
        return response.payload?.result;
      }
    });
    feedback.erc8004 = erc8004;
    feedback.trust_anchor = { ...(feedback.trust_anchor || {}), erc8004 };
    const attached = await postAuthenticatedJson("/agent-router/feedback/erc8004", {
      service_id: feedback.service_id,
      request_id: feedback.request_id,
      erc8004
    });
    feedback.erc8004_attachment = attached.payload;
    if (attached.ok) feedback.trust_anchor = attached.payload?.trust_anchor || feedback.trust_anchor;
    block.text = JSON.stringify(feedback, null, 2);
  } catch (error) {
    const failed = { ...feedback.erc8004, status: "sponsorship_failed", recorded_offchain: true, error: error.message };
    feedback.erc8004 = failed;
    const attached = await postAuthenticatedJson("/agent-router/feedback/erc8004", {
      service_id: feedback.service_id,
      request_id: feedback.request_id,
      erc8004: failed
    }).catch(() => null);
    if (attached) feedback.erc8004_attachment = attached.payload;
    if (attached?.ok) feedback.trust_anchor = attached.payload?.trust_anchor || feedback.trust_anchor;
    block.text = JSON.stringify(feedback, null, 2);
  }
}

async function currentCredential() {
  if (configuredCreditApiKey) return configuredCreditApiKey;
  const stored = await readStoredCredential({ origin: baseUrl });
  return stored?.access_token || "";
}

function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function send(message) {
  process.stdout.write(encodeMessage(message));
}

// Auto-start when executed directly (node server/index.js). The bin also calls
// start(); importing the module (tests) triggers neither.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  start();
}
