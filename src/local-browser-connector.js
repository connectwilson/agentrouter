import { randomUUID } from "node:crypto";

import { buildLocalSocialExecutionPlan } from "./local-social-privacy.js";

const NATIVE_ADAPTERS = new Set(["codex_browser", "claude_in_chrome"]);
const SUPPORTED_ADAPTERS = new Set([...NATIVE_ADAPTERS, "opencli"]);

export function buildLocalBrowserHandoff(input = {}) {
  const plan = input.localExecutionPlan || buildLocalSocialExecutionPlan({
    platform: input.platform,
    operation: input.operation,
    target: input.target,
    query: input.query,
    handle: input.handle,
    from: input.from,
    to: input.to,
    entity: input.entity,
    limit: input.limit
  });
  const selectedAdapter = selectBrowserAdapter(input.consumerContext, plan.operation);
  const allowedOrigins = [...new Set(plan.allowed_domains.map((domain) => `https://${domain.replace(/^www\./, "")}`))];
  const target = clean(input.target || plan.params?.target, 2000) || null;
  return {
    handoff_version: "agentrouter_local_browser_handoff_v1",
    handoff_id: `lbh_${randomUUID()}`,
    kind: "local_browser_execution",
    backend: "agentrouter_mcp_local_connector",
    selected_adapter: selectedAdapter,
    fallback_adapters: selectedAdapter === "opencli" ? [] : ["opencli"],
    execution_location: "user_device",
    platform: plan.platform,
    operation: plan.operation,
    target,
    allowed_origins: allowedOrigins,
    permissions: {
      access: "read_only",
      write_actions: "denied",
      credential_export: "denied",
      arbitrary_process_execution: "denied"
    },
    data_policy: {
      credentials: "never_return",
      cookies: "never_return",
      raw_browser_state: "never_return"
    },
    completion: {
      tool: "agentrouter_complete_handoff",
      required_fields: ["handoff", "result"],
      result_fields: ["canonical_url", "post_id", "text", "author_handle", "published_at", "engagement"]
    },
    preserve_route_context: true
  };
}

export function completeLocalBrowserHandoff({ handoff, result } = {}) {
  if (handoff?.handoff_version !== "agentrouter_local_browser_handoff_v1"
    || handoff?.kind !== "local_browser_execution") {
    return invalidCompletion("HANDOFF_INVALID", "A valid AgentRouter local browser handoff is required.");
  }
  if (handoff.permissions?.access !== "read_only" || handoff.permissions?.write_actions !== "denied") {
    return invalidCompletion("HANDOFF_NOT_READ_ONLY", "Only read-only browser handoffs can be completed.");
  }
  const sourceUrl = safeUrl(result?.canonical_url || handoff.target);
  if (!sourceUrl || !originAllowed(sourceUrl.origin, handoff.allowed_origins)) {
    return invalidCompletion("HANDOFF_SOURCE_NOT_ALLOWED", "The returned source is outside the handoff origin allowlist.");
  }
  const targetUrl = safeUrl(handoff.target);
  if (handoff.operation === "read_post" && targetUrl && !samePostTarget(targetUrl, sourceUrl)) {
    return invalidCompletion("HANDOFF_SOURCE_MISMATCH", "The returned post does not match the requested target.");
  }

  // Keep the canonical local invocation namespace so the authenticated
  // feedback-grant endpoint can bind this result to the same trust pipeline as
  // OpenCLI reads. The adapter remains explicit in source.backend_id.
  const requestId = `local_post_${handoff.platform}_${randomUUID()}`;
  const serviceId = `local_social_${handoff.platform}`;
  const postId = clean(result?.post_id, 120) || postIdFromUrl(targetUrl) || null;
  const canonicalUrl = targetUrl?.toString() || sourceUrl.toString();
  const post = {
    platform: clean(handoff.platform, 40),
    post_id: postId,
    canonical_url: canonicalUrl,
    text: clean(result?.text || result?.content, 20000) || null,
    author_handle: clean(result?.author_handle || result?.author, 120) || null,
    published_at: isoTimestamp(result?.published_at || result?.created_at),
    engagement: normalizeEngagement(result?.engagement || result?.public_metrics),
    verification_status: "source_url_verified"
  };
  return {
    ok: true,
    status: "completed",
    request_id: requestId,
    service_id: serviceId,
    protocol: {
      protocol_version: "agentrouter_local_browser_result_v1",
      execution_location: "user_device",
      access: "read_only",
      credential_policy: "never_return",
      raw_result_policy: "local_only"
    },
    request: {
      capability: handoff.operation === "read_post" ? "social_post_read" : "social_search",
      params: { platform: handoff.platform, operation: handoff.operation, ...(canonicalUrl ? { url: canonicalUrl } : {}) }
    },
    result: { post },
    source: {
      backend_id: handoff.selected_adapter,
      handoff_id: handoff.handoff_id,
      fallback_used: false
    },
    verification: {
      source_url_preserved: Boolean(targetUrl && samePostTarget(targetUrl, sourceUrl)),
      origin_allowlist_passed: true,
      post_id_matches_url: Boolean(postId && postId === postIdFromUrl(targetUrl))
    },
    consumer_feedback_request: feedbackRequest(requestId, serviceId, handoff, canonicalUrl)
  };
}

export function hasNativeBrowserCapability(consumerContext = {}, operation = "") {
  return NATIVE_ADAPTERS.has(selectBrowserAdapter(consumerContext, operation));
}

function selectBrowserAdapter(consumerContext = {}, operation = "") {
  const declaration = consumerContext?.local_browser || consumerContext?.browser;
  const candidates = Array.isArray(declaration?.adapters) ? declaration.adapters : declaration ? [declaration] : [];
  const normalized = candidates
    .map((candidate) => typeof candidate === "string" ? { adapter: candidate, available: true } : candidate)
    .filter((candidate) => candidate?.available !== false && SUPPORTED_ADAPTERS.has(clean(candidate?.adapter, 60).toLowerCase()))
    .filter((candidate) => !Array.isArray(candidate.operations) || !operation || candidate.operations.includes(operation));
  const preferred = clean(declaration?.preferred_adapter, 60).toLowerCase();
  const preferredCandidate = normalized.find((candidate) => candidate.adapter === preferred);
  if (preferredCandidate) return preferredCandidate.adapter;
  const native = normalized.find((candidate) => NATIVE_ADAPTERS.has(candidate.adapter));
  return native?.adapter || normalized[0]?.adapter || "opencli";
}

function feedbackRequest(requestId, serviceId, handoff, canonicalUrl) {
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
      platform: handoff.platform,
      url: canonicalUrl,
      capability: handoff.operation === "read_post" ? "social_post_read" : "social_search",
      browser_adapter: handoff.selected_adapter
    }
  };
}

function invalidCompletion(code, message) {
  return { ok: false, status: "invalid_handoff_result", error: { code, message } };
}

function originAllowed(origin, allowedOrigins = []) {
  return allowedOrigins.some((allowed) => safeUrl(allowed)?.origin === origin);
}

function samePostTarget(left, right) {
  return left.origin === right.origin && left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
}

function postIdFromUrl(url) {
  return url?.pathname.match(/\/(?:status|comments|video)\/([A-Za-z0-9_-]+)/)?.[1] || null;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeEngagement(value = {}) {
  const output = {};
  const aliases = {
    likes: ["likes", "like_count", "favorite_count"],
    comments: ["comments", "reply_count", "comment_count"],
    shares: ["shares", "retweet_count", "share_count"],
    views: ["views", "view_count", "play_count"]
  };
  for (const [field, keys] of Object.entries(aliases)) {
    const found = keys.map((key) => value?.[key]).find((item) => Number.isFinite(Number(item)));
    if (found !== undefined) output[field] = Number(found);
  }
  return output;
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}
