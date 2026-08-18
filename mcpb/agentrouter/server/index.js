#!/usr/bin/env node

const baseUrl = String(process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\/$/, "");
const creditApiKey = String(process.env.AGENT_ROUTER_API_KEY || "").trim();
let remoteSessionId = "";
let buffer = Buffer.alloc(0);
let processing = Promise.resolve();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processing = processing.then(processBufferedMessages).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
  });
});

process.stdin.on("end", () => {
  processing.finally(() => process.exit(0));
});

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
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
    buffer = buffer.subarray(bodyEnd);
  }
  return messages;
}

async function forwardRequest(message) {
  try {
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
  if (creditApiKey) {
    headers["x-agentrouter-api-key"] = creditApiKey;
    headers.authorization = `Bearer ${creditApiKey}`;
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

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function send(message) {
  // MCP stdio replies are newline-delimited JSON, not LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
