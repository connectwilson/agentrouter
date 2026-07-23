const PLATFORM_POLICIES = Object.freeze({
  x: policy("keyword_user_voice", ["search", "read_post", "read_user_posts"], ["x.com", "twitter.com"], ["opencli-twitter", "twitter-cli"]),
  reddit: policy("keyword_user_voice", ["search", "read_post", "read_community"], ["reddit.com", "oauth.reddit.com"], ["opencli-reddit", "rdt-cli"]),
  xiaohongshu: policy("keyword_user_voice", ["search", "read_post", "read_comments"], ["xiaohongshu.com", "edith.xiaohongshu.com"], ["opencli-xiaohongshu", "xhs-skills-local", "xhs-cli"]),
  bilibili: policy("keyword_user_voice", ["search", "read_video", "read_subtitles"], ["bilibili.com", "api.bilibili.com"], ["bili-cli", "opencli-bilibili"]),
  youtube: policy("keyword_user_voice", ["search", "read_video", "read_subtitles"], ["youtube.com", "www.youtube.com"], ["opencli-youtube", "yt-dlp"]),
  facebook: policy("keyword_user_voice", ["search", "read_profile", "read_feed", "read_groups"], ["facebook.com", "www.facebook.com"], ["opencli-facebook"]),
  instagram: policy("account_discovery_only", ["search_accounts", "read_profile", "read_user_posts"], ["instagram.com", "www.instagram.com"], ["opencli-instagram"]),
  v2ex: policy("community_browse_only", ["read_hot", "read_node", "read_topic", "read_replies"], ["v2ex.com", "www.v2ex.com"], ["v2ex-public-api"])
});

export function getLocalSocialPlatformCatalog() {
  return Object.entries(PLATFORM_POLICIES).map(([platform, item]) => ({
    platform,
    research_suitability: item.research_suitability,
    operations: [...item.operations],
    credential_location: "user_device_only",
    execution_location: "user_device",
    access: "read_only"
  }));
}

export function buildLocalSocialExecutionPlan(input = {}) {
  const platform = clean(input.platform, 40).toLowerCase();
  const operation = clean(input.operation, 40).toLowerCase();
  const platformPolicy = PLATFORM_POLICIES[platform];
  if (!platformPolicy) throw localError("LOCAL_SOCIAL_PLATFORM_NOT_SUPPORTED", `Local social platform ${platform || "(missing)"} is not supported.`);
  if (!platformPolicy.operations.includes(operation)) {
    throw localError("LOCAL_SOCIAL_OPERATION_NOT_ALLOWED", `${operation || "(missing)"} is not an allowed read-only operation for ${platform}.`);
  }
  return {
    protocol_version: "agentrouter_local_social_task_v1",
    task_id: clean(input.task_id, 120) || null,
    platform,
    operation,
    params: {
      query: clean(input.query, 1000) || null,
      target: clean(input.target, 2000) || null,
      limit: Math.max(1, Math.min(50, Number(input.limit) || 10))
    },
    execution_location: "user_device",
    allowed_domains: [...platformPolicy.allowed_domains],
    adapter_candidates: [...platformPolicy.adapter_candidates],
    permissions: {
      access: "read_only",
      user_confirmation: "required_first_use",
      write_actions: "denied",
      arbitrary_process_execution: "denied"
    },
    data_policy: {
      credentials: "never_upload",
      raw_results: "never_upload",
      default_disclosure: "aggregate_only",
      excerpt_disclosure: "explicit_user_consent_only"
    }
  };
}

export function prepareLocalSocialDisclosure({ platform, rows = [], consent = "aggregate_only" } = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const base = {
    protocol_version: "agentrouter_local_social_disclosure_v1",
    platform: clean(platform, 40).toLowerCase(),
    processed_on: "user_device",
    item_count: normalizedRows.length
  };
  if (consent !== "share_sanitized_excerpts") return { ...base, disclosure: "aggregate_only" };
  return {
    ...base,
    disclosure: "sanitized_excerpts",
    rows: normalizedRows.map(sanitizeRow).filter((row) => row.canonical_url || row.text_excerpt)
  };
}

function sanitizeRow(row = {}) {
  return {
    canonical_url: safePublicUrl(row.url || row.canonical_url),
    text_excerpt: clean(row.text_excerpt || row.text || row.selftext || row.title, 800) || null,
    title: clean(row.title, 300) || null,
    author_handle: clean(row.author_handle || row.author || row.username, 120) || null,
    published_at: row.published_at || row.created_at || row.created_utc || null,
    engagement: sanitizeEngagement(row.engagement)
  };
}

function sanitizeEngagement(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const key of ["likes", "comments", "shares", "views", "favorites"]) {
    if (Number.isFinite(Number(value[key]))) result[key] = Number(value[key]);
  }
  return result;
}

function safePublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|session|auth|signature|xsec/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function policy(researchSuitability, operations, allowedDomains, adapterCandidates) {
  return Object.freeze({ research_suitability: researchSuitability, operations: Object.freeze(operations), allowed_domains: Object.freeze(allowedDomains), adapter_candidates: Object.freeze(adapterCandidates) });
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function localError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
