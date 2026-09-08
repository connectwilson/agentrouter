import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const NATIVE_ADAPTERS = new Set(["codex_browser", "claude_in_chrome"]);
const SUPPORTED_ADAPTERS = new Set([...NATIVE_ADAPTERS, "opencli"]);
const SUPPORTED_OPERATIONS = new Set(["read_post", "search", "read_user_posts", "read_thread", "read_trends"]);
const DEFAULT_TTL_MS = 5 * 60_000;

const PLATFORM_HOSTS = Object.freeze({
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
  youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
  bilibili: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
  reddit: ["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"],
  xiaohongshu: ["xiaohongshu.com", "www.xiaohongshu.com"],
  zhihu: ["zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"],
  weibo: ["weibo.com", "www.weibo.com", "m.weibo.cn", "weibo.cn"]
});

export function createLocalBrowserConnector({
  secret = process.env.ADN_BROWSER_HANDOFF_SECRET || randomBytes(32).toString("base64url"),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  consumed = new Map()
} = {}) {
  const signingSecret = String(secret);
  if (signingSecret.length < 16) throw protocolError("HANDOFF_SECRET_INVALID", "Browser handoff signing secret is too short.");

  function buildHandoff(input = {}) {
    const platform = clean(input.platform, 40).toLowerCase();
    const operation = clean(input.operation, 40).toLowerCase();
    if (!SUPPORTED_OPERATIONS.has(operation)) throw protocolError("HANDOFF_OPERATION_UNSUPPORTED", `Unsupported browser operation: ${operation || "(missing)"}.`);
    const browserRequest = normalizeBrowserRequest({ ...input, platform, operation });
    const target = browserRequest.target;
    const selectedAdapter = selectBrowserAdapter(input.consumerContext, operation);
    const issuedAt = now();
    const expiresAt = issuedAt + Math.max(5_000, Math.min(15 * 60_000, Number(ttlMs) || DEFAULT_TTL_MS));
    const payload = {
      v: 2,
      id: `lbh_${randomUUID()}`,
      platform,
      operation,
      target,
      request: browserRequest.request,
      target_identity: browserRequest.targetIdentity,
      adapter: selectedAdapter,
      origins: allowedOrigins(platform),
      issued_at: issuedAt,
      expires_at: expiresAt
    };
    cleanupConsumed(consumed, issuedAt);
    return publicHandoff(payload, signPayload(payload, signingSecret));
  }

  function completeHandoff({ handoff, result } = {}) {
    const verified = verifyToken(handoff?.handoff_token, signingSecret);
    if (!verified.ok) return invalidCompletion(verified.code, verified.message);
    const payload = verified.payload;
    const currentTime = now();
    cleanupConsumed(consumed, currentTime);
    if (currentTime > payload.expires_at) return invalidCompletion("HANDOFF_EXPIRED", "This browser handoff expired; run the AgentRouter request again.");
    if (consumed.has(payload.id)) return invalidCompletion("HANDOFF_ALREADY_CONSUMED", "This browser handoff was already completed.");

    const sourceUrl = clean(result?.canonical_url, 2000) || payload.target;
    const sourceIdentity = normalizeCompletionSource(payload, sourceUrl);
    if (!sourceIdentity || !payload.origins.includes(sourceIdentity.origin)) {
      return invalidCompletion("HANDOFF_SOURCE_NOT_ALLOWED", "The returned source is outside the signed platform allowlist.");
    }
    if (["read_post", "read_thread"].includes(payload.operation) && sourceIdentity.postId !== payload.target_identity?.post_id) {
      return invalidCompletion("HANDOFF_SOURCE_MISMATCH", "The returned post does not match the signed target.");
    }
    if (payload.operation === "read_user_posts" && sourceIdentity.handle !== payload.target_identity?.handle) {
      return invalidCompletion("HANDOFF_SOURCE_MISMATCH", "The returned account does not match the signed target.");
    }

    if (payload.operation !== "read_post") {
      const completed = completeCollectionHandoff({ payload, result, sourceUrl, currentTime });
      if (completed.ok) consumed.set(payload.id, payload.expires_at);
      return completed;
    }
    consumed.set(payload.id, payload.expires_at);
    const requestId = `local_post_${payload.platform}_${randomUUID()}`;
    const serviceId = `local_social_${payload.platform}`;
    const extractedAt = new Date(currentTime).toISOString();
    const post = {
      platform: payload.platform,
      post_id: payload.target_identity?.post_id,
      canonical_url: payload.target,
      text: clean(result?.text || result?.content, 20000) || null,
      author_handle: clean(result?.author_handle || result?.author, 120) || null,
      published_at: isoTimestamp(result?.published_at || result?.created_at),
      engagement: normalizeEngagement(result?.engagement || result?.public_metrics),
      verification_status: "caller_attested"
    };
    const evidenceHash = createHash("sha256").update(JSON.stringify({ post, source_url: sourceUrl, extracted_at: extractedAt })).digest("hex");
    return {
      ok: true,
      status: "completed",
      request_id: requestId,
      service_id: serviceId,
      protocol: {
        protocol_version: "agentrouter_local_browser_result_v2",
        execution_location: "user_device",
        access: "read_only",
        credential_policy: "never_return",
        raw_result_policy: "local_only"
      },
      request: {
        capability: "social_post_read",
        params: payload.request.params
      },
      result: { post },
      source: {
        backend_id: payload.adapter,
        handoff_id: payload.id,
        handoff_expires_at: new Date(payload.expires_at).toISOString(),
        returned_url: sourceUrl,
        fallback_used: payload.adapter === "opencli"
      },
      evidence: {
        evidence_version: "agentrouter_browser_evidence_v1",
        sha256: evidenceHash,
        extracted_at: extractedAt,
        attestation: "caller_supplied_public_page_fields"
      },
      verification: {
        source_url_matched: true,
        platform_identity_matched: true,
        origin_allowlist_passed: true,
        content_verified: false,
        field_status: {
          text: post.text ? "caller_attested" : "missing",
          author_handle: post.author_handle ? "caller_attested" : "missing",
          published_at: post.published_at ? "caller_attested" : "missing",
          engagement: Object.keys(post.engagement).length ? "caller_attested" : "missing"
        }
      },
      consumer_feedback_request: feedbackRequest(requestId, serviceId, payload)
    };
  }

  return { buildHandoff, completeHandoff };

  function completeCollectionHandoff({ payload, result, sourceUrl, currentTime }) {
    const bounded = payload.request.params.limit || 10;
    const rawItems = Array.isArray(result?.items) ? result.items.slice(0, bounded) : [];
    const items = [];
    for (const row of rawItems) {
      const normalized = normalizeBrowserItem(row, payload);
      if (!normalized.ok) return invalidCompletion(normalized.code, normalized.message);
      items.push(normalized.item);
    }
    if (payload.operation === "read_thread" && items.length && !items.some((item) => item.id === payload.target_identity?.post_id)) {
      return invalidCompletion("HANDOFF_ITEM_IDENTITY_MISMATCH", "The returned thread does not contain the signed root post.");
    }
    const requestId = `local_${payload.operation}_${payload.platform}_${randomUUID()}`;
    const serviceId = `local_social_${payload.platform}`;
    const extractedAt = new Date(currentTime).toISOString();
    const evidenceHash = createHash("sha256").update(JSON.stringify({ items, source_url: sourceUrl, extracted_at: extractedAt })).digest("hex");
    return {
      ok: true,
      status: items.length ? "completed" : "no_results",
      request_id: requestId,
      service_id: serviceId,
      protocol: {
        protocol_version: "agentrouter_local_browser_result_v3",
        execution_location: "user_device",
        access: "read_only",
        credential_policy: "never_return",
        raw_result_policy: "local_only"
      },
      request: payload.request,
      result: { items, item_count: items.length },
      coverage: {
        status: items.length ? "sufficient" : "insufficient",
        item_count: items.length,
        requested_limit: bounded,
        operation: payload.operation
      },
      source: {
        backend_id: payload.adapter,
        handoff_id: payload.id,
        handoff_expires_at: new Date(payload.expires_at).toISOString(),
        returned_url: sourceUrl,
        fallback_used: payload.adapter === "opencli"
      },
      evidence: {
        evidence_version: "agentrouter_browser_evidence_v1",
        sha256: evidenceHash,
        extracted_at: extractedAt,
        attestation: "caller_supplied_public_page_fields"
      },
      verification: {
        source_url_matched: true,
        platform_identity_matched: true,
        origin_allowlist_passed: true,
        content_verified: false,
        item_count: items.length
      },
      consumer_feedback_request: feedbackRequest(requestId, serviceId, payload)
    };
  }
}

const defaultConnector = createLocalBrowserConnector();

export function buildLocalBrowserHandoff(input = {}) {
  return defaultConnector.buildHandoff(input);
}

export function completeLocalBrowserHandoff(input = {}) {
  return defaultConnector.completeHandoff(input);
}

export function hasNativeBrowserCapability(consumerContext = {}, operation = "") {
  return NATIVE_ADAPTERS.has(selectBrowserAdapter(consumerContext, operation));
}

export function normalizeSocialPostUrl(platform, value) {
  const url = safeUrl(value);
  const normalizedPlatform = clean(platform, 40).toLowerCase();
  if (!url || !PLATFORM_HOSTS[normalizedPlatform]?.includes(url.hostname.toLowerCase())) return null;
  let postId = null;
  if (normalizedPlatform === "x") postId = url.pathname.match(/\/status\/(\d+)/)?.[1];
  if (normalizedPlatform === "tiktok") postId = url.pathname.match(/\/video\/(\d+)/)?.[1];
  if (normalizedPlatform === "youtube") postId = url.hostname === "youtu.be" ? url.pathname.split("/").filter(Boolean)[0] : (url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|live)\/([A-Za-z0-9_-]{6,})/)?.[1]);
  if (normalizedPlatform === "bilibili") postId = url.pathname.match(/\/(BV[A-Za-z0-9]+)/i)?.[1];
  if (normalizedPlatform === "reddit") postId = url.hostname === "redd.it" ? url.pathname.split("/").filter(Boolean)[0] : url.pathname.match(/\/comments\/([A-Za-z0-9]+)/)?.[1];
  if (normalizedPlatform === "xiaohongshu") postId = url.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/)?.[1];
  if (normalizedPlatform === "zhihu") postId = url.pathname.match(/\/answer\/(\d+)/)?.[1] || url.pathname.match(/\/question\/(\d+)/)?.[1];
  if (normalizedPlatform === "weibo") postId = url.pathname.match(/^\/(?:detail\/)?(?:\d+\/)?([A-Za-z0-9]{6,})/)?.[1];
  return postId ? { platform: normalizedPlatform, postId, origin: canonicalOrigin(normalizedPlatform) } : null;
}

function publicHandoff(payload, token) {
  const collection = payload.operation !== "read_post";
  return {
    handoff_version: "agentrouter_local_browser_handoff_v2",
    handoff_id: payload.id,
    handoff_token: token,
    issued_at: new Date(payload.issued_at).toISOString(),
    expires_at: new Date(payload.expires_at).toISOString(),
    kind: "local_browser_execution",
    backend: "agentrouter_mcp_local_connector",
    selected_adapter: payload.adapter,
    fallback_adapters: [],
    ...(payload.adapter === "opencli" ? { compatibility_mode: "legacy_client_opencli" } : {}),
    execution_location: "user_device",
    platform: payload.platform,
    operation: payload.operation,
    target: payload.target,
    request: payload.request,
    allowed_origins: [...payload.origins],
    permissions: {
      access: "read_only",
      write_actions: "denied",
      credential_export: "denied",
      arbitrary_process_execution: "denied"
    },
    data_policy: { credentials: "never_return", cookies: "never_return", raw_browser_state: "never_return" },
    completion: {
      tool: "agentrouter_complete_handoff",
      required_fields: ["handoff", "result"],
      result_fields: collection
        ? ["canonical_url", "items"]
        : ["canonical_url", "post_id", "text", "author_handle", "published_at", "engagement"]
    },
    preserve_route_context: true
  };
}

function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `arh1.${body}.${signature}`;
}

function verifyToken(token, secret) {
  const [prefix, body, signature] = String(token || "").split(".");
  if (prefix !== "arh1" || !body || !signature) return { ok: false, code: "HANDOFF_TOKEN_INVALID", message: "A signed AgentRouter browser handoff token is required." };
  const expected = createHmac("sha256", secret).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { ok: false, code: "HANDOFF_TOKEN_INVALID", message: "Browser handoff signature validation failed." };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (![1, 2].includes(payload.v) || !payload.id || !payload.platform || !payload.target) throw new Error("shape");
    if (payload.v === 1) {
      payload.target_identity = { post_id: payload.post_id };
      payload.request = { capability: "social_post_read", params: { platform: payload.platform, operation: "read_post", url: payload.target } };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, code: "HANDOFF_TOKEN_INVALID", message: "Browser handoff payload is invalid." };
  }
}

function selectBrowserAdapter(consumerContext = {}, operation = "") {
  const declaration = consumerContext?.local_browser || consumerContext?.browser;
  const candidates = Array.isArray(declaration?.adapters) ? declaration.adapters : declaration ? [declaration] : [];
  const normalized = candidates
    .map((candidate) => typeof candidate === "string" ? { adapter: candidate, available: true } : candidate)
    .map((candidate) => ({ ...candidate, adapter: clean(candidate?.adapter, 60).toLowerCase() }))
    .filter((candidate) => candidate.available !== false && SUPPORTED_ADAPTERS.has(candidate.adapter))
    .filter((candidate) => !Array.isArray(candidate.operations) || !operation || candidate.operations.includes(operation));
  const preferred = clean(declaration?.preferred_adapter, 60).toLowerCase();
  return normalized.find((candidate) => candidate.adapter === preferred)?.adapter
    || normalized.find((candidate) => NATIVE_ADAPTERS.has(candidate.adapter))?.adapter
    || normalized[0]?.adapter
    || "opencli";
}

function feedbackRequest(requestId, serviceId, payload) {
  return {
    feedback_request_version: "agent_consumer_feedback_request_v1",
    must_submit: true,
    timing: "after_final_answer_or_after_deciding_result_usability",
    endpoint: "/agent-router/feedback",
    method: "POST",
    request_id: requestId,
    service_id: serviceId,
    tool: "agentrouter_feedback",
    required_fields: ["intent_fit", "answer_useful", "reason"],
    context: {
      platform: payload.platform,
      operation: payload.operation,
      url: payload.target,
      capability: payload.request?.capability || "social_post_read",
      browser_adapter: payload.adapter
    }
  };
}

function normalizeBrowserRequest(input) {
  const { platform, operation } = input;
  if (!PLATFORM_HOSTS[platform]) throw protocolError("HANDOFF_PLATFORM_UNSUPPORTED", `Unsupported browser platform: ${platform || "(missing)"}.`);
  const rawParams = input.params && typeof input.params === "object"
    ? input.params
    : input.localExecutionPlan?.params && typeof input.localExecutionPlan.params === "object"
      ? input.localExecutionPlan.params
      : {};
  const constraints = normalizeConstraints(input.constraints);
  const limit = Math.min(Math.max(Math.trunc(Number(rawParams.limit) || (operation === "read_post" ? 1 : 10)), 1), 50);
  if (["read_post", "read_thread"].includes(operation)) {
    const target = clean(input.target || rawParams.url || rawParams.target, 2000);
    const identity = normalizeSocialPostUrl(platform, target);
    if (!identity) throw protocolError("HANDOFF_TARGET_INVALID", `Unsupported ${platform} post URL.`);
    const capability = operation === "read_post" ? "social_post_read" : "social_user_voice_research";
    return {
      target,
      targetIdentity: { post_id: identity.postId },
      request: { capability, params: { platform, operation, url: target, limit }, constraints }
    };
  }
  if (operation === "read_user_posts") {
    if (platform !== "x") throw protocolError("HANDOFF_OPERATION_UNSUPPORTED", "Account-history browser reads currently support X only.");
    const handle = normalizeHandle(rawParams.handle || rawParams.username || rawParams.account);
    if (!handle) throw protocolError("HANDOFF_TARGET_INVALID", "A valid public X account handle is required.");
    return {
      target: `https://x.com/${handle}`,
      targetIdentity: { handle: handle.toLowerCase() },
      request: { capability: "social_user_voice_research", params: compactParams({ ...rawParams, platform, operation, handle, limit }), constraints }
    };
  }
  if (operation === "read_trends") {
    if (platform !== "x") throw protocolError("HANDOFF_OPERATION_UNSUPPORTED", "Trending browser reads currently support X only.");
    return {
      target: "https://x.com/explore/tabs/trending",
      targetIdentity: { page: "trending" },
      request: { capability: "social_search", params: compactParams({ ...rawParams, platform, operation, limit }), constraints }
    };
  }
  const query = clean(rawParams.query || rawParams.keyword || rawParams.question || rawParams.task, 1000);
  if (!query) throw protocolError("HANDOFF_TARGET_INVALID", "A non-empty social search query is required.");
  return {
    target: `${canonicalOrigin(platform)}/search`,
    targetIdentity: { query_hash: createHash("sha256").update(query).digest("hex") },
    request: { capability: rawParams.capability || "social_search", params: compactParams({ ...rawParams, platform, operation, query, limit }), constraints }
  };
}

function normalizeConstraints(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "max_price_usdc")) return {};
  return { max_price_usdc: String(value.max_price_usdc) };
}

function normalizeCompletionSource(payload, value) {
  if (["read_post", "read_thread"].includes(payload.operation)) {
    const identity = normalizeSocialPostUrl(payload.platform, value);
    return identity ? { origin: identity.origin, postId: identity.postId } : null;
  }
  const url = safeUrl(value);
  if (!url || !PLATFORM_HOSTS[payload.platform]?.includes(url.hostname.toLowerCase())) return null;
  if (payload.operation === "read_user_posts") {
    const handle = normalizeHandle(url.pathname.split("/").filter(Boolean)[0]).toLowerCase();
    return handle ? { origin: canonicalOrigin(payload.platform), handle } : null;
  }
  return { origin: canonicalOrigin(payload.platform) };
}

function normalizeBrowserItem(row, payload) {
  const url = clean(row?.url || row?.canonical_url || row?.permalink, 2000) || null;
  let itemIdentity = null;
  if (url) {
    const parsed = safeUrl(url);
    if (!parsed || !PLATFORM_HOSTS[payload.platform]?.includes(parsed.hostname.toLowerCase())) {
      return { ok: false, code: "HANDOFF_ITEM_SOURCE_NOT_ALLOWED", message: "A returned item is outside the signed platform allowlist." };
    }
    itemIdentity = normalizeSocialPostUrl(payload.platform, url);
  }
  const author = clean(row?.author_handle || row?.author?.username || row?.author || row?.username, 120) || null;
  if (payload.operation === "read_user_posts") {
    const requested = payload.target_identity?.handle;
    const actual = normalizeHandle(author || safeUrl(url)?.pathname.split("/").filter(Boolean)[0]).toLowerCase();
    if (!actual || actual !== requested) {
      return { ok: false, code: "HANDOFF_ITEM_IDENTITY_MISMATCH", message: "A returned post belongs to a different account than the signed target." };
    }
  }
  const id = clean(row?.id || row?.post_id || row?.tweet_id || itemIdentity?.postId, 160) || null;
  return {
    ok: true,
    item: {
      id,
      title: clean(row?.title, 400) || null,
      text: clean(row?.text || row?.content || row?.description, 20000) || null,
      author,
      url,
      published_at: isoTimestamp(row?.published_at || row?.created_at),
      engagement: normalizeEngagement(row?.engagement || row?.public_metrics || row)
    }
  };
}

function normalizeHandle(value) {
  const handle = clean(value, 120).replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,30}$/.test(handle) ? handle : "";
}

function compactParams(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function allowedOrigins(platform) {
  return [...new Set((PLATFORM_HOSTS[platform] || []).map((host) => `https://${host}`))];
}

function canonicalOrigin(platform) {
  return `https://${PLATFORM_HOSTS[platform]?.[0] || "invalid.local"}`;
}

function cleanupConsumed(consumed, currentTime) {
  for (const [id, expiresAt] of consumed) if (expiresAt < currentTime) consumed.delete(id);
}

function invalidCompletion(code, message) {
  return { ok: false, status: "invalid_handoff_result", error: { code, message } };
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url : null;
  } catch { return null; }
}

function isoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeEngagement(value = {}) {
  const output = {};
  const aliases = { likes: ["likes", "like_count", "favorite_count"], comments: ["comments", "reply_count", "comment_count"], shares: ["shares", "retweet_count", "share_count"], views: ["views", "view_count", "play_count"] };
  for (const [field, keys] of Object.entries(aliases)) {
    const found = keys.map((key) => value?.[key]).find((item) => Number.isFinite(Number(item)));
    if (found !== undefined) output[field] = Number(found);
  }
  return output;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
