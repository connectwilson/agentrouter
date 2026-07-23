import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchLocalSocialPlatform, searchSemanticWeb } from "./research-social-providers.js";

const SUPPORTED_PLATFORMS = new Set(["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook", "other"]);

export async function searchPublicDiscussions(input = {}, options = {}) {
  const question = clean(input.question, 500);
  if (!question) throw researchError("RESEARCH_QUESTION_REQUIRED", "question is required", 422);

  const platforms = [...new Set((Array.isArray(input.platforms) ? input.platforms : ["x", "reddit"])
    .map((value) => clean(value, 32).toLowerCase())
    .filter((value) => SUPPORTED_PLATFORMS.has(value)))];
  const selectedPlatforms = platforms.length ? platforms : ["x", "reddit"];
  const apiKey = options.apiKey || await readXcrawlApiKey(options.configPath);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const searches = [];
  const candidates = [];
  for (const platform of selectedPlatforms) {
    const requestPayload = buildSearchPayload(question, platform, input);
    const nativeQueries = buildNativeQueries(question, platform);
    const localAttempts = [];
    let local = { status: "not_configured", backend_id: null, rows: [], attempts: [] };
    let localRows = [];
    for (const nativeQuery of nativeQueries) {
      const attempt = await (options.localSearch || searchLocalSocialPlatform)(platform, nativeQuery, requestPayload.limit, options.localOptions || {});
      localAttempts.push(...(attempt.attempts || []).map((item) => ({ ...item, query: nativeQuery })));
      const relevantRows = attempt.status === "completed" ? filterRelevantRows(attempt.rows, question) : [];
      local = { ...attempt, attempts: localAttempts };
      if (relevantRows.length) {
        localRows = relevantRows;
        break;
      }
      if (attempt.status === "auth_required") break;
    }
    const nativeQuery = nativeQueries.join(" | ");
    if (localRows.length) {
      const rows = localRows;
      searches.push({
        platform,
        query: nativeQuery,
        status: "completed",
        result_count: rows.length,
        credits_used: 0,
        provider_id: "agentrouter-social-local",
        backend_id: local.backend_id,
        attempts: local.attempts
      });
      candidates.push(...rows.map((row, index) => normalizeCandidate(row, platform, index, {
        providerId: `agentrouter-social-local:${local.backend_id}`,
        verificationStatus: "platform_result_needs_context_review"
      })).filter(Boolean));
      continue;
    }
    if (local.status === "auth_required") {
      searches.push({
        platform,
        query: nativeQuery,
        status: "auth_required",
        result_count: 0,
        credits_used: 0,
        provider_id: "agentrouter-social-local",
        backend_id: null,
        local_status: local.status,
        local_attempts: local.attempts
      });
      continue;
    }
    if (platform === "xiaohongshu") {
      searches.push({
        platform,
        query: nativeQuery,
        status: local.status === "completed" ? "no_results" : "provider_error",
        result_count: 0,
        credits_used: 0,
        provider_id: "agentrouter-social-local",
        backend_id: local.backend_id,
        local_status: local.status,
        local_attempts: local.attempts
      });
      continue;
    }
    const semantic = await (options.semanticSearch || searchSemanticWeb)(requestPayload.query, requestPayload.limit, options.semanticOptions || {});
    const semanticRows = semantic.status === "completed" ? filterPlatformContentRows(semantic.rows, platform) : [];
    if (semanticRows.length) {
      searches.push({
        platform,
        query: requestPayload.query,
        status: "completed_fallback",
        result_count: semanticRows.length,
        credits_used: 0,
        provider_id: "agentrouter-social-web-fallback",
        backend_id: semantic.backend_id,
        local_status: local.status,
        local_attempts: local.attempts,
        fallback_attempts: semantic.attempts
      });
      candidates.push(...semanticRows.map((row, index) => normalizeCandidate(row, platform, index, {
        providerId: `agentrouter-social-web-fallback:${semantic.backend_id}`,
        verificationStatus: "requires_source_review",
        fallbackPlatform: "other"
      })).filter(Boolean));
      continue;
    }
    if (platform === "xiaohongshu") {
      searches.push({
        platform,
        query: nativeQuery,
        status: "no_results",
        result_count: 0,
        credits_used: 0,
        provider_id: local.status === "completed" ? "agentrouter-social-local" : "agentrouter-social-web-fallback",
        backend_id: local.backend_id || semantic.backend_id,
        local_status: local.status,
        local_attempts: local.attempts,
        fallback_attempts: semantic.attempts
      });
      continue;
    }
    if (!apiKey) {
      searches.push({
        platform,
        query: requestPayload.query,
        status: local.status === "provider_error" ? "provider_error" : "no_results",
        result_count: 0,
        credits_used: 0,
        provider_id: "agentrouter-social-router",
        error: local.status === "provider_error" ? "Local connector failed and no optional web fallback is configured" : null,
        local_status: local.status,
        local_attempts: local.attempts,
        fallback_attempts: semantic.attempts
      });
      continue;
    }
    let response;
    let payload;
    try {
      response = await fetchImpl("https://run.xcrawl.com/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestPayload)
      });
      payload = await response.json();
    } catch (error) {
      searches.push({ platform, query: requestPayload.query, status: "provider_error", result_count: 0, error: error.message, local_attempts: local.attempts, fallback_attempts: semantic.attempts });
      continue;
    }

    const rows = extractSearchRows(payload);
    const upstreamFailed = !response.ok || payload?.status === "failed";
    searches.push({
      platform,
      query: requestPayload.query,
      status: upstreamFailed ? "provider_error" : rows.length ? "completed" : "no_results",
      result_count: rows.length,
      credits_used: finiteNumber(payload?.total_credits_used ?? payload?.data?.credits_used) || 0,
      search_id: clean(payload?.search_id, 120) || null,
      error: upstreamFailed ? clean(payload?.message || payload?.error || "Provider returned a failed search", 300) : null
      ,local_status: local.status
      ,local_attempts: local.attempts
    });
    candidates.push(...rows.map((row, index) => normalizeCandidate(row, platform, index)).filter(Boolean));
  }

  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.canonical_url, candidate])).values()];
  return {
    search_version: "creator_public_search_v1",
    question,
    provider_id: "agentrouter-social-router",
    searched_at: new Date().toISOString(),
    status: uniqueCandidates.length ? "review_required" : searches.some((item) => item.status === "provider_error") ? "partial_or_failed" : "no_results",
    searches,
    candidates: uniqueCandidates,
    action_required: buildActionRequired(searches),
    evidence_policy: "Search results are unverified candidates. Open the source and confirm the excerpt before adding it as evidence."
  };
}

function buildSearchPayload(question, platform, input) {
  const sites = { x: "x.com", reddit: "reddit.com", xiaohongshu: "xiaohongshu.com", bilibili: "bilibili.com", youtube: "youtube.com", facebook: "facebook.com" };
  const site = sites[platform] ? `site:${sites[platform]}` : "";
  const isChineseSource = platform === "xiaohongshu" || platform === "bilibili";
  const complaintTerms = isComplaintResearch(question)
    ? isChineseSource ? "抱怨 OR 问题 OR 慢 OR 贵 OR 报错" : "complaint OR problem OR slow OR expensive OR error OR freeze"
    : "";
  return {
    query: `${site} ${question} ${complaintTerms}`.trim(),
    location: clean(input.location, 80) || (isChineseSource ? "CN" : "US"),
    language: isChineseSource ? "zh" : "en",
    limit: Math.min(Math.max(Number(input.limit) || 10, 1), 25)
  };
}

function buildNativeQuery(question, platform) {
  if (!isComplaintResearch(question)) return question;
  if (platform === "reddit") {
    const entity = extractSearchEntity(question);
    return `${entity ? `"${entity}"` : question} complaints slow expensive error token`.trim();
  }
  const terms = platform === "xiaohongshu" || platform === "bilibili" ? "使用体验 问题 慢 贵 报错" : "complaint problem slow expensive error freeze token";
  return `${question} ${terms}`.trim();
}

function buildNativeQueries(question, platform) {
  const primary = buildNativeQuery(question, platform);
  if (isComplaintResearch(question)) {
    const entity = extractSearchEntity(question);
    return [...new Set([primary, entity || question, question])];
  }
  if (platform !== "reddit" || !/\bai\b/i.test(question) || !/\bweb3\b/i.test(question)) return [primary];
  return [...new Set([
    primary,
    '"AI Web3" revenue customers',
    "AI crypto real revenue paying customers"
  ])];
}

function isComplaintResearch(question) {
  return /(?:抱怨|吐槽|痛点|缺点|问题|负面|投诉|差评)|\b(?:complaints?|problems?|pain\s*points?|issues?|negative|criticism|criticisms|dislikes?)\b/i.test(String(question));
}

function extractSearchEntity(question) {
  const stopwords = new Set([
    "what", "which", "who", "where", "when", "why", "how", "are", "is", "do", "does", "did", "have", "has",
    "users", "user", "people", "say", "saying", "about", "complaint", "complaints", "problem", "problems", "slow",
    "expensive", "error", "errors", "freeze", "token"
  ]);
  return (String(question).match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || [])
    .filter((token) => token.length >= 2 && !stopwords.has(token.toLowerCase()))
    .slice(0, 4)
    .join(" ");
}

function filterRelevantRows(rows, question) {
  const stopwords = new Set(["and", "or", "the", "with", "from", "that", "this", "what", "which", "who", "where", "when", "why", "how", "are", "is", "have", "has", "products", "product", "examples", "case", "cases"]);
  const tokens = [...new Set((String(question).match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !stopwords.has(token)))];
  if (!tokens.length) return rows;
  const required = Math.min(tokens.length, 2);
  return rows.filter((row) => {
    const content = `${row.title || ""} ${row.text || row.full_text || row.body || row.selftext || row.content || row.desc || ""}`;
    const textTokens = new Set((`${content} ${row.url || row.link || ""}`
      .toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []));
    const entityMatches = tokens.filter((token) => textTokens.has(token)).length >= required;
    return entityMatches && (!isComplaintResearch(question) || hasComplaintSignal(content));
  });
}

function hasComplaintSignal(value) {
  return /(?:抱怨|吐槽|问题|慢|贵|报错|错误|卡住|卡死|额度|用量|消耗|烧(?:钱|token|令牌)?|退款|难用|糟糕|不足|暂停|限流|套餐|价格|界面|交互|质量|信任)|\b(?:complaints?|problems?|issues?|slow|slower|expensive|overpriced|errors?|freeze|freezes|frozen|stuck|token(?:s)?|quota|limit(?:s|ed)?|refund|worse|poor|bad|bug(?:s|gy)?|latency|downtime|uptime|burn(?:s|ing)?|pricing|unusable|confusing|lacking)\b/i.test(String(value));
}

function filterPlatformContentRows(rows, platform) {
  return rows.filter((row) => {
    const url = String(row.url || row.link || row.canonical_url || "");
    if (platform === "x") return /(?:x|twitter)\.com\/[^/]+\/(?:status|article)\//i.test(url) || /x\.com\/i\/status\//i.test(url);
    if (platform === "reddit") return /reddit\.com\/r\/[^/]+\/comments\//i.test(url);
    if (platform === "xiaohongshu") return /xiaohongshu\.com\/(?:explore|discovery\/item)\//i.test(url) || /xhslink\.com/i.test(url);
    if (platform === "bilibili") return /bilibili\.com\/video\//i.test(url);
    if (platform === "youtube") return /(?:youtube\.com\/watch|youtu\.be\/)/i.test(url);
    if (platform === "facebook") return /facebook\.com\//i.test(url);
    return true;
  });
}

function extractSearchRows(payload) {
  const data = payload?.data;
  const arrays = [data?.data, data?.results, data?.organic_results, payload?.results, payload?.data];
  return arrays.find((value) => Array.isArray(value)) || [];
}

function normalizeCandidate(row, requestedPlatform, index, options = {}) {
  if (!row || typeof row !== "object") return null;
  const canonicalUrl = clean(row.url || row.link || row.canonical_url || row.permalink || row.post_url || row.note_url, 2048);
  if (!/^https?:\/\//i.test(canonicalUrl)) return null;
  const excerpt = clean(row.snippet || row.description || row.text || row.full_text || row.body || row.selftext || row.content || row.desc, 1200);
  const author = row.author_handle || row.author || row.username || row.user?.nickname || row.user?.name;
  return {
    candidate_id: `${options.providerId ? "local" : "xcrawl"}_${requestedPlatform}_${Date.now()}_${index}`,
    platform: inferPlatform(canonicalUrl, options.fallbackPlatform ?? requestedPlatform),
    canonical_url: canonicalUrl,
    title: clean(row.title || row.name, 300) || null,
    text_excerpt: excerpt || null,
    published_at: validDate(row.published_at || row.created_at || row.created_utc || row.date),
    author_handle: clean(author, 200) || null,
    engagement: normalizeEngagement(row),
    source_type: options.providerId ? "platform_search_result" : "provider_search_candidate",
    provider_id: options.providerId || "xcrawl",
    verification_status: options.verificationStatus || "requires_source_review"
  };
}

function normalizeEngagement(row) {
  const source = row.engagement && typeof row.engagement === "object" ? row.engagement : row;
  const aliases = { likes: ["likes", "like_count", "liked_count", "score"], comments: ["comments", "comment_count", "num_comments"], shares: ["shares", "share_count", "reposts"], views: ["views", "view_count"] };
  return Object.fromEntries(Object.entries(aliases).map(([key, keys]) => [key, keys.map((name) => finiteNumber(source[name])).find((value) => value !== null)]).filter(([, value]) => value !== undefined));
}

function buildActionRequired(searches) {
  const missing = searches.filter((item) => ["not_configured", "auth_required", "provider_error"].includes(item.local_status)).map((item) => ({
    platform: item.platform,
    action: item.local_status === "auth_required" ? "login_with_dedicated_account" : item.local_status === "provider_error" ? "inspect_local_browser_session" : "install_local_social_connector",
    recommendation: item.platform === "x" ? "Connect the AgentRouter X connector or sign in through the browser bridge" : item.platform === "reddit" ? "Sign in to Reddit in the dedicated AgentRouter browser profile" : item.platform === "xiaohongshu" ? "Open the local browser profile, confirm Xiaohongshu is signed in, then retry" : item.platform === "bilibili" ? "Install or inspect the local Bilibili read-only connector" : item.platform === "youtube" ? "Inspect the local YouTube browser session or install yt-dlp" : item.platform === "facebook" ? "Sign in to Facebook in the dedicated AgentRouter browser profile" : "Configure an AgentRouter platform connector"
  }));
  return missing.length ? missing : [];
}

function inferPlatform(url, fallback) {
  if (/reddit\.com/i.test(url)) return "reddit";
  if (/(^|\.)x\.com|twitter\.com/i.test(url)) return "x";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xiaohongshu";
  if (/bilibili\.com/i.test(url)) return "bilibili";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/facebook\.com/i.test(url)) return "facebook";
  return fallback || "other";
}

async function readXcrawlApiKey(configPath) {
  const target = configPath || path.join(os.homedir(), ".xcrawl", "config.json");
  try {
    const config = JSON.parse(await fs.readFile(target, "utf8"));
    return clean(config.XCRAWL_API_KEY, 1000);
  } catch {
    return "";
  }
}

function researchError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validDate(value) {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
