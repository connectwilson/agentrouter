#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { localSocialPostRequest, runLocalSocialPostRead } from "./local-social-post.js";
import { localSocialSearchRequest, runLocalSocialSearch } from "./local-social-search.js";
import { readStoredCredential, writeStoredCredential } from "./credential-store.js";
import { submitSponsoredFeedback } from "./bsc-feedback.js";
import { readOrCreateFeedbackSigner } from "./feedback-wallet.js";
import { decorateBrowserAuthorization, resolveMcpClientAction } from "./action-state.js";
import { agentRouterConnectTool, bridgeMcpTools } from "./tool-catalog.js";

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
const localFeedbackTokens = new Map();
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
    // Keyword search only works where a browser is: the hosted server has none.
    const localSearch = localSocialSearchRequest(message);
    if (localSearch) {
      const result = await runLocalSocialSearch(localSearch);
      await attachLocalFeedbackGrant(result);
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
      const result = await runLocalSocialPostRead(localSocialPost.canonical_url);
      await attachLocalFeedbackGrant(result);
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
    attachLocalFeedbackToken(message);
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
    await completeSponsoredFeedback(message, payload);
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

async function attachLocalFeedbackGrant(result) {
  if (!result?.request_id || !result?.service_id || !result?.consumer_feedback_request) return result;
  const params = result.request?.params || {};
  try {
    const response = await postAuthenticatedJson("/agent-router/feedback/grant", {
      request_id: result.request_id,
      service_id: result.service_id,
      operation: params.operation || (result.request_id.includes("_post_") ? "post" : "search"),
      capability: result.request?.capability || "social_search",
      result_status: result.status
    });
    if (!response.ok || !response.payload?.feedback_token) {
      result.consumer_feedback_request.registration = {
        status: "registration_failed",
        error: response.payload?.error?.message || response.payload?.error || `HTTP ${response.status}`
      };
      return result;
    }
    const token = response.payload.feedback_token;
    localFeedbackTokens.set(result.request_id, token);
    result.consumer_feedback_request.feedback_token_required = true;
    result.consumer_feedback_request.registration = { status: "registered", service_id: result.service_id };
    return result;
  } catch (error) {
    result.consumer_feedback_request.registration = { status: "registration_failed", error: error.message };
    return result;
  }
}

function attachLocalFeedbackToken(message) {
  if (message?.method !== "tools/call" || message?.params?.name !== "agentrouter_feedback") return;
  const args = message.params.arguments || {};
  if (args.feedback_token) return;
  const token = localFeedbackTokens.get(String(args.request_id || ""));
  if (token) args.feedback_token = token;
}

function handleLocalControlPlane(message) {
  if (message?.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "AgentRouter", version: "0.12.5" }
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
    if (!tools.some((tool) => tool?.name === agentRouterConnectTool.name)) tools.unshift(agentRouterConnectTool);
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
