import assert from "node:assert/strict";
import test from "node:test";

import { runExternalApiQuery } from "../src/external-api-capability.js";
import { createSocialConnection, socialProvidersForUser } from "../src/social-connections.js";
import { createMemoryStore } from "../src/store.js";

const TEST_TIMEOUT_MS = 40;
const TEST_MAX_BYTES = 512;

test("X BYOK times out while waiting for response headers with a typed provider error", async () => {
  const { store, secrets } = await connected("x", "x_api", "bearer_token");
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async () => new Promise(() => {})
  });

  const result = await within(providers.x[0].search("AgentRouter", 10));
  assert.equal(result.status, "provider_error");
  assert.equal(result.error_code, "SOCIAL_PROVIDER_TIMEOUT");
  assert.equal(result.diagnostics.category, "timeout");
  assert.deepEqual(result.rows, []);
});

test("Reddit BYOK times out while reading a slow body", async () => {
  const { store, secrets } = await connected("reddit", "reddit_api", "access_token");
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => new Promise(() => {})
    })
  });

  const result = await within(providers.reddit[0].search("AgentRouter", 10));
  assert.equal(result.status, "provider_error");
  assert.equal(result.error_code, "SOCIAL_PROVIDER_TIMEOUT");
  assert.equal(result.diagnostics.stage, "reddit_search");
});

test("X BYOK rejects an oversized response before parsing or reporting success", async () => {
  const { store, secrets } = await connected("x", "x_api", "bearer_token");
  let parsed = false;
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? String(TEST_MAX_BYTES + 1) : null },
      json: async () => {
        parsed = true;
        return { data: [{ id: "unsafe", text: "oversized" }] };
      }
    })
  });

  const result = await within(providers.x[0].search("AgentRouter", 10));
  assert.equal(result.status, "provider_error");
  assert.equal(result.error_code, "SOCIAL_PROVIDER_RESPONSE_TOO_LARGE");
  assert.equal(parsed, false);
});

test("one hung XPOZ platform cannot suppress another platform's partial evidence", async () => {
  const { store, secrets } = await connected("xpoz", "xpoz_api", "api_key");
  const startedAt = Date.now();
  const result = await within(runExternalApiQuery(store, "github:user-a", {
    source: "xpoz",
    operation: "search",
    query: "AgentRouter",
    platforms: ["x", "reddit"],
    limit: 4
  }, {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async (_url, options) => {
      const tool = JSON.parse(options.body).params.name;
      if (tool.includes("Reddit")) return new Promise(() => {});
      return mcpResponse({ data: [{ id: "x-1", text: "AgentRouter on X" }] });
    }
  }));

  assert.ok(Date.now() - startedAt < 500, "the aggregate request must have a bounded deadline");
  assert.equal(result.status, "completed");
  assert.equal(result.result.items.length, 1);
  assert.deepEqual(result.coverage.evidence_platforms, ["x"]);
  assert.deepEqual(result.coverage.failed_platforms, ["reddit"]);
  assert.equal(result.coverage.platform_errors.reddit.code, "SOCIAL_PROVIDER_TIMEOUT");
  assert.equal(result.coverage.status, "insufficient");
});

test("an oversized MCP platform is isolated while other platform evidence survives", async () => {
  const { store, secrets } = await connected("xpoz", "xpoz_api", "api_key");
  const result = await within(runExternalApiQuery(store, "github:user-a", {
    source: "xpoz",
    operation: "search",
    query: "AgentRouter",
    platforms: ["x", "reddit"],
    limit: 4
  }, {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async (_url, options) => {
      const tool = JSON.parse(options.body).params.name;
      if (tool.includes("Reddit")) return oversizedResponse(TEST_MAX_BYTES + 1);
      return mcpResponse({ data: [{ id: "x-1", text: "AgentRouter on X" }] });
    }
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(result.coverage.failed_platforms, ["reddit"]);
  assert.equal(result.coverage.platform_errors.reddit.code, "SOCIAL_PROVIDER_RESPONSE_TOO_LARGE");
  assert.deepEqual(result.result.items.map((item) => item.metadata.platform), ["x"]);
});

test("all-empty social vendor calls are recorded as no-results, never success", async () => {
  const { store, secrets } = await connected("xpoz", "xpoz_api", "api_key");
  const result = await within(runExternalApiQuery(store, "github:user-a", {
    source: "xpoz",
    operation: "search",
    query: "no matching posts",
    platforms: ["x", "reddit"],
    limit: 4
  }, {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async () => mcpResponse({ data: [] })
  }));

  assert.equal(result.status, "no_results");
  assert.equal(result.result.count, 0);
  assert.deepEqual(result.coverage.empty_platforms, ["x", "reddit"]);
  assert.equal(store.feedbackEvents.at(-1).status, "no_results");
  assert.notEqual(store.feedbackEvents.at(-1).status, "success");
});

test("a single-platform SocialDataX hang returns a bounded typed failure", async () => {
  const { store, secrets } = await connected("socialdatax", "socialdatax_api", "api_key");
  const result = await within(runExternalApiQuery(store, "github:user-a", {
    source: "socialdatax",
    operation: "search",
    query: "Agent 交易",
    platforms: ["xiaohongshu"],
    limit: 4
  }, {
    ...secrets,
    fetchTimeoutMs: TEST_TIMEOUT_MS,
    fetchMaxResponseBytes: TEST_MAX_BYTES,
    fetchImpl: async () => new Promise(() => {})
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROVIDER_ERROR");
  assert.equal(result.error.diagnostics.code, "SOCIAL_PROVIDER_TIMEOUT");
  assert.deepEqual(result.coverage.failed_platforms, ["xiaohongshu"]);
});

async function connected(platform, providerType, credentialField) {
  const store = createMemoryStore();
  const secrets = secretStore();
  await createSocialConnection(store, "github:user-a", {
    platform,
    provider_type: providerType,
    credentials: { [credentialField]: `${platform}-secret` }
  }, secrets);
  return { store, secrets };
}

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
    headers: { get: () => null },
    text: async () => `event: message\ndata: ${JSON.stringify(envelope)}\n\n`
  };
}

function oversizedResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "content-length" ? String(bytes) : null },
    text: async () => "x".repeat(bytes)
  };
}

function within(promise, timeoutMs = 750) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs))
  ]);
}
