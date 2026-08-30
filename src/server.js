import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { URL } from "node:url";
import { readJson, readRawBody, sendHtml, sendJson, sendNotFound, getRequestBaseUrl } from "./http-utils.js";
import { assertSettlementChainReady, settlementChain, erc8004Registries, erc8004AgentRegistryId, erc8004ExplorerUrl } from "./chains.js";
import { createMemoryStore, listServiceCategoryCounts, listServiceSummaries, publicServiceRecord, publicSampleResponse, publicValidationRun, summarizeHomeStats, summarizeRegistryStats } from "./store.js";
import { baseFundFlowManifest, btcLiquidationMaxPainManifest } from "./fixtures.js";
import { handleBtcLiquidationProvider, handleCustomProvider, handleFundFlowProvider, handleMockUpstreamApplicationError, handleMockUpstreamHeaderKey, handleMockUpstreamSentiment,
  fetchApifyActorMetadata,
  handleMockUpstreamApify } from "./provider-runtime.js";
import { applyErc8004VendorIdentity, feedbackGrantActorKey, hydratePersistentServiceEvents, invokePaidService, issueLocalFeedbackGrant, recordConsumerFeedback, registerService, searchServices, validateService, loadProviderConfigs, runServiceHealthCheck, updateServicePayoutWallet, registerServiceErc8004Identity, vendorIdentityStoreKey, withCurrentRuntimeEndpoint } from "./registry.js";
import { createEvidenceEnvelope, hashJson } from "./evidence.js";
import { discoverApiServices, publishApiDrafts } from "./openapi-import.js";
import { getCapabilityCatalog, quoteCapabilityRequest, resolveRoute, routeCapabilityRequest, routeTask } from "./router.js";
import { claimPersistentBrowserHandoff, persistenceReadiness, writePersistentServiceEvent } from "./persistence.js";
import { createConsumerFeedbackRequest, verifyServiceResult } from "./verifier.js";
import { isArcNetwork, verifyArcUsdcTransfer } from "./arc-payment.js";
import { anchorEvidenceOnArc, assertEvidenceAnchorReady } from "./arc-anchor.js";
import { createErc8004AgentMetadata, createErc8004FeedbackDescriptor, createErc8004RegistrationTransaction, ERC8004_REPUTATION_ABI, verifyErc8004FeedbackTransaction, verifyErc8004IdentityRegistrationTransaction } from "./erc8004.js";
import { askAgentRouter } from "./agent-router.js";
import { createProviderFromStudio, draftFromServiceRecord, studioHtml } from "./studio.js";
import { accountHtml, agentHtml, homeHtml, humanHtml, publicApisHtml, serviceDetailHtml } from "./home.js";
import { readProviderConfig } from "./provider-config.js";
import { authProviders, authUserKey, beginOAuth, clearSessionCookie, completeOAuth, createDevSession, currentUser, devLoginAvailable, logout } from "./auth.js";
import { accountSpendLimit, authenticateCreditRequest, bindDepositAddress, createCreditApiKey, creditApiKeyFromRequest, ensureCreditAccount, findAccountByDepositAddress, getCreditBalance, listCreditApiKeys, listCreditLedger, revokeCreditApiKey, setAccountSpendLimit } from "./credits.js";
import { approveDeviceAuthorization, beginDeviceAuthorization, getDeviceAuthorizationByUserCode, pollDeviceAuthorization } from "./device-auth.js";
import { currentPaymentBackend } from "./payment-adapter.js";
import { agentRouterConnectionRequired, isAgentRouterCreditsQuote } from "./agentrouter-connection.js";
import { createCreditTopup, processStripeCreditWebhook } from "./credit-payments.js";
import { claimCryptoTopup, cryptoTopupInstructions, depositPaymentUri } from "./credit-crypto.js";
import QRCode from "qrcode-svg";
import { decodeFunctionData, parseTransaction } from "viem";
import { createResearchDraft, normalizeSocialEvidenceItem, researchHtml } from "./research.js";
import { searchPublicDiscussions } from "./research-search.js";
import { getSocialProviderHealth } from "./research-social-providers.js";
import { buildCreatorResearchReport } from "./research-synthesis.js";
import { runSocialResearchCapability } from "./research-capability.js";
import { buildLocalSocialExecutionPlan, getLocalSocialPlatformCatalog } from "./local-social-privacy.js";
import { createSocialConnection, deleteSocialConnection, hydrateSocialConnections, listSocialConnections, socialProvidersForUser } from "./social-connections.js";
import { getExternalApiCatalog,
  freeLocalAlternative, getExternalApiServiceDetail, inferExternalApiRequest, runExternalApiQuery } from "./external-api-capability.js";
import { findSocialPostUrl, runSocialPostReadCapability } from "./social-post-read.js";
import { getBuiltinCapabilities } from "./builtin-capabilities.js";
import { listCapabilityPacks, serviceMatchesCapabilityPack } from "./capability-packs.js";
import {
  bootstrapPublicApiPipeline,
  hydratePublicApiCoverage,
  listPublicApiCatalog,
  publicApiCoverageReport,
  runPublicApiConversionBatch,
  startPublicApiConversionJob,
  syncPublicApiCoverage
} from "./public-api-pipeline.js";
import { agentRouterConnectTool, remoteMcpTools } from "../packages/agentrouter-mcp/server/tool-catalog.js";
import { completeLocalBrowserHandoff } from "../packages/agentrouter-mcp/server/local-browser-connector.js";
import { compactAgentFacingResult } from "./compact-result.js";

const mcpPackageMetadata = JSON.parse(await fs.readFile(new URL("../packages/agentrouter-mcp/package.json", import.meta.url), "utf8"));

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
const designFontPaths = {
  "GeistPixel_Circle.woff2": new URL("../public/assets/fonts/GeistPixel_Circle.woff2", import.meta.url),
  "GeistPixel_Square.woff2": new URL("../public/assets/fonts/GeistPixel_Square.woff2", import.meta.url)
};
const agentRouterSkillPath = new URL("../claude-skills/agent-router/SKILL.md", import.meta.url);
const hostedMcpTools = [...remoteMcpTools, agentRouterConnectTool];
const REMOTE_MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export function createServer({
  store = createMemoryStore(),
  baseUrl = "",
  socialResearchRunner = runSocialResearchCapability,
  socialConnectionOptions = {},
  socialProviderFactory = socialProvidersForUser,
  publicApiPipelineOptions = {},
  writeRateLimit = {},
  readinessProbe = agentRouterReadiness,
  browserHandoffClaim = claimPersistentBrowserHandoff,
  erc8004RegistrationVerifier = verifyErc8004IdentityRegistrationTransaction
} = {}) {
  const resolvedPublicApiPipelineOptions = {
    ...publicApiAutomationOptions(),
    ...publicApiPipelineOptions
  };
  const writeRateLimiter = createWriteRateLimiter(writeRateLimit);
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      await routeRequest(req, res, store, baseUrl || getRequestBaseUrl(req), {
        socialResearchRunner,
        socialConnectionOptions,
        socialProviderFactory,
        publicApiPipelineOptions: resolvedPublicApiPipelineOptions,
        writeRateLimiter,
        readinessProbe,
        browserHandoffClaim,
        erc8004RegistrationVerifier
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, {
        error: {
          code: error.code || (error.statusCode ? "REQUEST_ERROR" : "INTERNAL_ERROR"),
          message: statusCode >= 500 ? "The server could not complete this request." : error.message
        },
        ...(error.validation ? { validation: error.validation } : {})
      });
    }
  });

  server.store = store;
  server.publicApiPipelineOptions = resolvedPublicApiPipelineOptions;
  return server;
}

async function routeRequest(req, res, store, baseUrl, {
  socialResearchRunner = runSocialResearchCapability,
  socialConnectionOptions = {},
  socialProviderFactory = socialProvidersForUser,
  publicApiPipelineOptions = {},
  writeRateLimiter,
  readinessProbe = agentRouterReadiness,
  browserHandoffClaim = claimPersistentBrowserHandoff,
  erc8004RegistrationVerifier = verifyErc8004IdentityRegistrationTransaction
} = {}) {
  const url = new URL(req.url, baseUrl);
  const loginReturnTo = safeReturnTo(url.searchParams.get("return_to") || url.pathname);
  const auth = {
    user: currentUser(req, store) || currentApiTokenUser(req),
    providers: authProviders(),
    devLogin: devLoginAvailable(req, baseUrl),
    loginModal: url.searchParams.get("login") === "1",
    loginError: url.searchParams.get("error") || "",
    loginReturnTo
  };
  const paymentContext = await paidInvocationContext(req, baseUrl, store);

  if (req.method === "OPTIONS" && url.pathname.startsWith("/agent-router/")) {
    res.writeHead(204, apiCorsHeaders());
    res.end();
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/assets/client-logos/")) {
    await sendClientLogo(req, res, url);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/assets/fonts/")) {
    await sendDesignFont(req, res, url);
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

  if ((req.method === "GET" || req.method === "HEAD") && ["/SKILL.md", "/skills/AgentRouter/SKILL.md"].includes(url.pathname)) {
    await sendAgentRouterSkill(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/install.sh") {
    sendInstallScript(req, res, baseUrl);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/update.sh") {
    sendUpdateScript(req, res, baseUrl);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/agent-router/update-manifest.json") {
    sendUpdateManifest(req, res, baseUrl);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/erc8004/platform.json") {
    sendJson(res, 200, createErc8004AgentMetadata({ manifest: platformIdentityManifest(store), baseUrl }), { "cache-control": "public, max-age=300" });
    return;
  }

  if (req.method === "GET" && /^\/\.well-known\/erc8004\/vendors\/[^/]+\.json$/.test(url.pathname)) {
    const providerId = decodeURIComponent(url.pathname.split("/").pop().replace(/\.json$/, ""));
    const manifest = vendorIdentityManifest(store, providerId, baseUrl);
    if (!manifest) return sendNotFound(res, "VENDOR_NOT_FOUND");
    sendJson(res, 200, createErc8004AgentMetadata({ manifest, baseUrl }), { "cache-control": "public, max-age=300" });
    return;
  }

  if (["GET", "POST"].includes(req.method) && url.pathname === "/agent-router/erc8004/platform-registration") {
    if (!requirePlatformOperator(req, res, auth)) return;
    const agentUri = `${String(baseUrl).replace(/\/$/, "")}/.well-known/erc8004/platform.json`;
    const registration = createErc8004RegistrationTransaction({ agentUri });
    const currentIdentity = store.erc8004PlatformIdentities?.get(registration.network) || null;
    if (req.method === "GET") {
      sendJson(res, 200, { ...registration, current_identity: currentIdentity });
      return;
    }
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
    const body = await readJson(req);
    if (currentIdentity) {
      if (String(currentIdentity.tx_hash || "").toLowerCase() === String(body.tx_hash || "").toLowerCase()) {
        sendJson(res, 200, { ok: true, status: "already_registered", identity: currentIdentity });
        return;
      }
      sendJson(res, 409, { error: { code: "ERC8004_PLATFORM_IDENTITY_EXISTS", message: "The platform identity is already registered on this chain." }, identity: currentIdentity });
      return;
    }
    let identity;
    try {
      identity = await erc8004RegistrationVerifier({
        txHash: body.tx_hash,
        expected: {
          chainId: registration.chain_id,
          registryAddress: registration.transaction.to,
          agentUri,
          ownerAddress: body.owner_address
        }
      });
    } catch (error) {
      error.statusCode = error.code === "ERC8004_RECEIPT_NOT_FOUND" ? 409 : 422;
      throw error;
    }
    const event = {
      event_version: "agent_router_erc8004_platform_identity_v1",
      ...identity,
      registered_by: authUserKey(auth.user),
      created_at: new Date().toISOString()
    };
    store.erc8004PlatformIdentities ||= new Map();
    store.erc8004PlatformIdentities.set(identity.network, event);
    await writePersistentServiceEvent({
      eventType: "erc8004_platform_identity",
      serviceId: "agentrouter_external_api_platform",
      requestId: identity.tx_hash,
      event
    });
    sendJson(res, 200, { ok: true, status: "registered", identity: event });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/erc8004/vendors") {
    if (!requireAuth(req, res, auth, url)) return;
    const vendors = listRegisterableVendors(store, auth);
    sendJson(res, 200, { vendors });
    return;
  }

  const vendorRegistrationMatch = url.pathname.match(/^\/agent-router\/erc8004\/vendors\/([^/]+)\/registration$/);
  if (["GET", "POST"].includes(req.method) && vendorRegistrationMatch) {
    if (!requireAuth(req, res, auth, url)) return;
    const providerId = decodeURIComponent(vendorRegistrationMatch[1]);
    const manifest = vendorIdentityManifest(store, providerId, baseUrl);
    if (!manifest) return sendNotFound(res, "VENDOR_NOT_FOUND");
    if (!requireVendorIdentityOwner(req, res, auth, store, providerId)) return;
    const agentUri = `${String(baseUrl).replace(/\/$/, "")}/.well-known/erc8004/vendors/${encodeURIComponent(providerId)}.json`;
    const registration = createErc8004RegistrationTransaction({ agentUri });
    const currentIdentity = store.erc8004VendorIdentities?.get(vendorIdentityStoreKey(providerId, registration.network)) || null;
    if (req.method === "GET") {
      sendJson(res, 200, { ...registration, provider_id: providerId, current_identity: currentIdentity });
      return;
    }
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
    const body = await readJson(req);
    if (currentIdentity) {
      if (String(currentIdentity.tx_hash || "").toLowerCase() === String(body.tx_hash || "").toLowerCase()) {
        sendJson(res, 200, { ok: true, status: "already_registered", identity: currentIdentity });
        return;
      }
      sendJson(res, 409, { error: { code: "ERC8004_VENDOR_IDENTITY_EXISTS", message: "This Vendor already has an ERC-8004 identity on this chain." }, identity: currentIdentity });
      return;
    }
    let identity;
    try {
      identity = await erc8004RegistrationVerifier({
        txHash: body.tx_hash,
        expected: {
          chainId: registration.chain_id,
          registryAddress: registration.transaction.to,
          agentUri,
          ownerAddress: body.owner_address
        }
      });
    } catch (error) {
      error.statusCode = error.code === "ERC8004_RECEIPT_NOT_FOUND" ? 409 : 422;
      throw error;
    }
    const event = {
      event_version: "agent_router_erc8004_vendor_identity_v1",
      ...identity,
      provider_id: providerId,
      registered_by: authUserKey(auth.user),
      created_at: new Date().toISOString()
    };
    applyErc8004VendorIdentity(store, providerId, event);
    await writePersistentServiceEvent({
      eventType: "erc8004_vendor_identity",
      serviceId: `vendor:${providerId}`,
      requestId: identity.tx_hash,
      event
    });
    sendJson(res, 200, { ok: true, status: "registered", identity: event });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/ready") {
    const readiness = await readinessProbe();
    sendJson(res, readiness.ok ? 200 : 503, readiness, { "cache-control": "no-store" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/health") {
    sendJson(res, 200, {
      ok: true,
      service: "agent-router",
      origin: baseUrl,
      runtime_modes: ["http", "remote_mcp"],
      http_fetch: `${baseUrl}/agent-router/fetch`,
      well_known: `${baseUrl}/.well-known/agentrouter.json`,
      remote_mcp: `${baseUrl}/mcp`
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/api-sources") {
    sendJson(res, 200, {
      catalog_version: "agent_router_external_sources_v1",
      sources: getExternalApiCatalog(store, authUserKey(auth.user))
    }, { "cache-control": "private, no-store" });
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/agent-router/mcp") {
    await handleRemoteMcp(req, res, store, baseUrl, {
      ...paymentContext,
      socialConnectionOptions,
      socialProviderFactory,
      socialResearchRunner,
      browserHandoffClaim
    });
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

  if (req.method === "POST" && url.pathname === "/auth/device/start") {
    const body = await readJson(req);
    sendJson(res, 201, beginDeviceAuthorization(store, {
      baseUrl,
      clientName: body.client_name || body.clientName || "AI agent"
    }), { "cache-control": "no-store" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/token") {
    const body = await readJson(req);
    const result = await pollDeviceAuthorization(store, {
      deviceCode: body.device_code,
      issueCredential: ({ account, clientName }) => createCreditApiKey(store, {
        account,
        label: `Connected agent · ${clientName}`,
        authMethod: "device",
        clientName,
        prefix: "ar_device"
      })
    });
    const status = result.error === "slow_down" ? 429 : result.error ? 400 : 200;
    sendJson(res, status, result, { "cache-control": "no-store" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/connect") {
    const userCode = String(url.searchParams.get("user_code") || "").trim();
    const authorization = getDeviceAuthorizationByUserCode(store, userCode);
    if (!authorization) {
      sendHtml(res, 400, deviceConnectHtml({ authorization: null, error: "This connection code is invalid or expired." }));
      return;
    }
    if (!auth.user) {
      const returnTo = `/connect?user_code=${encodeURIComponent(authorization.user_code)}`;
      redirect(res, `/?login=1&return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    sendHtml(res, 200, deviceConnectHtml({ authorization, user: auth.user }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/approve") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to connect this agent.");
    const body = await readJson(req);
    const account = await ensureCreditAccount(store, auth.user);
    const approved = approveDeviceAuthorization(store, {
      userCode: body.user_code,
      account
    });
    sendJson(res, 200, approved, { "cache-control": "no-store" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhooks/stripe/credits") {
    const rawBody = await readRawBody(req);
    const result = await processStripeCreditWebhook(store, {
      rawBody,
      signatureHeader: req.headers["stripe-signature"] || ""
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/account/credits") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to view your AgentRouter credits.");
    const account = await ensureCreditAccount(store, auth.user);
    sendJson(res, 200, {
      account,
      balance: await getCreditBalance(store, account.account_id),
      currency: "credits",
      ledger: await listCreditLedger(store, account.account_id, { limit: url.searchParams.get("limit") || 100 })
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/account/dashboard") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to view your AgentRouter dashboard.");
    const account = await ensureCreditAccount(store, auth.user);
    const [balance, ledger, apiKeys] = await Promise.all([
      getCreditBalance(store, account.account_id),
      listCreditLedger(store, account.account_id, { limit: 100 }),
      listCreditApiKeys(store, account.account_id, { limit: 100 })
    ]);
    sendJson(res, 200, buildAccountDashboard({ account, balance, ledger, apiKeys }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/account/api-keys") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to create an AgentRouter API key.");
    const body = await readJson(req);
    const account = await ensureCreditAccount(store, auth.user);
    const apiKey = await createCreditApiKey(store, { account, label: body.label });
    sendJson(res, 201, {
      ...apiKey,
      note: "This API key is shown once. Store it in your AI client and do not share it."
    });
    return;
  }

  const revokeKeyMatch = url.pathname.match(/^\/account\/api-keys\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeKeyMatch) {
    if (!auth.user) return sendAuthRequired(res, "Sign in to disconnect an AgentRouter client.");
    const account = await ensureCreditAccount(store, auth.user);
    const revoked = await revokeCreditApiKey(store, {
      accountId: account.account_id,
      keyId: decodeURIComponent(revokeKeyMatch[1])
    });
    sendJson(res, 200, revoked);
    return;
  }

  // The payment code, rendered here rather than by an image service. Sending a
  // treasury address to a third party to draw and fetching the picture back
  // puts the destination of real money on someone else's server and in transit.
  if (req.method === "GET" && url.pathname === "/account/credits/deposit.svg") {
    const uri = depositPaymentUri({
      asset: url.searchParams.get("token") || "USDC",
      amount: url.searchParams.get("amount") || undefined
    });
    const svg = new QRCode({
      content: uri, padding: 1, width: 320, height: 320, ecl: "M", join: true, container: "svg-viewbox",
      color: "#000000", background: "#ffffff"
    }).svg().replace(/^<\?xml[^>]*\?>\s*/, "");
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(svg);
    return;
  }

  // What to send, where, on which chain. Fetched before paying, so the address
  // and chain come from the server rather than being retyped from a chat.
  if (req.method === "GET" && url.pathname === "/account/credits/deposit") {
    sendJson(res, 200, cryptoTopupInstructions());
    return;
  }

  // Claiming a deposit that already happened on chain.
  if (req.method === "POST" && url.pathname === "/account/credits/deposit") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to claim a deposit.");
    const body = await readJson(req);
    const account = await ensureCreditAccount(store, auth.user);
    const claimed = await claimCryptoTopup(store, {
      account,
      txHash: body.tx_hash || body.txHash,
      findAccountByDepositAddress: (address) => findAccountByDepositAddress(store, address),
      bindDepositAddress: (acct, address) => bindDepositAddress(store, acct, address)
    });
    sendJson(res, 201, claimed);
    return;
  }

  if (req.method === "POST" && url.pathname === "/account/credits/limit") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to change the per-call limit.");
    const body = await readJson(req);
    const account = await ensureCreditAccount(store, auth.user);
    sendJson(res, 200, await setAccountSpendLimit(store, {
      account,
      maxPricePerCall: body.max_price_per_call ?? body.maxPricePerCall
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/account/credits/topup") {
    if (!auth.user) return sendAuthRequired(res, "Sign in to add AgentRouter credits.");
    const body = await readJson(req);
    const account = await ensureCreditAccount(store, auth.user);
    const topup = await createCreditTopup(store, {
      account,
      amount: body.amount,
      baseUrl
    });
    sendJson(res, 201, topup);
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/login") {
    const returnTo = safeReturnTo(url.searchParams.get("return_to") || "/");
    const error = url.searchParams.get("error");
    const params = new URLSearchParams({ login: "1" });
    if (returnTo !== "/") params.set("return_to", returnTo);
    if (error) params.set("error", error);
    redirect(res, `/?${params.toString()}`);
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/logout") {
    redirect(res, "/", { "set-cookie": logout(req, store, baseUrl) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/dev/start") {
    if (!devLoginAvailable(req, baseUrl)) return sendNotFound(res, "ROUTE_NOT_FOUND");
    const result = createDevSession(store, baseUrl);
    redirect(res, safeReturnTo(url.searchParams.get("return_to") || "/account"), {
      "set-cookie": result.cookie
    });
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
      "cache-control": "no-store"
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/stats" || url.pathname === "/agent-router/stats")) {
    await loadProviderConfigs(store, baseUrl, { validate: false });
    sendJson(res, 200, summarizeRegistryStats(store), {
      "cache-control": "public, max-age=30, stale-while-revalidate=120"
    });
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
    const pack = url.searchParams.get("pack") || "";
    const sort = url.searchParams.get("sort") || "relevance";
    const limit = url.searchParams.get("limit") || 24;
    const offset = url.searchParams.get("offset") || 0;
    const includeDetails = url.searchParams.get("include_details") === "true";
    await loadProviderConfigs(store, baseUrl, { validate: false });
    if (includeDetails) {
      const candidates = query || maxPrice || verifiedOnly || capabilities.length
        ? searchServices(store, { query, capabilities, maxPrice, verifiedOnly })
        : [...store.services.values()].map((record) => publicServiceRecord(record));
      const records = pack
        ? candidates.filter((record) => serviceMatchesCapabilityPack(record, pack))
        : candidates;
      sendJson(res, 200, {
        service_list_version: "agent_router_service_list_v1",
        count: records.length,
        services: records
      });
      return;
    }
    sendJson(res, 200, listServiceSummaries(store, { query, capabilities, maxPrice, verifiedOnly, category, pack, sort, limit, offset }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/capability-packs") {
    await loadProviderConfigs(store, baseUrl, { validate: false });
    const packs = listCapabilityPacks([...store.services.values()]);
    sendJson(res, 200, {
      capability_pack_list_version: "agent_router_capability_packs_v1",
      total: packs.length,
      packs
    }, {
      "cache-control": "no-store"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/service-categories") {
    await loadProviderConfigs(store, baseUrl, { validate: false });
    sendJson(res, 200, {
      category_list_version: "agent_router_service_categories_v1",
      total: store.services.size,
      categories: listServiceCategoryCounts(store)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/builtin-capabilities") {
    const capabilities = getBuiltinCapabilities();
    sendJson(res, 200, {
      capability_list_version: "agent_router_builtin_capabilities_v1",
      total: capabilities.length,
      capabilities
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/service") {
    const serviceId = url.searchParams.get("service_id");
    const record = store.services.get(serviceId);
    const payload = record ? {
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
    } : getExternalApiServiceDetail(store, serviceId, authUserKey(auth.user));
    if (!payload) return sendNotFound(res, "SERVICE_NOT_FOUND");
    if (wantsHtml(req, url)) {
      sendHtml(res, 200, serviceDetailHtml(payload, { auth }));
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    sendHtml(res, 200, homeHtml({ auth }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/public-apis") {
    sendHtml(res, 200, publicApisHtml({ auth }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public-apis") {
    const catalog = listPublicApiCatalog(store, {
      query: url.searchParams.get("q"),
      category: url.searchParams.get("category"),
      availability: url.searchParams.get("availability"),
      status: url.searchParams.get("status"),
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    sendJson(res, 200, {
      ...catalog,
      pipeline: publicApiPipelineProgress(store)
    }, {
      "cache-control": "public, max-age=30, stale-while-revalidate=120"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/research") {
    sendHtml(res, 200, researchHtml(auth));
    return;
  }

  if (req.method === "POST" && url.pathname === "/research/api/projects") {
    const body = await readJson(req);
    sendJson(res, 201, createResearchDraft(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/research/api/evidence/normalize") {
    const body = await readJson(req);
    sendJson(res, 200, normalizeSocialEvidenceItem(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/research/api/search") {
    const body = await readJson(req);
    const providers = await socialProviderFactory(store, authUserKey(auth.user), socialConnectionOptions);
    sendJson(res, 200, await searchPublicDiscussions(body, { localOptions: { providers } }));
    return;
  }

  if (url.pathname === "/research/api/connections" && req.method === "GET") {
    if (!auth.user) return sendJson(res, 401, { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to manage social connections." } });
    sendJson(res, 200, { connections: listSocialConnections(store, authUserKey(auth.user)) });
    return;
  }

  if (url.pathname === "/research/api/connections" && req.method === "POST") {
    if (!auth.user) return sendJson(res, 401, { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to manage social connections." } });
    const body = await readJson(req);
    sendJson(res, 201, await createSocialConnection(store, authUserKey(auth.user), body, socialConnectionOptions));
    return;
  }

  if (url.pathname.startsWith("/research/api/connections/") && req.method === "DELETE") {
    if (!auth.user) return sendJson(res, 401, { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to manage social connections." } });
    const connectionId = decodeURIComponent(url.pathname.split("/").at(-1) || "");
    sendJson(res, 200, await deleteSocialConnection(store, authUserKey(auth.user), connectionId, socialConnectionOptions));
    return;
  }

  if (req.method === "GET" && url.pathname === "/research/api/providers") {
    sendJson(res, 200, await getSocialProviderHealth());
    return;
  }

  if (req.method === "GET" && url.pathname === "/research/api/local-platforms") {
    sendJson(res, 200, { protocol_version: "agentrouter_local_social_catalog_v1", platforms: getLocalSocialPlatformCatalog() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/research/api/local-plan") {
    if (!auth.user) return sendJson(res, 401, { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in before creating a local execution plan." } });
    const body = await readJson(req);
    sendJson(res, 200, buildLocalSocialExecutionPlan(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/research/api/run") {
    const body = await readJson(req);
    const providers = await socialProviderFactory(store, authUserKey(auth.user), socialConnectionOptions);
    const search = await searchPublicDiscussions(body, { localOptions: { providers } });
    const report = buildCreatorResearchReport({ question: body.question, candidates: search.candidates });
    sendJson(res, 200, {
      run_version: "creator_research_run_v1",
      search,
      report,
      completion_status: report.answer_status === "evidence_based" ? "review_required" : search.action_required?.length ? "action_required" : "insufficient_evidence"
    });
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

  if (req.method === "GET" && url.pathname === "/account") {
    if (!auth.user) {
      res.writeHead(302, { location: "/auth/login?return_to=%2Faccount" });
      res.end();
      return;
    }
    sendHtml(res, 200, accountHtml({ auth }));
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

  if (req.method === "POST" && url.pathname === "/studio/import/apify-actor") {
    const body = await readJson(req);
    try {
      const draft = await fetchApifyActorMetadata(body.actor_id, body.token);
      sendJson(res, 200, { ok: true, draft });
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        error: { code: error.code || "APIFY_ACTOR_METADATA_FAILED", message: error.message }
      });
    }
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

  if (req.method === "GET" && url.pathname === "/studio/public-api-pipeline/status") {
    if (!requireAuth(req, res, auth, url)) return;
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const candidates = [...store.publicApiCatalog.values()]
      .filter((candidate) => !status || candidate.status === status)
      .filter((candidate) => !category || candidate.category === category)
      .sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")))
      .slice(offset, offset + limit);
    sendJson(res, 200, {
      ok: true,
      coverage: publicApiCoverageReport(store),
      candidates,
      runs: store.publicApiPipelineRuns.slice(0, 20),
      job: store.publicApiPipelineJob || null,
      pagination: { limit, offset, returned: candidates.length }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/public-api-pipeline/sync") {
    if (!requireAdminToken(req, res, auth)) return;
    const result = await syncPublicApiCoverage(store, publicApiPipelineOptions);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/public-api-pipeline/run") {
    if (!requireAdminToken(req, res, auth)) return;
    const body = await readJson(req).catch(() => ({}));
    const result = await runPublicApiConversionBatch(store, {
      ...publicApiPipelineOptions,
      limit: body.limit,
      concurrency: body.concurrency,
      categories: body.categories,
      sources: body.sources,
      candidateIds: body.candidate_ids || body.candidateIds,
      baseUrl
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/public-api-pipeline/start") {
    if (!requireAdminToken(req, res, auth)) return;
    const body = await readJson(req).catch(() => ({}));
    const { accepted, job } = startPublicApiConversionJob(store, {
      ...publicApiPipelineOptions,
      limit: body.limit,
      concurrency: body.concurrency,
      categories: body.categories,
      sources: body.sources,
      candidateIds: body.candidate_ids || body.candidateIds,
      baseUrl
    });
    sendJson(res, 202, { ok: true, accepted, job });
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
    if (!requireAuth(req, res, auth, url)) return;
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
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
    if (!requireAuth(req, res, auth, url)) return;
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    if (!requireServiceOwner(req, res, auth, record)) return;
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
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
    if (!requireAuth(req, res, auth, url)) return;
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    if (!requireServiceOwner(req, res, auth, record)) return;
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
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
    sendJson(res, 200, (record.feedback_events || []).map(publicFeedbackEvent));
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/feedback") {
    const body = await readJson(req);
    const feedbackActorKey = authUserKey(auth.user) || paymentContext.ownerKey || feedbackGrantActorKey(store, body);
    if (!feedbackActorKey) {
      sendJson(res, 401, {
        error: {
          code: "AUTH_REQUIRED",
          message: "An authenticated AgentRouter connection is required to submit feedback."
        }
      });
      return;
    }
    if (!allowSensitiveWrite(req, res, writeRateLimiter, feedbackActorKey)) return;
    if (!body.service_id) {
      body.service_id = resolveFeedbackServiceId(store, body.request_id || body.feedback?.request_id);
    }
    const result = await recordConsumerFeedback(store, body, {
      actorKey: feedbackActorKey,
      requireKnownInvocation: true
    });
    const trustAnchor = result.status === "consumer_feedback_already_recorded" && result.trust_anchor
      ? result.trust_anchor
      : await recordConsumerFeedbackAnchor(store, result, baseUrl);
    result.arc_anchor = trustAnchor.arc_anchor;
    result.erc8004 = trustAnchor.erc8004;
    result.trust_anchor = trustAnchor;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/feedback/grant") {
    const feedbackActorKey = authUserKey(auth.user) || paymentContext.ownerKey || "";
    if (!feedbackActorKey) {
      sendJson(res, 401, { error: { code: "AUTH_REQUIRED", message: "An authenticated AgentRouter connection is required." } });
      return;
    }
    if (!allowSensitiveWrite(req, res, writeRateLimiter, feedbackActorKey)) return;
    const body = await readJson(req);
    const result = await issueLocalFeedbackGrant(store, body, { actorKey: feedbackActorKey });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/feedback/erc8004") {
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user) || paymentContext.ownerKey)) return;
    const body = await readJson(req);
    const result = await recordClientSubmittedErc8004Feedback(store, body);
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/paymaster") {
    if (!paymentContext.ownerKey) {
      sendJson(res, 401, { ok: false, status: "authentication_required", error: "An authenticated AgentRouter connection is required." });
      return;
    }
    if (!allowSensitiveWrite(req, res, writeRateLimiter, paymentContext.ownerKey)) return;
    const body = await readJson(req);
    const result = await relayBscPaymasterRequest(body, store);
    sendJson(res, result.ok ? 200 : result.statusCode, result);
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
      events: events.map(publicFeedbackEvent)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/calls/complete") {
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user) || paymentContext.ownerKey)) return;
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
    if (!paymentContext.invoke) {
      const blocked = paymentRequiredForService(store, body.service_id, body.input || {}, body.budget || {});
      sendJson(res, blocked.statusCode, blocked.body);
      return;
    }
    const result = await invokePaidService(store, body.service_id, body.input || {}, body.budget || {}, {
      consumerApiKey: paymentContext.consumerApiKey
    });
    sendJson(res, result.statusCode, result.body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/router/route") {
    const body = await readJson(req);
    if (!paymentContext.invoke) {
      const resolved = resolveRoute(store, body);
      const payload = routePaymentRequired(resolved, body);
      sendJson(res, paymentBoundaryStatusCode(payload), payload);
      return;
    }
    const result = await routeTask(store, body, paymentContext);
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
    const capabilityPacks = listCapabilityPacks([...store.services.values()]);
    sendJson(res, 200, {
      catalog_version: "agent_router_capability_catalog_v1",
      preferred_endpoint: "/agent-router/request",
      note: "Main agents should parse user intent into this structured capability schema. /agent-router/ask is a demo fallback, not the core protocol.",
      capabilities: getCapabilityCatalog(),
      capability_packs: capabilityPacks
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/request") {
    const body = await readJson(req);
    if (body.capability === "external_api_query") {
      const ownerKey = authUserKey(auth.user) || paymentContext.ownerKey || "";
      const sourceDefinition = getExternalApiCatalog(store, ownerKey).find((item) => item.source === String(body.params?.source || "").toLowerCase());
      if (!ownerKey && sourceDefinition?.connection_required === true) {
        // This source genuinely needs a credential, so the 401 stands. But
        // telling the agent only to connect an account is a dead end when the
        // same data is readable for free through the local browser — attach the
        // call that works instead of leaving it to guess.
        const alternative = freeLocalAlternative(String(body.params?.source || "").toLowerCase(), body.params || {});
        return sendJson(res, 401, {
          ...agentRouterConnectionRequired(),
          ...(alternative ? { free_alternative: alternative, recommended_action: "use_free_local_alternative" } : {})
        });
      }
      const result = await runExternalApiQuery(store, ownerKey, body.params || {}, socialConnectionOptions);
      sendJson(res, externalApiStatusCode(result), result);
      return;
    }
    if (body.capability === "social_user_voice_research") {
      const providers = await socialProviderFactory(store, authUserKey(auth.user), socialConnectionOptions);
      const result = await socialResearchRunner(body.params || {}, { searchOptions: { localOptions: { providers } } });
      sendJson(res, result.status === "invalid_request" ? 422 : 200, result);
      return;
    }
    if (body.capability === "social_post_read") {
      const providers = await socialProviderFactory(store, authUserKey(auth.user) || paymentContext.ownerKey || "", socialConnectionOptions);
      const result = await runSocialPostReadCapability(body.params || {}, { providers, consumerContext: body.consumer_context });
      sendJson(res, result.status === "invalid_request" ? 422 : 200, result);
      return;
    }
    if (!paymentContext.invoke) {
      const result = quoteCapabilityRequest(store, body, {
        actorKey: sensitiveWriteActorKey(req, authUserKey(auth.user) || paymentContext.ownerKey)
      });
      const payload = requestPaymentRequired(result);
      sendJson(res, paymentBoundaryStatusCode(payload), payload);
      return;
    }
    const result = await routeCapabilityRequest(store, body, paymentContext);
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/fetch") {
    const body = await readJson(req);
    const result = await runRemoteAgentRouterFetch(store, body, {
      ...paymentContext,
      socialConnectionOptions,
      socialProviderFactory
    });
    sendJson(res, paymentBoundaryStatusCode(result), result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/browser-handoffs/complete") {
    const body = await readJson(req);
    const result = await completeHostedBrowserHandoff(body, browserHandoffClaim);
    sendJson(res, result.ok === false ? 422 : 200, result, { "cache-control": "no-store" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/quote") {
    const body = await readJson(req);
    const quoteActorKey = sensitiveWriteActorKey(req, authUserKey(auth.user) || paymentContext.ownerKey);
    const result = quoteCapabilityRequest(store, body, { actorKey: quoteActorKey });
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/quote-feedback") {
    const quoteActorKey = sensitiveWriteActorKey(req, authUserKey(auth.user) || paymentContext.ownerKey);
    if (!allowSensitiveWrite(req, res, writeRateLimiter, quoteActorKey)) return;
    const body = await readJson(req);
    const result = await recordQuoteFeedback(store, body, {
      actorKey: quoteActorKey,
      requireIssuedQuote: true
    });
    sendJson(res, result.ok ? 200 : result.statusCode || 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/ask") {
    const body = await readJson(req);
    const result = await askAgentRouter(store, {
      task: body.task || body.query || "",
      max_price: body.max_price || body.maxPrice || "0.05",
      currency: body.currency || "USDC",
      invoke: paymentContext.invoke,
      consumerApiKey: paymentContext.consumerApiKey
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
      chain_anchor: `${settlementChain().network}_hash_anchor`,
      storage_model: "full_evidence_offchain_hashes_onchain",
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
    if (!requireAuth(req, res, auth, url)) return;
    const record = store.services.get(body.service_id);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    if (!requireServiceOwner(req, res, auth, record)) return;
    if (!allowSensitiveWrite(req, res, writeRateLimiter, authUserKey(auth.user))) return;
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
    await handleFundFlowProvider(req, res, { store, baseUrl });
    return;
  }

  if (req.method === "POST" && url.pathname === "/provider/btc-liquidation-max-pain") {
    await handleBtcLiquidationProvider(req, res, { store, baseUrl });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/provider/custom/")) {
    const serviceId = decodeURIComponent(url.pathname.split("/")[3] || "");
    await handleCustomProvider(req, res, serviceId, { store, baseUrl });
    return;
  }

  if ((req.method === "POST" || req.method === "GET") && url.pathname.startsWith("/mock/upstream/apify/")) {
    await handleMockUpstreamApify(req, res, url);
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

export async function agentRouterReadiness({
  persistenceProbe = persistenceReadiness,
  environment = process.env
} = {}) {
  const persistence = await persistenceProbe();
  const hosted = environment.NODE_ENV === "production" || Boolean(environment.RENDER);
  const signingSecret = String(environment.ADN_BROWSER_HANDOFF_SECRET || "");
  const signingReady = !hosted || signingSecret.length >= 32;
  return {
    ok: Boolean(persistence.ok && signingReady),
    checks: {
      ...(persistence.checks || {}),
      browser_handoff_signing: {
        ok: signingReady,
        required: hosted,
        configured: signingSecret.length >= 32,
        ...(signingReady ? {} : { error: "ADN_BROWSER_HANDOFF_SECRET must be a shared secret of at least 32 characters in hosted runtime." })
      }
    }
  };
}

async function completeHostedBrowserHandoff(args, claim = claimPersistentBrowserHandoff) {
  const result = completeLocalBrowserHandoff(args);
  if (result.ok === false) return result;
  const claimed = await claim(result.source.handoff_id, result.source.handoff_expires_at);
  if (claimed) return result;
  return {
    ok: false,
    status: "invalid_handoff_result",
    error: {
      code: "HANDOFF_ALREADY_CONSUMED",
      message: "This browser handoff was already completed on another AgentRouter instance."
    }
  };
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

function requireAdminToken(req, res, auth) {
  if (auth.user?.provider === "api_token" && auth.user?.role === "admin") return true;
  sendJson(res, auth.user ? 403 : 401, {
    error: {
      code: auth.user ? "ADMIN_TOKEN_REQUIRED" : "AUTH_REQUIRED",
      message: "An AgentRouter admin API token is required for catalog pipeline mutations."
    }
  });
  return false;
}

function requirePlatformOperator(req, res, auth) {
  if (!auth.user) {
    sendJson(res, 401, { error: { code: "AUTH_REQUIRED", message: "Sign in before registering the AgentRouter platform identity." } });
    return false;
  }
  if (!platformOperatorMatches(auth)) {
    const configured = Boolean(String(process.env.ADN_PLATFORM_OPERATOR_OWNER_KEY || "").trim() || String(process.env.ADN_PLATFORM_OPERATOR_GITHUB_LOGIN || "").trim());
    sendJson(res, configured ? 403 : 503, {
      error: {
        code: configured ? "PLATFORM_OPERATOR_REQUIRED" : "PLATFORM_OPERATOR_NOT_CONFIGURED",
        message: configured
          ? "Only the configured AgentRouter platform operator can register this identity."
          : "Platform identity registration is not enabled for an operator account."
      }
    });
    return false;
  }
  return true;
}

function platformOperatorMatches(auth) {
  if (!auth.user) return false;
  const actorKey = authUserKey(auth.user);
  const allowed = String(process.env.ADN_PLATFORM_OPERATOR_OWNER_KEY || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const githubLogin = String(process.env.ADN_PLATFORM_OPERATOR_GITHUB_LOGIN || "").trim().toLowerCase();
  const githubLoginMatches = githubLogin && auth.user.provider === "github" && String(auth.user.handle || "").toLowerCase() === githubLogin;
  return allowed.includes(actorKey) || Boolean(githubLoginMatches);
}

function requireVendorIdentityOwner(req, res, auth, store, providerId) {
  if (auth.user?.role === "admin" || platformOperatorMatches(auth)) return true;
  const actorKey = authUserKey(auth.user);
  const owned = [...store.services.values()].some((record) =>
    record.manifest?.provider?.provider_id === providerId &&
    record.manifest?.registration?.owner?.user_key === actorKey
  );
  if (owned) return true;
  sendJson(res, 403, {
    error: {
      code: "VENDOR_IDENTITY_OWNER_REQUIRED",
      message: "Only this Vendor's service owner or the configured platform operator can register its ERC-8004 identity."
    }
  });
  return false;
}

function sendAuthRequired(res, message) {
  sendJson(res, 401, {
    error: {
      code: "AUTH_REQUIRED",
      message
    }
  });
}

function currentApiTokenUser(req) {
  const supplied = bearerToken(req.headers.authorization || "") || req.headers["x-agentrouter-publish-token"] || "";
  if (!supplied) return null;
  const adminToken = process.env.ADN_ADMIN_API_TOKEN || "";
  const studioToken = process.env.ADN_STUDIO_API_TOKEN || "";
  const role = adminToken && constantTimeEqual(String(supplied), String(adminToken))
    ? "admin"
    : studioToken && constantTimeEqual(String(supplied), String(studioToken))
      ? "studio"
      : null;
  if (!role) return null;
  return {
    provider: "api_token",
    role,
    id: role === "admin" ? "admin-api-token" : "provider-publish-token",
    name: role === "admin" ? "AgentRouter Admin Token" : "Provider Publish Token",
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
  if (auth.user?.role === "admin" || ownerKey === authUserKey(auth.user)) return true;
  sendJson(res, 403, {
    error: {
      code: ownerKey ? "FORBIDDEN_SERVICE_OWNER" : "ADMIN_REQUIRED_FOR_UNOWNED_SERVICE",
      message: ownerKey
        ? "This service belongs to another provider account."
        : "Only an administrator can mutate an unowned built-in service."
    }
  });
  return false;
}

function createWriteRateLimiter({ max = 60, windowMs = 60_000 } = {}) {
  const safeMax = Math.max(1, Number(max) || 60);
  const safeWindowMs = Math.max(1_000, Number(windowMs) || 60_000);
  const buckets = new Map();
  return {
    consume(key, now = Date.now()) {
      const existing = buckets.get(key);
      const bucket = !existing || now >= existing.resetAt
        ? { count: 0, resetAt: now + safeWindowMs }
        : existing;
      bucket.count += 1;
      buckets.set(key, bucket);
      if (buckets.size > 10_000) {
        for (const [bucketKey, value] of buckets) {
          if (now >= value.resetAt) buckets.delete(bucketKey);
        }
      }
      return {
        allowed: bucket.count <= safeMax,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))
      };
    }
  };
}

function allowSensitiveWrite(req, res, limiter, actorKey = "") {
  const key = sensitiveWriteActorKey(req, actorKey);
  const result = limiter.consume(key);
  if (result.allowed) return true;
  res.setHeader("retry-after", String(result.retryAfterSeconds));
  sendJson(res, 429, {
    error: {
      code: "RATE_LIMITED",
      message: "Too many security-sensitive writes. Retry after the indicated delay."
    }
  });
  return false;
}

function sensitiveWriteActorKey(req, actorKey = "") {
  if (actorKey) return `actor:${actorKey}`;
  const socketAddress = req.socket?.remoteAddress || "unknown";
  return `anonymous:${crypto.createHash("sha256").update(socketAddress).digest("hex").slice(0, 24)}`;
}

function remoteMcpSession(req, store, now = Date.now()) {
  if (!store.remoteMcpSessions) store.remoteMcpSessions = new Map();
  for (const [id, record] of store.remoteMcpSessions) {
    if (record.expires_at <= now) store.remoteMcpSessions.delete(id);
  }
  const requestedId = String(req.headers["mcp-session-id"] || "").trim();
  const existing = requestedId ? store.remoteMcpSessions.get(requestedId) : null;
  if (existing) {
    existing.expires_at = now + REMOTE_MCP_SESSION_TTL_MS;
    return existing;
  }
  const session = {
    id: `armcp_${crypto.randomBytes(24).toString("base64url")}`,
    device_authorization: null,
    consumer_api_key: "",
    created_at: now,
    expires_at: now + REMOTE_MCP_SESSION_TTL_MS
  };
  store.remoteMcpSessions.set(session.id, session);
  return session;
}

async function remoteMcpPaymentContext(session, store, paymentContext) {
  if (!session?.consumer_api_key) return paymentContext;
  const identity = await authenticateCreditRequest(store, {
    headers: { authorization: `Bearer ${session.consumer_api_key}` }
  });
  return {
    ...paymentContext,
    invoke: true,
    consumerApiKey: session.consumer_api_key,
    ownerKey: identity?.account?.owner_key || ""
  };
}

async function connectRemoteMcpSession(store, session, baseUrl, args = {}) {
  if (!session) {
    return {
      ok: false,
      status: "session_required",
      message: "Initialize the AgentRouter MCP connection before authorizing an account."
    };
  }
  if (session.consumer_api_key) {
    return {
      ok: true,
      status: "connected",
      retry_original_request: true,
      message: "This MCP session is connected to AgentRouter. Retry the original request now."
    };
  }
  if (args.restart === true || !session.device_authorization) {
    session.device_authorization = beginDeviceAuthorization(store, {
      baseUrl,
      clientName: args.client_name || "Remote MCP client"
    });
    return remoteMcpAuthorizationRequired(session.device_authorization);
  }
  const result = await pollDeviceAuthorization(store, {
    deviceCode: session.device_authorization.device_code,
    issueCredential: ({ account, clientName }) => createCreditApiKey(store, {
      account,
      label: `Connected remote MCP · ${clientName}`,
      authMethod: "device",
      clientName,
      prefix: "ar_device"
    })
  });
  if (result.access_token) {
    session.consumer_api_key = result.access_token;
    session.device_authorization = null;
    return {
      ok: true,
      status: "connected",
      retry_original_request: true,
      message: "Browser approval succeeded. Retry the original AgentRouter request now."
    };
  }
  if (result.error === "expired_token") session.device_authorization = null;
  return {
    ...remoteMcpAuthorizationRequired(session.device_authorization),
    status: result.error === "expired_token" ? "authorization_expired" : "authorization_required",
    pending_reason: result.error || "authorization_pending"
  };
}

function remoteMcpAuthorizationRequired(authorization) {
  if (!authorization) {
    return {
      ok: false,
      status: "authorization_expired",
      action: "call_agentrouter_connect_again"
    };
  }
  return {
    ok: false,
    status: "authorization_required",
    action: "open_browser_authorization",
    user_code: authorization.user_code,
    verification_uri: authorization.verification_uri,
    verification_uri_complete: authorization.verification_uri_complete,
    expires_in: authorization.expires_in,
    interval: authorization.interval,
    retry_original_request: true,
    message: "Open the authorization link and approve this agent. Then call agentrouter_connect again. No API key should be pasted into chat."
  };
}

async function handleRemoteMcp(req, res, store, baseUrl, paymentContext = {}) {
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
      serverInfo: { name: "AgentRouter", version: mcpPackageMetadata.version },
      capabilities: { tools: {} },
      tools: hostedMcpTools
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
  const session = remoteMcpSession(req, store);
  const sessionPaymentContext = await remoteMcpPaymentContext(session, store, paymentContext);
  const responses = [];
  for (const message of messages) {
    const response = await dispatchRemoteMcpMessage(message, store, baseUrl, sessionPaymentContext, session);
    if (response) responses.push(response);
  }
  if (!responses.length) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  sendRemoteMcpJson(res, 200, Array.isArray(payload) ? responses : responses[0], {
    "mcp-session-id": session.id
  });
}

async function dispatchRemoteMcpMessage(message, store, baseUrl, paymentContext = {}, session = null) {
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
        serverInfo: { name: "AgentRouter", version: mcpPackageMetadata.version }
      });
    }
    if (message.method === "ping") return remoteMcpResult(id, {});
    if (message.method === "tools/list") {
      return remoteMcpResult(id, { tools: hostedMcpTools });
    }
    if (message.method === "tools/call") {
      const result = await callRemoteMcpTool(message.params?.name, message.params?.arguments || {}, store, baseUrl, paymentContext, session);
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

async function callRemoteMcpTool(name, args, store, baseUrl, paymentContext = {}, session = null) {
  await loadProviderConfigs(store, baseUrl, { validate: false });
  if (name === "agentrouter_connect") {
    return connectRemoteMcpSession(store, session, baseUrl, args);
  }
  if (name === "agentrouter_complete_handoff") {
    return completeHostedBrowserHandoff(args, paymentContext.browserHandoffClaim || claimPersistentBrowserHandoff);
  }
  if (name === "agentrouter_fetch") {
    return runRemoteAgentRouterFetch(store, args, {
      ...paymentContext
    });
  }
  if (name === "agentrouter_connect_source") {
    if (!paymentContext.ownerKey) return agentRouterConnectionRequired();
    const sourceId = String(args.source || "").trim().toLowerCase();
    const definition = getExternalApiCatalog(store, paymentContext.ownerKey)
      .find((item) => item.source === sourceId);
    if (!definition) {
      return {
        ok: false,
        status: "unsupported_source",
        error: { code: "UNSUPPORTED_SOURCE", message: `Unknown source: ${sourceId || "(missing)"}` }
      };
    }
    if (!definition.connection_required) {
      return {
        ok: true,
        status: "connection_not_required",
        source: sourceId,
        retry_original_request: true,
        message: `${definition.title} does not require an upstream account connection.`
      };
    }
    if (definition.connected) {
      return {
        ok: true,
        status: "connected",
        source: sourceId,
        retry_original_request: true,
        message: `${definition.title} is connected. Retry the original AgentRouter request now.`
      };
    }
    const authorizationUrl = new URL("/research", baseUrl || "https://agentrouter.network");
    authorizationUrl.searchParams.set("connect_source", sourceId);
    return {
      ok: false,
      status: "authorization_required",
      action: "connect_api_source",
      source: sourceId,
      source_title: definition.title,
      verification_uri: authorizationUrl.toString(),
      retry_original_request: true,
      do_not_fallback_outside_agentrouter: true,
      message: `Open the authorization link to connect ${definition.title}. The credential is entered only on AgentRouter's website and must never be pasted into chat. After saving it, call this tool again and retry the original request.`
    };
  }
  if (name === "agentrouter_request") {
    const request = {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {},
      consumer_context: args.consumer_context || { source: "remote_mcp" }
    };
    if (request.capability === "external_api_query") {
      const ownerKey = paymentContext.ownerKey || "";
      const sourceDefinition = getExternalApiCatalog(store, ownerKey).find((item) => item.source === String(request.params?.source || "").toLowerCase());
      if (sourceDefinition?.connection_required === true && !ownerKey) {
        return agentRouterConnectionRequired();
      }
      return runExternalApiQuery(store, ownerKey, request.params, paymentContext.socialConnectionOptions || {});
    }
    if (request.capability === "social_user_voice_research") {
      const ownerKey = paymentContext.ownerKey || "";
      const providerFactory = paymentContext.socialProviderFactory || socialProvidersForUser;
      const researchRunner = paymentContext.socialResearchRunner || runSocialResearchCapability;
      const providers = await providerFactory(store, ownerKey, paymentContext.socialConnectionOptions || {});
      return researchRunner(request.params, { searchOptions: { localOptions: { providers } } });
    }
    if (request.capability === "social_post_read") {
      const ownerKey = paymentContext.ownerKey || "";
      const providerFactory = paymentContext.socialProviderFactory || socialProvidersForUser;
      const providers = await providerFactory(store, ownerKey, paymentContext.socialConnectionOptions || {});
      return runSocialPostReadCapability(request.params, { providers, consumerContext: request.consumer_context });
    }
    if (!paymentContext.invoke) {
      return requestPaymentRequired(quoteCapabilityRequest(store, request));
    }
    return routeCapabilityRequest(store, request, paymentContext);
  }
  if (name === "agentrouter_quote") {
    return quoteCapabilityRequest(store, {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {}
    }, { actorKey: paymentContext.ownerKey ? `actor:${paymentContext.ownerKey}` : "" });
  }
  if (name === "agentrouter_quote_feedback") {
    if (!paymentContext.ownerKey) return agentRouterConnectionRequired();
    return recordQuoteFeedback(store, args, {
      actorKey: `actor:${paymentContext.ownerKey}`,
      requireIssuedQuote: true
    });
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
    const actorKey = paymentContext.ownerKey || feedbackGrantActorKey(store, body);
    if (!actorKey) return agentRouterConnectionRequired();
    const result = await recordConsumerFeedback(store, body, {
      actorKey,
      requireKnownInvocation: true
    });
    const trustAnchor = result.status === "consumer_feedback_already_recorded" && result.trust_anchor
      ? result.trust_anchor
      : await recordConsumerFeedbackAnchor(store, result, baseUrl);
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
      invoke: paymentContext.invoke,
      consumerApiKey: paymentContext.consumerApiKey
    });
  }
  return {
    ok: false,
    status: "unknown_tool",
    tool: name,
    available_tools: hostedMcpTools.map((tool) => tool.name)
  };
}

async function runRemoteAgentRouterFetch(store, args = {}, {
  invoke = true,
  consumerApiKey = "",
  ownerKey = "",
  socialConnectionOptions = {},
  socialProviderFactory = socialProvidersForUser
} = {}) {
  let requirements = Array.isArray(args.data_requirements) ? args.data_requirements : [];
  const maxPrice = args.max_price || args.constraints?.max_price_usdc || args.budget?.max_amount || "0.05";
  const currency = args.currency || args.budget?.currency || "USDC";

  // Prefer a source the caller has actually connected over a default one.
  // Resolved once here because both routing passes need it: the specialized
  // pass before the service router, and the web fallback after it.
  const connectedSources = requirements.length ? [] : getExternalApiCatalog(store, ownerKey)
    .filter((item) => item.connected === true)
    .map((item) => item.source);

  if (!requirements.length) {
    const socialPost = findSocialPostUrl(args.task || args.query || "");
    if (socialPost) {
      const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
      return runSocialPostReadCapability(
        { url: socialPost.canonical_url, platform: socialPost.platform },
        { providers, consumerContext: args.consumer_context }
      );
    }
    // Only the unambiguous domain sources run ahead of the registered-service
    // router. A generic web search used to run first and preempt services that
    // would have matched.
    const externalApiRequest = inferExternalApiRequest(args.task || args.query || "", {
      connectedSources,
      tier: "specialized"
    });
    if (externalApiRequest) requirements = [externalApiRequest];
  }

  if (!requirements.length) {
    const routed = await askAgentRouter(store, {
      task: args.task || args.query || "",
      max_price: maxPrice,
      currency,
      invoke,
      consumerApiKey
    });
    // "No registered service covers this" is not an answer when a web search
    // has one. The router used to only *suggest* the fallback and hand back a
    // dead end, so the agent had to guess a rephrasing and ask again.
    if (routed?.status !== "no_service_found") return routed;
    const webSearch = inferExternalApiRequest(args.task || args.query || "", {
      connectedSources,
      tier: "web"
    });
    if (!webSearch) return routed;
    requirements = [webSearch];
  }

  const researchPlans = requirements
    .map((requirement) => requirement?.research_plan)
    .filter((plan) => plan && typeof plan === "object");
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
    if (request.capability === "social_post_read") {
      const providers = await socialProviderFactory(store, ownerKey, socialConnectionOptions);
      results.push(await runSocialPostReadCapability(request.params, { providers, consumerContext: request.consumer_context }));
      continue;
    }
    if (request.capability === "external_api_query") {
      const sourceDefinition = getExternalApiCatalog(store, ownerKey)
        .find((item) => item.source === String(request.params?.source || "").toLowerCase());
      if (!ownerKey && sourceDefinition?.connection_required === true) {
        results.push(agentRouterConnectionRequired());
      } else {
        results.push(await runExternalApiQuery(store, ownerKey, request.params, socialConnectionOptions));
      }
      continue;
    }
    if (invoke) {
      results.push(await routeCapabilityRequest(store, request, { consumerApiKey }));
    } else {
      results.push(requestPaymentRequired(quoteCapabilityRequest(store, request)));
    }
  }
  const successful = results.filter((result) => result?.ok !== false && result?.result);
  const failed = results.filter((result) => result?.ok === false);
  const allPaymentRequired = failed.length === results.length && failed.every((result) => result?.status === "payment_required");
  const connectionRequired = failed.find((result) => result?.status === "connection_required");
  const feedbackRequired = results.some((result) => result?.consumer_feedback_request);
  return {
    ok: failed.length === 0,
    status: connectionRequired && !successful.length
      ? "connection_required"
      : allPaymentRequired
        ? "payment_required"
        : failed.length
          ? (successful.length ? "partial_data_returned" : "no_data_returned")
          : "data_returned",
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
    ...(researchPlans.length ? { research_plans: researchPlans } : {}),
    feedback_required: feedbackRequired,
    next_required_action: connectionRequired?.action_required || (feedbackRequired
      ? "After using these results in the final answer, submit agentrouter_feedback for each returned request_id."
      : null)
  };
}

function requirementToCapabilityRequest(requirement = {}, args = {}, { maxPrice, currency }) {
  const {
    capability,
    type,
    params,
    constraints,
    budget,
    consumer_context: consumerContext,
    research_plan: _researchPlan,
    ...inlineParams
  } = requirement;
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
  const sanitized = sanitizeProviderFields(compactAgentFacingResult(result));
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
    "access-control-allow-headers": "content-type, accept, mcp-session-id, authorization, anthropic-beta, anthropic-version, x-api-key, x-agentrouter-api-key",
    "access-control-expose-headers": "mcp-session-id",
    "cache-control": "no-store"
  };
}

function apiCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key, x-agentrouter-api-key",
    "access-control-max-age": "600"
  };
}

function applySecurityHeaders(res) {
  res.setHeader("content-security-policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; "));
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function externalApiStatusCode(result) {
  if (result?.ok !== false) return 200;
  if (["invalid_request", "unsupported_source", "unsupported_operation"].includes(result.status)) return 422;
  if (result.status === "connection_required" || result.status === "auth_required") return 401;
  if (result.status === "rate_limited") return 429;
  if (result.status === "provider_error") return 502;
  return 400;
}

function sendRemoteMcpJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    ...remoteMcpHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...headers
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

async function sendDesignFont(req, res, url) {
  const fileName = decodeURIComponent(url.pathname.replace("/assets/fonts/", ""));
  const filePath = designFontPaths[fileName];
  if (!filePath) return sendNotFound(res, "DESIGN_FONT_NOT_FOUND");
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=86400",
      "content-length": body.length
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendNotFound(res, "DESIGN_FONT_NOT_FOUND");
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

function sendUpdateManifest(req, res, baseUrl) {
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  const body = `${JSON.stringify({
    schema_version: "agentrouter_update_manifest_v1",
    channel: "stable",
    installer_version: "0.2.0",
    skill_version: "0.8.0",
    routing_policy_version: "external_information_first_v1",
    repository_access_required: false,
    remote_mcp_url: `${origin}/mcp`,
    skill_url: `${origin}/SKILL.md`,
    update_script_url: `${origin}/update.sh`,
    mcp: {
      package: "@agentrouternetwork/mcp",
      spec: "@agentrouternetwork/mcp@latest",
      command: "agentrouter-mcp",
      minimum_node_version: 18
    },
    preserves: [
      "wallet_files",
      "agentrouter_api_key",
      "custom_environment",
      "unrelated_mcp_servers"
    ]
  }, null, 2)}\n`;
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    "content-length": Buffer.byteLength(body)
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendUpdateScript(req, res, baseUrl) {
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  const body = `#!/usr/bin/env bash
set -euo pipefail

AGENT_ROUTER_URL="\${AGENT_ROUTER_URL:-${origin}}"
MANIFEST_URL="\${AGENT_ROUTER_URL%/}/agent-router/update-manifest.json"
CLAUDE_CONFIG="\${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CURSOR_CONFIG="\${CURSOR_MCP_CONFIG:-$HOME/.cursor/mcp.json}"
TARGETS="\${AGENTROUTER_SKILL_DIRS:-$HOME/.agents/skills/agentrouter:$HOME/.claude/skills/agentrouter:$HOME/.codex/skills/agentrouter}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

curl -fsSL "$MANIFEST_URL" -o "$tmp_dir/manifest.json"
MCP_SPEC="\${AGENTROUTER_MCP_PACKAGE:-$(MANIFEST_PATH="$tmp_dir/manifest.json" node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
const spec = String(manifest?.mcp?.spec || "");
if (!/^@agentrouternetwork\\/mcp@/.test(spec)) process.exit(2);
process.stdout.write(spec);
')}"
MCP_SPEC="\${MCP_SPEC:-@agentrouternetwork/mcp@latest}"
SKILL_URL="$(MANIFEST_PATH="$tmp_dir/manifest.json" node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
process.stdout.write(String(manifest.skill_url || ""));
')"

curl -fsSL "$SKILL_URL" -o "$tmp_dir/SKILL.md"
skill_count=0
IFS=":" read -r -a target_dirs <<< "$TARGETS"
for target_dir in "\${target_dirs[@]}"; do
  [ -d "$target_dir" ] || continue
  cp "$tmp_dir/SKILL.md" "$target_dir/SKILL.md"
  skill_count=$((skill_count + 1))
done
if [ "$skill_count" -eq 0 ]; then
  fallback_dir="$HOME/.agents/skills/agentrouter"
  mkdir -p "$fallback_dir"
  cp "$tmp_dir/SKILL.md" "$fallback_dir/SKILL.md"
  skill_count=1
fi

config_count=0
for config_path in "$CLAUDE_CONFIG" "$CURSOR_CONFIG"; do
  [ -f "$config_path" ] || continue
  if CONFIG_PATH="$config_path" OUT_PATH="$tmp_dir/config.json" MCP_SPEC="$MCP_SPEC" node <<'NODE'
const fs = require("fs");
const configPath = process.env.CONFIG_PATH;
const outPath = process.env.OUT_PATH;
const config = JSON.parse(fs.readFileSync(configPath, "utf8") || "{}");
const existing = config?.mcpServers?.AgentRouter;
if (!existing || typeof existing !== "object") process.exit(3);
const existingEnv = existing.env && typeof existing.env === "object" ? existing.env : {};
config.mcpServers.AgentRouter = {
  ...existing,
  command: "npx",
  args: ["-y", "--package", process.env.MCP_SPEC || "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
  env: existingEnv
};
fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + "\\n");
NODE
  then
    status=0
  else
    status=$?
  fi
  if [ "$status" -eq 3 ]; then
    continue
  fi
  if [ "$status" -ne 0 ]; then
    echo "Unable to update invalid MCP config: $config_path" >&2
    exit "$status"
  fi
  backup="$config_path.bak.$(date +%Y%m%d%H%M%S)"
  cp "$config_path" "$backup"
  cp "$tmp_dir/config.json" "$config_path"
  config_count=$((config_count + 1))
done

echo "AgentRouter updated. READY"
echo "Skill files updated: $skill_count"
echo "MCP client configs updated: $config_count"
echo "MCP package: $MCP_SPEC"
echo "Existing wallet files were not changed."
echo "API keys, custom AgentRouter environment values, and unrelated MCP servers were preserved."
echo "Restart or reload each updated AI client."
echo "Remote MCP: \${AGENT_ROUTER_URL%/}/mcp"
`;
  res.writeHead(200, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendInstallScript(req, res, baseUrl) {
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  const body = `#!/usr/bin/env bash
set -euo pipefail

AGENT_ROUTER_URL="\${AGENT_ROUTER_URL:-${origin}}"
SKILL_URL="\${AGENT_ROUTER_URL%/}/SKILL.md"
TARGETS="\${AGENTROUTER_SKILL_DIRS:-$HOME/.agents/skills/agentrouter:$HOME/.claude/skills/agentrouter:$HOME/.codex/skills/agentrouter}"
CLAUDE_CONFIG="\${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CURSOR_CONFIG="\${CURSOR_MCP_CONFIG:-$HOME/.cursor/mcp.json}"
CONFIGURE_CLAUDE_DESKTOP="\${AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP:-0}"
CONFIGURE_CURSOR="\${AGENTROUTER_CONFIGURE_CURSOR:-0}"

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
fi

if [ "$should_configure_claude" = "yes" ]; then
  mkdir -p "$(dirname "$CLAUDE_CONFIG")"
  if [ -f "$CLAUDE_CONFIG" ]; then
    cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  else
    printf '{}\n' > "$CLAUDE_CONFIG"
  fi

  AGENT_ROUTER_URL="$AGENT_ROUTER_URL" CONFIG_PATH="$CLAUDE_CONFIG" OUT_PATH="$config_tmp" node <<'NODE'
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
  args: ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
  env: {
    AGENT_ROUTER_URL: agentRouterUrl
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
fi

if [ "$should_configure_cursor" = "yes" ]; then
  mkdir -p "$(dirname "$CURSOR_CONFIG")"
  if [ -f "$CURSOR_CONFIG" ]; then
    cp "$CURSOR_CONFIG" "$CURSOR_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  else
    printf '{}\n' > "$CURSOR_CONFIG"
  fi

  AGENT_ROUTER_URL="$AGENT_ROUTER_URL" CONFIG_PATH="$CURSOR_CONFIG" OUT_PATH="$config_tmp" node <<'NODE'
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
  args: ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
  env: {
    AGENT_ROUTER_URL: agentRouterUrl
  }
};
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\\n");
NODE
  mv "$config_tmp" "$CURSOR_CONFIG"
  configured_cursor="yes"
fi

echo "AgentRouter skill installed."
if [ "$configured_claude" = "yes" ]; then
  echo "Claude Desktop MCP server configured."
fi
if [ "$configured_cursor" = "yes" ]; then
  echo "Cursor MCP server configured."
fi
echo "For paid hosted calls, create an AgentRouter API key at \${AGENT_ROUTER_URL%/}/account."
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

function buildAccountDashboard({ account, balance, ledger = [], apiKeys = [] }) {
  const since = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const recent = ledger.filter((entry) => new Date(entry.created_at).getTime() >= since);
  const paidCalls = recent.filter((entry) => entry.kind === "service_call");
  const spend = paidCalls.reduce((sum, entry) => sum + Math.abs(Number(entry.delta) || 0), 0);
  const topServiceCounts = new Map();
  for (const entry of paidCalls) {
    const serviceId = entry.service_id || "unknown_service";
    topServiceCounts.set(serviceId, (topServiceCounts.get(serviceId) || 0) + Math.abs(Number(entry.delta) || 0));
  }
  const topServices = [...topServiceCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([service_id, spend_credits]) => ({ service_id, spend_credits: Number(spend_credits.toFixed(6)) }));
  return {
    account: {
      account_id: account.account_id,
      user_profile: account.user_profile || {},
      max_price_per_call: accountSpendLimit(account),
      deposit_address: account.deposit_address || null
    },
    summary: {
      available_credits: balance,
      spend_30d: Number(spend.toFixed(6)),
      successful_paid_calls: paidCalls.length,
      active_api_keys: apiKeys.filter((key) => key.status === "active").length,
      connected_agents: apiKeys.filter((key) => key.status === "active" && key.auth_method === "device").length,
      developer_api_keys: apiKeys.filter((key) => key.status === "active" && key.auth_method !== "device").length,
      window_days: 30
    },
    api_keys: apiKeys,
    top_services: topServices,
    recent_activity: ledger.slice(0, 12)
  };
}

async function paidInvocationContext(req, baseUrl, store) {
  const consumerApiKey = creditApiKeyFromRequest(req);
  const creditIdentity = consumerApiKey ? await authenticateCreditRequest(store, req) : null;
  const paymentBackend = currentPaymentBackend();
  return {
    // Localhost may execute legacy local-payment backends, but credits are
    // authenticated server-side and must never be attempted without a key.
    invoke: (paymentBackend !== "credits" && localServerPaidInvocationsAllowed(baseUrl))
      || (paymentBackend === "credits" && Boolean(consumerApiKey)),
    consumerApiKey,
    ownerKey: creditIdentity?.account?.owner_key || ""
  };
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
      capability_packs: `${baseUrl}/agent-router/capability-packs`,
      feedback: `${baseUrl}/agent-router/feedback`,
      evidence: `${baseUrl}/agent-router/evidence`
    },
    services
  };
}

function requestPaymentRequired(result) {
  if (!result.ok && result.status !== "quote_blocked") return result;
  const response = {
    ...result,
    ok: false,
    status: result.status === "quote_blocked" ? "quote_blocked" : "payment_required",
    protocol: {
      protocol_version: "agent_router_request_v1",
      invocation_policy: "quote_only_no_server_side_payment"
    },
    next_step: result.status === "quote_blocked"
      ? "Increase the max_price budget or choose a lower-cost service."
      : paymentRequiredNextStep(result)
  };
  return response.status === "payment_required" && isAgentRouterCreditsQuote(result)
    ? agentRouterConnectionRequired(response)
    : response;
}

function paymentRequiredNextStep(result) {
  if (isAgentRouterCreditsQuote(result)) return "Call agentrouter_connect to approve this AI client in the browser, then retry automatically.";
  return "Use local MCP with a payment-capable backend, or call the provider endpoint with a valid x402/Arc payment proof.";
}

function paymentBoundaryStatusCode(payload) {
  if (payload?.status === "invalid_request") return 422;
  if (payload?.status === "connection_required") return 401;
  if (payload?.status === "payment_required" || payload?.status === "quote_blocked") return 402;
  if (payload?.status === "no_data_returned") {
    const statuses = (payload.results || []).map((result) => result?.status);
    if (statuses.some((status) => ["unsupported_source", "unsupported_operation", "invalid_request"].includes(status))) return 422;
    if (statuses.some((status) => status === "rate_limited")) return 429;
    if (statuses.some((status) => status === "provider_error")) return 502;
  }
  return 200;
}

function routePaymentRequired(resolved, body) {
  if (resolved.status === "needs_clarification" || resolved.status === "no_match") return resolved;
  const response = {
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
  return currentPaymentBackend() === "credits"
    ? agentRouterConnectionRequired(response)
    : response;
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
  const body = {
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
  };
  const connectionRequired = allowed && currentPaymentBackend() === "credits";
  return {
    statusCode: connectionRequired ? 401 : 402,
    body: connectionRequired
      ? agentRouterConnectionRequired(body)
      : body
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

function deviceConnectHtml({ authorization, user = null, error = "" }) {
  const clientName = escapeHtml(authorization?.client_name || "AI agent");
  const title = authorization ? `Connect ${clientName}` : "Connection unavailable";
  const code = authorization?.user_code || "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · AgentRouter</title>
  <style>
    /* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V3 */
    /* Hallmark · macrostructure: Focused Approval · tone: quiet confidence · anchor hue: forest */
    :root { color-scheme:light; --font-body:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --ink:#151719; --muted:#6f7479; --line:#d8dcdf; --panel:#f3f4f2; --surface:#fff; --accent:#323842; --success:#16794b; --success-soft:#eaf7f0; --success-line:#a8ddc1; --success-halo:rgba(22,121,75,.05); --success-dot-halo:rgba(22,121,75,.12); --focus:#2368d1; --error:#8c1d18; --shadow:rgba(22,27,29,.08); --radius-sm:8px; --radius-md:10px; --radius-lg:14px; }
    * { box-sizing:border-box; }
    html, body { overflow-x:clip; }
    body { margin:0; min-height:100svh; display:grid; place-items:center; padding:24px; background:var(--panel); color:var(--ink); font-family:var(--font-body); }
    main { width:min(100%,520px); padding:34px; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--surface); box-shadow:0 18px 55px var(--shadow); }
    .brand { display:flex; align-items:center; gap:10px; margin-bottom:34px; font-weight:800; letter-spacing:-.02em; }
    .mark { display:grid; place-items:center; width:30px; height:30px; border-radius:var(--radius-sm); color:var(--surface); background:var(--accent); }
    h1 { min-width:0; margin:0; font-size:28px; letter-spacing:-.04em; overflow-wrap:anywhere; }
    p { color:var(--muted); line-height:1.55; }
    .code { margin:24px 0; padding:18px; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--panel); text-align:center; font:700 24px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; }
    .identity { margin:20px 0; padding:12px 14px; border-left:3px solid var(--accent); background:var(--panel); font-size:14px; }
    button { width:100%; min-height:46px; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--surface); font:700 14px var(--font-body); white-space:nowrap; cursor:pointer; }
    button:hover:not(:disabled) { background:var(--ink); }
    button:active:not(:disabled) { transform:translateY(1px); }
    button:focus-visible { outline:3px solid var(--focus); outline-offset:3px; }
    button:disabled { opacity:.55; cursor:wait; }
    .warning { font-size:12px; }
    .error { color:var(--error); }
    #result { margin-top:16px; font-size:14px; font-weight:650; }
    [hidden] { display:none !important; }
    .success-panel { text-align:center; outline:none; }
    .success-icon { display:grid; place-items:center; width:72px; height:72px; margin:4px auto 22px; border:1px solid var(--success-line); border-radius:50%; background:var(--success-soft); color:var(--success); font-size:38px; font-weight:850; box-shadow:0 0 0 10px var(--success-halo); }
    .success-kicker { display:inline-flex; align-items:center; gap:7px; margin-bottom:14px; color:var(--success); font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .success-kicker::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--success); box-shadow:0 0 0 4px var(--success-dot-halo); }
    .success-panel h1 { font-size:32px; }
    .success-panel > p { margin:12px auto 24px; max-width:390px; }
    .success-next { padding:18px; border:1px solid var(--success-line); border-radius:var(--radius-md); background:var(--success-soft); text-align:left; }
    .success-next span { display:block; margin-bottom:6px; color:var(--success); font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .success-next strong { display:block; color:var(--ink); font-size:15px; line-height:1.45; }
    .success-footnote { margin:18px 0 0; font-size:12px; }
    @media (max-width:375px) { body { padding:12px; } main { padding:26px 20px; } .brand { margin-bottom:28px; } .success-panel h1 { font-size:28px; } }
    @media (prefers-reduced-motion:reduce) { button:active:not(:disabled) { transform:none; } }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark">AR</span><span>AgentRouter</span></div>
    ${authorization ? `
      <section id="request-panel">
        <h1>${title}</h1>
        <p>This allows the agent to use your prepaid AgentRouter credits. It cannot see provider credentials or your GitHub password.</p>
        <div class="code">${escapeHtml(code)}</div>
        <div class="identity">Signed in as <strong>${escapeHtml(user?.name || user?.handle || "AgentRouter user")}</strong></div>
        <button id="approve" type="button">Approve connection</button>
        <p class="warning">Only approve if you started this connection from your own AI client.</p>
        <div id="result" role="status" aria-live="polite"></div>
      </section>
      <section id="success-panel" class="success-panel" hidden role="status" aria-live="polite" aria-labelledby="success-title" tabindex="-1">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-kicker">Authorization complete</div>
        <h1 id="success-title">Connection approved</h1>
        <p><strong>${clientName} is now connected.</strong> Your AgentRouter credentials remain private on this device.</p>
        <div class="success-next">
          <span>What happens next</span>
          <strong>Your AI client will continue automatically.</strong>
        </div>
        <p class="success-footnote">You can safely close this tab and return to ${clientName}.</p>
      </section>
      <script>
        document.getElementById("approve").addEventListener("click", async function () {
          this.disabled = true;
          this.textContent = "Approving…";
          const result = document.getElementById("result");
          result.className = "";
          result.textContent = "Approving connection…";
          try {
            const response = await fetch("/auth/device/approve", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ user_code: ${JSON.stringify(code)} })
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error?.message || payload.error || "Approval failed");
            document.getElementById("request-panel").hidden = true;
            const successPanel = document.getElementById("success-panel");
            successPanel.hidden = false;
            document.title = "Connection approved · AgentRouter";
            successPanel.focus();
          } catch (error) {
            result.className = "error";
            result.textContent = error.message;
            this.disabled = false;
            this.textContent = "Try again";
          }
        });
      </script>` : `<h1>${title}</h1><p class="error">${escapeHtml(error || "This connection request is unavailable.")}</p>`}
  </main>
</body>
</html>`;
}

function loginHtml({ auth, error = "", returnTo = "/" }) {
  const providers = auth.providers || [];
  const providerCards = providers.map((provider) => {
    const icon = provider.id === "github"
      ? `<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.58-.3-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.07.74.8 1.19 1.83 1.19 3.09 0 4.42-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>`
      : "";
    const body = provider.configured
      ? `<a class="login-provider" href="/auth/${provider.id}/start?return_to=${escapeHtml(encodeURIComponent(safeReturnTo(returnTo)))}">${icon}<span>Continue with ${escapeHtml(provider.label)}</span></a>`
      : `<div class="login-provider disabled">
          <strong>${icon}${escapeHtml(provider.label)}</strong>
          <span>Set ${escapeHtml(provider.client_id_env)} and ${escapeHtml(provider.client_secret_env)}.</span>
        </div>`;
    return body;
  }).join("");
  const devLogin = auth.devLogin
    ? `<form method="POST" action="/auth/dev/start?return_to=${escapeHtml(encodeURIComponent(safeReturnTo(returnTo)))}">
        <button class="login-provider local-login" type="submit">Continue locally</button>
        <small>Local development only. This entry is unavailable on public deployments.</small>
      </form>`
    : "";
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
    :root { --ink:#17191b; --muted:#6c7177; --line:#d9dcdf; --panel:#f3f4f4; --card:#fff; --accent:#111827; --cyan:#bff8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--panel); }
    a { color:inherit; text-decoration:none; }
    main { min-height:100svh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; }
    .login-shell { width:100%; max-width:896px; }
    .login-card { width:100%; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); overflow:hidden; min-height:540px; border:1px solid var(--line); border-radius:14px; background:var(--card); box-shadow:0 18px 55px rgba(22,27,29,.08); }
    .login-panel { min-width:0; display:flex; flex-direction:column; justify-content:center; padding:48px; }
    .home-link { align-self:flex-start; display:inline-flex; align-items:center; gap:8px; margin-bottom:52px; color:var(--muted); font-size:13px; font-weight:700; }
    .home-link::before { content:"←"; transition:transform .18s ease; }
    .home-link:hover::before { transform:translateX(-3px); }
    .login-heading { display:grid; gap:9px; text-align:center; }
    h1 { margin:0; font-size:28px; line-height:1.15; letter-spacing:-.035em; }
    p { margin:0; color:var(--muted); font-size:14px; line-height:1.55; }
    .login-options { display:grid; gap:10px; margin-top:28px; }
    .login-provider { width:100%; min-height:46px; border:1px solid var(--line); border-radius:8px; background:#fff; display:flex; align-items:center; justify-content:center; gap:10px; padding:0 16px; color:var(--ink); font:inherit; font-size:14px; font-weight:720; cursor:pointer; transition:border-color .18s ease, background .18s ease, transform .18s ease; }
    .login-provider svg { width:18px; height:18px; flex:none; }
    .login-provider:hover { border-color:#aeb4b8; background:#fafafa; transform:translateY(-1px); }
    .login-provider.disabled { min-height:64px; justify-content:space-between; gap:16px; color:var(--muted); background:var(--panel); cursor:not-allowed; transform:none; }
    .login-provider.disabled strong { display:flex; align-items:center; gap:9px; color:var(--ink); }
    .login-provider.disabled span { max-width:190px; overflow-wrap:anywhere; font-size:11px; line-height:1.35; text-align:right; }
    .login-options form { display:grid; gap:8px; }
    .login-options form small { color:var(--muted); font-size:12px; line-height:1.4; }
    .local-login { background:var(--accent); border-color:var(--accent); color:#fff; }
    .local-login:hover { background:#272d38; border-color:#272d38; }
    .login-error { margin-top:20px; border:1px solid #efb8b5; border-radius:8px; background:#fff6f6; color:#8c1d18; padding:12px 14px; font-size:13px; line-height:1.4; }
    .login-user { margin-top:20px; border:1px solid var(--line); border-radius:9px; background:var(--panel); padding:12px; display:grid; grid-template-columns:36px minmax(0,1fr) auto; gap:10px; align-items:center; }
    .login-user img { width:36px; height:36px; border-radius:50%; }
    .login-user strong, .login-user span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .login-user span { color:var(--muted); font-size:12px; margin-top:2px; }
    .login-user a { font-size:11px; font-weight:800; text-transform:uppercase; }
    .privacy-note { margin-top:24px; padding:0 16px; color:var(--muted); font-size:11px; line-height:1.5; text-align:center; }
    .login-visual { position:relative; isolation:isolate; overflow:hidden; display:flex; flex-direction:column; justify-content:space-between; min-height:540px; padding:42px; color:#f8fafc; background:#12161b; }
    .login-visual::before { content:""; position:absolute; z-index:-2; inset:0; background:radial-gradient(circle at 78% 18%, rgba(191,248,255,.25), transparent 30%), radial-gradient(circle at 16% 76%, rgba(125,211,252,.16), transparent 32%); }
    .login-visual::after { content:""; position:absolute; z-index:-1; inset:-40%; background-image:linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px); background-size:42px 42px; transform:rotate(-8deg); }
    .visual-brand { display:flex; align-items:center; gap:10px; font-size:16px; font-weight:820; letter-spacing:-.02em; }
    .brand-mark { width:30px; height:30px; display:grid; place-items:center; border-radius:8px; color:#11161a; background:var(--cyan); font-size:14px; }
    .network { position:relative; align-self:center; width:260px; height:190px; }
    .network i { position:absolute; width:12px; height:12px; border:2px solid rgba(220,252,255,.9); border-radius:50%; background:#12161b; box-shadow:0 0 0 8px rgba(191,248,255,.06); }
    .network i:nth-child(1) { left:18px; top:84px; }
    .network i:nth-child(2) { left:122px; top:24px; width:18px; height:18px; background:var(--cyan); border-color:var(--cyan); }
    .network i:nth-child(3) { right:16px; top:82px; }
    .network i:nth-child(4) { left:122px; bottom:12px; }
    .network span { position:absolute; height:1px; width:115px; left:34px; top:92px; background:linear-gradient(90deg, rgba(191,248,255,.25), rgba(191,248,255,.9)); transform-origin:left center; }
    .network span:nth-of-type(1) { transform:rotate(-30deg); }
    .network span:nth-of-type(2) { transform:rotate(30deg); }
    .network span:nth-of-type(3) { left:137px; top:36px; transform:rotate(30deg); }
    .network span:nth-of-type(4) { left:137px; top:145px; transform:rotate(-30deg); }
    .visual-copy { display:grid; gap:10px; max-width:300px; }
    .visual-copy strong { font-size:30px; line-height:1.08; letter-spacing:-.045em; }
    .visual-copy span { color:#aeb9c2; font-size:13px; line-height:1.55; }
    @media (max-width:760px) {
      main { padding:24px; }
      .login-card { display:block; min-height:0; }
      .login-panel { padding:32px 28px; }
      .home-link { margin-bottom:42px; }
      .login-visual { display:none; }
    }
    @media (max-width:420px) {
      main { padding:16px; }
      .login-panel { padding:28px 20px; }
      .login-provider.disabled { display:grid; justify-content:stretch; padding:12px 14px; }
      .login-provider.disabled span { max-width:none; text-align:left; }
    }
  </style>
</head>
<body>
  <main>
    <div class="login-shell">
      <section class="login-card">
        <div class="login-panel">
          <a class="home-link" href="/">Back to AgentRouter</a>
          <div class="login-heading">
            <h1>Welcome back</h1>
            <p>Sign in to continue to your AgentRouter account.</p>
          </div>
          ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
          ${signedIn}
          <div class="login-options">${providerCards}${devLogin}</div>
          <p class="privacy-note">Authentication is handled by GitHub. AgentRouter never receives your GitHub password.</p>
        </div>
        <aside class="login-visual" aria-label="AgentRouter data routing network">
          <a class="visual-brand" href="/"><span class="brand-mark">AR</span>AgentRouter</a>
          <div class="network" aria-hidden="true"><i></i><i></i><i></i><i></i><span></span><span></span><span></span><span></span></div>
          <div class="visual-copy"><strong>One question.<br />The right data route.</strong><span>Discover and access trusted APIs across markets, social platforms, public datasets, and specialized providers.</span></div>
        </aside>
      </section>
    </div>
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
  const feedbackVersions = new Set([
    "agent_service_feedback_v1",
    "agent_external_api_feedback_v1",
    "agent_local_connector_feedback_v1",
    "agent_consumer_feedback_v1"
  ]);
  const events = (store.feedbackEvents || []).filter((event) => feedbackVersions.has(event.event_version));
  return events
    .filter((event) => !serviceId || event.service_id === serviceId)
    .filter((event) => !requestId || event.request_id === requestId);
}

function publicFeedbackEvent(event = {}) {
  const feedback = event.consumer_feedback;
  return {
    event_version: event.event_version,
    request_id: event.request_id,
    service_id: event.service_id,
    provider_id: event.provider_id,
    status: event.status,
    schema_valid: event.schema_valid,
    verification: event.verification,
    latency_ms: event.latency_ms,
    consumer_rating: event.consumer_rating,
    consumer_feedback: feedback ? {
      intent_fit: feedback.intent_fit,
      answer_useful: feedback.answer_useful,
      data_quality_score: feedback.data_quality_score,
      used_in_final_answer: feedback.used_in_final_answer,
      confidence: feedback.confidence,
      consumer_score: feedback.consumer_score
    } : null,
    trust_anchor: event.consumer_feedback_trust_anchor || event.trust_anchor || null,
    consumer_feedback_arc_anchor: event.consumer_feedback_arc_anchor || event.arc_anchor || null,
    consumer_feedback_erc8004: event.consumer_feedback_erc8004 || event.erc8004 || null,
    created_at: event.created_at,
    updated_at: event.updated_at || null
  };
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

async function recordConsumerFeedbackAnchor(store, feedbackResult, baseUrl = "") {
  const record = store.services.get(feedbackResult.service_id);
  const invocation = [...(store.feedbackEvents || [])].reverse().find((event) =>
    event.request_id === feedbackResult.request_id && event.service_id === feedbackResult.service_id
  );
  const providerId = record?.manifest?.provider?.provider_id || feedbackResult.provider_id || invocation?.provider_id || "";
  const feedbackManifest = record?.manifest
    || vendorIdentityManifest(store, providerId, baseUrl)
    || (providerId === "agentrouter_network" ? platformIdentityManifest(store) : null);
  const anchor = {
    status: "not_used",
    recorded_offchain: true,
    superseded_by: "ERC-8004",
    reason: "ERC-8004 is the single public onchain record for consumer feedback."
  };
  const erc8004 = createConsumerRequiredErc8004Feedback({ feedbackResult, manifest: feedbackManifest, providerId, baseUrl });
  const trustAnchor = {
    trust_anchor_version: "agent_router_trust_anchor_v1",
    primary_standard: erc8004.status === "not_configured" ? "offchain_feedback" : "ERC-8004",
    state: erc8004.status === "not_configured" ? "offchain_recorded" : "onchain_pending",
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

function createConsumerRequiredErc8004Feedback({ feedbackResult, manifest, providerId, baseUrl = "" }) {
  const descriptor = createErc8004FeedbackDescriptor({
    requestId: feedbackResult.request_id,
    serviceId: feedbackResult.service_id,
    providerId,
    manifest,
    feedback: feedbackResult.consumer_feedback,
    baseUrl
  });
  if (!descriptor.registry_address || !descriptor.agent_id) {
    return {
      ...descriptor,
      status: "not_configured",
      recorded_offchain: true,
      error: descriptor.agent_id
        ? "ERC-8004 Reputation Registry is not configured."
        : "ERC-8004 agent_id is missing for the active settlement chain."
    };
  }
  return {
    ...descriptor,
    status: "consumer_submission_required",
    submitter: "consumer_wallet",
    reason: "ERC-8004 Reputation feedback must be submitted by the consumer wallet, not the provider/operator wallet.",
    submit_endpoint: "/agent-router/feedback/erc8004",
    feedback_uri: `${String(baseUrl || "").replace(/\/$/, "")}/agent-router/feedback?request_id=${encodeURIComponent(feedbackResult.request_id)}`
  };
}

function platformIdentityManifest(store) {
  const chain = settlementChain();
  const identity = store.erc8004PlatformIdentities?.get(chain.network) || null;
  return {
    manifest_type: "agentrouter_platform_identity",
    service_id: "agentrouter_external_api_platform",
    version: "1.0.0",
    title: "AgentRouter External API Platform",
    description_for_agent: "AgentRouter-operated identity for read-only external API connectors and their consumer feedback.",
    image: "",
    status: "published",
    provider: { provider_id: "agentrouter_network" },
    capabilities: ["external_api_query", "consumer_feedback"],
    pricing: { amount: "0", currency: "USDC", protocol: "none" },
    registration: identity ? { erc8004: identity } : {}
  };
}

function vendorIdentityManifest(store, providerId, baseUrl = "") {
  const records = [...store.services.values()].filter((record) =>
    record.manifest?.provider?.provider_id === providerId
  );
  const external = getExternalApiCatalog(store, "").find((item) => item.provider_id === providerId) || null;
  if (!records.length && !external) return null;
  const chain = settlementChain();
  const identity = store.erc8004VendorIdentities?.get(vendorIdentityStoreKey(providerId, chain.network)) || null;
  const provider = store.providers.get(providerId) || {};
  const services = records.map((record) => ({
    service_id: record.manifest.service_id,
    title: record.manifest.title,
    description_for_agent: record.manifest.description_for_agent,
    capabilities: record.manifest.capabilities || [],
    pricing: record.manifest.pricing || {},
    endpoint: `${String(baseUrl).replace(/\/$/, "")}/agent-router/service?service_id=${encodeURIComponent(record.manifest.service_id)}`
  }));
  if (external) {
    services.push({
      service_id: external.service_id,
      title: external.display_title || external.title,
      description_for_agent: external.description_for_agent,
      capabilities: external.capabilities || [],
      pricing: { amount: String(external.agentrouter_price || 0), currency: "USDC", protocol: "none" },
      endpoint: `${String(baseUrl).replace(/\/$/, "")}/agent-router/service?service_id=${encodeURIComponent(external.service_id)}`
    });
  }
  return {
    manifest_type: "agentrouter_vendor_identity",
    service_id: `vendor:${providerId}`,
    version: "1.0.0",
    title: provider.provider_name || external?.display_title || external?.title || providerId,
    description_for_agent: `ERC-8004 identity for ${providerId} services routed through AgentRouter.`,
    status: "published",
    provider: { ...provider, provider_id: providerId },
    capabilities: [...new Set(services.flatMap((service) => service.capabilities || []))],
    services,
    pricing: { amount: "0", currency: "USDC", protocol: "none" },
    registration: identity ? { erc8004: identity } : {}
  };
}

function listRegisterableVendors(store, auth) {
  const actorKey = authUserKey(auth.user);
  const providerIds = new Set([...store.services.values()]
    .filter((record) => auth.user?.role === "admin" || record.manifest?.registration?.owner?.user_key === actorKey)
    .map((record) => record.manifest?.provider?.provider_id)
    .filter(Boolean));
  if (platformOperatorMatches(auth)) {
    for (const source of getExternalApiCatalog(store, actorKey)) {
      if (source.implementation_status === "available" && source.provider_id) providerIds.add(source.provider_id);
    }
  }
  const chain = settlementChain();
  return [...providerIds].sort().map((providerId) => {
    const manifest = vendorIdentityManifest(store, providerId, "");
    const identity = store.erc8004VendorIdentities?.get(vendorIdentityStoreKey(providerId, chain.network)) || null;
    return {
      provider_id: providerId,
      title: manifest?.title || providerId,
      service_count: manifest?.services?.length || 0,
      chain: chain.network,
      agent_id: identity?.agent_id || null,
      identity,
      registration_endpoint: `/agent-router/erc8004/vendors/${encodeURIComponent(providerId)}/registration`
    };
  });
}

async function recordClientSubmittedErc8004Feedback(store, body = {}) {
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
  const terminalFailureStatuses = new Set(["sponsorship_unavailable", "sponsorship_failed", "submit_failed"]);
  if (erc8004.status !== "submitted" && !terminalFailureStatuses.has(erc8004.status)) {
    return {
      ok: false,
      status: "invalid_erc8004_feedback_status",
      error: "erc8004.status must be submitted or a supported terminal failure state."
    };
  }
  if (erc8004.status === "submitted" && !/^0x[0-9a-fA-F]{64}$/.test(String(erc8004.tx_hash || ""))) {
    return { ok: false, status: "erc8004_feedback_not_submitted", error: "A submitted feedback transaction must include tx_hash." };
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
  const pending = event.consumer_feedback_erc8004;
  if (
    pending?.status !== "consumer_submission_required" ||
    !pending.chain_id ||
    !pending.registry_address ||
    !pending.agent_id ||
    !pending.feedback_hash
  ) {
    return {
      ok: false,
      status: "erc8004_feedback_not_prepared",
      error: "No verifiable ERC-8004 feedback request exists for this request_id."
    };
  }
  if (
    String(erc8004.agent_id || "") !== String(pending.agent_id) ||
    String(erc8004.feedback_hash || "").toLowerCase() !== String(pending.feedback_hash).toLowerCase()
  ) {
    return { ok: false, status: "erc8004_feedback_descriptor_mismatch", error: "ERC-8004 result does not match the pending feedback descriptor." };
  }
  let verified;
  if (terminalFailureStatuses.has(erc8004.status)) {
    verified = {
      ...pending,
      status: erc8004.status,
      recorded_offchain: true,
      error: String(erc8004.error || "ERC-8004 feedback submission failed."),
      gas_sponsorship: erc8004.gas_sponsorship || null
    };
  } else if (process.env.ADN_ERC8004_MODE === "mock" && erc8004.mode === "mock") {
    verified = {
      ...pending,
      status: "submitted",
      mode: "mock",
      tx_hash: erc8004.tx_hash,
      block_number: String(erc8004.block_number || "0"),
      feedback_account: erc8004.feedback_account || null,
      gas_sponsorship: erc8004.gas_sponsorship || null
    };
  } else {
    try {
      verified = await verifyErc8004FeedbackTransaction({
        txHash: erc8004.tx_hash,
        expected: {
          chainId: pending.chain_id,
          registryAddress: pending.registry_address,
          agentId: pending.agent_id,
          feedbackHash: pending.feedback_hash,
          value: pending.value,
          valueDecimals: pending.value_decimals,
          tag1: pending.tag1,
          tag2: pending.tag2,
          endpoint: pending.endpoint,
          feedbackUri: pending.feedback_uri
        }
      });
      verified.gas_sponsorship = erc8004.gas_sponsorship || null;
    } catch (error) {
      return {
        ok: false,
        status: "erc8004_feedback_verification_failed",
        code: error.code || "ERC8004_VERIFICATION_FAILED",
        error: error.shortMessage || error.message
      };
    }
  }
  event.consumer_feedback_erc8004 = verified;
  event.consumer_feedback_trust_anchor = {
    ...(event.consumer_feedback_trust_anchor || {}),
    primary_standard: "ERC-8004",
    state: verified.status === "submitted" ? "onchain_submitted" : "onchain_failed",
    erc8004: verified,
    updated_at: new Date().toISOString()
  };
  const globalConsumer = [...(store.feedbackEvents || [])].reverse().find((item) =>
    item.request_id === requestId &&
    item.service_id === serviceId &&
    item.event_version === "agent_consumer_feedback_v1"
  );
  if (globalConsumer) {
    globalConsumer.erc8004 = verified;
    globalConsumer.trust_anchor = event.consumer_feedback_trust_anchor;
  }
  await writePersistentServiceEvent({
    eventType: "consumer_feedback_erc8004_client",
    serviceId,
    requestId,
    event: {
      event_version: "agent_consumer_feedback_erc8004_client_v1",
      service_id: serviceId,
      provider_id: record?.manifest?.provider?.provider_id || erc8004.provider_id || null,
      request_id: requestId,
      erc8004: verified,
      created_at: new Date().toISOString()
    }
  });
  return {
    ok: true,
    status: verified.status === "submitted" ? "erc8004_feedback_attached" : "erc8004_feedback_failure_attached",
    service_id: serviceId,
    request_id: requestId,
    erc8004: verified,
    trust_anchor: event.consumer_feedback_trust_anchor
  };
}

async function relayBscPaymasterRequest(body = {}, store) {
  const method = String(body.method || "");
  if (!new Set(["pm_isSponsorable", "eth_sendRawTransaction"]).has(method)) {
    return { ok: false, statusCode: 422, status: "invalid_paymaster_method", error: "Only BNB Paymaster sponsorship checks and signed transaction submission are allowed." };
  }
  if (!Array.isArray(body.params)) {
    return { ok: false, statusCode: 422, status: "invalid_paymaster_params", error: "Paymaster params must be an array." };
  }
  const serviceId = body.service_id || resolveFeedbackServiceId(store, body.request_id);
  const feedbackEvent = [...(store.services.get(serviceId)?.feedback_events || [])]
    .reverse()
    .find((event) => event.request_id === body.request_id);
  const pending = feedbackEvent?.consumer_feedback_erc8004;
  if (pending?.status !== "consumer_submission_required") {
    return { ok: false, statusCode: 422, status: "feedback_not_pending", error: "A pending ERC-8004 feedback descriptor is required for Paymaster sponsorship." };
  }
  const validationError = validateBscPaymasterParams(method, body.params, pending);
  if (validationError) {
    return { ok: false, statusCode: 422, status: "invalid_paymaster_transaction", error: validationError };
  }
  const paymasterUrl = String(process.env.ADN_BSC_PAYMASTER_URL || "").trim();
  if (!paymasterUrl) {
    return { ok: false, statusCode: 503, status: "paymaster_not_configured", error: "ADN_BSC_PAYMASTER_URL is not configured on the AgentRouter server." };
  }
  try {
    const response = await fetch(paymasterUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: body.params }),
      signal: AbortSignal.timeout(Number(process.env.ADN_BSC_PAYMASTER_TIMEOUT_MS || 15000))
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
      return {
        ok: false,
        statusCode: response.ok ? 502 : response.status,
        status: "paymaster_request_failed",
        error: payload?.error?.message || `BNB Paymaster returned HTTP ${response.status}.`
      };
    }
    return { ok: true, statusCode: 200, result: payload?.result };
  } catch (error) {
    return { ok: false, statusCode: 502, status: "paymaster_unavailable", error: error.message };
  }
}

function validateBscPaymasterParams(method, params, pending) {
  const chain = settlementChain();
  if (![56, 97].includes(chain.id)) return "The active settlement chain is not BNB Smart Chain.";
  let transaction;
  try {
    transaction = method === "pm_isSponsorable" ? params[0] : parseTransaction(params[0]);
  } catch {
    return "The signed Paymaster transaction cannot be decoded.";
  }
  if (!transaction || String(transaction.to || "").toLowerCase() !== String(pending.registry_address || erc8004Registries().reputationRegistry || "").toLowerCase()) {
    return "The Paymaster transaction must target the configured ERC-8004 Reputation Registry.";
  }
  try {
    if (BigInt(transaction.value || 0) !== 0n) return "ERC-8004 feedback must not transfer native currency.";
  } catch {
    return "The Paymaster transaction value is invalid.";
  }
  if (method === "eth_sendRawTransaction") {
    if (Number(transaction.chainId) !== chain.id) return "The signed transaction chain does not match the active BNB chain.";
    try {
      if (BigInt(transaction.gasPrice ?? -1) !== 0n) return "A sponsored feedback transaction must use zero gas price.";
    } catch {
      return "The sponsored transaction gas price is invalid.";
    }
  }
  try {
    const decoded = decodeFunctionData({ abi: ERC8004_REPUTATION_ABI, data: transaction.data });
    if (decoded.functionName !== "giveFeedback") return "Only ERC-8004 giveFeedback calls can be sponsored.";
    const expectedArgs = [
      String(pending.agent_id),
      String(pending.value),
      String(pending.value_decimals),
      pending.tag1,
      pending.tag2,
      pending.endpoint,
      pending.feedback_uri,
      String(pending.feedback_hash).toLowerCase()
    ];
    const actualArgs = decoded.args.map((value) => typeof value === "bigint" ? value.toString() : String(value));
    actualArgs[actualArgs.length - 1] = actualArgs.at(-1).toLowerCase();
    if (actualArgs.some((value, index) => value !== expectedArgs[index])) {
      return "The Paymaster call does not match the pending AgentRouter feedback descriptor.";
    }
  } catch {
    return "The Paymaster transaction is not a valid ERC-8004 giveFeedback call.";
  }
  return null;
}

async function recordQuoteFeedback(store, body = {}, {
  actorKey = "",
  requireIssuedQuote = false
} = {}) {
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
  const existing = (store.quoteFeedbackEvents || []).find((item) =>
    item.quote_id === quoteId && (!actorKey || item.actor_key === actorKey)
  );
  if (existing) {
    const sameFeedback = existing.decision === decision
      && existing.reason_code === reasonCode
      && existing.reason === reason;
    return sameFeedback
      ? { ok: true, status: "quote_feedback_already_recorded", event: existing }
      : {
          ok: false,
          statusCode: 409,
          status: "quote_feedback_conflict",
          error: "Different feedback has already been recorded for this quote."
        };
  }
  const issuedQuote = store.issuedQuotes?.get(quoteId);
  if (requireIssuedQuote && !issuedQuote) {
    return {
      ok: false,
      statusCode: 404,
      status: "quote_not_found",
      error: "No unexpired AgentRouter quote exists for this quote_id."
    };
  }
  if (issuedQuote && Number(issuedQuote.expires_at || 0) <= Date.now()) {
    store.issuedQuotes.delete(quoteId);
    return {
      ok: false,
      statusCode: 410,
      status: "quote_expired",
      error: "This AgentRouter quote has expired."
    };
  }
  if (issuedQuote?.service_id && body.service_id && issuedQuote.service_id !== body.service_id) {
    return {
      ok: false,
      statusCode: 422,
      status: "quote_service_mismatch",
      error: "service_id does not match the issued quote."
    };
  }
  if (issuedQuote?.actor_key && actorKey && issuedQuote.actor_key !== actorKey) {
    return {
      ok: false,
      statusCode: 403,
      status: "quote_actor_mismatch",
      error: "Only the caller that requested this quote may submit its feedback."
    };
  }
  const event = {
    event_version: "agentrouter_quote_feedback_v1",
    quote_id: quoteId,
    service_id: issuedQuote?.service_id || body.service_id || null,
    consumer_id: actorKey || body.consumer_id || "main_agent",
    actor_key: actorKey || undefined,
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
  await hydrateSocialConnections(server.store);
  await hydratePublicApiCoverage(server.store);

  const automation = publicApiAutomationOptions();
  const publicApiBoot = await bootstrapPublicApiPipeline(server.store, {
    ...server.publicApiPipelineOptions,
    ...automation,
    // The catalog was hydrated just above; avoid a duplicate database read.
    hydrate: async () => publicApiCoverageReport(server.store)
  });
  server.publicApiPipelineBoot = publicApiBoot;
  if (publicApiBoot.synced) server.publicApiLastCatalogSyncAt = Date.now();
  if (!publicApiBoot.ok) {
    console.warn("[public-api-pipeline] bootstrap deferred", JSON.stringify(publicApiBoot.error));
  }
  schedulePublicApiRefresh(server, automation);
}

export function publicApiAutomationOptions(env = process.env) {
  return {
    autoSync: env.ADN_PUBLIC_API_AUTOSYNC !== "0",
    autoValidate: env.ADN_PUBLIC_API_AUTOVALIDATE !== "0",
    validationLimit: Math.max(1, Math.min(100, Number(env.ADN_PUBLIC_API_AUTOVALIDATE_LIMIT) || 50)),
    // Some local/corporate development networks map public DNS through the
    // RFC 2544 synthetic range. Keep this explicit so it never weakens the
    // normal production SSRF boundary.
    allowSyntheticProxyAddresses: env.ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES === "1",
    refreshIntervalMs: Math.max(0, Number(env.ADN_PUBLIC_API_REFRESH_INTERVAL_MS) || 5 * 60 * 1000),
    catalogRefreshIntervalMs: Math.max(0, Number(env.ADN_PUBLIC_API_CATALOG_REFRESH_INTERVAL_MS) || 24 * 60 * 60 * 1000)
  };
}

function schedulePublicApiRefresh(server, automation) {
  if (server.publicApiPipelineTimer || automation.refreshIntervalMs <= 0) return;
  const refresh = async () => {
    const now = Date.now();
    const forceSync = !server.publicApiLastCatalogSyncAt
      || now - server.publicApiLastCatalogSyncAt >= automation.catalogRefreshIntervalMs;
    const result = await bootstrapPublicApiPipeline(server.store, {
      ...server.publicApiPipelineOptions,
      ...automation,
      forceSync
    });
    if (result.synced) server.publicApiLastCatalogSyncAt = now;
    if (!result.ok) console.warn("[public-api-pipeline] scheduled refresh deferred", JSON.stringify(result.error));
  };
  server.publicApiPipelineTimer = setInterval(() => {
    void refresh();
  }, automation.refreshIntervalMs);
  server.publicApiPipelineTimer.unref?.();
  server.once("close", () => clearInterval(server.publicApiPipelineTimer));
}

function publicApiPipelineProgress(store) {
  const candidates = [...(store.publicApiCatalog?.values?.() || [])]
    .filter((candidate) => candidate.catalog_presence !== "removed");
  const job = store.publicApiPipelineJob || null;
  return {
    status: job?.status || "idle",
    started_at: job?.started_at || null,
    completed_at: job?.completed_at || null,
    processed: candidates.filter((candidate) => Number(candidate.attempt_count || 0) > 0).length,
    queued: candidates.filter((candidate) => ["queued", "retryable_failure"].includes(candidate.status)).length,
    promoted_services: candidates.reduce((total, candidate) => total + (candidate.promotion?.service_ids?.length || 0), 0),
    error: job?.error || null
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.listen(port, host, async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    // Refuse to serve an on-chain backend whose RPC is a different chain than
    // configured, or whose token scale disagrees with the contract. Either one
    // moves the wrong amount of money, and both are silent at runtime.
    try {
      const settlement = await assertSettlementChainReady({ backend: currentPaymentBackend() });
      if (!settlement.skipped) {
        console.log(`Settlement: ${settlement.chain} (chain ${settlement.chain_id}), ${settlement.asset} with ${settlement.decimals} decimals`);
      }
      const evidenceAnchor = await assertEvidenceAnchorReady();
      if (!evidenceAnchor.skipped) {
        console.log(`Evidence anchor: ${evidenceAnchor.contract_address} on ${evidenceAnchor.chain}`);
      }
    } catch (error) {
      console.error(`On-chain preflight failed: ${error.message}`);
      process.exit(1);
    }
    await bootstrapServer(server, baseUrl);
    console.log(`Agent Native Data Network MVP running at ${baseUrl} on ${host}`);
  });
}
