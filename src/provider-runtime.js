import { isArcNetwork, isEvmAddress, verifyArcUsdcTransfer } from "./arc-payment.js";
import { createPaymentRequirements, verifyPaymentProof } from "./payment.js";
import { currentPaymentBackend } from "./payment-adapter.js";
import { hashJson } from "./evidence.js";
import { createEnvelope, readProviderConfig } from "./provider-config.js";
import { createLiveBtcLiquidationEnvelope, createLiveFundFlowEnvelope } from "./fixtures.js";
import { readJson, sendJson, sendNotFound } from "./http-utils.js";
import { readProviderSecret } from "./provider-secrets.js";
import { isRealX402ProviderEnabled, processProviderX402Payment, sendX402Response, settleProviderX402Payment } from "./real-x402-provider.js";
import { authenticateCreditRequest, creditPaymentRequired, debitCredits, refundCredits } from "./credits.js";

const issuedChallenges = new Map();
const preflightResults = new Map();
const consumedTxHashes = new Map(); // lowercased tx_hash -> expiry ms; blocks one on-chain tx settling multiple challenges

// ponytail: in-memory, resets on restart like issuedChallenges; challenges also live here so the replay window is one process lifetime
function sweepExpiredPaymentState(now = Date.now()) {
  for (const [nonce, challenge] of issuedChallenges) {
    const expiry = Date.parse(challenge?.expires_at || "");
    if (expiry && expiry < now) issuedChallenges.delete(nonce);
  }
  for (const [nonce, entry] of preflightResults) {
    const expiry = Date.parse(entry?.expires_at || "");
    if (expiry && expiry < now) preflightResults.delete(nonce);
  }
  for (const [txHash, expiry] of consumedTxHashes) {
    if (expiry < now) consumedTxHashes.delete(txHash);
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
    description: "Base 7D Fund Flow"
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
    description: "BTC liquidation max pain"
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
  const paymentProof = req.headers["x-payment"];
  let preflight = null;
  if (!paymentProof && shouldPreflightProviderConfig(config)) {
    preflight = await executeProviderConfig(config, input);
    if (!isSuccessfulProviderResult(preflight)) {
      sendJson(res, 422, createPrepayValidationFailure({ serviceId, input, preflight }));
      return;
    }
  }
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
    preflight
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

  const result = payment.preflight?.result || await executeProviderConfig(config, input);
  await sendPaidResult({ res, payment, body: result.body, status: result.status, store });
}

export async function executeProviderConfig(config, input = {}) {
  const serviceId = config.manifest?.service_id || "custom_provider";
  if (config.source?.type === "hosted_http") {
    const upstream = await callHostedHttpSource(config, input);
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

  if (config.source?.type !== "static_json") {
    return { status: 200, body: {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      error: {
        code: "UNSUPPORTED_PROVIDER_SOURCE",
        message: "This MVP runtime currently supports static_json and hosted_http provider configs.",
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
      network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network,
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

  const verification = await verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network, payTo, inputHash })
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
      const txHash = String(decoded.payment.tx_hash || "").toLowerCase();
      if (consumedTxHashes.has(txHash)) {
        return { ok: false, error: "ARC_TX_ALREADY_SETTLED" };
      }
      const arc = await verifyArcUsdcTransfer({
        txHash: decoded.payment.tx_hash,
        expected: {
          amount: challenge.amount,
          payTo: challenge.pay_to,
          payer: decoded.payment.payer
        }
      });
      if (!arc.ok) return arc;
      verification.payment.arc_verification = arc;
      // Remember for 1h so the tx cannot settle any other (still-live, 5min TTL) challenge.
      consumedTxHashes.set(txHash, Date.now() + 3600_000);
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

function shouldPreflightProviderConfig(config) {
  return config.source?.type === "hosted_http";
}

function isSuccessfulProviderResult(result) {
  return Number(result?.status || 0) >= 200
    && Number(result?.status || 0) < 300
    && result?.body?.status === "success"
    && !result?.body?.error;
}

function createPrepayValidationFailure({ serviceId, input, preflight }) {
  const providerError = preflight?.body?.error || {
    code: "PROVIDER_PREPAY_VALIDATION_FAILED",
    message: "Provider preflight validation failed before payment."
  };
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: `prepay_${Date.now()}`,
    status: "error",
    payment_required: false,
    payment_collected: false,
    billing_status: "not_charged",
    query: input || {},
    error: {
      code: "PREPAY_VALIDATION_FAILED",
      message: "The provider upstream rejected this request before payment. No payment challenge was issued.",
      retryable: false,
      upstream_status: preflight?.body?.error?.upstream_status || preflight?.status || null,
      provider_error: providerError
    },
    metadata: {
      data_sources: ["provider_config_hosted_http"],
      generated_at: new Date().toISOString(),
      freshness_seconds: 0,
      is_estimated: false,
      confidence: 0,
      limitations: ["The request was rejected before payment because the upstream API would not return valid data for this input."]
    },
    agent_hints: {
      good_for: [],
      warnings: ["No payment was collected for this failed request."],
      suggested_followups: ["Fix the request parameters or choose a different service."]
    },
    summary: "Provider preflight validation failed before payment."
  };
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

async function callHostedHttpSource(config, input) {
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
    const response = await fetch(prepared.url, {
      ...request,
      signal: AbortSignal.timeout(Number(process.env.ADN_UPSTREAM_TIMEOUT_MS || 15000))
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
