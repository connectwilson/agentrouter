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
  // Cookie material must never be echoed back to the caller.
  assert.doesNotMatch(JSON.stringify(result.action_required), /auth_token|ct0/i);
  // Keychain may only be named to disclaim it, never to ask for it.
  assert.match(result.action_required.security_note, /never asks for a system or Keychain password/);
  assert.doesNotMatch(result.action_required.message, /keychain|password/i);
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

test("MCP bridge frames stdout as newline-delimited JSON, not LSP Content-Length", async () => {
  const { encodeMessage } = await import("../packages/agentrouter-mcp/server/index.js");
  const wire = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(wire.endsWith("\n"), true);
  assert.equal(wire.includes("Content-Length"), false);
  assert.equal(wire.includes("\r"), false);
  // Each frame must be one parseable line — the client splits on newlines.
  const lines = wire.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("MCP bridge intercepts TikTok video URLs and reads via local opencli", async () => {
  const url = "https://www.tiktok.com/@creator1/video/7300000000000000000";
  const intercepted = localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: `看看这个 ${url}` } }
  });
  assert.equal(intercepted.platform, "tiktok");
  assert.equal(intercepted.username, "creator1");
  assert.equal(intercepted.post_id, "7300000000000000000");

  const calls = [];
  const happy = await runLocalSocialPostRead(url, {
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { status: "completed", data: { data: [{
        id: "7300000000000000000", desc: "caption", author: { uniqueId: "creator1" },
        createTime: 1719792000, stats: { diggCount: 10, commentCount: 2, shareCount: 1, playCount: 500 }
      }] } };
    }
  });
  assert.deepEqual(calls[0].slice(0, 4), ["opencli", "tiktok", "user", "creator1"]);
  assert.equal(happy.status, "completed");
  assert.equal(happy.result.post.platform, "tiktok");
  assert.equal(happy.result.post.author_handle, "creator1");
  assert.deepEqual(happy.result.post.engagement, { likes: 10, comments: 2, shares: 1, views: 500 });

  // EMPTY_RESULT + whoami auth failure => auth_required guidance, not connector_offline
  const auth = await runLocalSocialPostRead(url, {
    runCommand: async (command, args) => args.includes("whoami")
      ? { status: "auth_required", error: "AUTH_REQUIRED: session cookies missing" }
      : { status: "provider_error", error: "EMPTY_RESULT" }
  });
  assert.equal(auth.status, "auth_required");
  assert.equal(auth.action_required.connector_id, "opencli-tiktok");

  // logged in but video not in recent uploads => post_not_found
  const miss = await runLocalSocialPostRead(url, {
    runCommand: async (command, args) => args.includes("whoami")
      ? { status: "completed", data: { username: "me" } }
      : { status: "completed", data: { data: [{ id: "1", desc: "other", stats: {} }] } }
  });
  assert.equal(miss.status, "post_not_found");
});

test("local bridge reads TikTok and YouTube video URLs, not just X", async () => {
  const { localSocialPostRequest, runLocalSocialPostRead, parseCount } =
    await import("../packages/agentrouter-mcp/server/local-social-post.js");

  // YouTube: watch / youtu.be / shorts all resolve to the same video.
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ"
  ]) {
    const hit = localSocialPostRequest({
      method: "tools/call",
      params: { name: "agentrouter_fetch", arguments: { task: `read ${url}` } }
    });
    assert.equal(hit?.platform, "youtube");
    assert.equal(hit.post_id, "dQw4w9WgXcQ");
  }
  assert.equal(localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: "https://www.youtube.com/@channel" } }
  }), null);

  // OpenCLI returns YouTube metadata as [{field,value}] with localized counts.
  const youtube = await runLocalSocialPostRead("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
    runCommand: async () => ({ status: "completed", data: [
      { field: "videoId", value: "dQw4w9WgXcQ" },
      { field: "title", value: "Never Gonna Give You Up" },
      { field: "channel", value: "Rick Astley" },
      { field: "views", value: "1799955450" },
      { field: "likes", value: "1930万" },
      { field: "duration", value: "213s" }
    ] })
  });
  assert.equal(youtube.status, "completed");
  assert.equal(youtube.result.post.platform, "youtube");
  assert.equal(youtube.result.post.author_handle, "Rick Astley");
  assert.equal(youtube.result.post.engagement.likes, 19300000);
  assert.equal(youtube.result.post.duration_seconds, 213);

  // TikTok has no single-video reader: match the id inside the creator's uploads.
  const tiktokUrl = "https://www.tiktok.com/@someone/video/7300000000000000000";
  assert.equal(localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_request", arguments: { capability: "social_post_read", params: { url: tiktokUrl } } }
  })?.platform, "tiktok");
  const tiktok = await runLocalSocialPostRead(tiktokUrl, {
    runCommand: async () => ({ status: "completed", data: { data: [
      { id: "7300000000000000000", desc: "caption", author: { uniqueId: "someone" },
        stats: { diggCount: 12, commentCount: 3, shareCount: 4, playCount: 5 } }
    ] } })
  });
  assert.equal(tiktok.status, "completed");
  assert.equal(tiktok.result.post.platform, "tiktok");
  assert.equal(tiktok.result.post.engagement.views, 5);

  // TikTok needs a browser login; an empty list plus failing whoami means "sign in".
  const signedOut = await runLocalSocialPostRead(tiktokUrl, {
    runCommand: async (_cmd, args) => args.includes("whoami")
      ? { status: "auth_required", error: "session cookies missing" }
      : { status: "provider_error", error: "EMPTY_RESULT" }
  });
  assert.equal(signedOut.status, "auth_required");
  assert.equal(signedOut.action_required.connector_id, "opencli-tiktok");

  assert.equal(parseCount("1.9亿"), 190000000);
  assert.equal(parseCount("19M"), 19000000);
  assert.equal(parseCount("abc"), undefined);
});

test("local bridge reads Bilibili, Reddit, and Xiaohongshu post URLs", async () => {
  const { localSocialPostRequest, runLocalSocialPostRead } =
    await import("../packages/agentrouter-mcp/server/local-social-post.js");

  const detect = (url) => localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: `read ${url}` } }
  });

  assert.equal(detect("https://www.bilibili.com/video/BV1qh3W6bEqf")?.platform, "bilibili");
  assert.equal(detect("https://b23.tv/abc123")?.platform, "bilibili");
  assert.equal(detect("https://www.reddit.com/r/programming/comments/1tlh5aj/x/")?.post_id, "1tlh5aj");
  assert.equal(detect("https://redd.it/1tlh5aj")?.platform, "reddit");
  assert.equal(detect("https://www.bilibili.com/video/notabv")?.platform, undefined);

  // Bilibili shares metadata as [{field,value}] with "name (mid: 1)" authors.
  const bilibili = await runLocalSocialPostRead("https://www.bilibili.com/video/BV1qh3W6bEqf", {
    runCommand: async () => ({ status: "completed", data: [
      { field: "bvid", value: "BV1qh3W6bEqf" },
      { field: "title", value: "标题" },
      { field: "author", value: "阿路 (mid: 12562611)" },
      { field: "duration", value: "2m29s (149s)" },
      { field: "view", value: "5625533" },
      { field: "like", value: "712776" },
      { field: "share", value: "23053" },
      { field: "coin", value: "164550" }
    ] })
  });
  assert.equal(bilibili.status, "completed");
  assert.equal(bilibili.result.post.author_handle, "阿路");
  assert.equal(bilibili.result.post.duration_seconds, 149);
  assert.equal(bilibili.result.post.engagement.shares, 23053);
  assert.equal(bilibili.result.post.coins, 164550);

  // `reddit read` returns the post plus its comment tree (L0/L1 entries).
  const reddit = await runLocalSocialPostRead("https://www.reddit.com/r/programming/comments/1tlh5aj/x/", {
    runCommand: async () => ({ status: "completed", data: [
      { type: "POST", author: "ChemicalRascal", score: 944, text: "Announcement: rules", created_utc: 1779544477 },
      { type: "L0", author: "a", text: "c1" },
      { type: "L1", author: "b", text: "c2" }
    ] })
  });
  assert.equal(reddit.status, "completed");
  assert.equal(reddit.result.post.author_handle, "ChemicalRascal");
  assert.equal(reddit.result.post.engagement.likes, 944);
  assert.equal(reddit.result.post.engagement.comments, 2);
  assert.equal(reddit.result.post.subreddit, "r/programming");

  // Xiaohongshu note reads are impossible without the signed xsec_token.
  const unsigned = await runLocalSocialPostRead(
    "https://www.xiaohongshu.com/explore/6839f1c6000000000d00f4b0",
    { runCommand: async () => ({ status: "provider_error", error: "requires a full signed URL" }) }
  );
  assert.equal(unsigned.status, "invalid_request");
  assert.equal(unsigned.action_required.code, "SIGNED_URL_REQUIRED");
});

test("Xiaohongshu share links resolve, and the signed-out login wall is not returned as content", async () => {
  const { localSocialPostRequest, runLocalSocialPostRead } =
    await import("../packages/agentrouter-mcp/server/local-social-post.js");

  // Share links arrive as http:// xhslink.cn URLs inside ordinary chat text.
  const shortLink = "http://xhslink.cn/o/5zGMV6AiWHZ";
  const detected = localSocialPostRequest({
    method: "tools/call",
    params: { name: "agentrouter_fetch", arguments: { task: `帮我看看这条小红书 ${shortLink}` } }
  });
  assert.equal(detected?.platform, "xiaohongshu");
  assert.equal(detected.short_link, true);

  const signedUrl = "https://www.xiaohongshu.com/discovery/item/6a69bb76000000000c014d94?xsec_token=ABC";
  const noteData = [
    { field: "title", value: "从王虹联想到burnout人群" },
    { field: "content", value: "正文内容" },
    { field: "author", value: "阿醒生存计划" },
    { field: "likes", value: "1203" },
    { field: "comments", value: "36" },
    { field: "collects", value: "531" }
  ];

  const resolved = await runLocalSocialPostRead(shortLink, {
    resolveUrl: async () => signedUrl,
    runCommand: async (_cmd, args) => {
      assert.equal(args[2], signedUrl, "the resolved signed URL must reach OpenCLI");
      return { status: "completed", data: noteData };
    }
  });
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.result.post.author_handle, "阿醒生存计划");
  assert.equal(resolved.result.post.engagement.likes, 1203);
  assert.equal(resolved.result.post.favorites, 531);

  // Signed out, Xiaohongshu serves the login wall with HTTP 200 and zeroed
  // counts; that must not be reported as the note's content.
  const loginWall = await runLocalSocialPostRead(signedUrl, {
    runCommand: async () => ({ status: "completed", data: [
      { field: "title", value: "手机号登录" },
      { field: "author", value: "" },
      { field: "content", value: "" },
      { field: "likes", value: "0" }
    ] })
  });
  assert.equal(loginWall.status, "auth_required");
  assert.equal(loginWall.action_required.connector_id, "opencli-xiaohongshu");

  // An unresolvable share link must say so rather than guess a note id.
  const unresolved = await runLocalSocialPostRead(shortLink, {
    resolveUrl: async () => null,
    runCommand: async () => assert.fail("must not call OpenCLI with an unresolved short link")
  });
  assert.equal(unresolved.action_required.code, "SHORT_LINK_UNRESOLVED");
});

test("connector guidance states that AgentRouter never asks for a Keychain password", async () => {
  const { runLocalSocialPostRead, BROWSER_CONNECTOR_SECURITY_NOTE } =
    await import("../packages/agentrouter-mcp/server/local-social-post.js");

  // The note has to name the actual macOS prompt, or a user cannot tell which
  // tool asked for it.
  assert.match(BROWSER_CONNECTOR_SECURITY_NOTE, /never asks for a system or Keychain password/);
  assert.match(BROWSER_CONNECTOR_SECURITY_NOTE, /Chrome Safe Storage/);
  assert.match(BROWSER_CONNECTOR_SECURITY_NOTE, /every site you are signed in to/);

  const offline = await runLocalSocialPostRead("https://x.com/a/status/123", {
    runCommand: async () => ({ status: "missing", error: "opencli is not installed" })
  });
  assert.equal(offline.action_required.code, "BROWSER_CONNECTOR_OFFLINE");
  assert.equal(offline.action_required.requires_system_password, false);
  assert.equal(offline.action_required.security_note, BROWSER_CONNECTOR_SECURITY_NOTE);

  const signedOut = await runLocalSocialPostRead("https://weibo.com/detail/5000000000000000", {
    runCommand: async () => ({ status: "auth_required", error: "not logged in" })
  });
  assert.equal(signedOut.action_required.code, "AUTH_REQUIRED");
  assert.equal(signedOut.action_required.requires_system_password, false);
  assert.equal(signedOut.action_required.security_note, BROWSER_CONNECTOR_SECURITY_NOTE);
  assert.match(signedOut.action_required.message, /never stores your credentials/);
});
