// Keyword search across social platforms runs through the host-native browser
// whenever the client declares that operation. This module retains the local
// OpenCLI execution path solely for older clients without native browser
// handoff support.
import { spawn } from "node:child_process";

import { BROWSER_CONNECTOR_SECURITY_NOTE, buildLocalCliEnvironment } from "./local-social-post.js";
import {
  buildLocalBrowserHandoff,
  hasNativeBrowserCapability
} from "./local-browser-connector.js";
import { isExplicitXPlatformTask } from "./social-platform-language.js";

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

// A named provider is a routing constraint, not another way to name a
// platform. Let the hosted router preserve the provider and any multi-platform
// plan instead of allowing this bridge to grab the first platform word.
const EXPLICIT_SOCIAL_VENDOR = /\b(?:xpoz|social\s*data\s*x|socialdatax|social\s*crawl|socialcrawl|largit\s*data|largitdata)\b/i;

const LOCAL_CAPABILITY_ALIASES = Object.freeze({
  social_search: { capability: "social_search" },
  social_keyword_search: { capability: "social_search" },
  social_user_voice_research: { capability: "social_user_voice_research" },
  x_search: { capability: "social_search", platform: "x", operation: "search" },
  twitter_search: { capability: "social_search", platform: "x", operation: "search" },
  tweet_search: { capability: "social_search", platform: "x", operation: "search" },
  x_user_posts: { capability: "social_user_voice_research", platform: "x", operation: "read_user_posts" },
  twitter_user_posts: { capability: "social_user_voice_research", platform: "x", operation: "read_user_posts" },
  x_thread: { capability: "social_user_voice_research", platform: "x", operation: "read_thread" },
  twitter_thread: { capability: "social_user_voice_research", platform: "x", operation: "read_thread" },
  x_trends: { capability: "social_search", platform: "x", operation: "read_trends" },
  twitter_trends: { capability: "social_search", platform: "x", operation: "read_trends" }
});

export function normalizeSearchPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLATFORM_ALIASES[key] || null;
}

export function localSocialSearchRequest(message) {
  if (message?.method !== "tools/call") return null;
  if (message.params?.name === "agentrouter_fetch") {
    const args = message.params?.arguments || {};
    const task = String(args.task || args.query || "").trim();
    if (isSocialProviderResearch(task) || EXPLICIT_SOCIAL_VENDOR.test(task)) return null;
    const platform = explicitPlatformInTask(task);
    if (!platform || !task) return null;
    // URLs identify a specific post or account; they are not keywords. Decide
    // their operation before applying any natural-language query cleanup.
    if (platform === "x" && xStatusUrlInTask(task)) return null;
    const accountHandle = platform === "x" ? xProfileHandleInTask(task) : null;
    if (accountHandle) {
      return {
        platform,
        operation: "read_user_posts",
        handle: accountHandle,
        query: task,
        quality_context: task,
        limit: args.limit,
        capability: "social_user_voice_research",
        ...naturalXConstraints(task),
        supplement_on_insufficient: false
      };
    }
    const naturalConstraints = platform === "x" ? naturalXConstraints(task) : {};
    const cleanedQuery = socialQuery(task, platform);
    return {
      platform,
      operation: "search",
      query: platform === "x" ? buildXSearchQuery(cleanedQuery, naturalConstraints) : cleanedQuery,
      quality_context: task,
      limit: args.limit,
      capability: "social_search",
      ...naturalConstraints,
      supplement_on_insufficient: true
    };
  }
  if (message.params?.name !== "agentrouter_request") return null;
  const args = message.params?.arguments || {};
  const requestedCapability = String(args.capability || "").trim().toLowerCase();
  const alias = LOCAL_CAPABILITY_ALIASES[requestedCapability];
  if (!alias) return null;
  const capability = alias.capability;
  const params = args.params || {};
  const platform = normalizeSearchPlatform(params.platform || params.source || alias.platform);
  if (!platform) return null;
  const operation = String(params.operation || alias.operation || "search").trim().toLowerCase();
  if (!supportedOperation(platform, operation)) return null;
  const handle = normalizeHandle(params.handle || params.username || params.account);
  const entity = normalizeEntityConstraint(params.entity || {
    required_terms: params.required_terms || (params.domain ? [params.domain] : []),
    excluded_terms: params.excluded_terms
  });
  const timeRange = normalizeTimeRange({ from: params.from || params.since, to: params.to || params.until });
  const target = String(params.url || params.target || "").trim();
  const rawQuery = String(params.query || params.keyword || params.question || params.task || "").trim();
  if (operation === "read_user_posts" && !handle) return null;
  if (operation === "read_thread" && !target) return null;
  if (operation === "search" && !rawQuery && !entity.required_terms.length) return null;
  return {
    platform,
    operation,
    handle,
    target,
    query: platform === "x" && operation === "search"
      ? buildXSearchQuery(rawQuery, { entity, ...timeRange })
      : rawQuery || handle,
    quality_context: rawQuery || handle,
    entity,
    ...timeRange,
    limit: params.limit,
    capability
  };
}

function supportedOperation(platform, operation) {
  return operation === "search" || (platform === "x" && ["read_user_posts", "read_thread", "read_trends"].includes(operation));
}

export function localBrowserSearchHandoffRequest(message, request) {
  if (!request || message?.method !== "tools/call") return null;
  const consumerContext = message.params?.arguments?.consumer_context || {};
  if (!hasNativeBrowserCapability(consumerContext, request.operation)) return null;
  const params = compactParams({
    platform: request.platform,
    operation: request.operation,
    query: request.query,
    handle: request.handle,
    url: request.target,
    from: request.from,
    to: request.to,
    entity: request.entity,
    limit: request.limit
  });
  const localExecutionPlan = {
    protocol_version: "agentrouter_local_social_task_v2",
    platform: request.platform,
    operation: request.operation,
    params,
    execution_location: "user_device",
    permissions: { access: "read_only", write_actions: "denied" },
    data_policy: { credentials: "never_upload", raw_results: "never_upload" }
  };
  const handoff = buildLocalBrowserHandoff({
    platform: request.platform,
    operation: request.operation,
    target: request.target,
    params,
    localExecutionPlan,
    constraints: localBudgetConstraints(message),
    consumerContext
  });
  return {
    ok: false,
    status: "local_connector_required",
    request: handoff.request,
    action_required: {
      code: "LOCAL_BROWSER_EXECUTION_REQUIRED",
      message: "Use the AI client's built-in browser for this read-only social request, then call agentrouter_complete_handoff with structured public evidence.",
      reload_after_bridge_update: false
    },
    handoff,
    fallback_allowed: false,
    local_execution_plan: localExecutionPlan
  };
}

function localBudgetConstraints(message) {
  const constraints = message?.params?.arguments?.constraints;
  if (!constraints || typeof constraints !== "object" || !Object.hasOwn(constraints, "max_price_usdc")) return {};
  return { max_price_usdc: constraints.max_price_usdc };
}

function naturalXConstraints(task) {
  const domains = [...String(task || "").matchAll(/(?:https?:\/\/)?\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/ig)]
    .map((match) => match[1].toLowerCase().replace(/^www\./, ""))
    .filter((domain) => !["x.com", "twitter.com"].includes(domain));
  const excluded = [...String(task || "").matchAll(/(?:排除|不要|excluding?|not)\s*["“”']?([a-z0-9._-]{3,})["“”']?/ig)]
    .map((match) => match[1].toLowerCase());
  return {
    entity: normalizeEntityConstraint({ required_terms: domains, excluded_terms: excluded }),
    ...relativeTimeRange(task)
  };
}

function relativeTimeRange(task, now = new Date()) {
  const text = String(task || "");
  const match = text.match(/(?:最近|过去|過去|近|last|past)\s*(一|1|\d+)\s*(年|个月|個月|月|周|週|天|years?|months?|weeks?|days?)/i);
  if (!match) return {};
  const amount = match[1] === "一" ? 1 : Math.max(1, Number(match[1]) || 1);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const unit = match[2].toLowerCase();
  if (/年|year/.test(unit)) from.setUTCFullYear(from.getUTCFullYear() - amount);
  else if (/月|month/.test(unit)) from.setUTCMonth(from.getUTCMonth() - amount);
  else if (/周|週|week/.test(unit)) from.setUTCDate(from.getUTCDate() - (amount * 7));
  else from.setUTCDate(from.getUTCDate() - amount);
  return { from: isoDay(from), to: isoDay(now) };
}

function normalizeTimeRange({ from, to } = {}) {
  const normalizedFrom = validIsoDay(from);
  const normalizedTo = validIsoDay(to);
  return {
    ...(normalizedFrom ? { from: normalizedFrom } : {}),
    ...(normalizedTo ? { to: normalizedTo } : {})
  };
}

function validIsoDay(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,30}$/.test(handle) ? handle : "";
}

function normalizeEntityConstraint(value = {}) {
  const terms = (items) => [...new Set((Array.isArray(items) ? items : [])
    .map((item) => clean(item, 120).toLowerCase())
    .filter(Boolean))];
  return {
    required_terms: terms(value.required_terms),
    excluded_terms: terms(value.excluded_terms)
  };
}

function buildXSearchQuery(query, { entity = {}, from, to } = {}) {
  const requiredTerms = entity.required_terms || [];
  const excludedTerms = entity.excluded_terms || [];
  let base = clean(query, 1000);
  for (const term of [...requiredTerms, ...excludedTerms]) {
    base = base.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "ig"), " ");
  }
  base = base
    .replace(/(?:排除|不要|excluding?|not)\s*["“”']?[a-z0-9._-]{3,}["“”']?/ig, " ")
    .replace(/(?:最近|过去|過去|近|last|past)\s*(?:一|1|\d+)\s*(?:年|个月|個月|月|周|週|天|years?|months?|weeks?|days?)/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    ...requiredTerms.map((term) => `"${term}"`),
    base,
    ...excludedTerms.map((term) => `-${term}`),
    from ? `since:${from}` : "",
    to ? `until:${to}` : ""
  ].filter(Boolean).join(" ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSocialProviderResearch(task) {
  const providerIntent = /\b(?:api|mcp|providers?|vendors?|services?|integrations?|marketplace|catalog)\b|服务商|供應商|供应商|数据源|資料源|接口|接入|集成|整合/i;
  const comparisonIntent = /\b(?:research|compare|comparison|cover|supports?|alternatives?|landscape)\b|研究|调研|調研|比较|比較|主流|哪些/i;
  return providerIntent.test(task) && comparisonIntent.test(task);
}

function explicitPlatformInTask(task) {
  const patterns = [
    [/\breddit\b/i, "reddit"],
    [/小红书|xiaohongshu|rednote/i, "xiaohongshu"],
    [/\byoutube\b/i, "youtube"],
    [/\bbilibili\b|哔哩哔哩/i, "bilibili"],
    [/知乎|\bzhihu\b/i, "zhihu"],
    [/微博|\bweibo\b/i, "weibo"],
    [isExplicitXPlatformTask, "x"]
  ];
  return patterns.find(([pattern]) => typeof pattern === "function" ? pattern(task) : pattern.test(task))?.[1] || null;
}

function socialQuery(task, platform) {
  const labels = {
    reddit: /(?:在\s*)?reddit(?:\s*上)?[，,:：]?/ig,
    xiaohongshu: /(?:在|查找)?\s*(?:小红书|xiaohongshu|rednote)(?:上)?[，,:：]?/ig,
    youtube: /(?:在|搜索)?\s*youtube(?:上)?[，,:：]?/ig,
    bilibili: /(?:在|搜索)?\s*(?:bilibili|哔哩哔哩)(?:上)?[，,:：]?/ig,
    zhihu: /(?:在|搜索)?\s*(?:知乎|zhihu)(?:上)?[，,:：]?/ig,
    weibo: /(?:在|搜索)?\s*(?:微博|weibo)(?:上)?[，,:：]?/ig,
    x: /(?:(?:请|請)?\s*(?:帮我|幫我)?\s*(?:去|到|从|從|在|搜索|搜尋|搜寻|搜尋|检索|檢索|查找|查询|查詢|查查|查看|找|看看|浏览|瀏覽)\s*x\s*(?:上|里|裡|中|平台(?:上|里|裡|中)?)|(?:find|search|check|research|read|browse|look\s+up)(?:\s+posts?)?\s+(?:on\s+)?x(?:\s+(?:for|about))?|x\.com|twitter)[，,:：]?/ig
  };
  const cleaned = task
    .replace(labels[platform], " ")
    .replace(/^(?:请|請)?\s*(?:帮我|幫我)?\s*(?:搜索|搜尋|查找|查询|查詢|看看|分析|研究|调研|調研)\s*/i, "")
    .replace(/(?:最近|过去|過去)\s*(?:一|1)?\s*(?:周|週|个月|個月|月|天|小时|小時)\s*/ig, "")
    .replace(/(?:人们|人們|用户|用戶|大家)?\s*对\s*/ig, "")
    .replace(/(?:的)?(?:看法|观点|觀點|评价|評價|意见|意見)[。.!！?？]*$/i, "")
    .replace(/^(?:search|find|look\s+up|research)\s+(?:for\s+)?/i, "")
    .replace(/\b(?:what\s+do\s+(?:people|users)\s+(?:think|say)\s+about|opinions?\s+(?:on|about)|views?\s+(?:on|about))\b/ig, "")
    .replace(/[，,:：。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || task;
}

export async function runLocalSocialSearch({
  platform,
  operation = "search",
  handle = "",
  target = "",
  query,
  quality_context: qualityContext = query,
  entity = {},
  from,
  to,
  capability = "social_search",
  limit,
  supplement_on_insufficient: supplementOnInsufficient = false
}, options = {}) {
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
  const context = { bounded, supplementOnInsufficient, qualityContext, entity, handle, target, from, to, operation, capability };
  const commandArgs = platform === "x" && operation === "read_user_posts"
    ? ["twitter", "user-posts", handle, "--limit", String(bounded), "-f", "json"]
    : platform === "x" && operation === "read_thread"
      ? ["twitter", "thread", target, "--limit", String(bounded), "-f", "json"]
      : platform === "x" && operation === "read_trends"
        ? ["twitter", "trends", "--limit", String(bounded), "-f", "json"]
        : definition.args(query, bounded);
  const result = await runCommand("opencli", commandArgs, { timeout: definition.timeout });
  const attempts = [{ backend_id: `opencli-${platform}`, status: result.status, error: result.error || null }];

  if (result.status === "completed") {
    const rows = filterRows(normalizeRows(result.data), { entity, handle, from, to, operation }).slice(0, bounded);
    if (rows.length) return completed(platform, query, rows, attempts, context);
    // An empty result set is a real answer, not a connector failure, but only
    // when the session is actually usable — otherwise report the auth problem.
    const who = await runCommand("opencli", [platform === "x" ? "twitter" : platform, "whoami", "-f", "json"], { timeout: 30000 });
    attempts.push({ backend_id: `opencli-${platform}-whoami`, status: who.status, error: who.error || null });
    if (who.status === "completed") return completed(platform, query, [], attempts, context);
    return authRequired(platform, query, attempts, context);
  }
  if (result.status === "auth_required") return authRequired(platform, query, attempts, context);
  if (result.status === "missing") return connectorOffline(platform, query, attempts, context);
  return connectorRuntimeUnavailable(platform, query, attempts, context);
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
    author: clean(typeof row?.author === "string" ? row.author : row?.author?.screen_name ?? row?.author?.username ?? row?.author?.uniqueId ?? row?.author?.name ?? row?.username ?? row?.nickname, 120),
    url: clean(row?.url ?? row?.link ?? row?.short_link, 800),
    published_at: row?.created_at ?? row?.publish_time ?? row?.published_at ?? null,
    engagement: pickEngagement(row)
  })).filter((row) => row.title || row.text || row.url);
}

function filterRows(rows, { entity = {}, handle = "", from, to, operation = "search" } = {}) {
  const requiredTerms = entity.required_terms || [];
  const excludedTerms = entity.excluded_terms || [];
  const expectedHandle = normalizeHandle(handle).toLowerCase();
  return rows.filter((row) => {
    const text = evidenceText(row);
    if (requiredTerms.length && !requiredTerms.every((term) => text.includes(term.toLowerCase()))) return false;
    if (excludedTerms.some((term) => text.includes(term.toLowerCase()))) return false;
    if (operation === "read_user_posts" && expectedHandle && rowHandle(row) !== expectedHandle) return false;
    if (from || to) {
      const timestamp = rowTimestamp(row.published_at);
      if (!timestamp) return false;
      if (from && timestamp < Date.parse(`${from}T00:00:00Z`)) return false;
      if (to && timestamp >= Date.parse(`${to}T23:59:59.999Z`) + 1) return false;
    }
    return true;
  });
}

function rowHandle(row) {
  const explicit = normalizeHandle(row.author).toLowerCase();
  if (explicit) return explicit;
  try {
    return normalizeHandle(new URL(row.url).pathname.split("/").filter(Boolean)[0]).toLowerCase();
  } catch {
    return "";
  }
}

function xStatusUrlInTask(task) {
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/status|[A-Za-z0-9_]{1,30}\/status)\/\d+(?:[/?#]|$)/i.test(String(task || ""));
}

function xProfileHandleInTask(task) {
  const urls = (String(task || "").match(/https?:\/\/[^\s]+/ig) || [])
    .map((value) => value.replace(/[，,。.!！?？]+$/g, ""));
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) continue;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) continue;
      const handle = normalizeHandle(segments[0]);
      if (handle && !new Set(["home", "explore", "search", "settings", "i", "intent"]).has(handle.toLowerCase())) return handle;
    } catch {
      // Ignore malformed text that merely resembles a URL.
    }
  }
  return null;
}

function rowTimestamp(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
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

function completed(platform, query, rows, attempts, {
  bounded = 10,
  supplementOnInsufficient = false,
  qualityContext = query,
  entity = {},
  handle = "",
  target = "",
  from,
  to,
  operation = "search",
  capability = "social_search"
} = {}) {
  const requestId = localRequestId(`${operation}_${platform}`);
  const minimumItems = Math.min(3, bounded);
  const quality = assessEvidenceQuality(query, qualityContext, rows, minimumItems, entity);
  const insufficient = quality.reasons.length > 0;
  const requestParams = {
    platform,
    operation,
    ...(query ? { query } : {}),
    ...(handle ? { handle } : {}),
    ...(target ? { url: target } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...((entity.required_terms?.length || entity.excluded_terms?.length) ? { entity } : {})
  };
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
    routing_control: {
      protocol_version: "agentrouter_route_control_v1",
      orchestrator: "agentrouter",
      selected_backend: `opencli-${platform}`,
      agent_reach_allowed: false,
      external_handoff: null,
      preserve_route_context: true,
      allowed_next_tools: ["agentrouter_request", "agentrouter_feedback"]
    },
    request: { capability, params: requestParams },
    result: { items: rows, item_count: rows.length },
    coverage: {
      status: insufficient ? "insufficient" : "sufficient",
      item_count: rows.length,
      minimum_items: minimumItems,
      relevant_item_count: quality.relevantItemCount,
      timestamped_item_count: quality.timestampedItemCount,
      substantive_item_count: quality.substantiveItemCount,
      entity_match_policy: quality.entityMatchPolicy,
      reasons: quality.reasons
    },
    ...(insufficient && supplementOnInsufficient ? {
      supplemental_request: {
        preferred_tool: "agentrouter_request",
        capability: "external_api_query",
        params: {
          source: "exa",
          operation: "search",
          query,
          limit: Math.max(5, bounded - rows.length)
        },
        trigger: "insufficient_local_social_evidence",
        preserve_route_context: true,
        do_not_fallback_outside_agentrouter: true,
        merge_policy: "Use web results only as supplemental context; keep platform-native evidence separately attributed."
      }
    } : {}),
    source: { backend_id: `opencli-${platform}`, attempts },
    consumer_feedback_request: localFeedbackRequest(requestId, `local_social_${platform}`, { ...requestParams, capability })
  };
}

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "before", "current", "find", "from", "latest", "people", "product",
  "recent", "reddit", "search", "think", "users", "views", "what", "with", "x", "youtube"
]);

function assessEvidenceQuality(query, qualityContext, rows, minimumItems, entity = {}) {
  const tokens = evidenceTokens(query);
  const entityScoped = entity.required_terms?.length || entity.excluded_terms?.length;
  const relevant = entityScoped
    ? rows
    : tokens.length
    ? rows.filter((row) => tokens.some((token) => evidenceText(row).includes(token)))
    : rows;
  const timestampedItemCount = relevant.filter((row) => Boolean(row.published_at)).length;
  const substantiveItemCount = relevant.filter((row) => clean(row.text, 4000).length >= 20).length;
  const reasons = [];
  if (rows.length < minimumItems) reasons.push(`item_count_below_minimum:${rows.length}/${minimumItems}`);
  if (tokens.length && relevant.length < minimumItems) reasons.push(`relevant_items_below_minimum:${relevant.length}/${minimumItems}`);
  if (requestsFreshEvidence(qualityContext) && relevant.length >= minimumItems && timestampedItemCount < minimumItems) {
    reasons.push(`timestamped_items_below_minimum:${timestampedItemCount}/${minimumItems}`);
  }
  if (requestsUserOpinion(qualityContext) && relevant.length >= minimumItems && substantiveItemCount === 0) {
    reasons.push("substantive_user_voice_missing");
  }
  return {
    relevantItemCount: relevant.length,
    timestampedItemCount,
    substantiveItemCount,
    entityMatchPolicy: entityScoped ? "all_required_no_excluded" : "query_token_overlap",
    reasons
  };
}

function evidenceTokens(query) {
  const latin = String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
  const cjk = String(query || "").match(/[\u3400-\u9fff]{2,}/g) || [];
  return [...new Set([...latin.filter((token) => !SEARCH_STOP_WORDS.has(token)), ...cjk])];
}

function evidenceText(row) {
  return `${row.author || ""} ${row.url || ""} ${row.title || ""} ${row.text || ""}`.toLowerCase();
}

function requestsFreshEvidence(query) {
  return /\b(?:recent|latest|today|last\s+(?:week|month|\d+\s+(?:hours?|days?)))\b|最近|最新|今天|过去|過去|近\s*\d+\s*(?:小时|小時|天|周|週|月)/i.test(query);
}

function requestsUserOpinion(query) {
  return /\b(?:opinions?|views?|what\s+(?:people|users)\s+(?:think|say))\b|看法|观点|觀點|评价|評價|意见|意見|用户原声|用戶原聲/i.test(query);
}

function socialRequest(platform, query, {
  capability = "social_search",
  operation = "search",
  handle = "",
  target = "",
  from,
  to,
  entity = {}
} = {}) {
  const params = {
    platform,
    operation,
    ...(query ? { query } : {}),
    ...(handle ? { handle } : {}),
    ...(target ? { url: target } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...((entity.required_terms?.length || entity.excluded_terms?.length) ? { entity } : {})
  };
  if (operation === "search") delete params.operation;
  return { capability, params };
}

function authRequired(platform, query, attempts, context) {
  return {
    ok: false,
    status: "auth_required",
    request: socialRequest(platform, query, context),
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

function connectorOffline(platform, query, attempts, context) {
  return {
    ok: false,
    status: "browser_connector_offline",
    request: socialRequest(platform, query, context),
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

function connectorRuntimeUnavailable(platform, query, attempts, context) {
  const request = socialRequest(platform, query, context);
  return {
    ok: false,
    status: "local_connector_runtime_unavailable",
    request,
    action_required: {
      code: "LOCAL_CONNECTOR_RUNTIME_UNAVAILABLE",
      connector_id: `opencli-${platform}`,
      message: "The current runtime could not reach the local OpenCLI daemon. Retry this request through the AgentRouter MCP bridge; a sandboxed shell may be isolated from the healthy browser connector.",
      preferred_tool: "agentrouter_request",
      tool_arguments: request,
      do_not_fallback_outside_agentrouter: true,
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

function compactParams(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null || item === "") return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return Object.keys(item).length > 0;
    return true;
  }));
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
