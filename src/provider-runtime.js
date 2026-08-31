import { isArcNetwork, isEvmAddress, verifyArcUsdcTransfer } from "./arc-payment.js";
import { createPaymentRequirements, verifyPaymentProof } from "./payment.js";
import { issueCompletionGrant } from "./completion-grant.js";
import { settlementChain } from "./chains.js";
import { currentPaymentBackend } from "./payment-adapter.js";
import { hashJson } from "./evidence.js";
import { createEnvelope, readProviderConfig } from "./provider-config.js";
import { createLiveBtcLiquidationEnvelope, createLiveFundFlowEnvelope } from "./fixtures.js";
import { readJson, sendJson, sendNotFound } from "./http-utils.js";
import { readProviderSecret } from "./provider-secrets.js";
import { isRealX402ProviderEnabled, processProviderX402Payment, sendX402Response, settleProviderX402Payment } from "./real-x402-provider.js";
import { accountSpendLimit, assertWithinSpendLimit, authenticateCreditRequest, creditPaymentRequired, debitCredits, refundCredits } from "./credits.js";
import { executeOneDollarAudit } from "./one-dollar-audit.js";
import { claimSettlementTransaction } from "./settlement-replay.js";
import { requestProviderHttp } from "./provider-http-transport.js";

const issuedChallenges = new Map();
const preflightResults = new Map();

function sweepExpiredPaymentState(now = Date.now()) {
  sweepExpiredEntries(issuedChallenges, now);
  sweepExpiredEntries(preflightResults, now);
}

// An unauthenticated challenge endpoint must not be able to force an unbounded
// full-map scan on every request. Map insertion order follows challenge issue
// order, so a bounded oldest-first sweep steadily drains expired entries.
function sweepExpiredEntries(entries, now, maxScanned = 256) {
  let scanned = 0;
  for (const [key, entry] of entries) {
    if (scanned >= maxScanned) break;
    scanned += 1;
    const expiry = Date.parse(entry?.expires_at || "");
    if (expiry && expiry < now) entries.delete(key);
  }
}

export async function handleFundFlowProvider(req, res, { store, baseUrl = "" } = {}) {
  const input = await readJson(req);
  const serviceId = "chain_fund_flow_7d_base";
  const amount = "0.01";
  const currency = "USDC";
  const network = "base";
  if (input.chain && input.chain !== "base") {
    sendJson(res, 422, providerInputError(serviceId, input, "UNSUPPORTED_CHAIN", "This service only supports Base.", "Use chain=base."));
    return;
  }
  const payment = await requirePaymentOrRespond({
    req,
    res,
    store,
    baseUrl,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(),
    description: "Base 7D Fund Flow",
    inputHash: hashJson(input || {})
  });
  if (!payment.ok) return;

  await sendPaidResult({ res, payment, body: createLiveFundFlowEnvelope(input), store });
}

export async function handleBtcLiquidationProvider(req, res, { store, baseUrl = "" } = {}) {
  const input = await readJson(req);
  const serviceId = "btc_liquidation_max_pain_demo";
  const amount = "0.02";
  const currency = "USDC";
  const network = "base";
  if (input.asset && String(input.asset).toUpperCase() !== "BTC") {
    sendJson(res, 422, providerInputError(serviceId, input, "UNSUPPORTED_ASSET", "This service only supports BTC.", "Use asset=BTC."));
    return;
  }
  const payment = await requirePaymentOrRespond({
    req,
    res,
    store,
    baseUrl,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(),
    description: "BTC liquidation max pain",
    inputHash: hashJson(input || {})
  });
  if (!payment.ok) return;

  await sendPaidResult({ res, payment, body: createLiveBtcLiquidationEnvelope(input), store });
}

export async function handleCustomProvider(req, res, serviceId, { store, baseUrl = "" } = {}) {
  let config;
  try {
    config = await readProviderConfig(serviceId);
  } catch {
    sendNotFound(res, "PROVIDER_CONFIG_NOT_FOUND");
    return;
  }

  const input = await readJson(req);
  const manifest = config.manifest;
  const inputHash = hashJson(input || {});
  const platformTransport = platformOwnedMockTransport(baseUrl);
  const amount = manifest.pricing.amount;
  const currency = manifest.pricing.currency;
  const network = manifest.pricing.network;
  const payment = await requirePaymentOrRespond({
    req,
    res,
    store,
    baseUrl,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(manifest),
    description: manifest.description_for_agent || manifest.title,
    inputHash,
    preflight: null
  });
  if (!payment.ok) return;

  if (payment.input_hash && payment.input_hash !== inputHash) {
    sendJson(res, 409, {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      query: input || {},
      error: {
        code: "PAYMENT_INPUT_MISMATCH",
        message: "Payment challenge was issued for a different request input.",
        retryable: false
      }
    });
    return;
  }

  // Issuing an anonymous payment challenge must never consume a Vendor's
  // credential-backed upstream quota. Upstream I/O starts only after the
  // credits or settlement proof has been verified.
  const result = await executeProviderConfig(config, input, {
    ...platformTransport,
    allowPaidUpstream: true
  });
  await sendPaidResult({ res, payment, body: result.body, status: result.status, store });
}

function platformOwnedMockTransport(baseUrl) {
  return {
    transportOptions: {
      // This is an application-owned integration fixture, not a provider
      // manifest-controlled private-network exception.
      trustedOrigins: [{
        origin: baseUrl,
        pathPrefixes: ["/mock/upstream/", "/mock/api/"],
        exactPaths: ["/api/v1/data/header-key"]
      }]
    }
  };
}

export async function executeProviderConfig(config, input = {}, options = {}) {
  const serviceId = config.manifest?.service_id || "custom_provider";
  if (config.source?.type === "external_x402_async") {
    return executeOneDollarAudit(config, input, options);
  }
  if (config.source?.type === "hosted_http") {
    const upstream = await callHostedHttpSource(config, input, options);
    if (upstream?.upstream_error) {
      return { status: 502, body: {
        schema_version: "agent_data_envelope_v1",
        service_id: serviceId,
        request_id: `req_${Date.now()}`,
        status: "error",
        query: input || {},
        error: {
          code: "UPSTREAM_ERROR",
          message: `Upstream API returned HTTP ${upstream.status}.`,
          retryable: upstream.status >= 500,
          upstream_status: upstream.status,
          upstream_payload: upstream.payload
        },
        metadata: {
          data_sources: ["provider_config_hosted_http"],
          generated_at: new Date().toISOString(),
          freshness_seconds: 0,
          is_estimated: false,
          confidence: 0,
          limitations: ["The provider endpoint was reachable, but the upstream API rejected or failed the request."]
        },
        agent_hints: {
          good_for: [],
          warnings: ["Check the provider secret, endpoint permissions, and request body shape."],
          suggested_followups: ["Ask the provider to validate the upstream API key and sample request."]
        },
        summary: "Hosted HTTP upstream call failed."
      } };
    }
    return { status: 200, body: createEnvelope({
      serviceId,
      input,
      data: shapeHostedHttpPayload(upstream, input),
      sourceType: "hosted_http",
      sampleType: null,
      isEstimated: false,
      confidence: 0.8,
      summary: config.source.summary
    }) };
  }

  if (config.source?.type === "apify_actor") {
    return executeApifyActor(config, input);
  }

  if (config.source?.type !== "static_json") {
    return { status: 200, body: {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      error: {
        code: "UNSUPPORTED_PROVIDER_SOURCE",
        message: "This runtime supports static_json, hosted_http, apify_actor, and external_x402_async provider configs.",
        retryable: false,
        suggested_action: "Use a supported provider config or add a source adapter."
      }
    } };
  }

  return { status: 200, body: createEnvelope({
    serviceId,
    input,
    data: config.source.live_data,
    sourceType: "static_json",
    sampleType: null,
    isEstimated: false,
    confidence: 0.8,
    summary: config.source.summary
  }) };
}

async function requirePaymentOrRespond({ req, res, store, baseUrl = "", serviceId, amount, currency, network, payTo, description, inputHash = null, preflight = null }) {
  if (currentPaymentBackend() === "credits") {
    if (!store) {
      sendJson(res, 503, {
        error: "Credit ledger unavailable",
        code: "CREDIT_LEDGER_UNAVAILABLE"
      });
      return { ok: false };
    }
    const creditAuth = await authenticateCreditRequest(store, req);
    if (!creditAuth) {
      sendJson(res, 402, creditPaymentRequired({ amount, baseUrl }));
      return { ok: false };
    }
    // Refused before the debit: a call over the ceiling is not charged and then
    // refunded, it simply does not run.
    try {
      assertWithinSpendLimit(creditAuth.account, amount);
    } catch (error) {
      if (error.code !== "SPEND_LIMIT_EXCEEDED") throw error;
      sendJson(res, 402, {
        error: "Payment Required",
        code: "SPEND_LIMIT_EXCEEDED",
        message: error.message,
        service_id: serviceId,
        amount: String(amount),
        currency: "credits",
        max_price_per_call: accountSpendLimit(creditAuth.account),
        action_required: {
          action: "raise_per_call_limit_or_choose_a_cheaper_service",
          endpoint: "/account/credits/limit",
          method: "POST",
          note: "The limit is the account owner's decision; do not raise it on their behalf without asking."
        }
      });
      return { ok: false };
    }
    const requestId = `bill_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    try {
      const ledger = await debitCredits(store, {
        accountId: creditAuth.account.account_id,
        amount,
        serviceId,
        requestId,
        metadata: { input_hash: inputHash, description }
      });
      return {
        ok: true,
        payment: { required: false },
        backend: "credits",
        credit_auth: creditAuth,
        ledger,
        request_id: requestId,
        amount: String(amount),
        currency: "credits",
        input_hash: inputHash,
        preflight: preflight ? { result: preflight } : null
      };
    } catch (error) {
      if (error.code !== "INSUFFICIENT_CREDITS") throw error;
      sendJson(res, 402, {
        ...creditPaymentRequired({ amount, baseUrl }),
        code: "INSUFFICIENT_CREDITS",
        balance: error.balance_atomic == null ? null : String(error.balance_atomic / 1_000_000),
        required: String(amount)
      });
      return { ok: false };
    }
  }
  if (isRealX402ProviderEnabled()) {
    const payment = await processProviderX402Payment({
      req,
      serviceId,
      amount,
      network,
      description
    });
    if (!payment.ok) {
      sendX402Response(res, payment.response);
      return { ok: false };
    }
    return { ok: true, payment };
  }

  const paymentProof = req.headers["x-payment"];
  if (!paymentProof) {
    if (currentPaymentBackend() === "circle_arc" && !isEvmAddress(payTo)) {
      sendJson(res, 503, {
        error: "Provider payout address is not configured",
        code: "PROVIDER_PAYOUT_ADDRESS_REQUIRED",
        message: "Circle Arc settlement requires a valid provider EVM wallet address."
      });
      return { ok: false };
    }
    const payment = issueChallenge({
      serviceId,
      amount,
      currency,
      network: currentPaymentBackend() === "circle_arc" ? settlementChain().network : network,
      payTo,
      inputHash,
      preflight
    });
    sendJson(res, 402, {
      error: "Payment Required",
      payment
    });
    return { ok: false };
  }

  const verification = await verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? settlementChain().network : network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? settlementChain().network : network, payTo, inputHash })
    });
    return { ok: false };
  }
  const cachedPreflight = verification.challenge_nonce ? preflightResults.get(verification.challenge_nonce) : null;
  if (verification.challenge_nonce) preflightResults.delete(verification.challenge_nonce);
  return {
    ok: true,
    payment: { required: false },
    input_hash: verification.payment?.input_hash || null,
    preflight: cachedPreflight
  };
}

async function sendPaidResult({ res, payment, body, status = 200, store = null }) {
  if (payment.payment?.required) {
    const settlement = await settleProviderX402Payment(payment.payment, body);
    if (settlement.failed) {
      sendX402Response(res, settlement.response);
      return;
    }
    sendJson(res, status, body, settlement.headers);
    return;
  }
  if (payment.backend === "credits") {
    const successful = status >= 200 && status < 300 && body?.status === "success" && !body?.error;
    if (!successful) {
      const refund = await refundCredits(store, {
        accountId: payment.credit_auth.account.account_id,
        amount: payment.amount,
        serviceId: body?.service_id || payment.ledger.service_id,
        requestId: payment.request_id,
        metadata: { reason: "provider_result_not_delivered", debit_entry_id: payment.ledger.entry_id }
      });
      attachCreditBilling(body, payment, { status: "refunded", refund });
    } else {
      attachCreditBilling(body, payment, { status: "charged" });
    }
  }
  sendJson(res, status, body);
}

function attachCreditBilling(body, payment, { status, refund = null }) {
  if (!body || typeof body !== "object") return;
  body.metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  body.metadata.billing = {
    payment_backend: "credits",
    billing_status: status,
    amount: payment.amount,
    currency: "credits",
    ledger_entry_id: payment.ledger.entry_id,
    balance_after: payment.ledger.balance,
    refund_entry_id: refund?.entry_id || null
  };
}

function providerInputError(serviceId, input, code, message, suggestedAction) {
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: `req_${Date.now()}`,
    status: "error",
    query: input || {},
    payment_collected: false,
    billing_status: "not_charged",
    error: {
      code,
      message,
      retryable: false,
      suggested_action: suggestedAction
    }
  };
}

function issueChallenge({ serviceId, amount, currency, network, payTo, inputHash = null, preflight = null }) {
  sweepExpiredPaymentState();
  const payment = createPaymentRequirements({ serviceId, amount, currency, network, payTo, inputHash });
  payment.completion_grant = issueCompletionGrant({
    serviceId,
    inputHash,
    challengeNonce: payment.nonce,
    expiresAt: payment.expires_at
  });
  issuedChallenges.set(payment.nonce, payment);
  if (preflight) {
    preflightResults.set(payment.nonce, {
      input_hash: inputHash,
      result: preflight,
      expires_at: payment.expires_at
    });
  }
  return payment;
}

async function verifyPaymentWithChallenge(paymentProof, expected) {
  const decoded = decodeProof(paymentProof);
  if (!decoded.ok) return decoded;
  const challenge = issuedChallenges.get(decoded.payment.challenge_nonce);
  if (!challenge) return { ok: false, error: "UNKNOWN_OR_REPLAYED_PAYMENT_CHALLENGE" };
  const verification = verifyPaymentProof(paymentProof, {
    ...expected,
    payTo: challenge.pay_to,
    nonce: challenge.nonce,
    resourceHash: challenge.resource_hash
  });
  if (verification.ok) {
    if (currentPaymentBackend() === "circle_arc" || isArcNetwork(challenge.network)) {
      const arc = await verifyArcUsdcTransfer({
        txHash: decoded.payment.tx_hash,
        expected: {
          amount: challenge.amount,
          payTo: challenge.pay_to,
          payer: decoded.payment.payer
        }
      });
      if (!arc.ok) return arc;
      let claimed;
      try {
        claimed = await claimSettlementTransaction({
          chainId: arc.chain_id || settlementChain().id,
          txHash: decoded.payment.tx_hash,
          serviceId: challenge.service_id,
          payer: decoded.payment.payer
        });
      } catch (error) {
        return { ok: false, error: error.code || "SETTLEMENT_REPLAY_GUARD_UNAVAILABLE" };
      }
      if (!claimed) return { ok: false, error: "ARC_TX_ALREADY_SETTLED" };
      verification.payment.arc_verification = arc;
    }
    issuedChallenges.delete(challenge.nonce);
    verification.challenge_nonce = challenge.nonce;
  }
  return verification;
}

function providerPayoutAddress(manifest = null) {
  return manifest?.provider?.payout_address ||
    manifest?.pricing?.pay_to ||
    process.env.ADN_PROVIDER_RECEIVE_ADDRESS ||
    process.env.ADN_X402_PAY_TO ||
    "";
}

function decodeProof(proof) {
  try {
    return {
      ok: true,
      payment: JSON.parse(Buffer.from(proof, "base64url").toString("utf8"))
    };
  } catch {
    return { ok: false, error: "INVALID_PAYMENT_PROOF" };
  }
}

export async function handleMockUpstreamSentiment(req, res) {
  const auth = req.headers.authorization;
  const input = await readJson(req);
  if (auth !== "Bearer demo-provider-secret") {
    sendJson(res, 401, {
      error: "missing or invalid provider secret"
    });
    return;
  }
  if (String(input.asset || "").toUpperCase() === "BAD") {
    sendJson(res, 422, {
      error: "invalid asset",
      code: "INVALID_ASSET",
      message: "asset BAD is not supported"
    });
    return;
  }
  sendJson(res, 200, {
    asset: input.asset || "ETH",
    window: input.window || "7d",
    sentiment_score: 0.79,
    mentions: 24120,
    positive_ratio: 0.71,
    negative_ratio: 0.12,
    neutral_ratio: 0.17,
    source: "mock_upstream_sentiment"
  });
}

export async function handleMockUpstreamApplicationError(_req, res) {
  sendJson(res, 200, {
    status: 100,
    message: "Missing API key",
    data: null
  });
}

export async function handleMockUpstreamHeaderKey(req, res) {
  if (req.headers["api-key"] !== "demo-provider-secret") {
    sendJson(res, 401, {
      error: "missing or invalid provider secret"
    });
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const rowCount = boundedInteger(url.searchParams.get("total_rows"), 1, 1000) || 1;
  sendJson(res, 200, {
    status: "success",
    rows: Array.from({ length: rowCount }, (_, index) => ({
      metric: `sample_metric_${index + 1}`,
      value: 42 + index
    })),
    source: "mock_upstream_header_key"
  });
}

async function callHostedHttpSource(config, input, options = {}) {
  const secretValue = config.source.auth?.secret_value || await readProviderSecret(config.source.auth?.secret_ref);
  const method = (config.source.upstream_method || "POST").toUpperCase();
  const prepared = prepareHostedHttpRequest({
    url: config.source.upstream_url,
    method,
    input
  });
  const authAttempts = buildAuthAttempts({
    mode: config.source.auth?.mode,
    header: config.source.auth?.header,
    secretValue
  });
  const fetchImpl = options.fetchImpl || requestProviderHttp;
  const timeoutMs = Number(process.env.ADN_UPSTREAM_TIMEOUT_MS || 15000);
  let lastError = null;
  for (const attempt of authAttempts) {
    const request = {
      method,
      headers: {
        "content-type": "application/json",
        ...attempt.headers
      }
    };
    if (prepared.body !== undefined) request.body = prepared.body;
    const response = await fetchImpl(prepared.url, {
      ...request,
      signal: AbortSignal.timeout(timeoutMs)
    }, {
      ...(options.transportOptions || {}),
      timeoutMs: options.transportOptions?.timeoutMs ?? timeoutMs
    });
    const payload = await parseUpstreamPayload(response);
    const outcome = classifyUpstreamResponse(response, payload, attempt);
    if (!outcome.upstream_error) return payload;
    lastError = outcome;
  }
  return {
    ...lastError,
    attempted_auth_headers: authAttempts.map((attempt) => attempt.label).filter((label) => label !== "none")
  };
}

function prepareHostedHttpRequest({ url, method, input }) {
  let nextUrl = url;
  const consumedPathParams = new Set();
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    const encodedKey = encodeURIComponent(key);
    if (nextUrl.includes(`{${key}}`) || nextUrl.includes(`%7B${encodedKey}%7D`)) {
      nextUrl = nextUrl
        .replaceAll(`{${key}}`, encodeURIComponent(String(value)))
        .replaceAll(`%7B${encodedKey}%7D`, encodeURIComponent(String(value)));
      consumedPathParams.add(key);
    }
  }
  if (method === "GET") {
    const parsed = new URL(nextUrl);
    for (const [key, value] of Object.entries(input || {})) {
      if (consumedPathParams.has(key)) continue;
      if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
    }
    return { url: parsed.toString() };
  }
  return {
    url: nextUrl,
    body: JSON.stringify(input)
  };
}

function buildAuthAttempts({ mode, header, secretValue }) {
  if (mode !== "header" || !secretValue) return [{ label: "none", headers: {} }];
  const normalized = String(header || "").trim().toLowerCase();
  if (normalized && normalized !== "auto") {
    return [{
      label: normalized,
      headers: { [normalized]: normalized === "authorization" ? `Bearer ${secretValue}` : secretValue }
    }];
  }
  return [
    { label: "authorization", headers: { authorization: `Bearer ${secretValue}` } },
    { label: "x-api-key", headers: { "x-api-key": secretValue } },
    { label: "api-key", headers: { "api-key": secretValue } },
    { label: "apiKey", headers: { apiKey: secretValue } },
    { label: "apikey", headers: { apikey: secretValue } },
    { label: "x-access-token", headers: { "x-access-token": secretValue } }
  ];
}

function classifyUpstreamResponse(response, payload, attempt) {
  if (payload.non_json) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload: {
        code: "UPSTREAM_NON_JSON_RESPONSE",
        content_type: payload.content_type,
        body_preview: payload.body_preview
      }
    };
  }
  if (!response.ok) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload
    };
  }
  const applicationError = detectApplicationError(payload);
  if (applicationError) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload: applicationError
    };
  }
  return { upstream_error: false };
}

function shapeHostedHttpPayload(payload, input = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const limit = boundedInteger(input.limit ?? input.pagination?.per_page, 0, 100);
  const offset = boundedInteger(input.offset, 0, 100000) || 0;
  if (!limit) return payload;

  for (const key of ["data", "rows", "items", "records", "results"]) {
    if (!Array.isArray(payload[key]) || (payload[key].length <= limit && offset === 0)) continue;
    const page = payload[key].slice(offset, offset + limit);
    return {
      ...payload,
      [key]: page,
      agentrouter_page: {
        applied: true,
        field: key,
        limit,
        offset,
        returned: page.length,
        total_available: payload[key].length,
        truncated: offset + limit < payload[key].length
      }
    };
  }
  return payload;
}

function boundedInteger(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function detectApplicationError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const message = String(payload.message || payload.error || payload.msg || "").toLowerCase();
  const hasAuthError = /missing api key|api key missing|invalid api key|unauthorized|forbidden|token|auth/.test(message);
  if (hasAuthError) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "auth_or_permission_error",
      message: payload.message || payload.error || payload.msg || "Upstream API reported an authentication or permission error.",
      upstream_payload: payload
    };
  }
  const status = payload.status ?? payload.code;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : status;
  const successStatuses = new Set([0, 1, 200, "0", "1", "200", "ok", "success", "succeeded"]);
  if (status !== undefined && !successStatuses.has(normalizedStatus) && (payload.message || payload.error || payload.data === null)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "non_success_status",
      message: payload.message || payload.error || `Upstream API returned non-success status ${status}.`,
      upstream_payload: payload
    };
  }
  if (payload.data === null && (payload.message || payload.error)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "empty_error_payload",
      message: payload.message || payload.error || "Upstream API returned null data with an error-like message.",
      upstream_payload: payload
    };
  }
  return null;
}

async function parseUpstreamPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text.trim()) return {};
  if (contentType.includes("application/json") || looksLikeJson(text)) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return {
        non_json: true,
        content_type: contentType,
        body_preview: text.slice(0, 240),
        parse_error: error.message
      };
    }
  }
  return {
    non_json: true,
    content_type: contentType,
    body_preview: text.slice(0, 240)
  };
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}


const APIFY_DEFAULT_BASE = "https://api.apify.com/v2";

function apifyErrorEnvelope(serviceId, input, { code, message, retryable, upstreamStatus = null, upstreamPayload = null, actorId = "" }) {
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: `req_${Date.now()}`,
    status: "error",
    query: input || {},
    error: {
      code,
      message,
      retryable,
      ...(upstreamStatus === null ? {} : { upstream_status: upstreamStatus }),
      ...(upstreamPayload === null ? {} : { upstream_payload: upstreamPayload })
    },
    metadata: {
      data_sources: ["apify_actor"],
      generated_at: new Date().toISOString(),
      freshness_seconds: 0,
      is_estimated: false,
      confidence: 0,
      limitations: [`Apify actor ${actorId} did not return a usable dataset.`]
    },
    agent_hints: {
      good_for: [],
      warnings: ["Check the Apify token, actor id, and actor input shape."],
      suggested_followups: ["Ask the provider to run the actor directly on Apify with the same input."]
    },
    summary: "Apify actor run failed."
  };
}

function filterApifyInput(input = {}, allowlist) {
  if (!Array.isArray(allowlist) || !allowlist.length) return { ...input };
  const filtered = {};
  for (const key of allowlist) {
    if (input && Object.hasOwn(input, key)) filtered[key] = input[key];
  }
  return filtered;
}

function projectApifyItems(items, fields) {
  if (!Array.isArray(fields) || !fields.length) return items;
  return items.map((item) => Object.fromEntries(fields.map((key) => [key, item?.[key]])));
}

export async function executeApifyActor(config, input = {}) {
  const source = config.source || {};
  const serviceId = config.manifest?.service_id || "apify_actor";
  const actorId = String(source.actor_id || "").trim();
  const token = source.auth?.secret_value || await readProviderSecret(source.auth?.secret_ref);
  if (!token) {
    return { status: 502, body: apifyErrorEnvelope(serviceId, input, {
      code: "UPSTREAM_APPLICATION_ERROR",
      message: "The Apify token for this service is missing or unreadable.",
      retryable: false,
      actorId
    }) };
  }

  const body = { ...(source.input_template || {}), ...filterApifyInput(input, source.input_allowlist) };
  const base = String(process.env.ADN_APIFY_API_BASE || APIFY_DEFAULT_BASE).replace(/\/$/, "");
  // Apify addresses actors as username~actor-name, so the tilde must survive.
  const url = new URL(`${base}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`);
  url.searchParams.set("clean", String(source.dataset?.clean ?? true));
  url.searchParams.set("format", "json");
  const maxItems = Number(source.dataset?.max_items ?? input.limit);
  if (Number.isFinite(maxItems) && maxItems > 0) url.searchParams.set("limit", String(Math.min(Math.trunc(maxItems), 1000)));
  const offset = Number(input.offset);
  if (Number.isFinite(offset) && offset > 0) url.searchParams.set("offset", String(Math.trunc(offset)));

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.ADN_APIFY_MAX_WAIT_MS || 120000))
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { status: timedOut ? 504 : 502, body: apifyErrorEnvelope(serviceId, input, {
      code: timedOut ? "APIFY_RUN_TIMEOUT" : "UPSTREAM_ERROR",
      message: timedOut
        ? "The actor exceeded the synchronous run window; async support is planned for v2."
        : `Could not reach Apify: ${error?.message || "unknown error"}.`,
      retryable: true,
      actorId
    }) };
  }

  const payload = await parseUpstreamPayload(response);
  if (response.status === 408 || response.status === 504) {
    return { status: 504, body: apifyErrorEnvelope(serviceId, input, {
      code: "APIFY_RUN_TIMEOUT",
      message: "The actor exceeded the synchronous run window; async support is planned for v2.",
      retryable: true,
      upstreamStatus: response.status,
      actorId
    }) };
  }
  if (!response.ok) {
    const isAuth = response.status === 401 || response.status === 403;
    return { status: 502, body: apifyErrorEnvelope(serviceId, input, {
      code: isAuth ? "UPSTREAM_APPLICATION_ERROR" : "UPSTREAM_ERROR",
      message: isAuth
        ? "Apify rejected the provider token for this actor."
        : `Apify returned HTTP ${response.status} for actor ${actorId}.`,
      retryable: response.status >= 500,
      upstreamStatus: response.status,
      upstreamPayload: payload,
      actorId
    }) };
  }
  if (payload?.non_json) {
    return { status: 502, body: apifyErrorEnvelope(serviceId, input, {
      code: "UPSTREAM_NON_JSON_RESPONSE",
      message: "Apify returned a non-JSON dataset response.",
      retryable: false,
      upstreamStatus: response.status,
      upstreamPayload: payload,
      actorId
    }) };
  }

  const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
  const items = projectApifyItems(raw, source.dataset?.fields);
  return { status: 200, body: createEnvelope({
    serviceId,
    input,
    // Empty datasets stay a success envelope so the existing empty-result
    // verification fires instead of being masked as an upstream failure.
    data: { items, item_count: items.length, actor_id: actorId },
    sourceType: "apify_actor",
    sampleType: null,
    isEstimated: false,
    confidence: 0.8,
    summary: source.summary
  }) };
}


// Mock Apify dataset endpoint so tests never reach api.apify.com. The path
// mirrors the real one: /acts/{actorId}/run-sync-get-dataset-items
export async function handleMockUpstreamApify(req, res, url) {
  const isMetadata = req.method === "GET";
  const body = isMetadata ? {} : await readJson(req);
  if (req.headers.authorization !== "Bearer mock-apify-token") {
    sendJson(res, 401, { error: { type: "authentication-error", message: "Invalid token" } });
    return;
  }
  const actorId = decodeURIComponent(String(url.pathname).split("/acts/")[1]?.split("/")[0] || "");
  if (actorId === "apify~missing-actor") {
    sendJson(res, 404, { error: { type: "record-not-found", message: "Actor not found" } });
    return;
  }
  if (actorId === "apify~slow-actor") {
    sendJson(res, 408, { error: { type: "request-timeout", message: "Run exceeded the sync window" } });
    return;
  }
  if (actorId === "apify~empty-actor") {
    sendJson(res, 200, []);
    return;
  }
  if (isMetadata) {
    sendJson(res, 200, { data: {
      id: actorId,
      title: "Google Search Scraper",
      description: "Scrapes Google SERPs.",
      defaultRunOptions: {
        memoryMbytes: 1024,
        timeoutSecs: 120,
        input: { properties: {
          queries: { type: "string", prefill: "agentrouter" },
          maxPagesPerQuery: { type: "integer", default: 1 },
          resultsPerPage: { type: "integer", default: 10 }
        } }
      }
    } });
    return;
  }
  const limit = Number(url.searchParams.get("limit"));
  const items = [
    { title: "First result", url: "https://example.com/1", description: "One", secret_field: "hidden" },
    { title: "Second result", url: "https://example.com/2", description: "Two", secret_field: "hidden" },
    { title: "Third result", url: "https://example.com/3", description: "Three", secret_field: "hidden" }
  ].map((item) => ({ ...item, echoed_input: body }));
  sendJson(res, 200, Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items);
}


// PRD §9-B: read actor metadata so Provider Studio can pre-fill a draft instead
// of making the provider retype the title, description, and input shape.
export async function fetchApifyActorMetadata(actorId, token, { fetchImpl = globalThis.fetch } = {}) {
  const id = String(actorId || "").trim();
  if (!id) {
    const error = new Error("actor_id is required.");
    error.code = "APIFY_ACTOR_ID_REQUIRED";
    error.statusCode = 422;
    throw error;
  }
  const base = String(process.env.ADN_APIFY_API_BASE || APIFY_DEFAULT_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/acts/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(Number(process.env.ADN_UPSTREAM_TIMEOUT_MS || 15000))
  });
  const payload = await parseUpstreamPayload(response);
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? "Apify rejected the token while reading actor metadata."
      : `Apify returned HTTP ${response.status} for actor ${id}.`);
    error.code = response.status === 404 ? "APIFY_ACTOR_NOT_FOUND" : "APIFY_ACTOR_METADATA_FAILED";
    error.statusCode = 422;
    throw error;
  }
  const data = payload?.data || payload || {};
  const properties = data.defaultRunOptions?.input?.properties
    || data.inputSchema?.properties
    || data.exampleRunInput?.properties
    || {};
  const inputKeys = Object.keys(properties);
  const sampleRequest = {};
  for (const key of inputKeys.slice(0, 6)) {
    const spec = properties[key] || {};
    if (spec.prefill !== undefined) sampleRequest[key] = spec.prefill;
    else if (spec.default !== undefined) sampleRequest[key] = spec.default;
    else if (spec.type === "array") sampleRequest[key] = [];
    else if (spec.type === "integer" || spec.type === "number") sampleRequest[key] = 1;
    else if (spec.type === "boolean") sampleRequest[key] = false;
    else sampleRequest[key] = "";
  }
  return {
    actor_id: id,
    title: String(data.title || data.name || id).slice(0, 200),
    description: String(data.description || "").slice(0, 1000),
    input_allowlist: inputKeys,
    sample_request: sampleRequest,
    default_memory_mbytes: data.defaultRunOptions?.memoryMbytes ?? null,
    default_timeout_secs: data.defaultRunOptions?.timeoutSecs ?? null
  };
}
