import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLocalBrowserHandoff,
  completeLocalBrowserHandoff
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

  assert.equal(handoff.handoff_version, "agentrouter_local_browser_handoff_v1");
  assert.equal(handoff.kind, "local_browser_execution");
  assert.equal(handoff.selected_adapter, "codex_browser");
  assert.deepEqual(handoff.fallback_adapters, ["opencli"]);
  assert.deepEqual(handoff.allowed_origins, ["https://x.com", "https://twitter.com"]);
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
  assert.equal(completed.verification.source_url_preserved, true);
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
