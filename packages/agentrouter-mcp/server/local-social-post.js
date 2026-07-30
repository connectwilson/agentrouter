import { spawn } from "node:child_process";
import path from "node:path";

export async function runLocalSocialPostRead(value, options = {}) {
  const parsed = parseXStatusUrl(value);
  if (!parsed) return invalidUrl();
  const runCommand = options.runCommand || spawnCommand;
  const attempts = [{
    command: "opencli",
    args: ["twitter", "thread", parsed.canonical_url, "--limit", "1", "-f", "json"]
  }];
  const allowCredentialFallback = options.allowCredentialFallback === true
    || process.env.AGENTROUTER_ALLOW_TWITTER_CLI_FALLBACK === "1";
  if (allowCredentialFallback) {
    attempts.push({
      command: "twitter",
      args: ["tweet", parsed.canonical_url, "-n", "0", "--json"]
    });
  }
  const diagnostics = [];
  for (const attempt of attempts) {
    const result = await runCommand(attempt.command, attempt.args, { timeout: 45000 });
    diagnostics.push({
      backend_id: attempt.command === "opencli" ? "opencli-twitter" : "twitter-cli",
      status: result.status,
      error: result.error || null
    });
    if (result.status !== "completed") continue;
    const row = extractTweet(result.data, parsed);
    if (row) return completed(parsed, row, diagnostics.at(-1).backend_id, diagnostics);
  }
  if (!allowCredentialFallback) return browserConnectorOffline(parsed, diagnostics);
  return {
    ok: false,
    status: diagnostics.some((item) => item.status === "auth_required") ? "auth_required" : "local_connector_unavailable",
    request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: "x" } },
    action_required: {
      code: diagnostics.some((item) => item.status === "auth_required") ? "AUTH_REQUIRED" : "LOCAL_CONNECTOR_UNAVAILABLE",
      message: "Install the read-only Twitter CLI or sign in to X in the local browser session, then retry."
    },
    attempts: diagnostics
  };
}

function browserConnectorOffline(parsed, attempts) {
  return {
    ok: false,
    status: "browser_connector_offline",
    request: {
      capability: "social_post_read",
      params: { url: parsed.canonical_url, platform: "x" }
    },
    action_required: {
      code: "BROWSER_CONNECTOR_OFFLINE",
      connector_id: "opencli-twitter",
      message: "Open Chrome, enable the OpenCLI browser extension, and reconnect it before retrying.",
      requires_system_password: false,
      credential_access: "browser_managed",
      permissions: {
        access: "read_only",
        write_actions: "denied"
      }
    },
    attempts
  };
}

export function localSocialPostRequest(message) {
  if (message?.method !== "tools/call") return null;
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  if (name === "agentrouter_request" && args.capability === "social_post_read") {
    return parseXStatusUrl(args.params?.url || args.params?.target);
  }
  if (name !== "agentrouter_fetch" && name !== "agentrouter_ask") return null;
  return findXStatusUrl(args.task || args.query);
}

function parseXStatusUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]{1,30}\/status)\/(\d+)(?:\/)?$/);
    if (!match) return null;
    return {
      post_id: match[1],
      canonical_url: `https://x.com${url.pathname.replace(/\/$/, "")}`
    };
  } catch {
    return null;
  }
}

function findXStatusUrl(value) {
  const candidates = String(value || "").match(/https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const parsed = parseXStatusUrl(candidate.replace(/[),.;!?，。；！？]+$/, ""));
    if (parsed) return parsed;
  }
  return null;
}

function extractTweet(payload, parsed) {
  const value = typeof payload === "string" ? safeJson(payload) : payload;
  const candidates = [
    value?.tweet,
    value?.data?.tweet,
    value?.data,
    value,
    ...(Array.isArray(value?.tweets) ? value.tweets : []),
    ...(Array.isArray(value) ? value : [])
  ].filter((item) => item && typeof item === "object");
  const tweet = candidates.find((item) =>
    String(item.id || item.tweet_id || item.rest_id || "") === parsed.post_id
  ) || candidates.find((item) => item.text || item.full_text || item.legacy?.full_text);
  if (!tweet) return null;
  const legacy = tweet.legacy || {};
  return {
    id: tweet.id || tweet.tweet_id || tweet.rest_id || parsed.post_id,
    text: tweet.text || tweet.full_text || legacy.full_text || tweet.content,
    author: (typeof tweet.author === "string" ? tweet.author : tweet.author?.username)
      || tweet.user?.screen_name
      || tweet.username
      || legacy.screen_name,
    published_at: tweet.published_at || tweet.created_at || legacy.created_at || null,
    engagement: tweet.engagement || tweet.public_metrics || {
      like_count: tweet.likes ?? legacy.favorite_count,
      reply_count: tweet.replies ?? legacy.reply_count,
      retweet_count: tweet.retweets ?? legacy.retweet_count,
      view_count: (typeof tweet.views === "object" ? tweet.views?.count : tweet.views)
    }
  };
}

function completed(parsed, row, backendId, attempts) {
  return {
    ok: true,
    status: "completed",
    protocol: {
      protocol_version: "agentrouter_social_post_read_v1",
      execution_location: "user_device",
      access: "read_only",
      credential_policy: "never_upload",
      raw_result_policy: "local_only"
    },
    request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: "x" } },
    result: {
      post: {
        platform: "x",
        post_id: String(row.id || parsed.post_id),
        canonical_url: parsed.canonical_url,
        text: String(row.text || "").trim().slice(0, 20000) || null,
        author_handle: String(row.author || "").trim().slice(0, 120) || null,
        published_at: row.published_at || null,
        engagement: normalizeEngagement(row.engagement),
        verification_status: "source_url_verified"
      }
    },
    source: { backend_id: backendId, attempts },
    verification: {
      source_url_preserved: true,
      post_id_matches_url: String(row.id || parsed.post_id) === parsed.post_id
    }
  };
}

function normalizeEngagement(value = {}) {
  const result = {};
  const aliases = {
    likes: ["likes", "like_count", "favorite_count"],
    comments: ["comments", "reply_count"],
    shares: ["shares", "retweet_count"],
    views: ["views", "view_count"]
  };
  for (const [target, keys] of Object.entries(aliases)) {
    const found = keys.map((key) => value?.[key]).find((item) => Number.isFinite(Number(item)));
    if (found !== undefined) result[target] = Number(found);
  }
  return result;
}

function invalidUrl() {
  return {
    ok: false,
    status: "invalid_request",
    error: { code: "SOCIAL_POST_URL_INVALID", message: "A public X status URL is required." }
  };
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
    const child = spawn(command, args, {
      env: buildLocalCliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
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
      const auth = /auth|login|cookie|session/i.test(stderr);
      return finish({ status: auth ? "auth_required" : "provider_error", error: stderr.trim() || `${command} exited ${code}` });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "provider_error", error: `${command} timed out` });
    }, Number(options.timeout) || 45000);
  });
}

export function buildLocalCliEnvironment(environment = process.env) {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME"
  ];
  const safeEnvironment = Object.fromEntries(
    allowed
      .filter((key) => typeof environment[key] === "string")
      .map((key) => [key, environment[key]])
  );
  const userHome = environment.HOME || environment.USERPROFILE;
  const searchPaths = [
    userHome && path.join(userHome, ".npm-global", "bin"),
    userHome && path.join(userHome, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    environment.PATH
  ].filter(Boolean);
  safeEnvironment.PATH = [...new Set(searchPaths)].join(path.delimiter);
  return safeEnvironment;
}
