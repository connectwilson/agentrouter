#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { localSocialPostRequest, runLocalSocialPostRead } from "./local-social-post.js";
import { localSocialSearchRequest, runLocalSocialSearch } from "./local-social-search.js";
import { readStoredCredential, writeStoredCredential } from "./credential-store.js";

const baseUrl = String(process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\/$/, "");
const configuredCreditApiKey = String(process.env.AGENT_ROUTER_API_KEY || "").trim();
let remoteSessionId = "";
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
    send(payload);
  } catch (error) {
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

  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });
  const nextSessionId = response.headers.get("mcp-session-id");
  if (nextSessionId) remoteSessionId = nextSessionId;
  return response;
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
    const started = await postJson("/auth/device/start", {
      client_name: String(args.client_name || "AI agent").slice(0, 120)
    });
    if (!started.ok) return toolResult({ status: "connection_failed", error: started.payload?.error || `HTTP ${started.status}` }, true);
    deviceAuthorization = started.payload;
  }

  const waitSeconds = Math.max(0, Math.min(55, Number(args.wait_seconds ?? 45) || 0));
  const deadline = Date.now() + waitSeconds * 1000;
  let tokenResult = await pollDeviceToken();
  while (tokenResult.error === "authorization_pending" && Date.now() < deadline) {
    await delay(Math.max(1, Number(deviceAuthorization.interval) || 3) * 1000);
    tokenResult = await pollDeviceToken();
  }
  if (tokenResult.access_token) {
    await writeStoredCredential({
      origin: baseUrl,
      accessToken: tokenResult.access_token,
      keyId: tokenResult.key_id,
      clientName: String(args.client_name || "AI agent").slice(0, 120)
    });
    deviceAuthorization = null;
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
