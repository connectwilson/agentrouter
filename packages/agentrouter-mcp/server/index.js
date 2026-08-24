#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { localSocialPostRequest, runLocalSocialPostRead } from "./local-social-post.js";
import { localSocialSearchRequest, runLocalSocialSearch } from "./local-social-search.js";
import { readStoredCredential, writeStoredCredential } from "./credential-store.js";
import { submitSponsoredFeedback } from "./bsc-feedback.js";
import { readOrCreateFeedbackSigner } from "./feedback-wallet.js";
import { decorateBrowserAuthorization, resolveMcpClientAction } from "./action-state.js";

const baseUrl = String(process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\/$/, "");
const configuredCreditApiKey = String(process.env.AGENT_ROUTER_API_KEY || "").trim();
const remoteAttempts = boundedInteger(process.env.AGENT_ROUTER_REMOTE_ATTEMPTS, 3, 1, 5);
const remoteRetryMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_RETRY_MS, 250, 10, 5_000);
const remoteTimeoutMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_TIMEOUT_MS, 15_000, 250, 60_000);
const remoteCooldownMs = boundedInteger(process.env.AGENT_ROUTER_REMOTE_COOLDOWN_MS, 5_000, 100, 60_000);
const transientHttpStatuses = new Set([408, 425, 429, 502, 503, 504]);
let remoteSessionId = "";
let remoteCircuitOpenUntil = 0;
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
      await forwardNotification(message);
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
    if (isConnectRequest(message)) {
      send({ jsonrpc: "2.0", id: message.id, result: await handleConnectRequest(message) });
      return;
    }
    await resumePendingDeviceAuthorization();
    // Keyword search only works where a browser is: the hosted server has none.
    const localSearch = localSocialSearchRequest(message);
    if (localSearch) {
      const result = await runLocalSocialSearch(localSearch);
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
    const response = await postRemote(message);
    const text = await response.text();
    if (!response.ok) {
      if (isToolCall(message) && transientHttpStatuses.has(response.status)) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: remoteUnavailableToolResult({
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
    if (message.method === "tools/list") appendLocalTools(payload);
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

async function forwardNotification(message) {
  try {
    await postRemote(message);
  } catch {
    // Notifications never produce a JSON-RPC response.
  }
}

async function postRemote(message) {
  if (isToolCall(message) && remoteCircuitOpenUntil > Date.now()) {
    throw remoteDiagnosticError({
      category: "circuit_open",
      attempts: 0,
      timeout_ms: remoteTimeoutMs,
      retry_after_seconds: circuitRetryAfterSeconds()
    });
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  const credential = await currentCredential();
  if (credential) {
    headers["x-agentrouter-api-key"] = credential;
    headers.authorization = `Bearer ${credential}`;
  }
  if (remoteSessionId) headers["mcp-session-id"] = remoteSessionId;

  for (let attempt = 1; attempt <= remoteAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(remoteTimeoutMs)
      });
      response.agentRouterRemoteAttempts = attempt;
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) remoteSessionId = nextSessionId;
      if (shouldRetryHttpResponse(message, response, attempt)) {
        await response.body?.cancel().catch(() => {});
        await delay(retryDelay(attempt));
        continue;
      }
      if (isToolCall(message) && transientHttpStatuses.has(response.status)) openRemoteCircuit();
      else if (!transientHttpStatuses.has(response.status)) remoteCircuitOpenUntil = 0;
      return response;
    } catch (error) {
      if (error?.agentRouterRemoteDiagnostic) throw error;
      const category = classifyRemoteNetworkError(error);
      if (isSafePreConnectFailure(error) && attempt < remoteAttempts) {
        await delay(retryDelay(attempt));
        continue;
      }
      if (isToolCall(message)) openRemoteCircuit();
      throw remoteDiagnosticError({
        category,
        attempts: attempt,
        timeout_ms: remoteTimeoutMs,
        retry_after_seconds: circuitRetryAfterSeconds()
      });
    }
  }
  throw new Error("AgentRouter remote MCP retry loop ended unexpectedly.");
}

function isToolCall(message) {
  return message?.method === "tools/call";
}

function remoteUnavailableToolResult({
  category = "network",
  httpStatus = null,
  attempts = 1,
  timeout_ms: timeoutMs = remoteTimeoutMs,
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
      timeout_ms: timeoutMs
    },
    retryable: true,
    retry_original_request: true,
    retry_after_seconds: retryAfterSeconds,
    do_not_fallback_outside_agentrouter: true,
    message: "AgentRouter is temporarily unreachable. Retry the original AgentRouter request; do not replace it with an untracked data source."
  });
}

function shouldRetryHttpResponse(message, response, attempt) {
  if (attempt >= remoteAttempts || !transientHttpStatuses.has(response.status)) return false;
  if (!isToolCall(message)) return true;
  return response.headers.get("x-agentrouter-retry-safe")?.toLowerCase() === "true";
}

function openRemoteCircuit() {
  remoteCircuitOpenUntil = Date.now() + remoteCooldownMs;
}

function circuitRetryAfterSeconds() {
  return Math.max(1, Math.ceil((remoteCircuitOpenUntil - Date.now()) / 1_000));
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

function appendLocalTools(payload) {
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools) || tools.some((tool) => tool?.name === "agentrouter_connect")) return;
  tools.unshift({
    name: "agentrouter_connect",
    description: "Connect this AI client to the user's AgentRouter account through one browser approval. Use this when a paid call reports that no AgentRouter payment credential is available. Never ask the user to copy an API key or edit an MCP configuration file.",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Human-readable AI client name." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 55, default: 45, description: "How long to wait for browser approval before returning pending status." },
        restart: { type: "boolean", default: false, description: "Start a new authorization if the previous code expired." }
      }
    }
  });
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
  const response = await fetch(`${baseUrl}${pathname}`, {
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
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, payload: await response.json().catch(() => null) };
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
    if (erc8004.status === "submitted") {
      const attached = await postAuthenticatedJson("/agent-router/feedback/erc8004", {
        service_id: feedback.service_id,
        request_id: feedback.request_id,
        erc8004
      });
      feedback.erc8004_attachment = attached.payload;
      if (attached.ok) feedback.trust_anchor = attached.payload?.trust_anchor || feedback.trust_anchor;
    }
    block.text = JSON.stringify(feedback, null, 2);
  } catch (error) {
    feedback.erc8004 = { ...feedback.erc8004, status: "sponsorship_failed", recorded_offchain: true, error: error.message };
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
