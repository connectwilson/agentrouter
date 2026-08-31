import crypto from "node:crypto";
import { deleteProviderSecret, readProviderSecret, writeProviderSecret } from "./provider-secrets.js";
import { deletePersistentSocialConnection, listPersistentSocialConnections, writePersistentSocialConnection } from "./persistence.js";
import { readBoundedSocialResponse, socialProviderTransportFailure } from "./social-transport.js";

const PROVIDER_MATRIX = {
  x: new Set(["local_browser", "x_api"]),
  reddit: new Set(["local_browser", "reddit_api"]),
  xiaohongshu: new Set(["local_browser"]),
  bilibili: new Set(["local_browser"]),
  youtube: new Set(["local_browser", "youtube_api"]),
  facebook: new Set(["local_browser"]),
  brave_search: new Set(["brave_api"]),
  tavily: new Set(["tavily_api"]),
  serper: new Set(["serper_api"]),
  exa: new Set(["exa_api"]),
  firecrawl: new Set(["firecrawl_api"]),
  jina: new Set(["jina_api"]),
  virus_total: new Set(["virustotal_api"]),
  google_places: new Set(["google_places_api"]),
  amadeus: new Set(["amadeus_api"]),
  easy_post: new Set(["easypost_api"]),
  openalex: new Set(["openalex_api"]),
  fred: new Set(["fred_api"]),
  finnhub: new Set(["finnhub_api"]),
  perplexity: new Set(["perplexity_api"]),
  tushare: new Set(["tushare_api"]),
  zhihu: new Set(["local_browser"]),
  weibo: new Set(["local_browser"]),
  tiktok: new Set(["local_browser"]),
  xpoz: new Set(["xpoz_api"]),
  socialdatax: new Set(["socialdatax_api"])
};

const REQUIRED_CREDENTIAL = {
  x_api: "bearer_token",
  reddit_api: "access_token",
  brave_api: "api_key",
  tavily_api: "api_key",
  serper_api: "api_key",
  exa_api: "api_key",
  firecrawl_api: "api_key",
  jina_api: "api_key",
  youtube_api: "api_key",
  virustotal_api: "api_key",
  google_places_api: "api_key",
  amadeus_api: "access_token",
  easypost_api: "api_key",
  openalex_api: "api_key",
  fred_api: "api_key",
  finnhub_api: "api_key",
  perplexity_api: "api_key",
  tushare_api: "api_key",
  xpoz_api: "api_key",
  socialdatax_api: "api_key"
};

export async function createSocialConnection(store, ownerKey, input = {}, options = {}) {
  assertOwner(ownerKey);
  const platform = clean(input.platform, 32).toLowerCase();
  const providerType = clean(input.provider_type, 40).toLowerCase();
  if (!PROVIDER_MATRIX[platform]?.has(providerType)) {
    throw socialError("INVALID_SOCIAL_PROVIDER", `Provider ${providerType || "(missing)"} is not supported for ${platform || "this platform"}.`, 422);
  }
  const requiredCredential = REQUIRED_CREDENTIAL[providerType];
  const credentialValue = requiredCredential ? clean(input.credentials?.[requiredCredential], 20000) : "";
  if (requiredCredential && !credentialValue) {
    throw socialError("SOCIAL_CREDENTIAL_REQUIRED", `${requiredCredential} is required for ${providerType}.`, 422);
  }

  const connectionId = `social_${crypto.randomUUID()}`;
  const writeSecret = options.writeSecret || writeProviderSecret;
  const secretRef = credentialValue
    ? await writeSecret({ serviceId: connectionId, secretName: requiredCredential, secretValue: credentialValue })
    : null;
  const now = new Date().toISOString();
  const record = {
    connection_id: connectionId,
    owner_key: ownerKey,
    platform,
    provider_type: providerType,
    label: clean(input.label, 120) || defaultLabel(platform, providerType),
    secret_ref: secretRef,
    credential_field: requiredCredential || null,
    status: "configured",
    created_at: now,
    updated_at: now
  };
  store.socialConnections.set(connectionId, record);
  await (options.writeConnection || writePersistentSocialConnection)(record);
  return publicConnection(record);
}

export function listSocialConnections(store, ownerKey) {
  assertOwner(ownerKey);
  return [...(store.socialConnections || new Map()).values()]
    .filter((record) => record.owner_key === ownerKey)
    .map(publicConnection);
}

export async function deleteSocialConnection(store, ownerKey, connectionId, options = {}) {
  assertOwner(ownerKey);
  const record = store.socialConnections?.get(connectionId);
  if (!record || record.owner_key !== ownerKey) throw socialError("SOCIAL_CONNECTION_NOT_FOUND", "Social connection was not found.", 404);
  if (record.secret_ref) await (options.deleteSecret || deleteProviderSecret)(record.secret_ref);
  await (options.deleteConnection || deletePersistentSocialConnection)(connectionId, ownerKey);
  store.socialConnections.delete(connectionId);
  return { ok: true, connection_id: connectionId };
}

export async function hydrateSocialConnections(store, options = {}) {
  const records = await (options.listConnections || listPersistentSocialConnections)();
  for (const record of records) {
    if (record?.connection_id && record?.owner_key) store.socialConnections.set(record.connection_id, record);
  }
  return records.length;
}

export async function socialProvidersForUser(store, ownerKey, options = {}) {
  if (!ownerKey) return {};
  const readSecret = options.readSecret || readProviderSecret;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const transport = {
    timeoutMs: options.fetchTimeoutMs,
    maxBytes: options.fetchMaxResponseBytes
  };
  const providers = {};
  for (const record of (store.socialConnections || new Map()).values()) {
    if (record.owner_key !== ownerKey || record.provider_type === "local_browser") continue;
    const secret = await readSecret(record.secret_ref);
    const provider = record.provider_type === "x_api"
      ? createXApiProvider(record, secret, fetchImpl, transport)
      : record.provider_type === "reddit_api"
        ? createRedditApiProvider(record, secret, fetchImpl, transport)
        : null;
    if (provider) (providers[record.platform] ||= []).push(provider);
  }
  return providers;
}

function createXApiProvider(record, bearerToken, fetchImpl, transport) {
  return {
    id: `x-api:${record.connection_id}`,
    async readPost(target) {
      const postId = xPostId(target);
      if (!postId) return { status: "provider_error", error: "A valid X status URL is required.", rows: [] };
      const url = new URL(`https://api.x.com/2/tweets/${postId}`);
      addXResponseFields(url);
      const fetched = await providerJson(fetchImpl, url, {
        headers: { authorization: `Bearer ${bearerToken}`, accept: "application/json" }
      }, transport, "x_read_post");
      if (!fetched.ok) return fetched.failure;
      const { response, payload } = fetched;
      if (!response.ok) return providerFailure(response.status, payload);
      const users = new Map((payload.includes?.users || []).map((user) => [user.id, user]));
      return {
        status: payload.data ? "completed" : "provider_error",
        rows: payload.data ? [normalizeXTweet(payload.data, users)] : [],
        error: payload.data ? null : "X returned no post data."
      };
    },
    async search(query, limit) {
      const url = new URL("https://api.x.com/2/tweets/search/recent");
      url.searchParams.set("query", query);
      url.searchParams.set("max_results", String(Math.max(10, Math.min(100, Number(limit) || 10))));
      addXResponseFields(url);
      const fetched = await providerJson(fetchImpl, url, {
        headers: { authorization: `Bearer ${bearerToken}`, accept: "application/json" }
      }, transport, "x_search");
      if (!fetched.ok) return fetched.failure;
      const { response, payload } = fetched;
      if (!response.ok) return providerFailure(response.status, payload);
      const users = new Map((payload.includes?.users || []).map((user) => [user.id, user]));
      const rows = (payload.data || []).map((tweet) => normalizeXTweet(tweet, users));
      return {
        status: rows.length ? "completed" : "no_results",
        rows
      };
    }
  };
}

function addXResponseFields(url) {
  url.searchParams.set("tweet.fields", "author_id,created_at,public_metrics,lang");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name");
}

function normalizeXTweet(tweet, users) {
  const user = users.get(tweet.author_id) || {};
  const author = user.username || tweet.author_id || null;
  return {
    id: tweet.id,
    text: tweet.text,
    author,
    published_at: tweet.created_at || null,
    url: author ? `https://x.com/${author}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`,
    engagement: {
      likes: tweet.public_metrics?.like_count,
      comments: tweet.public_metrics?.reply_count,
      shares: tweet.public_metrics?.retweet_count,
      views: tweet.public_metrics?.impression_count
    }
  };
}

function xPostId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) return null;
    return url.pathname.match(/\/status\/(\d+)(?:\/)?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function createRedditApiProvider(record, accessToken, fetchImpl, transport) {
  return {
    id: `reddit-api:${record.connection_id}`,
    async search(query, limit) {
      const url = new URL("https://oauth.reddit.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(limit) || 10))));
      url.searchParams.set("sort", "relevance");
      url.searchParams.set("raw_json", "1");
      const fetched = await providerJson(fetchImpl, url, {
        headers: { authorization: `Bearer ${accessToken}`, "user-agent": "AgentRouter/0.1 social research", accept: "application/json" }
      }, transport, "reddit_search");
      if (!fetched.ok) return fetched.failure;
      const { response, payload } = fetched;
      if (!response.ok) return providerFailure(response.status, payload);
      const rows = (payload.data?.children || []).map((child) => child.data || {}).map((post) => ({
        id: post.id,
        title: post.title,
        text: post.selftext,
        author: post.author,
        published_at: post.created_utc,
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.url,
        engagement: { likes: post.score, comments: post.num_comments }
      }));
      return {
        status: rows.length ? "completed" : "no_results",
        rows
      };
    }
  };
}

function providerFailure(status, payload) {
  const errorCode = status === 401 || status === 403 ? "SOCIAL_PROVIDER_AUTH_REQUIRED"
    : status === 429 ? "SOCIAL_PROVIDER_RATE_LIMITED" : "SOCIAL_PROVIDER_HTTP_ERROR";
  return {
    status: status === 401 || status === 403 ? "auth_required" : status === 429 ? "rate_limited" : "provider_error",
    error_code: errorCode,
    error: clean(payload?.detail || payload?.title || payload?.error || `Provider returned HTTP ${status}`, 300),
    diagnostics: {
      code: errorCode,
      category: status === 429 ? "rate_limit" : status >= 500 ? "upstream_server" : "upstream_client",
      stage: "social_provider_http",
      retryable: status === 429 || status >= 500,
      http_status: Number(status) || null
    },
    rows: []
  };
}

async function providerJson(fetchImpl, url, options, transport, stage) {
  try {
    const fetched = await readBoundedSocialResponse(fetchImpl, url, options, {
      mode: "json",
      stage,
      timeoutMs: transport?.timeoutMs,
      maxBytes: transport?.maxBytes
    });
    return { ok: true, ...fetched };
  } catch (error) {
    return { ok: false, failure: socialProviderTransportFailure(error, { stage }) };
  }
}

function publicConnection(record) {
  return {
    connection_id: record.connection_id,
    platform: record.platform,
    provider_type: record.provider_type,
    label: record.label,
    status: record.status,
    has_credentials: Boolean(record.secret_ref),
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function defaultLabel(platform, providerType) {
  return providerType === "local_browser" ? `${platform} · Local browser` : `${platform} · Official API`;
}

function assertOwner(ownerKey) {
  if (!ownerKey) throw socialError("AUTHENTICATION_REQUIRED", "Sign in before managing social connections.", 401);
}

function socialError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
