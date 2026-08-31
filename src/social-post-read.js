import { buildLocalSocialExecutionPlan } from "./local-social-privacy.js";
import { buildLocalBrowserHandoff } from "./local-browser-connector.js";

export function parseSocialPostUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) return null;
    const match = url.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]{1,30}\/status)\/(\d+)(?:\/)?$/);
    if (!match) return null;
    const path = url.pathname.replace(/\/$/, "");
    return {
      platform: "x",
      post_id: match[1],
      canonical_url: `https://x.com${path}`
    };
  } catch {
    return null;
  }
}

export function findSocialPostUrl(value) {
  const text = String(value || "");
  const candidates = text.match(/https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const parsed = parseSocialPostUrl(candidate.replace(/[),.;!?，。；！？]+$/, ""));
    if (parsed) return parsed;
  }
  return null;
}

export async function runSocialPostReadCapability(params = {}, options = {}) {
  const parsed = parseSocialPostUrl(params.url || params.target);
  if (!parsed) {
    return {
      ok: false,
      status: "invalid_request",
      error: {
        code: "SOCIAL_POST_URL_INVALID",
        message: "A public X status URL is required."
      }
    };
  }

  const attempts = [];
  for (const provider of options.providers?.[parsed.platform] || []) {
    if (typeof provider.readPost !== "function") continue;
    let result;
    try {
      result = await provider.readPost(parsed.canonical_url);
    } catch (error) {
      result = { status: "provider_error", error: error.message, rows: [] };
    }
    attempts.push({
      backend_id: provider.id,
      status: result.status,
      error: result.error || null
    });
    const row = Array.isArray(result.rows) ? result.rows[0] : null;
    if (result.status === "completed" && row) {
      if (!rowMatchesRequestedPost(row, parsed)) {
        attempts[attempts.length - 1] = {
          ...attempts[attempts.length - 1],
          status: "identity_mismatch",
          error: `Provider returned a different post than ${parsed.post_id}.`
        };
        continue;
      }
      return completedResult(parsed, row, provider.id, attempts);
    }
  }

  return localConnectorRequired(parsed, attempts, options.consumerContext);
}

export function completedSocialPostReadResult(parsed, row, backendId, attempts = []) {
  return completedResult(parsed, row, backendId, attempts);
}

function completedResult(parsed, row, backendId, attempts) {
  if (!rowMatchesRequestedPost(row, parsed)) {
    return {
      ok: false,
      status: "quality_failure",
      error: {
        code: "SOCIAL_POST_IDENTITY_MISMATCH",
        message: "Provider content could not be tied to the requested post URL."
      },
      source: { backend_id: backendId, attempts }
    };
  }
  const post = {
    platform: parsed.platform,
    post_id: String(row.id || parsed.post_id),
    canonical_url: parsed.canonical_url,
    text: clean(row.text || row.full_text || row.content, 20000) || null,
    author_handle: clean(row.author_handle || row.author?.username || row.author || row.username, 120) || null,
    published_at: row.published_at || row.created_at || null,
    engagement: normalizeEngagement(row.engagement || row.public_metrics),
    verification_status: "source_url_verified"
  };
  return {
    ok: true,
    status: "completed",
    protocol: {
      protocol_version: "agentrouter_social_post_read_v1",
      access: "read_only",
      credential_policy: "never_return",
      raw_result_policy: "local_only_when_local_connector_is_used"
    },
    request: {
      capability: "social_post_read",
      params: { url: parsed.canonical_url, platform: parsed.platform }
    },
    result: { post },
    source: { backend_id: backendId, attempts },
    verification: {
      source_url_preserved: true,
      post_id_matches_url: post.post_id === parsed.post_id,
      author_present: Boolean(post.author_handle),
      published_at_present: Boolean(post.published_at)
    }
  };
}

function rowMatchesRequestedPost(row, parsed) {
  const rowId = String(row?.id || row?.post_id || row?.tweet_id || "").trim();
  if (rowId) return rowId === parsed.post_id;
  const rowUrl = parseSocialPostUrl(row?.url || row?.canonical_url || row?.permalink);
  return rowUrl?.post_id === parsed.post_id;
}

function localConnectorRequired(parsed, attempts, consumerContext = {}) {
  const localExecutionPlan = buildLocalSocialExecutionPlan({
    platform: parsed.platform,
    operation: "read_post",
    target: parsed.canonical_url,
    limit: 1
  });
  const handoff = buildLocalBrowserHandoff({
    platform: parsed.platform,
    operation: "read_post",
    target: parsed.canonical_url,
    localExecutionPlan,
    consumerContext
  });
  const nativeBrowser = handoff.selected_adapter !== "opencli";
  return {
    ok: false,
    status: "local_connector_required",
    request: {
      capability: "social_post_read",
      params: { url: parsed.canonical_url, platform: parsed.platform }
    },
    action_required: {
      code: "LOCAL_CONNECTOR_REQUIRED",
      message: nativeBrowser
        ? "Read this X post with the AI client's built-in browser, then return the structured result through agentrouter_complete_handoff. Browser login remains local."
        : "Read this X post through the AgentRouter MCP bridge on the user's device, where the browser login remains local.",
      reload_after_bridge_update: !nativeBrowser
    },
    handoff: { ...handoff, capability: "social_post_read" },
    fallback_allowed: nativeBrowser,
    local_execution_plan: localExecutionPlan,
    attempts
  };
}

function normalizeEngagement(value = {}) {
  const result = {};
  const aliases = {
    likes: ["likes", "like_count", "favorite_count"],
    comments: ["comments", "reply_count"],
    shares: ["shares", "retweet_count"],
    views: ["views", "view_count"],
    favorites: ["favorites", "bookmark_count"]
  };
  for (const [target, keys] of Object.entries(aliases)) {
    const found = keys.map((key) => value?.[key]).find((item) => Number.isFinite(Number(item)));
    if (found !== undefined) result[target] = Number(found);
  }
  return result;
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
