import test from "node:test";
import assert from "node:assert/strict";

import { runExternalApiQuery } from "../src/external-api-capability.js";
import { createSocialConnection } from "../src/social-connections.js";
import { createMemoryStore } from "../src/store.js";

function secretStore() {
  const values = new Map();
  return {
    writeSecret: async ({ serviceId, secretName, secretValue }) => {
      const ref = `${serviceId}:${secretName}`;
      values.set(ref, secretValue);
      return ref;
    },
    readSecret: async (ref) => values.get(ref) || ""
  };
}

function mcpResponse(payload) {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    text: async () => `event: message\ndata: ${JSON.stringify(envelope)}\n\n`
  };
}

test("XPOZ fans one routed request out across all requested platforms", async () => {
  const store = createMemoryStore();
  const secrets = secretStore();
  await createSocialConnection(store, "github:user-a", {
    platform: "xpoz",
    provider_type: "xpoz_api",
    credentials: { api_key: "xpoz-token" }
  }, secrets);
  const calls = [];

  const result = await runExternalApiQuery(store, "github:user-a", {
    source: "xpoz",
    operation: "search",
    query: "AgentRouter",
    platforms: ["x", "reddit", "tiktok"],
    limit: 6
  }, {
    ...secrets,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), headers: options.headers, body });
      return mcpResponse({ data: [{ id: body.params.name, text: `result from ${body.params.name}` }] });
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.body.params.name), [
    "getTwitterPostsByKeywords",
    "getRedditPostsByKeywords",
    "getTiktokPostsByKeywords"
  ]);
  assert.ok(calls.every((call) => call.url === "https://mcp.xpoz.ai/mcp"));
  assert.ok(calls.every((call) => call.headers.authorization === "Bearer xpoz-token"));
  assert.deepEqual(result.items.map((item) => item.metadata.platform), ["x", "reddit", "tiktok"]);
});

test("SocialDataX uses each platform's official MCP endpoint and merges the evidence", async () => {
  const store = createMemoryStore();
  const secrets = secretStore();
  await createSocialConnection(store, "github:user-a", {
    platform: "socialdatax",
    provider_type: "socialdatax_api",
    credentials: { api_key: "sdx-token" }
  }, secrets);
  const calls = [];

  const result = await runExternalApiQuery(store, "github:user-a", {
    source: "socialdatax",
    operation: "search",
    query: "Agent 交易",
    platforms: ["xiaohongshu", "douyin", "weibo"],
    limit: 6
  }, {
    ...secrets,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), headers: options.headers, body });
      return mcpResponse({ data: [{ id: body.params.name, title: `result from ${body.params.name}` }] });
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.body.params.name), [
    "xhs_search_notes",
    "douyin_search_videos",
    "weibo_search_posts"
  ]);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://mcp.socialdatax.com/xhs/mcp",
    "https://mcp.socialdatax.com/douyin/mcp",
    "https://mcp.socialdatax.com/weibo/mcp"
  ]);
  assert.ok(calls.every((call) => call.headers.authorization === "Bearer sdx-token"));
  assert.deepEqual(result.items.map((item) => item.metadata.platform), ["xiaohongshu", "douyin", "weibo"]);
});
