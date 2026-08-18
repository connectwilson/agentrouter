// Keyword search across social platforms, run locally through the OpenCLI
// browser connector. The hosted server has no browser, so search requests that
// reach it can only fail; intercepting them in the bridge is what makes
// "search X for crypto PM jobs" work without an X API token.
import { spawn } from "node:child_process";

import { BROWSER_CONNECTOR_SECURITY_NOTE, buildLocalCliEnvironment } from "./local-social-post.js";

const PLATFORMS = {
  x: { label: "X (x.com)", args: (query, limit) => ["twitter", "search", query, "--limit", String(limit), "-f", "json"], timeout: 60000 },
  reddit: { label: "Reddit", args: (query, limit) => ["reddit", "search", query, "--limit", String(limit), "-f", "json"], timeout: 60000 },
  xiaohongshu: { label: "Xiaohongshu", args: (query, limit) => ["xiaohongshu", "search", query, "--limit", String(limit), "-f", "json"], timeout: 90000 },
  bilibili: { label: "Bilibili", args: (query, limit) => ["bilibili", "search", query, "--limit", String(limit), "-f", "json"], timeout: 90000 },
  youtube: { label: "YouTube", args: (query, limit) => ["youtube", "search", query, "--limit", String(limit), "-f", "json"], timeout: 120000 },
  zhihu: { label: "Zhihu", args: (query, limit) => ["zhihu", "search", query, "--limit", String(limit), "-f", "json"], timeout: 90000 },
  weibo: { label: "Weibo", args: (query, limit) => ["weibo", "search", query, "--limit", String(limit), "-f", "json"], timeout: 90000 }
};

export const LOCAL_SEARCH_PLATFORMS = Object.keys(PLATFORMS);

// Aliases the hosted catalog and ordinary agent phrasing both use.
const PLATFORM_ALIASES = {
  x: "x", twitter: "x", "x.com": "x",
  reddit: "reddit",
  xiaohongshu: "xiaohongshu", xhs: "xiaohongshu", rednote: "xiaohongshu", 小红书: "xiaohongshu",
  bilibili: "bilibili", bili: "bilibili", 哔哩哔哩: "bilibili",
  youtube: "youtube", yt: "youtube",
  zhihu: "zhihu", 知乎: "zhihu",
  weibo: "weibo", 微博: "weibo"
};

export function normalizeSearchPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLATFORM_ALIASES[key] || null;
}

// Only structured calls are intercepted. Natural-language tasks stay with the
// hosted router, which knows about paid services the bridge cannot see.
export function localSocialSearchRequest(message) {
  if (message?.method !== "tools/call") return null;
  if (message.params?.name !== "agentrouter_request") return null;
  const args = message.params?.arguments || {};
  const capability = String(args.capability || "");
  if (!["social_search", "social_user_voice_research", "social_keyword_search"].includes(capability)) return null;
  const params = args.params || {};
  const platform = normalizeSearchPlatform(params.platform || params.source);
  if (!platform) return null;
  const query = String(params.query || params.keyword || params.task || "").trim();
  if (!query) return null;
  return { platform, query, limit: params.limit, capability };
}

export async function runLocalSocialSearch({ platform, query, limit }, options = {}) {
  const definition = PLATFORMS[platform];
  if (!definition) {
    return {
      ok: false,
      status: "invalid_request",
      error: {
        code: "PLATFORM_NOT_SUPPORTED",
        message: `Local search supports ${LOCAL_SEARCH_PLATFORMS.join(", ")}.`
      }
    };
  }
  const runCommand = options.runCommand || spawnCommand;
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 10), 1), 50);
  const result = await runCommand("opencli", definition.args(query, bounded), { timeout: definition.timeout });
  const attempts = [{ backend_id: `opencli-${platform}`, status: result.status, error: result.error || null }];

  if (result.status === "completed") {
    const rows = normalizeRows(result.data).slice(0, bounded);
    if (rows.length) return completed(platform, query, rows, attempts);
    // An empty result set is a real answer, not a connector failure, but only
    // when the session is actually usable — otherwise report the auth problem.
    const who = await runCommand("opencli", [platform === "x" ? "twitter" : platform, "whoami", "-f", "json"], { timeout: 30000 });
    attempts.push({ backend_id: `opencli-${platform}-whoami`, status: who.status, error: who.error || null });
    if (who.status === "completed") return completed(platform, query, [], attempts);
    return authRequired(platform, query, attempts);
  }
  if (result.status === "auth_required") return authRequired(platform, query, attempts);
  if (result.status === "missing") return connectorOffline(platform, query, attempts);
  return connectorOffline(platform, query, attempts);
}

function normalizeRows(payload) {
  const value = typeof payload === "string" ? safeJson(payload) : payload;
  const list = Array.isArray(value) ? value
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.results) ? value.results
    : Array.isArray(value?.items) ? value.items
    : [];
  return list.map((row) => ({
    id: row?.id ?? row?.note_id ?? row?.bvid ?? row?.aweme_id ?? null,
    title: clean(row?.title ?? row?.text ?? row?.desc ?? row?.content, 400),
    text: clean(row?.text ?? row?.desc ?? row?.content ?? row?.description, 4000),
    author: clean(typeof row?.author === "string" ? row.author : row?.author?.name ?? row?.author?.uniqueId ?? row?.username ?? row?.nickname, 120),
    url: clean(row?.url ?? row?.link ?? row?.short_link, 800),
    published_at: row?.created_at ?? row?.publish_time ?? row?.published_at ?? null,
    engagement: pickEngagement(row)
  })).filter((row) => row.title || row.text || row.url);
}

function pickEngagement(row = {}) {
  const out = {};
  const map = { likes: ["likes", "like_count", "diggCount", "score", "upvotes"], comments: ["comments", "comment_count", "reply_count"], shares: ["shares", "retweets", "share_count"], views: ["views", "view_count", "play_count"] };
  for (const [key, aliases] of Object.entries(map)) {
    const found = aliases.map((alias) => row?.[alias]).find((value) => Number.isFinite(Number(value)));
    if (found !== undefined) out[key] = Number(found);
  }
  return out;
}

// Local runs are free, but they still need a handle: without a request_id an
// agent cannot rate a result it was happy with, so reputation would only ever
// reflect the paid paths that fail.
export function localRequestId(prefix) {
  return `local_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

  // Matches the paid path's contract: an agent that only rates failures leaves a
  // service's reputation made of complaints. Successful calls are exactly the
  // ones that need rating, so the request says so in the same shape.
export function localFeedbackRequest(requestId, serviceId, context) {
  return {
    feedback_request_version: "agent_consumer_feedback_request_v1",
    must_submit: true,
    timing: "after_final_answer_or_after_deciding_result_usability",
    endpoint: "/agent-router/feedback",
    method: "POST",
    request_id: requestId,
    service_id: serviceId,
    tool: "agentrouter_feedback",
    instructions: [
      "Submit after deciding whether these results helped answer the user's task.",
      "Judge intent fit and usefulness for this call only; do not infer domain truth beyond the returned data.",
      "If another source was needed, set answer_useful to partial or no and list missing_fields.",
      "Do not skip this for successful calls — reputation built only from failures is misleading."
    ],
    required_fields: ["intent_fit", "answer_useful", "reason"],
    example: {
      request_id: requestId,
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        confidence: 0.9,
        reason: "Results matched the question and were used in the answer."
      }
    },
    context
  };
}

function completed(platform, query, rows, attempts) {
  const requestId = localRequestId(`search_${platform}`);
  return {
    ok: true,
    status: rows.length ? "completed" : "no_results",
    request_id: requestId,
    service_id: `local_social_${platform}`,
    protocol: {
      protocol_version: "agentrouter_social_search_v1",
      execution_location: "user_device",
      access: "read_only",
      credential_policy: "never_upload",
      raw_result_policy: "local_only"
    },
    request: { capability: "social_search", params: { platform, query } },
    result: { items: rows, item_count: rows.length },
    source: { backend_id: `opencli-${platform}`, attempts },
    consumer_feedback_request: localFeedbackRequest(requestId, `local_social_${platform}`, { platform, query, capability: "social_search" })
  };
}

function authRequired(platform, query, attempts) {
  return {
    ok: false,
    status: "auth_required",
    request: { capability: "social_search", params: { platform, query } },
    action_required: {
      code: "AUTH_REQUIRED",
      connector_id: `opencli-${platform}`,
      message: `Sign in to ${PLATFORMS[platform].label} in Chrome, then retry. AgentRouter searches through that logged-in session and never stores your credentials.`,
      requires_system_password: false,
      security_note: BROWSER_CONNECTOR_SECURITY_NOTE,
      credential_access: "browser_managed",
      permissions: { access: "read_only", write_actions: "denied" }
    },
    attempts
  };
}

function connectorOffline(platform, query, attempts) {
  return {
    ok: false,
    status: "browser_connector_offline",
    request: { capability: "social_search", params: { platform, query } },
    action_required: {
      code: "BROWSER_CONNECTOR_OFFLINE",
      connector_id: `opencli-${platform}`,
      message: "Open Chrome and reconnect the OpenCLI browser extension, then retry.",
      requires_system_password: false,
      security_note: BROWSER_CONNECTOR_SECURITY_NOTE,
      credential_access: "browser_managed",
      permissions: { access: "read_only", write_actions: "denied" }
    },
    attempts
  };
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { env: buildLocalCliEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(0, 4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 2000); });
    child.on("error", (error) => finish(error.code === "ENOENT"
      ? { status: "missing", error: `${command} is not installed` }
      : { status: "provider_error", error: error.message }));
    child.on("close", (code) => {
      if (code === 0) return finish({ status: "completed", data: safeJson(stdout) || stdout });
      const auth = /auth_required|auth|login|cookie|session/i.test(`${stderr}\n${stdout}`);
      finish({ status: auth ? "auth_required" : "provider_error", error: stderr.trim() || `${command} exited ${code}` });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "provider_error", error: `${command} timed out` });
    }, Number(options.timeout) || 60000);
  });
}
