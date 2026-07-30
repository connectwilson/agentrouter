import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { getCapabilityCatalog } from "../src/router.js";
import { buildLocalSocialExecutionPlan } from "../src/local-social-privacy.js";
import {
  parseSocialPostUrl,
  runSocialPostReadCapability
} from "../src/social-post-read.js";
import {
  buildLocalCliEnvironment,
  localSocialPostRequest,
  runLocalSocialPostRead
} from "../packages/agentrouter-mcp/server/local-social-post.js";

const xUrl = "https://x.com/marclou/status/2081890388298874880";

test("AgentRouter publishes a read-only social_post_read capability", () => {
  const capability = getCapabilityCatalog().find((item) => item.capability === "social_post_read");
  assert.ok(capability);
  assert.deepEqual(capability.input_schema.required, ["url"]);
  assert.deepEqual(capability.input_schema.properties.platform.enum, ["x"]);
  assert.match(capability.agent_description, /single public social post/i);
});

test("X status URLs are canonicalized without accepting lookalike hosts", () => {
  assert.deepEqual(parseSocialPostUrl(xUrl), {
    platform: "x",
    post_id: "2081890388298874880",
    canonical_url: xUrl
  });
  assert.equal(
    parseSocialPostUrl("https://twitter.com/i/status/2081890388298874880").canonical_url,
    "https://x.com/i/status/2081890388298874880"
  );
  assert.equal(parseSocialPostUrl("https://x.com.evil.example/user/status/123"), null);
  assert.equal(parseSocialPostUrl("https://x.com/user/likes"), null);
});

test("local X read plans stay declarative, read-only, and credential-local", () => {
  const plan = buildLocalSocialExecutionPlan({
    platform: "x",
    operation: "read_post",
    target: xUrl,
    limit: 1
  });
  assert.equal(plan.params.target, xUrl);
  assert.equal(plan.execution_location, "user_device");
  assert.equal(plan.permissions.access, "read_only");
  assert.equal(plan.permissions.write_actions, "denied");
  assert.equal(plan.data_policy.credentials, "never_upload");
  assert.equal("command" in plan, false);
});

test("social_post_read uses a connected X API provider and normalizes provenance", async () => {
  const calls = [];
  const result = await runSocialPostReadCapability({ url: xUrl }, {
    providers: {
      x: [{
        id: "x-api:test",
        readPost: async (target) => {
          calls.push(target);
          return {
            status: "completed",
            rows: [{
              id: "2081890388298874880",
              url: xUrl,
              text: "AgentRouter should read this post.",
              author: "marclou",
              published_at: "2026-07-29T00:00:00Z",
              engagement: { likes: 12, comments: 3, shares: 2 }
            }]
          };
        }
      }]
    }
  });

  assert.deepEqual(calls, [xUrl]);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.result.post.canonical_url, xUrl);
  assert.equal(result.result.post.author_handle, "marclou");
  assert.equal(result.verification.source_url_preserved, true);
  assert.equal(JSON.stringify(result).includes("cookie"), false);
});

test("hosted fetch recognizes an X URL and requests local execution instead of no_service_found", async () => {
  const server = createServer({ store: createMemoryStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/agent-router/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: `抓取这个 X 帖子 ${xUrl}` })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "local_connector_required");
    assert.equal(payload.request.capability, "social_post_read");
    assert.equal(payload.local_execution_plan.params.target, xUrl);
    assert.notEqual(payload.status, "no_service_found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public MCP bridge reads an X post through the browser connector first", async () => {
  const calls = [];
  const result = await runLocalSocialPostRead(xUrl, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        status: "completed",
        data: [{
          id: "2081890388298874880",
          text: "Local browser session result",
          author: "marclou",
          created_at: "2026-07-29T00:00:00Z",
          likes: 9,
          replies: 2,
          retweets: 1
        }]
      };
    }
  });

  assert.deepEqual(calls, [
    { command: "opencli", args: ["twitter", "thread", xUrl, "--limit", "1", "-f", "json"] }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.result.post.text, "Local browser session result");
  assert.equal(result.result.post.canonical_url, xUrl);
  assert.equal(result.protocol.execution_location, "user_device");
  assert.equal(result.protocol.credential_policy, "never_upload");
});

test("public MCP bridge does not request keychain access when the browser connector is offline", async () => {
  const calls = [];
  const result = await runLocalSocialPostRead(xUrl, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { status: "provider_error", error: "Browser extension is not connected" };
    }
  });

  assert.deepEqual(calls, [
    { command: "opencli", args: ["twitter", "thread", xUrl, "--limit", "1", "-f", "json"] }
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.status, "browser_connector_offline");
  assert.equal(result.action_required.code, "BROWSER_CONNECTOR_OFFLINE");
  assert.equal(result.action_required.connector_id, "opencli-twitter");
  assert.equal(result.action_required.requires_system_password, false);
  assert.equal(result.action_required.credential_access, "browser_managed");
  assert.match(result.action_required.message, /OpenCLI browser extension/i);
  assert.doesNotMatch(JSON.stringify(result.action_required), /auth_token|ct0|keychain/i);
});

test("Twitter CLI credential fallback requires explicit opt-in", async () => {
  const calls = [];
  const result = await runLocalSocialPostRead(xUrl, {
    allowCredentialFallback: true,
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (command === "opencli") {
        return { status: "provider_error", error: "Browser extension is not connected" };
      }
      return {
        status: "completed",
        data: {
          tweet: {
            id: "2081890388298874880",
            text: "Explicit fallback result",
            author: { username: "marclou" }
          }
        }
      };
    }
  });

  assert.deepEqual(calls, [
    { command: "opencli", args: ["twitter", "thread", xUrl, "--limit", "1", "-f", "json"] },
    { command: "twitter", args: ["tweet", xUrl, "-n", "0", "--json"] }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.source.backend_id, "twitter-cli");
});

test("MCP bridge discovers user-installed OpenCLI without forwarding secrets", () => {
  const env = buildLocalCliEnvironment({
    HOME: "/Users/example",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    AGENT_ROUTER_API_KEY: "secret",
    TWITTER_AUTH_TOKEN: "secret"
  });

  assert.equal(
    env.PATH,
    "/Users/example/.npm-global/bin:/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin"
  );
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal("AGENT_ROUTER_API_KEY" in env, false);
  assert.equal("TWITTER_AUTH_TOKEN" in env, false);
});

test("public MCP bridge intercepts natural and structured X reads only", () => {
  const natural = localSocialPostRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_fetch",
      arguments: { task: `读取 ${xUrl}` }
    }
  });
  assert.equal(natural.canonical_url, xUrl);

  const structured = localSocialPostRequest({
    method: "tools/call",
    params: {
      name: "agentrouter_request",
      arguments: { capability: "social_post_read", params: { url: xUrl } }
    }
  });
  assert.equal(structured.post_id, "2081890388298874880");

  assert.equal(localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: "BTC price" } }
  }), null);
});
