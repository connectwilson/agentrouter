import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLocalBrowserHandoff,
  completeLocalBrowserHandoff,
  createLocalBrowserConnector
} from "../src/local-browser-connector.js";

const target = "https://x.com/marclou/status/2081890388298874880";

test("local browser handoff prefers a declared Codex native browser over OpenCLI", () => {
  const handoff = buildLocalBrowserHandoff({
    platform: "x",
    operation: "read_post",
    target,
    consumerContext: {
      local_browser: {
        adapter: "codex_browser",
        available: true,
        session_mode: "isolated_profile",
        operations: ["navigate", "read_post"]
      }
    }
  });

  assert.equal(handoff.handoff_version, "agentrouter_local_browser_handoff_v2");
  assert.equal(handoff.kind, "local_browser_execution");
  assert.equal(handoff.selected_adapter, "codex_browser");
  assert.deepEqual(handoff.fallback_adapters, []);
  assert.equal(handoff.fallback, undefined);
  assert.deepEqual(handoff.allowed_origins, ["https://x.com", "https://www.x.com", "https://twitter.com", "https://www.twitter.com"]);
  assert.match(handoff.handoff_token, /^arh1\./);
  assert.ok(handoff.expires_at);
  assert.equal(handoff.permissions.access, "read_only");
  assert.equal(handoff.permissions.write_actions, "denied");
  assert.equal(handoff.completion.tool, "agentrouter_complete_handoff");
  assert.equal(handoff.preserve_route_context, true);
});

test("local browser handoff supports Claude in Chrome and falls back to OpenCLI", () => {
  const claude = buildLocalBrowserHandoff({
    platform: "x",
    operation: "read_post",
    target,
    consumerContext: {
      local_browser: {
        adapter: "claude_in_chrome",
        available: true,
        session_mode: "shared_profile",
        operations: ["read_post"]
      }
    }
  });
  assert.equal(claude.selected_adapter, "claude_in_chrome");

  const fallback = buildLocalBrowserHandoff({ platform: "x", operation: "read_post", target });
  assert.equal(fallback.selected_adapter, "opencli");
  assert.deepEqual(fallback.fallback_adapters, []);
  assert.equal(fallback.compatibility_mode, "legacy_client_opencli");
});

test("native browser handoff supports social search before the OpenCLI fallback", () => {
  const handoff = buildLocalBrowserHandoff({
    platform: "x",
    operation: "search",
    params: { query: "crypto markets", limit: 5, from: "2026-09-01", to: "2026-09-02" },
    consumerContext: {
      local_browser: {
        adapter: "codex_browser",
        available: true,
        operations: ["navigate", "search"]
      }
    }
  });

  assert.equal(handoff.selected_adapter, "codex_browser");
  assert.equal(handoff.operation, "search");
  assert.equal(handoff.target, "https://x.com/search");
  assert.deepEqual(handoff.request.params, {
    platform: "x",
    operation: "search",
    query: "crypto markets",
    limit: 5,
    from: "2026-09-01",
    to: "2026-09-02"
  });
  assert.equal(handoff.fallback, undefined);
  assert.deepEqual(handoff.completion.result_fields, ["canonical_url", "items"]);
});

test("native browser completion normalizes multi-result search evidence", () => {
  const connector = createLocalBrowserConnector({ secret: "0123456789abcdef0123456789abcdef" });
  const handoff = connector.buildHandoff({
    platform: "x",
    operation: "search",
    params: { query: "crypto", limit: 2 },
    consumerContext: {
      local_browser: { adapter: "codex_browser", available: true, operations: ["search"] }
    }
  });
  const completed = connector.completeHandoff({
    handoff,
    result: {
      canonical_url: "https://x.com/search?q=crypto",
      items: [
        { id: "101", url: "https://x.com/a/status/101", text: "crypto one", author: "a", published_at: "2026-09-02T00:00:00Z", engagement: { likes: 8 } },
        { id: "102", url: "https://x.com/b/status/102", text: "crypto two", author_handle: "b", published_at: "2026-09-02T01:00:00Z", engagement: { views: 20 } }
      ]
    }
  });

  assert.equal(completed.ok, true);
  assert.match(completed.request_id, /^local_search_x_/);
  assert.equal(completed.request.capability, "social_search");
  assert.equal(completed.result.item_count, 2);
  assert.equal(completed.result.items[0].author, "a");
  assert.deepEqual(completed.result.items[1].engagement, { views: 20 });
  assert.equal(completed.source.backend_id, "codex_browser");
  assert.equal(completed.source.fallback_used, false);
  assert.equal(completed.consumer_feedback_request.context.operation, "search");
});

test("account history, threads, and trends are native browser operations", () => {
  const connector = createLocalBrowserConnector({ secret: "0123456789abcdef0123456789abcdef" });
  const context = {
    local_browser: {
      adapter: "claude_in_chrome",
      available: true,
      operations: ["read_user_posts", "read_thread", "read_trends"]
    }
  };

  const account = connector.buildHandoff({
    platform: "x",
    operation: "read_user_posts",
    params: { handle: "lookonchain", limit: 10 },
    consumerContext: context
  });
  assert.equal(account.target, "https://x.com/lookonchain");
  assert.equal(account.selected_adapter, "claude_in_chrome");

  const thread = connector.buildHandoff({
    platform: "x",
    operation: "read_thread",
    target: "https://x.com/lookonchain/status/1234567890",
    consumerContext: context
  });
  assert.equal(thread.operation, "read_thread");

  const trends = connector.buildHandoff({
    platform: "x",
    operation: "read_trends",
    params: { limit: 5, category: "crypto" },
    consumerContext: context
  });
  assert.equal(trends.target, "https://x.com/explore/tabs/trending");
});

test("native account completion rejects posts from a different handle", () => {
  const connector = createLocalBrowserConnector({ secret: "0123456789abcdef0123456789abcdef" });
  const handoff = connector.buildHandoff({
    platform: "x",
    operation: "read_user_posts",
    params: { handle: "lookonchain", limit: 5 },
    consumerContext: {
      local_browser: { adapter: "codex_browser", available: true, operations: ["read_user_posts"] }
    }
  });
  const completed = connector.completeHandoff({
    handoff,
    result: {
      canonical_url: "https://x.com/lookonchain",
      items: [{ id: "123", url: "https://x.com/lookalike/status/123", text: "wrong account", author: "lookalike" }]
    }
  });

  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "HANDOFF_ITEM_IDENTITY_MISMATCH");

  const corrected = connector.completeHandoff({
    handoff,
    result: {
      canonical_url: "https://x.com/lookonchain",
      items: [{ id: "124", url: "https://x.com/lookonchain/status/124", text: "correct account", author: "lookonchain" }]
    }
  });
  assert.equal(corrected.ok, true, "invalid caller evidence must not consume the signed handoff");
});

test("legacy clients only select OpenCLI when no native operation is declared", () => {
  const native = buildLocalBrowserHandoff({
    platform: "x",
    operation: "read_trends",
    params: { limit: 5 },
    consumerContext: {
      local_browser: { adapter: "codex_browser", available: true, operations: ["read_trends"] }
    }
  });
  const legacy = buildLocalBrowserHandoff({ platform: "x", operation: "read_trends", params: { limit: 5 } });

  assert.equal(native.selected_adapter, "codex_browser");
  assert.equal(legacy.selected_adapter, "opencli");
  assert.deepEqual(legacy.fallback_adapters, []);
});

test("native browser completion normalizes evidence and never returns browser secrets", () => {
  const handoff = buildLocalBrowserHandoff({
    platform: "x",
    operation: "read_post",
    target,
    consumerContext: {
      local_browser: { adapter: "codex_browser", available: true, operations: ["read_post"] }
    }
  });
  const completed = completeLocalBrowserHandoff({
    handoff,
    result: {
      canonical_url: target,
      post_id: "2081890388298874880",
      text: "Native browser result",
      author_handle: "marclou",
      published_at: "2026-07-29T00:00:00Z",
      engagement: { likes: 12, views: 200 },
      cookie: "must-not-escape",
      auth_token: "must-not-escape"
    }
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.status, "completed");
  assert.equal(completed.source.backend_id, "codex_browser");
  assert.match(completed.request_id, /^local_post_x_/);
  assert.equal(completed.result.post.text, "Native browser result");
  assert.equal(completed.verification.source_url_matched, true);
  assert.equal(completed.result.post.verification_status, "caller_attested");
  assert.equal(completed.verification.content_verified, false);
  assert.equal(completed.consumer_feedback_request.tool, "agentrouter_feedback");
  assert.doesNotMatch(JSON.stringify(completed), /must-not-escape|cookie|auth_token/i);
});

test("native browser completion rejects evidence from a different origin", () => {
  const handoff = buildLocalBrowserHandoff({ platform: "x", operation: "read_post", target });
  const completed = completeLocalBrowserHandoff({
    handoff,
    result: { canonical_url: "https://evil.example/status/2081890388298874880", text: "wrong source" }
  });
  assert.equal(completed.ok, false);
  assert.equal(completed.status, "invalid_handoff_result");
  assert.equal(completed.error.code, "HANDOFF_SOURCE_NOT_ALLOWED");
});
