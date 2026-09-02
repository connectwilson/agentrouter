import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createLocalBrowserConnector } from "../packages/agentrouter-mcp/server/local-browser-connector.js";
import { createExpiringTokenCache } from "../packages/agentrouter-mcp/server/feedback-token-cache.js";

const xTarget = "https://x.com/marclou/status/2081890388298874880";
const nativeContext = {
  local_browser: { adapter: "codex_browser", available: true, operations: ["read_post"] }
};

test("published MCP files never import modules outside the npm package", async () => {
  const packageRoot = path.resolve("packages/agentrouter-mcp");
  const files = await jsFiles(packageRoot);
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      assert.ok(resolved.startsWith(`${packageRoot}${path.sep}`), `${path.relative(packageRoot, file)} imports outside package: ${match[1]}`);
      await fs.access(resolved);
    }
  }
});

test("browser handoffs are signed, expiring, immutable and single-use", () => {
  let now = Date.parse("2026-08-28T00:00:00Z");
  const connector = createLocalBrowserConnector({
    secret: "test-secret-with-enough-entropy",
    now: () => now,
    ttlMs: 60_000
  });
  const handoff = connector.buildHandoff({
    platform: "x",
    operation: "read_post",
    target: xTarget,
    consumerContext: nativeContext
  });

  assert.match(handoff.handoff_token, /^arh1\./);
  assert.equal(handoff.issued_at, "2026-08-28T00:00:00.000Z");
  assert.equal(handoff.expires_at, "2026-08-28T00:01:00.000Z");
  assert.deepEqual(handoff.fallback_adapters, []);
  assert.equal(handoff.fallback, undefined);

  const forged = {
    ...handoff,
    target: "https://evil.example/status/2081890388298874880",
    allowed_origins: ["https://evil.example"],
    platform: "reddit",
    selected_adapter: "opencli"
  };
  const rejected = connector.completeHandoff({
    handoff: forged,
    result: { canonical_url: forged.target, text: "forged" }
  });
  assert.equal(rejected.error.code, "HANDOFF_SOURCE_NOT_ALLOWED");

  const completed = connector.completeHandoff({
    handoff,
    result: {
      canonical_url: "https://www.x.com/marclou/status/2081890388298874880",
      text: "real result",
      author_handle: "marclou"
    }
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.source.backend_id, "codex_browser");
  assert.equal(completed.result.post.verification_status, "caller_attested");
  assert.equal(completed.verification.source_url_matched, true);
  assert.match(completed.evidence.sha256, /^[a-f0-9]{64}$/);

  const replay = connector.completeHandoff({ handoff, result: { canonical_url: xTarget, text: "again" } });
  assert.equal(replay.error.code, "HANDOFF_ALREADY_CONSUMED");

  const expiring = connector.buildHandoff({ platform: "x", operation: "read_post", target: xTarget, consumerContext: nativeContext });
  now += 61_000;
  const expired = connector.completeHandoff({ handoff: expiring, result: { canonical_url: xTarget, text: "late" } });
  assert.equal(expired.error.code, "HANDOFF_EXPIRED");
});

test("browser handoff canonicalization covers every locally parsed social platform", () => {
  const connector = createLocalBrowserConnector({ secret: "platform-test-secret" });
  const cases = [
    ["x", "https://twitter.com/i/status/123", "https://x.com/i/status/123", "123"],
    ["tiktok", "https://www.tiktok.com/@creator/video/7300000000000000000", "https://m.tiktok.com/@creator/video/7300000000000000000", "7300000000000000000"],
    ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["bilibili", "https://www.bilibili.com/video/BV1qh3W6bEqf", "https://m.bilibili.com/video/BV1qh3W6bEqf", "BV1qh3W6bEqf"],
    ["reddit", "https://www.reddit.com/r/test/comments/abc123/title/", "https://old.reddit.com/r/test/comments/abc123/title/", "abc123"],
    ["xiaohongshu", "https://www.xiaohongshu.com/explore/66abcdef1234567890123456", "https://xiaohongshu.com/explore/66abcdef1234567890123456", "66abcdef1234567890123456"],
    ["zhihu", "https://www.zhihu.com/question/123/answer/456", "https://zhihu.com/question/123/answer/456", "456"],
    ["weibo", "https://weibo.com/12345/Abcdef1", "https://www.weibo.com/12345/Abcdef1", "Abcdef1"]
  ];
  for (const [platform, target, returned, postId] of cases) {
    const handoff = connector.buildHandoff({ platform, operation: "read_post", target, consumerContext: nativeContext });
    const result = connector.completeHandoff({ handoff, result: { canonical_url: returned, text: platform } });
    assert.equal(result.status, "completed", `${platform}: ${result.error?.code || "failed"}`);
    assert.equal(result.result.post.post_id, postId);
  }
});

test("local feedback tokens expire, are bounded, and can be consumed", () => {
  let now = 1_000;
  const cache = createExpiringTokenCache({ now: () => now, ttlMs: 100, maxEntries: 2 });
  cache.set("a", "token-a");
  cache.set("b", "token-b");
  cache.set("c", "token-c");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "token-b");
  cache.delete("b");
  assert.equal(cache.get("b"), undefined);
  now = 1_101;
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.size, 0);
});

async function jsFiles(root) {
  const output = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await jsFiles(target));
    else if (entry.name.endsWith(".js")) output.push(target);
  }
  return output;
}
