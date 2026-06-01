import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { URL } from "node:url";
import { readJson, sendHtml, sendJson, sendNotFound, getRequestBaseUrl } from "./http-utils.js";
import { createMemoryStore, listServiceSummaries, publicServiceRecord, publicSampleResponse, publicValidationRun, summarizeHomeStats, summarizeRegistryStats } from "./store.js";
import { baseFundFlowManifest, btcLiquidationMaxPainManifest } from "./fixtures.js";
import { handleBtcLiquidationProvider, handleCustomProvider, handleFundFlowProvider, handleMockUpstreamApplicationError, handleMockUpstreamHeaderKey, handleMockUpstreamSentiment } from "./provider-runtime.js";
import { hydratePersistentServiceEvents, invokePaidService, recordConsumerFeedback, registerService, searchServices, validateService, loadProviderConfigs, runServiceHealthCheck, updateServicePayoutWallet, registerServiceErc8004Identity, withCurrentRuntimeEndpoint } from "./registry.js";
import { createEvidenceEnvelope, hashJson } from "./evidence.js";
import { discoverApiServices, publishApiDrafts } from "./openapi-import.js";
import { getCapabilityCatalog, quoteCapabilityRequest, resolveRoute, routeCapabilityRequest, routeTask } from "./router.js";
import { writePersistentServiceEvent } from "./persistence.js";
import { createConsumerFeedbackRequest, verifyServiceResult } from "./verifier.js";
import { isArcNetwork, verifyArcUsdcTransfer } from "./arc-payment.js";
import { anchorConsumerFeedbackOnArc, anchorEvidenceOnArc } from "./arc-anchor.js";
import { createErc8004AgentMetadata, submitErc8004Feedback } from "./erc8004.js";
import { askAgentRouter } from "./agent-router.js";
import { createProviderFromStudio, draftFromServiceRecord, studioHtml } from "./studio.js";
import { agentHtml, homeHtml, humanHtml, serviceDetailHtml } from "./home.js";
import { readProviderConfig } from "./provider-config.js";
import { authProviders, authUserKey, beginOAuth, clearSessionCookie, completeOAuth, currentUser, logout } from "./auth.js";

const clientLogoPaths = {
  "claude.svg": new URL("../public/assets/client-logos/claude.svg", import.meta.url),
  "cursor.svg": new URL("../public/assets/client-logos/cursor.svg", import.meta.url),
  "gemini.svg": new URL("../public/assets/client-logos/gemini.svg", import.meta.url),
  "nous-research.svg": new URL("../public/assets/client-logos/nous-research.svg", import.meta.url),
  "openai.svg": new URL("../public/assets/client-logos/openai.svg", import.meta.url),
  "opencode.svg": new URL("../public/assets/client-logos/opencode.svg", import.meta.url),
  "openclaw.svg": new URL("../public/assets/client-logos/openclaw.svg", import.meta.url),
  "windsurf.svg": new URL("../public/assets/client-logos/windsurf.svg", import.meta.url)
};
const brandLogoPath = new URL("../public/assets/brand/logo.png", import.meta.url);
const agentRouterSkillPath = new URL("../claude-skills/agent-router/SKILL.md", import.meta.url);
const remoteMcpTools = [
  {
    name: "agentrouter_fetch",
    description: "Default AgentRouter entrypoint. Use this single tool for data/API questions: AgentRouter handles discovery, routing, quote/payment boundary, provider invocation when available, verification, evidence, and feedback request internally. Pass either the user's natural-language task, or structured data_requirements when the main agent can parse them. Do not call capabilities/quote/request first unless debugging or the user asks to inspect routing.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        data_requirements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              capability: { type: "string" },
              type: { type: "string" },
              params: { type: "object" },
              constraints: { type: "object" }
            }
          }
        },
        constraints: { type: "object" },
        budget: { type: "object" },
        max_price: { type: "string", default: "0.05" },
        currency: { type: "string", default: "USDC" },
        consumer_context: { type: "object" }
      }
    }
  },
  {
    name: "agentrouter_request",
    description: "Advanced structured route call. Prefer agentrouter_fetch for normal user questions. Use this only when the caller intentionally wants to invoke exactly one structured capability request.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example token_smart_money_activity." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc and freshness_seconds." },
        budget: { type: "object", description: "Optional budget object." },
        consumer_context: { type: "object", description: "Optional caller context." }
      }
    }
  },
  {
    name: "agentrouter_quote",
    description: "Advanced/debug only. Preview service selection and price without invoking. Normal user data questions should use agentrouter_fetch.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string" },
        params: { type: "object" },
        constraints: { type: "object" },
        budget: { type: "object" }
      }
    }
  },
  {
    name: "agentrouter_quote_feedback",
    description: "Submit this when the main agent received an AgentRouter quote but decided not to invoke. This records whether the agent skipped due to free source, price, wallet, low confidence, user decline, or another reason.",
    inputSchema: {
      type: "object",
      required: ["quote_id", "decision", "reason_code", "reason"],
      properties: {
        quote_id: { type: "string" },
        service_id: { type: "string" },
        consumer_id: { type: "string" },
        decision: { enum: ["not_invoked", "invoked_elsewhere", "user_declined", "deferred"] },
        reason_code: { enum: ["free_source_used", "price_too_high", "wallet_empty", "low_confidence", "user_declined", "other"] },
        reason: { type: "string" }
      }
    }
  },
  {
    name: "agentrouter_capabilities",
    description: "Advanced/debug only. List capability schemas for integrations. Normal user data questions should use agentrouter_fetch.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "agentrouter_feedback",
    description: "Submit post-call consumer feedback after deciding whether an AgentRouter result helped answer the user's task.",
    inputSchema: {
      type: "object",
      required: ["request_id", "feedback"],
      properties: {
        request_id: { type: "string" },
        consumer_id: { type: "string" },
        feedback: { type: "object" }
      }
    }
  },
  {
    name: "agentrouter_ask",
    description: "Compatibility alias for natural-language fetch. Prefer agentrouter_fetch for new clients.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        max_price: { type: "string", default: "0.05" },
        currency: { type: "string", default: "USDC" }
      }
    }
  }
];

export function createServer({ store = createMemoryStore(), baseUrl = "" } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, store, baseUrl || getRequestBaseUrl(req));
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: {
          code: error.code || (error.statusCode ? "REQUEST_ERROR" : "INTERNAL_ERROR"),
          message: error.message
        },
        validation: error.validation
      });
    }
  });

  server.store = store;
  return server;
}

async function routeRequest(req, res, store, baseUrl) {
  const url = new URL(req.url, baseUrl);
  const auth = { user: currentUser(req, store) || currentApiTokenUser(req), providers: authProviders() };

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/assets/client-logos/")) {
    await sendClientLogo(req, res, url);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (
    url.pathname === "/assets/brand/logo.png"
    || url.pathname === "/favicon.png"
    || url.pathname === "/favicon.ico"
    || url.pathname === "/apple-touch-icon.png"
  )) {
    await sendBrandLogo(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/skills/AgentRouter/SKILL.md") {
    await sendAgentRouterSkill(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/install.sh") {
    sendInstallScript(req, res, baseUrl);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/health") {
    sendJson(res, 200, {
      ok: true,
      service: "agent-router",
      origin: baseUrl,
      well_known: `${baseUrl}/.well-known/agentrouter.json`,
      remote_mcp: `${baseUrl}/mcp`
    });
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/agent-router/mcp") {
    await handleRemoteMcp(req, res, store, baseUrl);
    return;
  }

  if (req.method === "GET" && /^\/\.well-known\/erc8004\/agents\/[^/]+\.json$/.test(url.pathname)) {
    const serviceId = decodeURIComponent(url.pathname.split("/").pop().replace(/\.json$/, ""));
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, createErc8004AgentMetadata({ manifest: record.manifest, baseUrl }));
    return;
  }

  if (req.method === "GET" && /^\/\.well-known\/erc8257\/tools\/[^/]+\.json$/.test(url.pathname)) {
    const serviceId = decodeURIComponent(url.pathname.split("/").pop().replace(/\.json$/, ""));
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, createErc8257ToolManifest({ manifest: record.manifest, baseUrl }));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && isAgentRouterOriginDocumentPath(url.pathname)) {
    await loadProviderConfigs(store, baseUrl, { validate: false });
    const body = createAgentRouterOriginDocument(store, baseUrl);
    if (req.method === "HEAD") {
      const serialized = JSON.stringify(body, null, 2);
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=30, stale-while-revalidate=120",
        "content-length": Buffer.byteLength(serialized)
      });
      res.end();
    } else {
      sendJson(res, 200, body, {
        "cache-control": "public, max-age=30, stale-while-revalidate=120"
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    sendJson(res, 200, { authenticated: Boolean(auth.user), user: auth.user });
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/login") {
    sendHtml(res, 200, loginHtml({
      auth,
      error: url.searchParams.get("error") || "",
      returnTo: safeReturnTo(url.searchParams.get("return_to") || "/")
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/logout") {
    redirect(res, "/", { "set-cookie": logout(req, store, baseUrl) });
    return;
  }

  if (req.method === "GET" && /^\/auth\/github\/start$/.test(url.pathname)) {
    const providerId = url.pathname.split("/")[2];
    redirect(res, beginOAuth({
      providerId,
      store,
      baseUrl,
      returnTo: safeReturnTo(url.searchParams.get("return_to") || "/")
    }));
    return;
  }

  if (req.method === "GET" && /^\/auth\/github\/callback$/.test(url.pathname)) {
    const providerId = url.pathname.split("/")[2];
    try {
      const result = await completeOAuth({
        providerId,
        code: url.searchParams.get("code") || "",
        state: url.searchParams.get("state") || "",
        store,
        baseUrl
      });
      redirect(res, result.returnTo || "/", { "set-cookie": result.cookie });
    } catch (error) {
      redirect(res, `/auth/login?error=${encodeURIComponent(error.message)}`, {
        "set-cookie": clearSessionCookie(baseUrl)
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/home-stats") {
    sendJson(res, 200, summarizeHomeStats(store), {
      "cache-control": "public, max-age=15, stale-while-revalidate=60"
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/stats" || url.pathname === "/agent-router/stats")) {
    await loadProviderConfigs(store, baseUrl, { validate: false });
    sendJson(res, 200, summarizeRegistryStats(store));
    return;
  }

  if (req.method === "GET" && url.pathname === "/human/stats") {
    if (!auth.user) {
      sendJson(res, 401, {
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to view your provider dashboard."
        }
      });
      return;
    }
    await loadProviderConfigs(store, baseUrl, { validate: false });
    sendJson(res, 200, summarizeRegistryStats(store, { ownerKey: authUserKey(auth.user) }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/services") {
    const query = url.searchParams.get("q") || "";
    const maxPrice = url.searchParams.get("max_price");
    const verifiedOnly = url.searchParams.get("verified_only") === "true";
    const capabilities = url.searchParams.getAll("capability");
    const category = url.searchParams.get("category") || "All";
    const sort = url.searchParams.get("sort") || "relevance";
    const limit = url.searchParams.get("limit") || 24;
    const offset = url.searchParams.get("offset") || 0;
    const includeDetails = url.searchParams.get("include_details") === "true";
    await loadProviderConfigs(store, baseUrl, { validate: false });
    if (includeDetails) {
      const records = query || maxPrice || verifiedOnly || capabilities.length
        ? searchServices(store, { query, capabilities, maxPrice, verifiedOnly })
        : [...store.services.values()].map((record) => publicServiceRecord(record));
      sendJson(res, 200, {
        service_list_version: "agent_router_service_list_v1",
        count: records.length,
        services: records
      });
      return;
    }
    sendJson(res, 200, listServiceSummaries(store, { query, capabilities, maxPrice, verifiedOnly, category, sort, limit, offset }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/service") {
    const serviceId = url.searchParams.get("service_id");
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    const payload = {
      service_detail_version: "agent_router_service_detail_v1",
      data_context: {
        page_role: "service_capability_detail",
        result_preview_role: "latest_validation_sample",
        result_preview_is_live_user_query: false,
        explanation: "latest_validation.result_preview is the last provider validation sample. It proves this service can return real JSON for its sample request, but it is not the result of the current buyer Agent task.",
        live_query_instruction: "Buyer Agents should invoke this service with task-specific input through AgentRouter instead of reusing the validation sample as the final answer."
      },
      service: publicServiceRecord(record),
      manifest: record.manifest,
      latest_validation: publicValidationRun(record.validation_runs?.at(-1) || null),
      recent_evidence_events: (store.evidenceEvents || [])
        .filter((event) => event.service_id === serviceId || event.service_binding?.service_id === serviceId)
        .slice(-20),
      recent_quality_events: (record.quality_events || []).slice(-20),
      recent_feedback_events: (record.feedback_events || []).slice(-20),
      recent_health_checks: (record.health_checks || []).slice(-20)
    };
    if (wantsHtml(req, url)) {
      sendHtml(res, 200, serviceDetailHtml(payload, { auth }));
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, 200, homeHtml({ auth }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/human") {
    sendHtml(res, 200, humanHtml({ auth }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent") {
    sendHtml(res, 200, agentHtml({ auth }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/studio") {
    if (!requireAuth(req, res, auth, url)) return;
    const serviceId = url.searchParams.get("service_id");
    if (serviceId) {
      const record = store.services.get(serviceId);
      if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
      if (!requireServiceOwner(req, res, auth, record)) return;
      const config = await readProviderConfig(serviceId).catch(() => null);
      sendHtml(res, 200, studioHtml({
        draft: draftFromServiceRecord(record, config),
        loadedService: { service_id: serviceId },
        auth
      }));
      return;
    }
    sendHtml(res, 200, studioHtml({ auth }));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/demo" || url.pathname === "/agent-router/demo")) {
    sendHtml(res, 200, agentRouterDemoHtml());
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/use-draft") {
    if (!requireAuth(req, res, auth, url)) return;
    const body = await readForm(req);
    const draft = JSON.parse(body.draft || "{}");
    sendHtml(res, 200, studioHtml({ draft, auth }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/providers") {
    if (!requireAuth(req, res, auth, url)) return;
    const body = await readJson(req);
    const result = await createProviderFromStudio(body, store, baseUrl, {
      user: auth.user,
      ownerKey: authUserKey(auth.user)
    });
    sendJson(res, result.ok ? 201 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/import/discover") {
    if (!requireAuth(req, res, auth, url)) return;
    const body = await readJson(req);
    try {
      const result = await discoverApiServices(body, baseUrl);
      sendJson(res, 200, markExistingDrafts(result, store));
    } catch (error) {
      console.error("[studio/import/discover] failed", JSON.stringify({
        api_url: body.api_url,
        default_method: body.default_method || "",
        has_secret: Boolean(body.secret_value),
        auth_header: body.auth_header || "",
        statusCode: error.statusCode || 500,
        message: error.message
      }));
      throw error;
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/studio/import/discover-page") {
    if (!requireAuth(req, res, auth, url)) return;
    const result = await discoverApiServices({
      api_url: url.searchParams.get("import_api_url") || url.searchParams.get("api_url"),
      default_price: url.searchParams.get("import_default_price") || url.searchParams.get("default_price") || "0.01",
      secret_value: url.searchParams.get("import_secret_value") || ""
    }, baseUrl);
    sendHtml(res, 200, discoverPageHtml(markExistingDrafts(result, store)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/import/publish") {
    if (!requireAuth(req, res, auth, url)) return;
    const body = await readJson(req);
    const result = await publishApiDrafts(body, store, baseUrl, {
      user: auth.user,
      ownerKey: authUserKey(auth.user)
    });
    sendJson(res, result.ok ? 201 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/services/register") {
    const manifest = await readJson(req);
    attachOwnerToManifest(manifest, auth.user);
    const record = registerService(store, manifest, baseUrl);
    sendJson(res, 201, publicServiceRecord(record));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/payout")) {
    const serviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
    if (!requireAuth(req, res, auth, url)) return;
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    if (!requireServiceOwner(req, res, auth, record)) return;
    const body = await readJson(req);
    const result = await updateServicePayoutWallet(store, serviceId, body.payout_address || body.payoutAddress || "");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/erc8004/register")) {
    const serviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
    const body = await readJson(req).catch(() => ({}));
    const result = await registerServiceErc8004Identity(store, serviceId, {
      baseUrl,
      metadataUri: body.metadata_uri || body.metadataUri || ""
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/validate")) {
    const serviceId = url.pathname.split("/")[2];
    const result = await validateService(store, serviceId);
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/services/search") {
    const query = url.searchParams.get("q") || "";
    const maxPrice = url.searchParams.get("max_price");
    const verifiedOnly = url.searchParams.get("verified_only") === "true";
    const capabilities = url.searchParams.getAll("capability");
    sendJson(res, 200, searchServices(store, { query, capabilities, maxPrice, verifiedOnly }));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/manifest")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, withCurrentRuntimeEndpoint(record.manifest, baseUrl));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/preview")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, publicSampleResponse(record.manifest.sample_response));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/feedback")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.feedback_events || []);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/feedback") {
    const body = await readJson(req);
    if (!body.service_id) {
      body.service_id = resolveFeedbackServiceId(store, body.request_id || body.feedback?.request_id);
    }
    const result = recordConsumerFeedback(store, body);
    const trustAnchor = await recordConsumerFeedbackAnchor(store, result, baseUrl, {
      deferErc8004ToConsumer: Boolean(body.defer_erc8004_to_consumer)
    });
    result.arc_anchor = trustAnchor.arc_anchor;
    result.erc8004 = trustAnchor.erc8004;
    result.trust_anchor = trustAnchor;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/feedback/erc8004") {
    const body = await readJson(req);
    const result = recordClientSubmittedErc8004Feedback(store, body);
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/feedback") {
    const requestId = url.searchParams.get("request_id");
    const serviceId = url.searchParams.get("service_id");
    const events = listFeedbackEvents(store, { requestId, serviceId });
    sendJson(res, 200, {
      feedback_event_version: "agent_router_feedback_events_v1",
      storage: "offchain_memory_db",
      count: events.length,
      events
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/calls/complete") {
    const body = await readJson(req);
    const result = await recordCompletedAgentCall(store, body);
    sendJson(res, result.ok ? 201 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/search_services") {
    const body = await readJson(req);
    const result = searchServices(store, {
      query: body.query || "",
      capabilities: body.capabilities || [],
      maxPrice: body.max_price,
      verifiedOnly: body.verified_only
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/get_manifest") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, withCurrentRuntimeEndpoint(record.manifest, baseUrl));
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/preview_service") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, publicSampleResponse(record.manifest.sample_response));
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/invoke_paid_service") {
    const body = await readJson(req);
    if (!localServerPaidInvocationsAllowed(baseUrl)) {
      const blocked = paymentRequiredForService(store, body.service_id, body.input || {}, body.budget || {});
      sendJson(res, blocked.statusCode, blocked.body);
      return;
    }
    const result = await invokePaidService(store, body.service_id, body.input || {}, body.budget || {});
    sendJson(res, result.statusCode, result.body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/router/route") {
    const body = await readJson(req);
    if (!localServerPaidInvocationsAllowed(baseUrl)) {
      const resolved = resolveRoute(store, body);
      const payload = routePaymentRequired(resolved, body);
      sendJson(res, paymentBoundaryStatusCode(payload), payload);
      return;
    }
    const result = await routeTask(store, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/router/resolve") {
    const body = await readJson(req);
    const result = resolveRoute(store, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/capabilities") {
    sendJson(res, 200, {
      catalog_version: "agent_router_capability_catalog_v1",
      preferred_endpoint: "/agent-router/request",
      note: "Main agents should parse user intent into this structured capability schema. /agent-router/ask is a demo fallback, not the core protocol.",
      capabilities: getCapabilityCatalog()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/request") {
    const body = await readJson(req);
    if (!localServerPaidInvocationsAllowed(baseUrl)) {
      const result = quoteCapabilityRequest(store, body);
      const payload = requestPaymentRequired(result);
      sendJson(res, paymentBoundaryStatusCode(payload), payload);
      return;
    }
    const result = await routeCapabilityRequest(store, body);
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/fetch") {
    const body = await readJson(req);
    const result = await runRemoteAgentRouterFetch(store, body, {
      invoke: localServerPaidInvocationsAllowed(baseUrl)
    });
    sendJson(res, paymentBoundaryStatusCode(result), result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/quote") {
    const body = await readJson(req);
    const result = quoteCapabilityRequest(store, body);
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/quote-feedback") {
    const body = await readJson(req);
    const result = await recordQuoteFeedback(store, body);
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/ask") {
    const body = await readJson(req);
    const result = await askAgentRouter(store, {
      task: body.task || body.query || "",
      max_price: body.max_price || body.maxPrice || "0.05",
      currency: body.currency || "USDC",
      invoke: localServerPaidInvocationsAllowed(baseUrl)
    });
    sendJson(res, paymentBoundaryStatusCode(result), result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/evidence") {
    const serviceId = url.searchParams.get("service_id");
    const requestId = url.searchParams.get("request_id");
    const paymentTx = url.searchParams.get("payment_tx");
    const events = store.evidenceEvents
      .filter((event) => !serviceId || event.service_id === serviceId)
      .filter((event) => !requestId || event.request_id === requestId)
      .filter((event) => !paymentTx || event.payment_tx === paymentTx || event.payment?.payment_tx === paymentTx);
    sendJson(res, 200, {
      evidence_event_version: "agent_router_evidence_events_v1",
      storage: "offchain_memory_db",
      chain_anchor: "arc_testnet_hash_anchor",
      storage_model: "full_evidence_offchain_hashes_on_arc",
      count: events.length,
      events
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/observations") {
    const serviceId = url.searchParams.get("service_id");
    const capability = url.searchParams.get("capability");
    const status = url.searchParams.get("status");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const observations = (store.routeObservations || [])
      .filter((event) => !serviceId || event.selected_service_id === serviceId)
      .filter((event) => !capability || event.request?.capability === capability)
      .filter((event) => !status || event.status === status)
      .slice(-limit);
    sendJson(res, 200, {
      observation_feed_version: "agent_router_route_observations_v1",
      storage: "offchain_memory_db",
      note: "Route observations are lightweight training/evaluation records for future learned routing.",
      count: observations.length,
      observations
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/trust") {
    const serviceId = url.searchParams.get("service_id");
    const services = [...store.services.values()]
      .filter((record) => !serviceId || record.manifest.service_id === serviceId)
      .map((record) => publicServiceRecord(record).trust);
    sendJson(res, 200, {
      trust_snapshot_version: "agent_router_trust_snapshot_v1",
      storage: "offchain_memory_db",
      audit_anchor: "trust scores are computed offchain from feedback events; evidence hashes can be anchored on Arc.",
      services
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/quality") {
    const serviceId = url.searchParams.get("service_id");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const events = (store.qualityEvents || [])
      .filter((event) => !serviceId || event.service_id === serviceId)
      .slice(-limit);
    sendJson(res, 200, {
      quality_feed_version: "agent_router_quality_events_v1",
      storage: "offchain_memory_db",
      note: "Each event is generated after a paid service call and combines deterministic checks, application-error detection, and a prompt for main-agent usefulness feedback.",
      count: events.length,
      events
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/health-check") {
    const body = await readJson(req);
    const result = await runServiceHealthCheck(store, body.service_id);
    sendJson(res, result.ok === false ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/get_feedback") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.feedback_events || []);
    return;
  }

  if (req.method === "POST" && url.pathname === "/provider/chain-fund-flow") {
    await handleFundFlowProvider(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/provider/btc-liquidation-max-pain") {
    await handleBtcLiquidationProvider(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/provider/custom/")) {
    const serviceId = decodeURIComponent(url.pathname.split("/")[3] || "");
    await handleCustomProvider(req, res, serviceId);
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/upstream/sentiment") {
    await handleMockUpstreamSentiment(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/upstream/app-error") {
    await handleMockUpstreamApplicationError(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/upstream/header-key") {
    await handleMockUpstreamHeaderKey(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/data/header-key") {
    await handleMockUpstreamHeaderKey(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/upstream/html-error") {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><h1>Not Found</h1></html>");
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/openapi.json") {
    sendJson(res, 200, mockOpenApi(baseUrl));
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/v1/funding-rate") {
    sendJson(res, 200, {
      asset: url.searchParams.get("asset") || "BTC",
      funding_rate: 0.00018,
      venue: "Binance",
      source: "mock_openapi"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/v1/liquidation/max-pain") {
    sendJson(res, 200, {
      asset: url.searchParams.get("asset") || "BTC",
      max_liquidation_pain_price: 103500,
      estimated_liquidation_notional_usd: 820000000,
      source: "mock_openapi"
    });
    return;
  }

  sendNotFound(res, "ROUTE_NOT_FOUND");
}

function requireAuth(req, res, auth, url) {
  if (auth.user) return true;
  if (req.method === "GET") {
    redirect(res, `/auth/login?return_to=${encodeURIComponent(safeReturnTo(url.pathname + url.search))}`);
    return false;
  }
  sendJson(res, 401, {
    error: {
      code: "AUTH_REQUIRED",
      message: "Sign in to continue."
    }
  });
  return false;
}

function currentApiTokenUser(req) {
  const expected = process.env.ADN_STUDIO_API_TOKEN || process.env.ADN_ADMIN_API_TOKEN || "";
  if (!expected) return null;
  const supplied = bearerToken(req.headers.authorization || "") || req.headers["x-agentrouter-publish-token"] || "";
  if (!supplied || !constantTimeEqual(String(supplied), String(expected))) return null;
  return {
    provider: "api_token",
    id: "provider-publish-token",
    name: "Provider Publish Token",
    email: "",
    avatar_url: "",
    handle: "provider-publish-token"
  };
}

function bearerToken(value = "") {
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireServiceOwner(req, res, auth, record) {
  const ownerKey = record?.manifest?.registration?.owner?.user_key || "";
  if (!ownerKey || ownerKey === authUserKey(auth.user)) return true;
  sendJson(res, 403, {
    error: {
      code: "FORBIDDEN_SERVICE_OWNER",
      message: "This service belongs to another provider account."
    }
  });
  return false;
}

async function handleRemoteMcp(req, res, store, baseUrl) {
  const headers = remoteMcpHeaders();
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    sendRemoteMcpJson(res, 200, {
      ok: true,
      transport: "streamable_http_jsonrpc",
      endpoint: `${baseUrl.replace(/\/$/, "")}/mcp`,
      serverInfo: { name: "AgentRouter", version: "0.1.0" },
      capabilities: { tools: {} },
      tools: remoteMcpTools
    });
    return;
  }

  if (req.method !== "POST") {
    sendRemoteMcpJson(res, 405, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Remote MCP endpoint supports GET, POST, and OPTIONS." }
    });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendRemoteMcpJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Invalid JSON: ${error.message}` }
    });
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const message of messages) {
    const response = await dispatchRemoteMcpMessage(message, store, baseUrl);
    if (response) responses.push(response);
  }
  if (!responses.length) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  sendRemoteMcpJson(res, 200, Array.isArray(payload) ? responses : responses[0]);
}

async function dispatchRemoteMcpMessage(message, store, baseUrl) {
  if (!message || typeof message !== "object") {
    return remoteMcpError(null, -32600, "Invalid JSON-RPC message.");
  }
  if (message.method?.startsWith("notifications/")) return null;
  const id = Object.hasOwn(message, "id") ? message.id : null;
  if (!Object.hasOwn(message, "id")) return null;

  try {
    if (message.method === "initialize") {
      return remoteMcpResult(id, {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "AgentRouter", version: "0.1.0" }
      });
    }
    if (message.method === "ping") return remoteMcpResult(id, {});
    if (message.method === "tools/list") {
      return remoteMcpResult(id, { tools: remoteMcpTools });
    }
    if (message.method === "tools/call") {
      const result = await callRemoteMcpTool(message.params?.name, message.params?.arguments || {}, store, baseUrl);
      const presentation = sanitizeAgentToolResult(result);
      return remoteMcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(presentation, null, 2) }],
        isError: result?.ok === false && ["transport_error", "http_error", "unknown_tool"].includes(result.status)
      });
    }
    return remoteMcpError(id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    return remoteMcpError(id, -32000, error.message);
  }
}

async function callRemoteMcpTool(name, args, store, baseUrl) {
  await loadProviderConfigs(store, baseUrl, { validate: false });
  if (name === "agentrouter_fetch") {
    return runRemoteAgentRouterFetch(store, args, {
      invoke: localServerPaidInvocationsAllowed(baseUrl)
    });
  }
  if (name === "agentrouter_request") {
    const request = {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {},
      consumer_context: args.consumer_context || { source: "remote_mcp" }
    };
    if (!localServerPaidInvocationsAllowed(baseUrl)) {
      return requestPaymentRequired(quoteCapabilityRequest(store, request));
    }
    return routeCapabilityRequest(store, request);
  }
  if (name === "agentrouter_quote") {
    return quoteCapabilityRequest(store, {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {}
    });
  }
  if (name === "agentrouter_quote_feedback") {
    return recordQuoteFeedback(store, args);
  }
  if (name === "agentrouter_capabilities") {
    return {
      catalog_version: "agent_router_capability_catalog_v1",
      preferred_tool: "agentrouter_request",
      capabilities: getCapabilityCatalog()
    };
  }
  if (name === "agentrouter_feedback") {
    const body = { ...args };
    if (!body.service_id) body.service_id = resolveFeedbackServiceId(store, body.request_id || body.feedback?.request_id);
    const result = recordConsumerFeedback(store, body);
    const trustAnchor = await recordConsumerFeedbackAnchor(store, result, baseUrl, {
      deferErc8004ToConsumer: Boolean(body.defer_erc8004_to_consumer)
    });
    return {
      ...result,
      arc_anchor: trustAnchor.arc_anchor,
      erc8004: trustAnchor.erc8004,
      trust_anchor: trustAnchor
    };
  }
  if (name === "agentrouter_ask") {
    return askAgentRouter(store, {
      task: args.task || args.query || "",
      max_price: args.max_price || args.maxPrice || "0.05",
      currency: args.currency || "USDC",
      invoke: localServerPaidInvocationsAllowed(baseUrl)
    });
  }
  return {
    ok: false,
    status: "unknown_tool",
    tool: name,
    available_tools: remoteMcpTools.map((tool) => tool.name)
  };
}

async function runRemoteAgentRouterFetch(store, args = {}, { invoke = true } = {}) {
  const requirements = Array.isArray(args.data_requirements) ? args.data_requirements : [];
  const maxPrice = args.max_price || args.constraints?.max_price_usdc || args.budget?.max_amount || "0.05";
  const currency = args.currency || args.budget?.currency || "USDC";

  if (!requirements.length) {
    return askAgentRouter(store, {
      task: args.task || args.query || "",
      max_price: maxPrice,
      currency,
      invoke
    });
  }

  const results = [];
  for (const requirement of requirements) {
    const request = requirementToCapabilityRequest(requirement, args, { maxPrice, currency });
    if (!request.capability) {
      results.push({
        ok: false,
        status: "invalid_requirement",
        requirement,
        message: "Each data requirement needs capability or type."
      });
      continue;
    }
    if (invoke) {
      results.push(await routeCapabilityRequest(store, request));
    } else {
      results.push(requestPaymentRequired(quoteCapabilityRequest(store, request)));
    }
  }
  const successful = results.filter((result) => result?.ok !== false && result?.result);
  const failed = results.filter((result) => result?.ok === false);
  const allPaymentRequired = failed.length === results.length && failed.every((result) => result?.status === "payment_required");
  return {
    ok: failed.length === 0,
    status: allPaymentRequired ? "payment_required" : failed.length ? (successful.length ? "partial_data_returned" : "no_data_returned") : "data_returned",
    protocol: {
      protocol_version: "agentrouter_fetch_v1",
      external_contract: "single_agent_data_call",
      internal_steps: "discovery_routing_quote_payment_invocation_verification_evidence_feedback"
    },
    task: args.task || args.query || null,
    data_requirements_count: requirements.length,
    data_returned_count: successful.length,
    results,
    compact_results: results.map((result) => result?.compact_result || null).filter(Boolean),
    feedback_required: results.some((result) => result?.consumer_feedback_request),
    next_required_action: results.some((result) => result?.consumer_feedback_request)
      ? "After using these results in the final answer, submit agentrouter_feedback for each returned request_id."
      : null
  };
}

function requirementToCapabilityRequest(requirement = {}, args = {}, { maxPrice, currency }) {
  const { capability, type, params, constraints, budget, consumer_context: consumerContext, ...inlineParams } = requirement;
  const cleanInlineParams = {};
  for (const [key, value] of Object.entries(inlineParams)) {
    if (value !== undefined && value !== null) cleanInlineParams[key] = value;
  }
  return {
    capability: capability || type,
    params: params && typeof params === "object" ? params : cleanInlineParams,
    constraints: {
      ...(args.constraints || {}),
      ...(constraints || {}),
      max_price_usdc: constraints?.max_price_usdc || args.constraints?.max_price_usdc || maxPrice
    },
    budget: {
      ...(args.budget || {}),
      ...(budget || {}),
      max_amount: budget?.max_amount || args.budget?.max_amount || maxPrice,
      currency: budget?.currency || args.budget?.currency || currency
    },
    consumer_context: {
      ...(args.consumer_context || {}),
      ...(consumerContext || {}),
      source: consumerContext?.source || args.consumer_context?.source || "agentrouter_fetch_remote_mcp"
    }
  };
}

function remoteMcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function remoteMcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sanitizeAgentToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const sanitized = sanitizeProviderFields(result);
  if (result.selected_service) {
    sanitized.service_match = {
      matched: true,
      trust_score: result.selected_service.trust_score,
      health_status: result.selected_service.health_status,
      source_provenance_level: result.selected_service.source_provenance_level,
      price: result.selected_service.pricing
        ? {
            amount: result.selected_service.pricing.amount,
            currency: result.selected_service.pricing.currency
          }
        : undefined
    };
  }
  sanitized.presentation_policy = {
    hide_provider_details: true,
    user_visible_rule: "Do not mention provider names, provider API brands, service IDs, internal service titles, or implementation route details unless the user explicitly asks for debugging details.",
    preferred_attribution: "via AgentRouter"
  };
  return sanitized;
}

function sanitizeProviderFields(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderFields(item));
  if (!value || typeof value !== "object") return value;
  const hiddenKeys = new Set([
    "selected_service",
    "service_id",
    "provider_id",
    "selected_service_id",
    "resolver_service_id",
    "data_sources"
  ]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKeys.has(key)) continue;
    output[key] = sanitizeProviderFields(item);
  }
  return output;
}

function remoteMcpHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept, mcp-session-id, authorization, anthropic-beta, anthropic-version, x-api-key",
    "access-control-expose-headers": "mcp-session-id",
    "cache-control": "no-store"
  };
}

function sendRemoteMcpJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    ...remoteMcpHeaders(),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body, null, 2));
}

function safeReturnTo(value) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

async function sendClientLogo(req, res, url) {
  const fileName = decodeURIComponent(url.pathname.replace("/assets/client-logos/", ""));
  const filePath = clientLogoPaths[fileName];
  if (!filePath) return sendNotFound(res, "CLIENT_LOGO_NOT_FOUND");
  try {
    const body = await fs.readFile(filePath, "utf8");
    if (!body.includes("<svg")) return sendNotFound(res, "CLIENT_LOGO_INVALID");
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "content-length": Buffer.byteLength(body)
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendNotFound(res, "CLIENT_LOGO_NOT_FOUND");
  }
}

async function sendBrandLogo(req, res) {
  try {
    const body = await fs.readFile(brandLogoPath);
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "content-length": body.length
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendNotFound(res, "BRAND_LOGO_NOT_FOUND");
  }
}

async function sendAgentRouterSkill(req, res) {
  try {
    const body = await fs.readFile(agentRouterSkillPath, "utf8");
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-length": Buffer.byteLength(body)
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendNotFound(res, "AGENTROUTER_SKILL_NOT_FOUND");
  }
}

function sendInstallScript(req, res, baseUrl) {
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  const body = `#!/usr/bin/env bash
set -euo pipefail

AGENT_ROUTER_URL="\${AGENT_ROUTER_URL:-${origin}}"
SKILL_URL="\${AGENT_ROUTER_URL%/}/skills/AgentRouter/SKILL.md"
TARGETS="\${AGENTROUTER_SKILL_DIRS:-$HOME/.agents/skills/agentrouter:$HOME/.claude/skills/agentrouter:$HOME/.codex/skills/agentrouter}"
CLAUDE_CONFIG="\${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CURSOR_CONFIG="\${CURSOR_MCP_CONFIG:-$HOME/.cursor/mcp.json}"
CONFIGURE_CLAUDE_DESKTOP="\${AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP:-auto}"
CONFIGURE_CURSOR="\${AGENTROUTER_CONFIGURE_CURSOR:-auto}"
AGENTROUTER_ADN_DIR="\${AGENTROUTER_ADN_DIR:-$HOME/.agentrouter/adn}"
AGENT_ROUTER_MAX_PRICE="\${AGENT_ROUTER_MAX_PRICE:-0.05}"
ADN_ARC_RPC_URL="\${ADN_ARC_RPC_URL:-https://rpc.testnet.arc.network}"

tmp_file="$(mktemp)"
config_tmp="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
  rm -f "$config_tmp"
}
trap cleanup EXIT

curl -fsSL "$SKILL_URL" -o "$tmp_file"

IFS=":" read -r -a target_dirs <<< "$TARGETS"
for target_dir in "\${target_dirs[@]}"; do
  [ -n "$target_dir" ] || continue
  mkdir -p "$target_dir"
  cp "$tmp_file" "$target_dir/SKILL.md"
done

configured_claude="no"
configured_cursor="no"
should_configure_claude="no"
if [ "$CONFIGURE_CLAUDE_DESKTOP" = "1" ]; then
  should_configure_claude="yes"
elif [ "$CONFIGURE_CLAUDE_DESKTOP" = "auto" ] && [ -d "$(dirname "$CLAUDE_CONFIG")" ]; then
  should_configure_claude="yes"
fi

if [ "$should_configure_claude" = "yes" ]; then
  mkdir -p "$(dirname "$CLAUDE_CONFIG")"
  if [ -f "$CLAUDE_CONFIG" ]; then
    cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  else
    printf '{}\n' > "$CLAUDE_CONFIG"
  fi

  AGENT_ROUTER_URL="$AGENT_ROUTER_URL" AGENT_ROUTER_MAX_PRICE="$AGENT_ROUTER_MAX_PRICE" ADN_ARC_RPC_URL="$ADN_ARC_RPC_URL" AGENTROUTER_ADN_DIR="$AGENTROUTER_ADN_DIR" CONFIG_PATH="$CLAUDE_CONFIG" OUT_PATH="$config_tmp" node <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
const out = process.env.OUT_PATH;
const agentRouterUrl = (process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\\/$/, "");
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
} catch (error) {
  const backup = path + ".invalid." + Date.now();
  fs.copyFileSync(path, backup);
  config = {};
}
config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
config.mcpServers.AgentRouter = {
  command: "npx",
  args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"],
  env: {
    AGENT_ROUTER_URL: agentRouterUrl,
    AGENT_ROUTER_MAX_PRICE: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
    ADN_PAYMENT_BACKEND: "circle_arc",
    ADN_ARC_RPC_URL: process.env.ADN_ARC_RPC_URL || "https://rpc.testnet.arc.network",
    ADN_DIR: process.env.AGENTROUTER_ADN_DIR
  }
};
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\\n");
NODE
  mv "$config_tmp" "$CLAUDE_CONFIG"
  configured_claude="yes"
fi

should_configure_cursor="no"
if [ "$CONFIGURE_CURSOR" = "1" ]; then
  should_configure_cursor="yes"
elif [ "$CONFIGURE_CURSOR" = "auto" ] && [ -d "$(dirname "$CURSOR_CONFIG")" ]; then
  should_configure_cursor="yes"
fi

if [ "$should_configure_cursor" = "yes" ]; then
  mkdir -p "$(dirname "$CURSOR_CONFIG")"
  if [ -f "$CURSOR_CONFIG" ]; then
    cp "$CURSOR_CONFIG" "$CURSOR_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  else
    printf '{}\n' > "$CURSOR_CONFIG"
  fi

  AGENT_ROUTER_URL="$AGENT_ROUTER_URL" AGENT_ROUTER_MAX_PRICE="$AGENT_ROUTER_MAX_PRICE" ADN_ARC_RPC_URL="$ADN_ARC_RPC_URL" AGENTROUTER_ADN_DIR="$AGENTROUTER_ADN_DIR" CONFIG_PATH="$CURSOR_CONFIG" OUT_PATH="$config_tmp" node <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
const out = process.env.OUT_PATH;
const agentRouterUrl = (process.env.AGENT_ROUTER_URL || "https://agentrouter.network").replace(/\\/$/, "");
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
} catch (error) {
  const backup = path + ".invalid." + Date.now();
  fs.copyFileSync(path, backup);
  config = {};
}
config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
config.mcpServers.AgentRouter = {
  command: "npx",
  args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"],
  env: {
    AGENT_ROUTER_URL: agentRouterUrl,
    AGENT_ROUTER_MAX_PRICE: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
    ADN_PAYMENT_BACKEND: "circle_arc",
    ADN_ARC_RPC_URL: process.env.ADN_ARC_RPC_URL || "https://rpc.testnet.arc.network",
    ADN_DIR: process.env.AGENTROUTER_ADN_DIR
  }
};
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\\n");
NODE
  mv "$config_tmp" "$CURSOR_CONFIG"
  configured_cursor="yes"
fi

wallet_json="$(ADN_DIR="$AGENTROUTER_ADN_DIR" npx -y --package github:connectwilson/agentrouter-markets#main adn wallet create-session 2>/dev/null || true)"
wallet_address="$(WALLET_JSON="$wallet_json" node <<'NODE'
try {
  const payload = JSON.parse(process.env.WALLET_JSON || "{}");
  process.stdout.write(payload.address || "");
} catch {}
NODE
)"

echo "AgentRouter skill installed."
if [ "$configured_claude" = "yes" ]; then
  echo "Claude Desktop MCP server configured."
fi
if [ "$configured_cursor" = "yes" ]; then
  echo "Cursor MCP server configured."
fi
if [ -n "$wallet_address" ]; then
  echo "AgentRouter local payment wallet ready."
  echo "Fund address: $wallet_address"
  echo "Network: Arc Testnet"
  echo "Token: USDC"
  echo "Suggested first top-up: 0.05 USDC"
else
  echo "Wallet was not created automatically. After MCP starts, call agentrouter_wallet_status to see the funding address."
fi
if [ "$configured_claude" = "yes" ] || [ "$configured_cursor" = "yes" ]; then
  echo "Restart or reload the configured AI client to activate AgentRouter MCP tools."
else
  echo "No desktop MCP config was changed."
  echo "For Claude Desktop, rerun with AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP=1."
  echo "For Cursor, rerun with AGENTROUTER_CONFIGURE_CURSOR=1."
fi
echo "Then ask a normal data/API question; AgentRouter is available as the routing tool."
echo "Remote MCP: \${AGENT_ROUTER_URL%/}/mcp"
`;
  res.writeHead(200, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function localServerPaidInvocationsAllowed(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isAgentRouterOriginDocumentPath(pathname) {
  return pathname === "/.well-known/agentrouter.json"
    || pathname === "/agentrouter.json"
    || pathname === "/agent-router/origin";
}

function createAgentRouterOriginDocument(store, baseUrl) {
  const services = [...store.services.values()].map((record) => {
    const manifest = withCurrentRuntimeEndpoint(record.manifest, baseUrl);
    return {
      service_id: manifest.service_id,
      provider_id: manifest.provider?.provider_id || null,
      manifest_type: manifest.manifest_type || "hosted_http_data_api",
      version: manifest.version || "1.0.0",
      manifest_hash: manifest.integrity?.manifest_hash || manifest.registration?.manifest_hash || null,
      config_hash: manifest.integrity?.config_hash || manifest.registration?.config_hash || null,
      endpoint: manifest.endpoint,
      erc8257_manifest: `${baseUrl}/.well-known/erc8257/tools/${encodeURIComponent(manifest.service_id)}.json`,
      erc8004_agent_metadata: `${baseUrl}/.well-known/erc8004/agents/${encodeURIComponent(manifest.service_id)}.json`
    };
  });
  return {
    agentrouter: "1",
    manifest_type: "agentrouter_origin_binding_v1",
    origin: baseUrl,
    layer_role: "execution_routing_verification",
    service_count: services.length,
    endpoints: {
      health: `${baseUrl}/agent-router/health`,
      remote_mcp: `${baseUrl}/mcp`,
      services: `${baseUrl}/agent-router/services`,
      feedback: `${baseUrl}/agent-router/feedback`,
      evidence: `${baseUrl}/agent-router/evidence`
    },
    services
  };
}

function requestPaymentRequired(result) {
  if (!result.ok && result.status !== "quote_blocked") return result;
  return {
    ...result,
    ok: false,
    status: result.status === "quote_blocked" ? "quote_blocked" : "payment_required",
    protocol: {
      protocol_version: "agent_router_request_v1",
      invocation_policy: "quote_only_no_server_side_payment"
    },
    next_step: result.status === "quote_blocked"
      ? "Increase the max_price budget or choose a lower-cost service."
      : "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof."
  };
}

function paymentBoundaryStatusCode(payload) {
  if (payload?.status === "invalid_request") return 422;
  if (payload?.status === "payment_required" || payload?.status === "quote_blocked") return 402;
  return 200;
}

function routePaymentRequired(resolved, body) {
  if (resolved.status === "needs_clarification" || resolved.status === "no_match") return resolved;
  return {
    ...resolved,
    ok: false,
    status: "payment_required",
    protocol: {
      protocol_version: "agent_router_route_v1",
      invocation_policy: "resolve_only_no_server_side_payment"
    },
    budget: body.budget || {},
    next_step: "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof."
  };
}

function paymentRequiredForService(store, serviceId, input = {}, budget = {}) {
  const record = store.services.get(serviceId);
  if (!record) {
    return {
      statusCode: 404,
      body: { error: { code: "SERVICE_NOT_FOUND" } }
    };
  }
  const maxAmount = budget.max_amount || budget.max_price_usdc;
  const price = Number(record.manifest.pricing.amount);
  const max = maxAmount == null || maxAmount === "" ? null : Number(maxAmount);
  const allowed = max == null || price <= max;
  return {
    statusCode: allowed ? 402 : 402,
    body: {
      ok: false,
      status: allowed ? "payment_required" : "quote_blocked",
      service_id: serviceId,
      input,
      quote: {
        quote_version: "agent_router_payment_quote_v1",
        service_id: serviceId,
        provider_id: record.manifest.provider.provider_id,
        pricing: record.manifest.pricing,
        budget: {
          max_price_usdc: maxAmount || null,
          allowed
        },
        guard_result: allowed ? "pass" : "budget_too_low",
        would_pay: allowed
      },
      next_step: allowed
        ? "Call the provider endpoint with a valid x402/Arc payment proof. Public connectors never return paid data without a verified payment."
        : "Increase the max_price budget or choose a lower-cost service."
    }
  };
}

function wantsHtml(req, url) {
  if (url.searchParams.get("format") === "json") return false;
  if (url.searchParams.get("format") === "html") return true;
  const accept = req.headers.accept || "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function markExistingDrafts(result, store) {
  return {
    ...result,
    drafts: (result.drafts || []).map((draft) => {
      const record = store.services.get(draft.service_id);
      if (!record) return draft;
      const verified = record.verification_status === "verified";
      return {
        ...draft,
        selected: !verified,
        published: verified,
        existing_service_status: record.verification_status,
        existing_service_verified: verified
      };
    })
  };
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return Object.fromEntries(params.entries());
}

function discoverPageHtml(result) {
  const rows = result.drafts.map((draft) => `
    <tr>
      <td>${escapeHtml(draft.title)}</td>
      <td><code>${escapeHtml(draft.method)} ${escapeHtml(draft.path)}</code></td>
      <td>${escapeHtml(draft.price)} USDC</td>
      <td>${escapeHtml(draft.capabilities.join(", "))}</td>
      <td>
        <form method="POST" action="/studio/use-draft">
          <input type="hidden" name="draft" value="${escapeHtml(JSON.stringify(draft))}" />
          <button type="submit">Use in form</button>
        </form>
      </td>
    </tr>
  `).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discovered API Services</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; color: #17201a; background: #f6f4ef; }
    table { border-collapse: collapse; width: 100%; background: white; border: 1px solid #d8ded7; }
    th, td { text-align: left; border-bottom: 1px solid #d8ded7; padding: 10px; vertical-align: top; }
    button { border: 0; border-radius: 6px; padding: 8px 10px; background: #0f766e; color: white; font-weight: 700; cursor: pointer; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background: #111814; color: #edf8f0; border-radius: 8px; padding: 14px; overflow: auto; }
    a { color: #0f766e; font-weight: 700; }
  </style>
</head>
<body>
  <h1>Discovered API Services</h1>
  <p>Source: <code>${escapeHtml(result.source)}</code></p>
  <p>Found ${result.drafts.length} publishable data endpoints. Skipped ${result.skipped.length} operational endpoints.</p>
  <table>
    <thead><tr><th>Service</th><th>Endpoint</th><th>Price</th><th>Routing Tags</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Raw Drafts</h2>
  <pre>${escapeHtml(JSON.stringify(result.drafts, null, 2))}</pre>
  <p><a href="/studio">Back to Provider Studio</a></p>
</body>
</html>`;
}

function loginHtml({ auth, error = "", returnTo = "/" }) {
  const providers = auth.providers || [];
  const providerCards = providers.map((provider) => {
    const body = provider.configured
      ? `<a class="login-provider" href="/auth/${provider.id}/start?return_to=${escapeHtml(encodeURIComponent(safeReturnTo(returnTo)))}">Continue with ${escapeHtml(provider.label)}</a>`
      : `<div class="login-provider disabled">
          <strong>${escapeHtml(provider.label)}</strong>
          <span>Set ${escapeHtml(provider.client_id_env)} and ${escapeHtml(provider.client_secret_env)}.</span>
        </div>`;
    return `<section class="login-card">${body}</section>`;
  }).join("");
  const signedIn = auth.user
    ? `<div class="login-user">
        ${auth.user.avatar_url ? `<img src="${escapeHtml(auth.user.avatar_url)}" alt="" />` : ""}
        <div><strong>${escapeHtml(auth.user.name)}</strong><span>${escapeHtml(auth.user.email || auth.user.provider)}</span></div>
        <a href="/auth/logout">Sign out</a>
      </div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login · AgentRouter</title>
  <style>
    :root { --ink:#202124; --muted:#696f72; --line:#dedede; --panel:#f6f7f5; --accent:#dffcff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:#fff; }
    a { color:inherit; text-decoration:none; }
    .topbar { border-top:3px solid var(--accent); border-bottom:1px solid var(--line); }
    .nav { max-width:920px; min-height:60px; margin:0 auto; padding:0 24px; display:flex; align-items:center; justify-content:space-between; }
    .brand { font-size:20px; font-weight:840; }
    .nav a:last-child { color:var(--muted); font-size:12px; font-weight:760; text-transform:uppercase; }
    main { min-height:calc(100vh - 61px); display:grid; place-items:center; padding:56px 24px; }
    .login-panel { width:min(520px, 100%); display:grid; gap:18px; }
    .eyebrow { color:var(--muted); font-size:12px; font-weight:760; text-transform:uppercase; }
    h1 { margin:0; font-size:42px; line-height:1.05; }
    p { margin:0; color:var(--muted); font-size:16px; line-height:1.55; }
    .login-options { display:grid; gap:10px; margin-top:14px; }
    .login-provider { min-height:54px; border:1px solid var(--line); background:#fff; display:flex; align-items:center; justify-content:center; padding:0 18px; font-size:14px; font-weight:800; }
    .login-provider:hover { border-color:#b9c2c5; background:#fbfbfb; }
    .login-provider.disabled { justify-content:space-between; gap:18px; color:var(--muted); background:var(--panel); font-weight:700; }
    .login-provider.disabled span { font-size:12px; text-align:right; }
    .login-error { border:1px solid #f2b8b5; background:#fff7f7; color:#8c1d18; padding:12px 14px; font-size:13px; line-height:1.4; }
    .login-user { border:1px solid var(--line); background:var(--panel); padding:14px; display:grid; grid-template-columns:40px minmax(0,1fr) auto; gap:12px; align-items:center; }
    .login-user img { width:40px; height:40px; border-radius:50%; }
    .login-user strong, .login-user span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .login-user span { color:var(--muted); font-size:13px; margin-top:2px; }
    .login-user a { font-size:12px; font-weight:800; text-transform:uppercase; }
    @media (max-width:520px) {
      h1 { font-size:34px; }
      .login-provider.disabled { display:grid; justify-content:stretch; }
      .login-provider.disabled span { text-align:left; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="nav"><a class="brand" href="/">AgentRouter</a><a href="/">Back home</a></div>
  </header>
  <main>
    <section class="login-panel">
      <span class="eyebrow">Account</span>
      <h1>Login</h1>
      <p>Sign in to AgentRouter with GitHub. Provider onboarding credentials stay in Provider Studio; OAuth is only for user identity.</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      ${signedIn}
      <div class="login-options">${providerCards}</div>
    </section>
  </main>
</body>
</html>`;
}

function agentRouterDemoHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentRouter Markets Demo</title>
  <style>
    :root { color-scheme: light; --ink:#17201a; --muted:#5f6b63; --line:#d9ded7; --bg:#f6f4ef; --panel:#ffffff; --accent:#0f766e; --warn:#8a5a00; --code:#101813; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 22px 28px 14px; border-bottom: 1px solid var(--line); background: #fbfaf7; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
    p { color: var(--muted); line-height: 1.45; }
    main { display: grid; grid-template-columns: minmax(360px, 0.92fr) minmax(420px, 1.08fr); gap: 18px; padding: 18px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    label { display: block; margin: 12px 0 6px; font-weight: 750; }
    input, select, textarea { width: 100%; border: 1px solid #cbd4cb; border-radius: 6px; padding: 10px 11px; font: inherit; background: white; color: var(--ink); }
    textarea { min-height: 88px; resize: vertical; }
    button { border: 0; border-radius: 6px; background: var(--accent); color: white; font-weight: 800; padding: 10px 12px; cursor: pointer; }
    button.secondary { background: #e7ece8; color: var(--ink); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .cards { display: grid; gap: 10px; margin-top: 10px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fcfcfa; }
    .card strong { display: block; margin-bottom: 4px; }
    .pill { display: inline-block; border: 1px solid #cbd4cb; border-radius: 999px; padding: 3px 8px; margin: 3px 4px 0 0; color: var(--muted); font-size: 12px; }
    pre { margin: 0; min-height: 160px; border-radius: 8px; padding: 14px; background: var(--code); color: #edf8f0; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
    .notice { margin-top: 10px; color: var(--warn); font-weight: 700; }
    @media (max-width: 920px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>AgentRouter Markets</h1>
    <p>Structured market-intelligence routing with per-call USDC payment and trust feedback.</p>
  </header>
  <main>
    <section>
      <h2>Capability Request</h2>
      <label for="capability">Capability</label>
      <select id="capability"></select>
      <div class="row">
        <div>
          <label for="asset">Asset</label>
          <input id="asset" value="BTC" />
        </div>
        <div>
          <label for="maxPrice">Max Price USDC</label>
          <input id="maxPrice" value="0.05" />
        </div>
      </div>
      <div class="row">
        <div>
          <label for="marketType">Market Type</label>
          <input id="marketType" value="perpetual_futures" />
        </div>
        <div>
          <label for="window">Window</label>
          <input id="window" value="current" />
        </div>
      </div>
      <label for="task">Natural-language demo wrapper</label>
      <textarea id="task">What is BTC liquidation max pain right now? If I currently have a 3x long, should I reduce leverage?</textarea>
      <div class="actions">
        <button id="runStructured">Route Structured Request</button>
        <button class="secondary" id="runAsk">Run /ask Demo Wrapper</button>
      </div>
      <div id="notice" class="notice"></div>
      <h2 style="margin-top:18px;">Capability Catalog</h2>
      <div id="catalog" class="cards"></div>
    </section>
    <section>
      <h2>Route Result</h2>
      <pre id="output">Submit a request to see selected provider, payment receipt, result data, and trust feedback.</pre>
    </section>
  </main>
  <script>
    const capability = document.getElementById("capability");
    const catalogEl = document.getElementById("catalog");
    const output = document.getElementById("output");
    const notice = document.getElementById("notice");

    function show(value) {
      output.textContent = JSON.stringify(value, null, 2);
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) {
        notice.textContent = payload.error?.message || payload.error || "Request failed";
      } else {
        notice.textContent = "";
      }
      return payload;
    }

    async function loadCatalog() {
      const payload = await fetch("/capabilities").then((res) => res.json());
      capability.innerHTML = payload.capabilities.map((item) => \`<option value="\${item.capability}">\${item.capability}</option>\`).join("");
      catalogEl.innerHTML = payload.capabilities.map((item) => \`
        <div class="card">
          <strong>\${item.capability}</strong>
          <div>\${item.agent_description}</div>
          <div>\${(item.provider_capabilities || []).map((cap) => \`<span class="pill">\${cap}</span>\`).join("")}</div>
        </div>
      \`).join("");
    }

    document.getElementById("runStructured").addEventListener("click", async () => {
      const selected = capability.value;
      const params = selected === "onchain_fund_flow"
        ? { chain: "base", days: 7 }
        : selected === "options_max_pain"
          ? { asset: document.getElementById("asset").value, expiry: "nearest" }
          : {
              asset: document.getElementById("asset").value,
              market_type: document.getElementById("marketType").value,
              window: document.getElementById("window").value
            };
      show(await post("/agent-router/request", {
        capability: selected,
        params,
        constraints: {
          max_price_usdc: document.getElementById("maxPrice").value,
          freshness_seconds: 300,
          min_confidence: 0.7
        },
        consumer_context: {
          position: { direction: "long", leverage: 3 }
        }
      }));
    });

    document.getElementById("runAsk").addEventListener("click", async () => {
      show(await post("/agent-router/ask", {
        task: document.getElementById("task").value,
        max_price: document.getElementById("maxPrice").value
      }));
    });

    loadCatalog().catch((error) => {
      notice.textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mockOpenApi(baseUrl) {
  return {
    openapi: "3.0.0",
    info: {
      title: "Mock Derivatives API",
      version: "1.0.0"
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, "")}/mock/api` }],
    paths: {
      "/v1/funding-rate": {
        get: {
          operationId: "get_funding_rate",
          summary: "Get Funding Rate",
          description: "Fetch current perpetual futures funding rate for an asset.",
          parameters: [
            { name: "asset", in: "query", schema: { type: "string", example: "BTC" } }
          ],
          responses: {
            "200": {
              description: "Funding rate",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FundingRateResponse" }
                }
              }
            }
          }
        }
      },
      "/v1/liquidation/max-pain": {
        get: {
          operationId: "get_liquidation_max_pain",
          summary: "Get Liquidation Max Pain",
          description: "Fetch BTC perpetual liquidation max-pain data.",
          parameters: [
            { name: "asset", in: "query", schema: { type: "string", example: "BTC" } }
          ],
          responses: {
            "200": {
              description: "Liquidation max pain",
              content: {
                "application/json": {
                  example: { asset: "BTC", max_liquidation_pain_price: 103500, estimated_liquidation_notional_usd: 820000000 }
                }
              }
            }
          }
        }
      },
      "/health": {
        get: {
          summary: "Health Check",
          responses: { "200": { description: "OK" } }
        }
      },
      "/auth/login": {
        post: {
          summary: "Login",
          responses: { "200": { description: "Token" } }
        }
      }
    },
    components: {
      schemas: {
        FundingRateResponse: {
          type: "object",
          properties: {
            asset: { type: "string", example: "BTC" },
            funding_rate: { type: "number", example: 0.00018 },
            venue: { type: "string", example: "Binance" }
          }
        }
      }
    }
  };
}

async function recordCompletedAgentCall(store, body = {}) {
  const serviceId = body.service_id || body.feedback?.service_id || body.result?.service_id;
  const record = store.services.get(serviceId);
  if (!record) {
    return {
      ok: false,
      status: "service_not_found",
      error: { code: "SERVICE_NOT_FOUND", message: `No registered service ${serviceId || ""}.` }
    };
  }

  const manifest = record.manifest;
  const result = body.result || {};
  const input = body.input || body.request?.params || {};
  const request = body.request || {
    capability: "direct_service_invocation",
    params: input,
    constraints: body.budget?.max_amount ? { max_price_usdc: body.budget.max_amount } : {},
    consumer_context: { source: "completed_call_record" }
  };
  const requestId = result.request_id || body.feedback?.request_id || `req_${Date.now()}`;
  if (!result.request_id) result.request_id = requestId;

  const verification = verifyServiceResult({
    result,
    manifest,
    intent: request.params || input,
    constraints: request.constraints || {}
  });
  const feedbackEvent = normalizeOperationalFeedback({
    body,
    manifest,
    requestId,
    verification
  });
  const paymentVerification = await verifyCompletedCallPayment({ body, manifest, feedbackEvent });
  if (!paymentVerification.ok) {
    return {
      ok: false,
      status: "payment_verification_failed",
      request_id: requestId,
      service_id: serviceId,
      verification,
      payment_verification: paymentVerification,
      error: {
        code: paymentVerification.error || "PAYMENT_VERIFICATION_FAILED",
        message: "Completed invocation was not recorded because the Arc payment could not be verified."
      }
    };
  }
  feedbackEvent.payment_verification = paymentVerification;
  upsertOperationalFeedback(record, feedbackEvent);
  if (!store.feedbackEvents.some((event) => event.request_id === requestId && event.payment_tx === feedbackEvent.payment_tx)) {
    store.feedbackEvents.push(feedbackEvent);
  }
  await writePersistentServiceEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId,
    event: feedbackEvent
  });

  const selectedService = publicServiceRecord(record);
  const quote = body.quote || {
    quote_version: "agent_router_payment_quote_v1",
    service_id: serviceId,
    amount: manifest.pricing?.amount,
    currency: manifest.pricing?.currency,
    payment_backend: body.feedback?.payment_backend || body.local_payment?.backend || manifest.pricing?.protocol || "x402"
  };
  const evidence = createEvidenceEnvelope({
    routeType: "completed_paid_invocation",
    request,
    input,
    selectedService,
    manifest,
    quote,
    result,
    feedback: feedbackEvent,
    verification
  });
  evidence.arc_anchor = await anchorEvidenceOnArc(evidence);
  const existingEvidence = store.evidenceEvents.find((event) =>
    (event.request_id && event.request_id === requestId) ||
    event.trace_hash === evidence.trace_hash
  );
  const savedEvidence = existingEvidence || evidence;
  if (!existingEvidence) {
    store.evidenceEvents.push(evidence);
    await writePersistentServiceEvent({
      eventType: "evidence",
      serviceId,
      requestId,
      event: evidence
    });
  }

  const qualityEvent = createCompletedCallQualityEvent({
    serviceId,
    providerId: manifest.provider.provider_id,
    requestId,
    feedbackEvent,
    verification,
    evidence: savedEvidence
  });
  record.quality_events = record.quality_events || [];
  if (!record.quality_events.some((event) => event.quality_event_id === qualityEvent.quality_event_id)) {
    record.quality_events.push(qualityEvent);
  }
  if (!store.qualityEvents.some((event) => event.quality_event_id === qualityEvent.quality_event_id)) {
    store.qualityEvents.push(qualityEvent);
  }
  await writePersistentServiceEvent({
    eventType: "quality_event",
    serviceId,
    requestId,
    event: qualityEvent
  });

  const consumerFeedbackRequest = createConsumerFeedbackRequest({
    request,
    selectedService,
    result,
    verification
  });

  return {
    ok: true,
    status: "completed_invocation_recorded",
    request_id: requestId,
    service_id: serviceId,
    verification,
    evidence: savedEvidence,
    feedback: feedbackEvent,
    payment_verification: paymentVerification,
    quality_event: qualityEvent,
    consumer_feedback_request: consumerFeedbackRequest
  };
}

async function verifyCompletedCallPayment({ body, manifest, feedbackEvent }) {
  const receipt = feedbackEvent.settlement_receipt || {};
  const localPayment = body.local_payment || {};
  const network = receipt.network || localPayment.network || manifest.pricing?.network;
  if (!isArcNetwork(network)) {
    return {
      ok: true,
      status: "not_checked_non_arc_payment",
      network: network || null
    };
  }
  if (!feedbackEvent.payment_tx) {
    return {
      ok: false,
      error: "MISSING_PAYMENT_TX"
    };
  }
  const expected = {
    amount: receipt.amount || localPayment.amount || manifest.pricing?.amount,
    payTo: receipt.pay_to || localPayment.pay_to || manifest.pricing?.pay_to,
    payer: localPayment.payer || null
  };
  if (!expected.amount || !expected.payTo) {
    return {
      ok: false,
      error: "MISSING_PAYMENT_EXPECTATION",
      expected
    };
  }
  const verified = await verifyArcUsdcTransfer({
    txHash: feedbackEvent.payment_tx,
    expected
  });
  return {
    ...verified,
    status: verified.ok ? "verified_arc_usdc_transfer" : "arc_usdc_transfer_invalid",
    expected
  };
}

function normalizeOperationalFeedback({ body, manifest, requestId, verification }) {
  const source = body.feedback || {};
  const localPayment = body.local_payment || {};
  const status = source.status || localPayment.status || (body.result?.status === "success" ? "success" : "error");
  const event = {
    event_version: "agent_service_feedback_v1",
    request_id: requestId,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    consumer_id: source.consumer_id || localPayment.payer || "local_agent_wallet",
    payment_tx: source.payment_tx || localPayment.payment_tx || null,
    payment_collected: source.payment_collected ?? Boolean(source.payment_tx || localPayment.payment_tx),
    billing_status: source.billing_status || (source.payment_tx || localPayment.payment_tx ? "charged_success" : "unknown"),
    result_delivery_status: source.result_delivery_status || (status === "success" ? "delivered" : "failed_after_payment"),
    settlement_receipt: source.settlement_receipt || null,
    status,
    schema_valid: verification.schema_valid,
    freshness_valid: verification.freshness_valid,
    coverage_valid: verification.coverage_valid,
    data_non_empty: verification.data_non_empty,
    latency_ms: source.latency_ms ?? null,
    consumer_rating: typeof source.consumer_rating === "number" ? source.consumer_rating : null,
    payment_backend: source.payment_backend || localPayment.backend || null,
    verification,
    created_at: source.created_at || new Date().toISOString()
  };
  event.feedback_hash = source.feedback_hash || hashJson(event);
  return event;
}

function upsertOperationalFeedback(record, event) {
  record.feedback_events = record.feedback_events || [];
  const existing = record.feedback_events.find((item) =>
    item.request_id === event.request_id &&
    ((item.payment_tx && event.payment_tx && item.payment_tx === event.payment_tx) || !item.payment_tx || !event.payment_tx)
  );
  if (existing) {
    Object.assign(existing, event, {
      consumer_feedback: existing.consumer_feedback,
      consumer_rating: existing.consumer_rating ?? event.consumer_rating,
      updated_at: new Date().toISOString()
    });
    return existing;
  }
  record.feedback_events.push(event);
  return event;
}

function createCompletedCallQualityEvent({ serviceId, providerId, requestId, feedbackEvent, verification, evidence }) {
  const qualityEvent = {
    event_version: "agent_service_quality_event_v1",
    quality_event_id: hashJson({
      service_id: serviceId,
      request_id: requestId,
      payment_tx: feedbackEvent.payment_tx,
      trace_hash: evidence.trace_hash,
      type: "completed_paid_invocation"
    }),
    service_id: serviceId,
    provider_id: providerId,
    request_id: requestId,
    payment_tx: feedbackEvent.payment_tx,
    trace_hash: evidence.trace_hash,
    event_type: "completed_paid_invocation",
    deterministic_verification: verification,
    status: verification.schema_valid && verification.data_non_empty ? "verified_result_recorded" : "needs_review",
    blocking_issues: (verification.issues || []).filter((issue) =>
      ["SCHEMA_ERROR", "ENVELOPE_ERROR", "STATUS_NOT_SUCCESS", "EMPTY_RESULT"].includes(issue.code)
    ),
    consumer_feedback_expected: true,
    created_at: new Date().toISOString()
  };
  qualityEvent.event_hash = hashJson(qualityEvent);
  return qualityEvent;
}

function listFeedbackEvents(store, { requestId, serviceId } = {}) {
  const events = serviceId
    ? (store.services.get(serviceId)?.feedback_events || [])
    : [...store.services.values()].flatMap((record) => record.feedback_events || []);
  return events.filter((event) => !requestId || event.request_id === requestId);
}

function resolveFeedbackServiceId(store, requestId) {
  if (!requestId) return null;
  const matches = listFeedbackEvents(store, { requestId })
    .map((event) => event.service_id)
    .filter(Boolean);
  const unique = [...new Set(matches)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    const error = new Error("request_id matches multiple services; service_id is required");
    error.statusCode = 409;
    error.code = "AMBIGUOUS_FEEDBACK_REQUEST";
    throw error;
  }
  return null;
}

async function recordConsumerFeedbackAnchor(store, feedbackResult, baseUrl = "", { deferErc8004ToConsumer = false } = {}) {
  const record = store.services.get(feedbackResult.service_id);
  const providerId = record?.manifest?.provider?.provider_id || feedbackResult.provider_id || "";
  const anchor = await anchorConsumerFeedbackOnArc({
    requestId: feedbackResult.request_id,
    serviceId: feedbackResult.service_id,
    providerId,
    feedback: feedbackResult.consumer_feedback
  });
  const erc8004 = deferErc8004ToConsumer
    ? createConsumerRequiredErc8004Feedback({ feedbackResult, record, providerId, baseUrl })
    : await submitErc8004Feedback({
        requestId: feedbackResult.request_id,
        serviceId: feedbackResult.service_id,
        providerId,
        manifest: record?.manifest,
        feedback: feedbackResult.consumer_feedback,
        baseUrl
      });
  const trustAnchor = {
    trust_anchor_version: "agent_router_trust_anchor_v1",
    primary_standard: erc8004.status === "submitted" ? "ERC-8004" : "custom_arc_anchor",
    arc_anchor: anchor,
    erc8004
  };
  const target = [...(record?.feedback_events || [])].reverse().find((event) => event.request_id === feedbackResult.request_id);
  if (target) {
    target.consumer_feedback_arc_anchor = anchor;
    target.consumer_feedback_erc8004 = erc8004;
    target.consumer_feedback_trust_anchor = trustAnchor;
  }
  const globalTarget = [...(store.feedbackEvents || [])].reverse().find((event) =>
    event.request_id === feedbackResult.request_id &&
    event.service_id === feedbackResult.service_id &&
    event.event_version === "agent_consumer_feedback_v1"
  );
  if (globalTarget) {
    globalTarget.arc_anchor = anchor;
    globalTarget.erc8004 = erc8004;
    globalTarget.trust_anchor = trustAnchor;
  }
  await writePersistentServiceEvent({
    eventType: "consumer_feedback_anchor",
    serviceId: feedbackResult.service_id,
    requestId: feedbackResult.request_id,
    event: {
      event_version: "agent_consumer_feedback_anchor_v1",
      service_id: feedbackResult.service_id,
      provider_id: providerId,
      request_id: feedbackResult.request_id,
      arc_anchor: anchor,
      erc8004,
      trust_anchor: trustAnchor,
      created_at: new Date().toISOString()
    }
  });
  return trustAnchor;
}

function createConsumerRequiredErc8004Feedback({ feedbackResult, record, providerId, baseUrl = "" }) {
  const agentId =
    record?.manifest?.registration?.erc8004?.agent_id ||
    record?.manifest?.provider?.erc8004_agent_id ||
    record?.manifest?.provider?.agent_id ||
    null;
  return {
    standard: "ERC-8004",
    registry_type: "reputation",
    event_type: "AgentRouterConsumerFeedback",
    network: "arc-testnet",
    caip2: "eip155:5042002",
    chain_id: 5042002,
    agent_id: agentId ? String(agentId) : null,
    service_id: feedbackResult.service_id,
    provider_id: providerId,
    request_id: feedbackResult.request_id,
    status: "consumer_submission_required",
    submitter: "consumer_wallet",
    reason: "ERC-8004 Reputation feedback must be submitted by the consumer wallet, not the provider/operator wallet.",
    submit_endpoint: "/agent-router/feedback/erc8004",
    feedback_uri: `${String(baseUrl || "").replace(/\/$/, "")}/agent-router/feedback?request_id=${encodeURIComponent(feedbackResult.request_id)}`
  };
}

function recordClientSubmittedErc8004Feedback(store, body = {}) {
  const serviceId = body.service_id || resolveFeedbackServiceId(store, body.request_id);
  const requestId = body.request_id;
  const erc8004 = body.erc8004;
  if (!serviceId || !requestId || !erc8004 || typeof erc8004 !== "object") {
    return {
      ok: false,
      status: "invalid_request",
      error: "service_id, request_id, and erc8004 object are required."
    };
  }
  if (erc8004.standard !== "ERC-8004" || erc8004.registry_type !== "reputation") {
    return {
      ok: false,
      status: "invalid_erc8004_feedback",
      error: "erc8004 must describe an ERC-8004 reputation submission."
    };
  }
  if (erc8004.status !== "submitted" || !/^0x[0-9a-fA-F]{64}$/.test(String(erc8004.tx_hash || ""))) {
    return {
      ok: false,
      status: "erc8004_feedback_not_submitted",
      error: "erc8004.status must be submitted and tx_hash must be present."
    };
  }
  const record = store.services.get(serviceId);
  const event = [...(record?.feedback_events || [])].reverse().find((item) => item.request_id === requestId);
  if (!event) {
    return {
      ok: false,
      status: "feedback_event_not_found",
      error: "No feedback event exists for this request_id."
    };
  }
  event.consumer_feedback_erc8004 = erc8004;
  event.consumer_feedback_trust_anchor = {
    ...(event.consumer_feedback_trust_anchor || {}),
    primary_standard: "ERC-8004",
    erc8004,
    updated_at: new Date().toISOString()
  };
  const globalConsumer = [...(store.feedbackEvents || [])].reverse().find((item) =>
    item.request_id === requestId &&
    item.service_id === serviceId &&
    item.event_version === "agent_consumer_feedback_v1"
  );
  if (globalConsumer) {
    globalConsumer.erc8004 = erc8004;
    globalConsumer.trust_anchor = event.consumer_feedback_trust_anchor;
  }
  writePersistentServiceEvent({
    eventType: "consumer_feedback_erc8004_client",
    serviceId,
    requestId,
    event: {
      event_version: "agent_consumer_feedback_erc8004_client_v1",
      service_id: serviceId,
      provider_id: record?.manifest?.provider?.provider_id || erc8004.provider_id || null,
      request_id: requestId,
      erc8004,
      created_at: new Date().toISOString()
    }
  }).catch(() => {});
  return {
    ok: true,
    status: "erc8004_feedback_attached",
    service_id: serviceId,
    request_id: requestId,
    erc8004,
    trust_anchor: event.consumer_feedback_trust_anchor
  };
}

async function recordQuoteFeedback(store, body = {}) {
  const quoteId = String(body.quote_id || "").trim();
  const decision = String(body.decision || "").trim();
  const reasonCode = String(body.reason_code || "").trim();
  const reason = String(body.reason || "").trim();
  if (!quoteId || !decision || !reasonCode || !reason) {
    return {
      ok: false,
      status: "invalid_request",
      error: "quote_id, decision, reason_code, and reason are required."
    };
  }
  const allowedDecisions = new Set(["not_invoked", "invoked_elsewhere", "user_declined", "deferred"]);
  const allowedReasons = new Set(["free_source_used", "price_too_high", "wallet_empty", "low_confidence", "user_declined", "other"]);
  if (!allowedDecisions.has(decision) || !allowedReasons.has(reasonCode)) {
    return {
      ok: false,
      status: "invalid_quote_feedback",
      error: "decision or reason_code is not supported."
    };
  }
  const event = {
    event_version: "agentrouter_quote_feedback_v1",
    quote_id: quoteId,
    service_id: body.service_id || null,
    consumer_id: body.consumer_id || "main_agent",
    decision,
    reason_code: reasonCode,
    reason,
    created_at: new Date().toISOString()
  };
  store.quoteFeedbackEvents ||= [];
  store.quoteFeedbackEvents.push(event);
  await writePersistentServiceEvent({
    eventType: "quote_feedback",
    serviceId: event.service_id,
    requestId: quoteId,
    event
  });
  return {
    ok: true,
    status: "quote_feedback_recorded",
    event
  };
}

export async function seedDemoService(serverUrl, store) {
  const record = registerService(store, baseFundFlowManifest, serverUrl);
  await validateService(store, record.manifest.service_id);
  const liquidationRecord = registerService(store, btcLiquidationMaxPainManifest, serverUrl);
  await validateService(store, liquidationRecord.manifest.service_id);
  return record;
}

function attachOwnerToManifest(manifest, user) {
  const ownerKey = authUserKey(user);
  if (!ownerKey) return;
  manifest.registration = {
    ...(manifest.registration || {}),
    owner: {
      user_key: ownerKey,
      provider: user?.provider || "",
      user_id: user?.id || "",
      handle: user?.handle || "",
      email: user?.email || "",
      name: user?.name || "",
      created_at: new Date().toISOString()
    }
  };
}

function createErc8257ToolManifest({ manifest, baseUrl = "" } = {}) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  const serviceId = manifest?.service_id || "";
  return {
    schema: "erc8257.tool_manifest.v1",
    standard: "ERC-8257",
    compatibility: "agentrouter_erc8257_manifest_compat_v1",
    registry_strategy: "compatible_manifest_only_no_custom_onchain_tool_registry",
    tool_id: serviceId,
    name: manifest?.title || serviceId,
    description: manifest?.description_for_agent || "",
    tool_type: manifest?.manifest_type || "hosted_http_data_api",
    version: manifest?.version || "1.0.0",
    creator: {
      provider_id: manifest?.provider?.provider_id || "",
      payout_address: manifest?.provider?.payout_address || manifest?.pricing?.pay_to || null
    },
    endpoint: {
      url: manifest?.endpoint?.url || "",
      method: manifest?.endpoint?.method || "POST",
      payment_required: true,
      payment_protocol: manifest?.pricing?.protocol || "x402"
    },
    input_schema: manifest?.input_schema || {},
    output_schema: manifest?.output_schema || {},
    pricing: manifest?.pricing || {},
    routing: manifest?.routing || {},
    integrity: manifest?.integrity || {
      manifest_hash: manifest?.registration?.manifest_hash || null,
      config_hash: manifest?.registration?.config_hash || null
    },
    origin_binding: manifest?.origin_binding || null,
    agentrouter: {
      layer_role: "execution_routing_verification",
      service_id: serviceId,
      service_detail_url: origin && serviceId ? `${origin}/agent-router/service?service_id=${encodeURIComponent(serviceId)}` : "",
      evidence_profile: {
        profile_version: "agentrouter_execution_evidence_profile_v1",
        profile_type: "paid_hosted_http_data_api_execution"
      },
      erc8004_agent_metadata: origin && serviceId ? `${origin}/.well-known/erc8004/agents/${encodeURIComponent(serviceId)}.json` : ""
    }
  };
}

export async function bootstrapServer(server, baseUrl) {
  if (process.env.ADN_SEED_EXAMPLE_SERVICES === "1") {
    await seedDemoService(baseUrl, server.store);
  }
  await loadProviderConfigs(server.store, baseUrl, {
    validate: process.env.ADN_VALIDATE_PROVIDER_CONFIGS_ON_BOOT === "1"
  });
  await hydratePersistentServiceEvents(server.store);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.listen(port, host, async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    await bootstrapServer(server, baseUrl);
    console.log(`Agent Native Data Network MVP running at ${baseUrl} on ${host}`);
  });
}
