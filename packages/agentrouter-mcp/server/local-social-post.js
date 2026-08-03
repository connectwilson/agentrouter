import { spawn } from "node:child_process";
import path from "node:path";

export async function runLocalSocialPostRead(value, options = {}) {
  const parsed = parseXStatusUrl(value) || parseTikTokVideoUrl(value) || parseYouTubeVideoUrl(value);
  if (!parsed) return invalidUrl();
  if (parsed.platform === "tiktok") return runTikTokRead(parsed, options);
  if (parsed.platform === "youtube") return runYouTubeRead(parsed, options);
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
      params: { url: parsed.canonical_url, platform: parsed.platform }
    },
    action_required: {
      code: "BROWSER_CONNECTOR_OFFLINE",
      connector_id: connectorId(parsed.platform),
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
    const value = args.params?.url || args.params?.target;
    return parseXStatusUrl(value) || parseTikTokVideoUrl(value) || parseYouTubeVideoUrl(value);
  }
  if (name !== "agentrouter_fetch" && name !== "agentrouter_ask") return null;
  return findSocialPostUrl(args.task || args.query);
}

function parseXStatusUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]{1,30}\/status)\/(\d+)(?:\/)?$/);
    if (!match) return null;
    return {
      platform: "x",
      post_id: match[1],
      canonical_url: `https://x.com${url.pathname.replace(/\/$/, "")}`
    };
  } catch {
    return null;
  }
}

// OpenCLI has no single-video-by-URL reader for TikTok, so we capture the
// creator handle + video id from a canonical video URL and look the video up in
// the creator's recent uploads. Short share links (vm/vt.tiktok.com) are not
// resolved here — they carry no handle/id.
function parseTikTokVideoUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    if (!["www.tiktok.com", "tiktok.com", "m.tiktok.com"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/@([A-Za-z0-9._]{1,30})\/video\/(\d+)(?:\/)?$/);
    if (!match) return null;
    return {
      platform: "tiktok",
      username: match[1],
      post_id: match[2],
      canonical_url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`
    };
  } catch {
    return null;
  }
}

function findSocialPostUrl(value) {
  const candidates = String(value || "").match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.;!?，。；！？]+$/, "");
    const parsed = parseXStatusUrl(cleaned) || parseTikTokVideoUrl(cleaned) || parseYouTubeVideoUrl(cleaned);
    if (parsed) return parsed;
  }
  return null;
}

// youtube.com/watch?v=ID, youtu.be/ID, and /shorts/ID all name one video.
function parseYouTubeVideoUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id = null;
    if (host === "youtu.be") {
      id = url.pathname.slice(1);
    } else if (host === "youtube.com" || host === "m.youtube.com") {
      id = url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] || null);
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return {
      platform: "youtube",
      post_id: id,
      canonical_url: `https://www.youtube.com/watch?v=${id}`
    };
  } catch {
    return null;
  }
}

// YouTube reads work without a login, so there is no whoami disambiguation.
async function runYouTubeRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const result = await runCommand("opencli", ["youtube", "video", parsed.canonical_url, "-f", "json"], { timeout: 90000 });
  const diagnostics = [{ backend_id: "opencli-youtube", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const row = extractYouTubeVideo(result.data, parsed);
    if (row) return completed(parsed, row, "opencli-youtube", diagnostics);
    return postNotFound(parsed, diagnostics);
  }
  return browserConnectorOffline(parsed, diagnostics);
}

function extractYouTubeVideo(payload, parsed) {
  const value = typeof payload === "string" ? safeJson(payload) : payload;
  // OpenCLI returns YouTube metadata as [{ field, value }] pairs.
  const fields = Array.isArray(value) && value.some((item) => item && "field" in item)
    ? Object.fromEntries(value.map((item) => [item.field, item.value]))
    : (Array.isArray(value) ? value[0] : value);
  if (!fields || typeof fields !== "object") return null;
  const id = fields.videoId || fields.id || parsed.post_id;
  if (!fields.title && !fields.description) return null;
  const duration = String(fields.duration || "").match(/(\d+)/)?.[1];
  return {
    id,
    text: fields.title,
    description: fields.description,
    author: fields.channel || fields.author,
    published_at: fields.publishDate || fields.published_at || null,
    engagement: { view_count: parseCount(fields.views), like_count: parseCount(fields.likes) },
    extra: {
      channel_id: fields.channelId || null,
      duration_seconds: duration ? Number(duration) : null,
      category: fields.category || null,
      is_live: fields.isLive === true || fields.isLive === "true",
      thumbnail: fields.thumbnail || null
    }
  };
}

// Counts arrive localized ("1930万", "19M", "1.9K"); keep them numeric.
export function parseCount(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const text = String(value).replace(/[,\s]/g, "");
  const match = text.match(/^([\d.]+)\s*([万亿KkMmBb])?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const scale = { 万: 1e4, 亿: 1e8, K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 }[match[2]] || 1;
  return Math.round(base * scale);
}

async function runTikTokRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const result = await runCommand("opencli", ["tiktok", "user", parsed.username, "--limit", "40", "-f", "json"], { timeout: 90000 });
  const diagnostics = [{ backend_id: "opencli-tiktok", status: result.status, error: result.error || null }];
  if (result.status === "missing") return browserConnectorOffline(parsed, diagnostics);
  if (result.status === "completed") {
    const row = extractTikTokVideo(result.data, parsed);
    if (row) return completed(parsed, row, "opencli-tiktok", diagnostics);
  }
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  // TikTok's `user` returns EMPTY_RESULT whether the browser session is missing
  // or the video list is genuinely empty — disambiguate with whoami before
  // deciding between "log in" and "not in recent uploads".
  const who = await runCommand("opencli", ["tiktok", "whoami", "-f", "json"], { timeout: 30000 });
  diagnostics.push({ backend_id: "opencli-tiktok-whoami", status: who.status, error: who.error || null });
  if (who.status === "missing") return browserConnectorOffline(parsed, diagnostics);
  if (who.status !== "completed") return authRequired(parsed, diagnostics);
  return postNotFound(parsed, diagnostics);
}

function extractTikTokVideo(payload, parsed) {
  const value = typeof payload === "string" ? safeJson(payload) : payload;
  const list = Array.isArray(value) ? value
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.videos) ? value.videos
    : Array.isArray(value?.data?.videos) ? value.data.videos
    : Array.isArray(value?.result) ? value.result
    : [];
  const video = list.find((item) =>
    String(item?.id || item?.video_id || item?.aweme_id || "") === parsed.post_id
  );
  if (!video) return null;
  const stats = video.stats || video.statistics || video.statsV2 || {};
  const createdSeconds = Number(video.createTime || video.create_time);
  return {
    id: video.id || video.video_id || video.aweme_id || parsed.post_id,
    text: video.desc || video.title || video.caption || video.text,
    author: video.author?.uniqueId || video.author?.unique_id
      || (typeof video.author === "string" ? video.author : video.author?.nickname)
      || parsed.username,
    published_at: Number.isFinite(createdSeconds) && createdSeconds > 0
      ? new Date(createdSeconds * 1000).toISOString()
      : (video.published_at || null),
    engagement: {
      like_count: stats.diggCount ?? stats.digg_count ?? video.likes,
      reply_count: stats.commentCount ?? stats.comment_count ?? video.comments,
      retweet_count: stats.shareCount ?? stats.share_count ?? video.shares,
      view_count: stats.playCount ?? stats.play_count ?? video.views
    }
  };
}

function authRequired(parsed, attempts) {
  return {
    ok: false,
    status: "auth_required",
    request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: parsed.platform } },
    action_required: {
      code: "AUTH_REQUIRED",
      connector_id: connectorId(parsed.platform),
      message: `Open Chrome and sign in to ${platformLabel(parsed.platform)}, then retry. Reads use your own logged-in browser session.`,
      requires_system_password: false,
      credential_access: "browser_managed",
      permissions: { access: "read_only", write_actions: "denied" }
    },
    attempts
  };
}

function postNotFound(parsed, attempts) {
  return {
    ok: false,
    status: "post_not_found",
    request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: parsed.platform } },
    action_required: {
      code: "POST_NOT_FOUND",
      message: parsed.username
        ? `OpenCLI has no single-video reader for ${platformLabel(parsed.platform)}; this post was not in @${parsed.username}'s recent uploads. Try a recent post, or fetch the creator's profile/videos instead.`
        : `${platformLabel(parsed.platform)} returned no readable data for this URL. The video may be private, removed, or region-locked.`
    },
    attempts
  };
}

function connectorId(platform) {
  return platform === "x" ? "opencli-twitter" : `opencli-${platform}`;
}

function platformLabel(platform) {
  return { x: "X (x.com)", tiktok: "TikTok (tiktok.com)", youtube: "YouTube (youtube.com)" }[platform] || platform;
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
    request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: parsed.platform } },
    result: {
      post: {
        platform: parsed.platform,
        post_id: String(row.id || parsed.post_id),
        canonical_url: parsed.canonical_url,
        text: String(row.text || "").trim().slice(0, 20000) || null,
        author_handle: String(row.author || "").trim().slice(0, 120) || null,
        published_at: row.published_at || null,
        engagement: normalizeEngagement(row.engagement),
        ...(row.description ? { description: String(row.description).trim().slice(0, 20000) } : {}),
        ...(row.extra || {}),
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
    error: { code: "SOCIAL_POST_URL_INVALID", message: "A public X status or TikTok video URL is required." }
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
      // Some adapters (e.g. TikTok) report AUTH on stdout with a non-zero exit.
      const auth = /auth_required|auth|login|cookie|session/i.test(`${stderr}\n${stdout}`);
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
