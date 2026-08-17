import { spawn } from "node:child_process";

import path from "node:path";

// Users see a macOS Keychain prompt when a cookie-decrypting tool runs, and it is
// easy to blame whichever tool asked for data. Say plainly that it is not us.
export const BROWSER_CONNECTOR_SECURITY_NOTE =
  'AgentRouter reads through the connected browser extension in your existing session, so it never asks for a system or Keychain password. If macOS asks to use "Chrome Safe Storage", another tool is decrypting your saved cookie file — approving that exposes cookies for every site you are signed in to, not just this one.';

export async function runLocalSocialPostRead(value, options = {}) {
  const parsed = parseSocialUrl(value);
  if (!parsed) return invalidUrl();
  if (parsed.platform === "tiktok") return runTikTokRead(parsed, options);
  if (parsed.platform === "youtube") return runYouTubeRead(parsed, options);
  if (parsed.platform === "bilibili") return runBilibiliRead(parsed, options);
  if (parsed.platform === "reddit") return runRedditRead(parsed, options);
  if (parsed.platform === "xiaohongshu") return runXiaohongshuRead(parsed, options);
  if (parsed.platform === "zhihu") return runZhihuRead(parsed, options);
  if (parsed.platform === "weibo") return runWeiboRead(parsed, options);
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
      message: "Open Chrome and reconnect the OpenCLI browser extension, then retry.",
      requires_system_password: false,
      security_note: BROWSER_CONNECTOR_SECURITY_NOTE,
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
    return parseSocialUrl(args.params?.url || args.params?.target);
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

function parseSocialUrl(value) {
  return parseXStatusUrl(value)
    || parseTikTokVideoUrl(value)
    || parseYouTubeVideoUrl(value)
    || parseRedditPostUrl(value)
    || parseBilibiliVideoUrl(value)
    || parseXiaohongshuNoteUrl(value)
    || parseZhihuUrl(value)
    || parseWeiboUrl(value);
}

// zhihu.com/question/<qid> reads the question's top answer;
// zhihu.com/question/<qid>/answer/<aid> reads that specific answer.
function parseZhihuUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "zhihu.com" && host !== "zhuanlan.zhihu.com") return null;
    const answer = url.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)/);
    if (answer) {
      return {
        platform: "zhihu",
        post_id: answer[2],
        question_id: answer[1],
        canonical_url: `https://www.zhihu.com/question/${answer[1]}/answer/${answer[2]}`
      };
    }
    const standalone = url.pathname.match(/^\/answer\/(\d+)/);
    if (standalone) {
      return { platform: "zhihu", post_id: standalone[1], canonical_url: `https://www.zhihu.com/answer/${standalone[1]}` };
    }
    const question = url.pathname.match(/^\/question\/(\d+)/);
    if (question) {
      return {
        platform: "zhihu",
        post_id: question[1],
        question_id: question[1],
        question_only: true,
        canonical_url: `https://www.zhihu.com/question/${question[1]}`
      };
    }
    return null;
  } catch {
    return null;
  }
}

// weibo.com/<uid>/<mblogid>, weibo.com/detail/<id>, m.weibo.cn/detail/<id>
function parseWeiboUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    if (host !== "weibo.com" && host !== "weibo.cn") return null;
    const detail = url.pathname.match(/^\/(?:detail|status)\/([A-Za-z0-9]+)/);
    const profile = url.pathname.match(/^\/(\d{4,})\/([A-Za-z0-9]{6,})/);
    const id = detail?.[1] || profile?.[2];
    if (!id) return null;
    return { platform: "weibo", post_id: id, canonical_url: `https://weibo.com/detail/${id}` };
  } catch {
    return null;
  }
}

async function runZhihuRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const args = parsed.question_only
    ? ["zhihu", "question", parsed.question_id, "--limit", "1", "-f", "json"]
    : ["zhihu", "answer-detail", parsed.canonical_url, "-f", "json"];
  const result = await runCommand("opencli", args, { timeout: 120000 });
  const diagnostics = [{ backend_id: "opencli-zhihu", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const value = typeof result.data === "string" ? safeJson(result.data) : result.data;
    const answer = Array.isArray(value) ? value[0] : (value?.answers?.[0] || value);
    if (answer && (answer.content || answer.text || answer.title)) {
      return completed(parsed, {
        id: answer.id || parsed.post_id,
        text: answer.content || answer.text || answer.title,
        author: answer.author || answer.author_name || null,
        published_at: answer.created_at || answer.publish_time || null,
        engagement: { like_count: parseCount(answer.votes ?? answer.voteup_count), reply_count: parseCount(answer.comments) },
        extra: { question_url: parsed.question_id ? `https://www.zhihu.com/question/${parsed.question_id}` : null }
      }, "opencli-zhihu", diagnostics);
    }
    return postNotFound(parsed, diagnostics);
  }
  return browserConnectorOffline(parsed, diagnostics);
}

async function runWeiboRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const result = await runCommand("opencli", ["weibo", "post", parsed.post_id, "-f", "json"], { timeout: 90000 });
  const diagnostics = [{ backend_id: "opencli-weibo", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const post = toFieldObject(result.data);
    if (post && typeof post === "object" && (post.text || post.content || post.title)) {
      return completed(parsed, {
        id: post.id || post.idstr || post.mblogid || parsed.post_id,
        text: post.text || post.content || post.title,
        author: post.author || post.user?.screen_name || post.screen_name || post.nickname || null,
        published_at: post.created_at || post.publish_time || null,
        engagement: {
          like_count: parseCount(post.attitudes_count ?? post.likes ?? post.attitudes),
          reply_count: parseCount(post.comments_count ?? post.comments),
          share_count: parseCount(post.reposts_count ?? post.reposts)
        }
      }, "opencli-weibo", diagnostics);
    }
  }
  if (result.status === "missing") return browserConnectorOffline(parsed, diagnostics);
  // Weibo answers "Post not found" both when signed out and when the id is
  // genuinely gone, so probe whoami before blaming the URL.
  const who = await runCommand("opencli", ["weibo", "whoami", "-f", "json"], { timeout: 30000 });
  diagnostics.push({ backend_id: "opencli-weibo-whoami", status: who.status, error: who.error || null });
  if (who.status === "missing") return browserConnectorOffline(parsed, diagnostics);
  if (who.status !== "completed") return authRequired(parsed, diagnostics);
  return postNotFound(parsed, diagnostics);
}

function findSocialPostUrl(value) {
  const candidates = String(value || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.;!?，。；！？]+$/, "");
    const parsed = parseSocialUrl(cleaned);
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

// Several OpenCLI adapters (YouTube, Bilibili) return metadata as
// [{ field, value }] pairs rather than a plain object.
function toFieldObject(payload) {
  const value = typeof payload === "string" ? safeJson(payload) : payload;
  if (Array.isArray(value) && value.some((item) => item && "field" in item)) {
    return Object.fromEntries(value.map((item) => [item.field, item.value]));
  }
  return Array.isArray(value) ? value[0] : value;
}

function extractYouTubeVideo(payload, parsed) {
  const fields = toFieldObject(payload);
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

function parseRedditPostUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^(www|old|new|np)\./, "");
    if (host === "redd.it") {
      const id = url.pathname.slice(1).replace(/\/$/, "");
      if (!/^[a-z0-9]{4,12}$/i.test(id)) return null;
      return { platform: "reddit", post_id: id, canonical_url: `https://www.reddit.com/comments/${id}` };
    }
    if (host !== "reddit.com") return null;
    const match = url.pathname.match(/^\/(?:r\/([A-Za-z0-9_]{1,30})\/)?comments\/([a-z0-9]{4,12})/i);
    if (!match) return null;
    return {
      platform: "reddit",
      post_id: match[2],
      subreddit: match[1] || null,
      canonical_url: match[1]
        ? `https://www.reddit.com/r/${match[1]}/comments/${match[2]}`
        : `https://www.reddit.com/comments/${match[2]}`
    };
  } catch {
    return null;
  }
}

function parseBilibiliVideoUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    // b23.tv short links carry no BV id — OpenCLI resolves them itself.
    if (host === "b23.tv") {
      const code = url.pathname.slice(1).replace(/\/$/, "");
      if (!/^[A-Za-z0-9]{4,20}$/.test(code)) return null;
      return { platform: "bilibili", post_id: code, canonical_url: `https://b23.tv/${code}`, command_target: `https://b23.tv/${code}` };
    }
    if (host !== "bilibili.com") return null;
    const bvid = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})/)?.[1];
    if (!bvid) return null;
    const canonical = `https://www.bilibili.com/video/${bvid}`;
    return { platform: "bilibili", post_id: bvid, canonical_url: canonical, command_target: canonical };
  } catch {
    return null;
  }
}

// Xiaohongshu note reads need the full signed URL (xsec_token), so the original
// query string is preserved and passed through verbatim.
function parseXiaohongshuNoteUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    // Share links are handed out as http:// xhslink short URLs, so accept both.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const isShortLink = host === "xhslink.com" || host === "xhslink.cn";
    if (host !== "xiaohongshu.com" && !isShortLink) return null;
    if (isShortLink) {
      const code = url.pathname.replace(/^\/(?:o\/)?/, "").replace(/\/$/, "");
      if (!code) return null;
      // The short link hides the note id and xsec_token until it is resolved.
      return { platform: "xiaohongshu", post_id: code, canonical_url: url.href, command_target: url.href, short_link: true };
    }
    const id = url.pathname.match(/^\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]{16,32})/i)?.[1];
    if (!id) return null;
    return {
      platform: "xiaohongshu",
      post_id: id,
      canonical_url: url.href,
      command_target: url.href,
      signed: url.searchParams.has("xsec_token")
    };
  } catch {
    return null;
  }
}

async function runBilibiliRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const result = await runCommand("opencli", ["bilibili", "video", parsed.command_target, "-f", "json"], { timeout: 90000 });
  const diagnostics = [{ backend_id: "opencli-bilibili", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const fields = toFieldObject(result.data);
    if (fields && (fields.title || fields.bvid)) {
      const seconds = String(fields.duration || "").match(/\((\d+)s\)/)?.[1]
        || String(fields.duration || "").match(/^(\d+)s/)?.[1];
      return completed(parsed, {
        id: fields.bvid || parsed.post_id,
        text: fields.title,
        description: fields.description,
        // OpenCLI formats the author as "name (mid: 123)".
        author: String(fields.author || "").replace(/\s*\(mid:.*\)$/, "").trim() || null,
        published_at: fields.publish_time || null,
        engagement: {
          view_count: parseCount(fields.view),
          like_count: parseCount(fields.like),
          reply_count: parseCount(fields.reply),
          share_count: parseCount(fields.share)
        },
        extra: {
          duration_seconds: seconds ? Number(seconds) : null,
          coins: parseCount(fields.coin) ?? null,
          favorites: parseCount(fields.favorite) ?? null,
          danmaku: parseCount(fields.danmaku) ?? null,
          thumbnail: fields.thumbnail || null
        }
      }, "opencli-bilibili", diagnostics);
    }
    return postNotFound(parsed, diagnostics);
  }
  return browserConnectorOffline(parsed, diagnostics);
}

async function runRedditRead(parsed, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const result = await runCommand("opencli", ["reddit", "read", parsed.post_id, "-f", "json"], { timeout: 60000 });
  const diagnostics = [{ backend_id: "opencli-reddit", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const value = typeof result.data === "string" ? safeJson(result.data) : result.data;
    const items = Array.isArray(value) ? value : [];
    const post = items.find((item) => item?.type === "POST") || items[0];
    if (post && (post.text || post.title)) {
      // `reddit read` returns the post followed by its comment tree; the title
      // is folded into the post text rather than exposed as its own field.
      const commentCount = items.filter((item) => typeof item?.type === "string" && /^L\d+$/.test(item.type)).length;
      return completed(parsed, {
        id: parsed.post_id,
        text: post.title ? `${post.title}\n\n${post.text || ""}`.trim() : post.text,
        author: post.author,
        published_at: post.created_utc ? new Date(Number(post.created_utc) * 1000).toISOString() : null,
        engagement: { like_count: parseCount(post.score ?? post.upvotes), reply_count: commentCount },
        extra: { subreddit: parsed.subreddit ? `r/${parsed.subreddit}` : (post.subreddit || null) }
      }, "opencli-reddit", diagnostics);
    }
    return postNotFound(parsed, diagnostics);
  }
  return browserConnectorOffline(parsed, diagnostics);
}

// A share short link carries no note id or xsec_token, so follow it first.
async function resolveXiaohongshuShortLink(parsed, options = {}) {
  const resolve = options.resolveUrl || defaultResolveUrl;
  const finalUrl = await resolve(parsed.command_target);
  const next = finalUrl && finalUrl !== parsed.command_target ? parseXiaohongshuNoteUrl(finalUrl) : null;
  return next && !next.short_link ? next : parsed;
}

async function defaultResolveUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
      signal: AbortSignal.timeout(20000)
    });
    return response.url || null;
  } catch {
    return null;
  }
}

// Signed-out Xiaohongshu serves the login wall with HTTP 200, so the adapter
// reports success with a "手机号登录" title and zeroed counts. Treat that as an
// auth failure instead of returning the login page as note content.
function isXiaohongshuLoginWall(note) {
  if (!note || typeof note !== "object") return false;
  const title = String(note.title || "").trim();
  const body = String(note.desc || note.text || note.content || "").trim();
  const author = String(note.author || note.nickname || "").trim();
  return /登录|login/i.test(title) && !body && !author;
}

async function runXiaohongshuRead(input, options = {}) {
  const runCommand = options.runCommand || spawnCommand;
  const parsed = input.short_link ? await resolveXiaohongshuShortLink(input, options) : input;
  if (parsed.short_link) {
    return {
      ok: false,
      status: "invalid_request",
      request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: "xiaohongshu" } },
      action_required: {
        code: "SHORT_LINK_UNRESOLVED",
        message: "This Xiaohongshu share link could not be resolved to a note URL. Open it once in a browser and retry with the resulting xiaohongshu.com link."
      },
      attempts: []
    };
  }
  const result = await runCommand("opencli", ["xiaohongshu", "note", parsed.command_target, "-f", "json"], { timeout: 90000 });
  const diagnostics = [{ backend_id: "opencli-xiaohongshu", status: result.status, error: result.error || null }];
  if (result.status === "auth_required") return authRequired(parsed, diagnostics);
  if (result.status === "completed") {
    const note = toFieldObject(result.data);
    if (isXiaohongshuLoginWall(note)) return authRequired(parsed, diagnostics);
    if (note && typeof note === "object" && (note.title || note.desc || note.text || note.content)) {
      const interact = note.interact_info || note.interactInfo || note;
      return completed(parsed, {
        id: note.note_id || note.noteId || parsed.post_id,
        text: [note.title, note.desc || note.text || note.content].filter(Boolean).join("\n\n"),
        author: note.author || note.nickname || note.user?.nickname || null,
        published_at: note.publish_time || note.time || null,
        engagement: {
          like_count: parseCount(interact.liked_count ?? interact.likes ?? note.likes),
          reply_count: parseCount(interact.comment_count ?? interact.comments ?? note.comments),
          share_count: parseCount(interact.share_count ?? note.shares)
        },
        extra: { favorites: parseCount(interact.collected_count ?? note.collects) ?? null }
      }, "opencli-xiaohongshu", diagnostics);
    }
    return postNotFound(parsed, diagnostics);
  }
  // A note URL without xsec_token cannot be opened at all — say so explicitly.
  if (parsed.signed === false) {
    return {
      ok: false,
      status: "invalid_request",
      request: { capability: "social_post_read", params: { url: parsed.canonical_url, platform: "xiaohongshu" } },
      action_required: {
        code: "SIGNED_URL_REQUIRED",
        message: "Xiaohongshu note reads need the full shared link including its xsec_token. Copy the share URL from the app or from search results and retry."
      },
      attempts: diagnostics
    };
  }
  return browserConnectorOffline(parsed, diagnostics);
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
      message: `Sign in to ${platformLabel(parsed.platform)} in Chrome, then retry. AgentRouter reads through that logged-in session and never stores your credentials.`,
      requires_system_password: false,
      security_note: BROWSER_CONNECTOR_SECURITY_NOTE,
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
  return {
    x: "X (x.com)",
    tiktok: "TikTok (tiktok.com)",
    youtube: "YouTube (youtube.com)",
    bilibili: "Bilibili (bilibili.com)",
    reddit: "Reddit (reddit.com)",
    xiaohongshu: "Xiaohongshu (xiaohongshu.com)",
    zhihu: "Zhihu (zhihu.com)",
    weibo: "Weibo (weibo.com)"
  }[platform] || platform;
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
  const requestId = `local_post_${parsed.platform}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const serviceId = `local_social_${parsed.platform}`;
  return {
    ok: true,
    status: "completed",
    request_id: requestId,
    service_id: serviceId,
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
    },
    // Successful free reads must be rateable too, or reputation only ever
    // records the calls that went wrong.
    consumer_feedback_request: {
      feedback_request_version: "agent_consumer_feedback_request_v1",
      must_submit: true,
      timing: "after_final_answer_or_after_deciding_result_usability",
      endpoint: "/agent-router/feedback",
      method: "POST",
      request_id: requestId,
      service_id: serviceId,
      tool: "agentrouter_feedback",
      required_fields: ["intent_fit", "answer_useful", "reason"],
      example: {
        request_id: requestId,
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          confidence: 0.9,
          reason: "The post content answered the question and was used in the answer."
        }
      },
      context: { platform: parsed.platform, url: parsed.canonical_url, capability: "social_post_read" }
    }
  };
}

function normalizeEngagement(value = {}) {
  const result = {};
  const aliases = {
    likes: ["likes", "like_count", "favorite_count"],
    comments: ["comments", "reply_count", "comment_count"],
    shares: ["shares", "retweet_count", "share_count"],
    views: ["views", "view_count", "play_count"]
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
    error: { code: "SOCIAL_POST_URL_INVALID", message: "A supported post URL is required (X, TikTok, YouTube, Bilibili, Reddit, Xiaohongshu, Zhihu, or Weibo)." }
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
