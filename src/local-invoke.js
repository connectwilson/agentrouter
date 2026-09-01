import crypto from "node:crypto";
import { assertArcUsdcBalance, sendArcUsdcTransfer } from "./arc-payment.js";
import { hashJson } from "./evidence.js";
import { createArcPaymentProof } from "./payment.js";
import { createSettlementReceipt, currentPaymentBackend } from "./payment-adapter.js";
import { requestProviderHttp } from "./provider-http-transport.js";
import { invokeWithRealX402, isRealX402Enabled } from "./real-x402-client.js";
import { assertPolicyAllows, readWallet, recordPayment } from "./wallet.js";
import { validateBudgetAmount } from "./budget-normalization.js";

export async function invokePaidServiceWithLocalWallet({
  baseUrl,
  serviceId,
  input = {},
  budget = { max_amount: "0.05", currency: "USDC" },
  request = null,
  routingObservation = null,
  routingSummary = null,
  transportOptions = {}
}) {
  const rawMaxAmount = budget?.max_amount ?? budget?.max_price_usdc ?? budget?.max_price;
  const budgetValidation = validateBudgetAmount(rawMaxAmount, { field: "budget.max_amount" });
  if (!budgetValidation.ok) throw localBudgetError(budgetValidation);
  const manifest = await postJson(baseUrl, "/connector/get_manifest", { service_id: serviceId });
  if (budgetValidation.present && Number(manifest.pricing.amount) > budgetValidation.amount) {
    throw new Error(`Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}, above budget ${rawMaxAmount} ${budget.currency}.`);
  }
  const providerTransportOptions = localProviderTransportOptions(baseUrl, transportOptions);
  if (isRealX402Enabled()) {
    return invokeOfficialX402Service({
      baseUrl,
      manifest,
      serviceId,
      input,
      budget,
      request,
      routingObservation,
      routingSummary,
      transportOptions: providerTransportOptions
    });
  }
  if (currentPaymentBackend() !== "circle_arc") {
    throw new Error("Local paid invocation requires ADN_PAYMENT_BACKEND=circle_arc or official x402 configuration.");
  }

  const firstResponse = await requestProviderBeforePayment(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }, providerTransportOptions);
  if (firstResponse.status !== 402) {
    let payload = null;
    try {
      payload = await firstResponse.json();
    } catch {}
    const prepayFailure = payload?.error?.code === "PREPAY_VALIDATION_FAILED";
    const error = new Error(prepayFailure
      ? payload.error.message
      : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`);
    error.code = firstResponse.status >= 500 ? "provider_unavailable_before_payment" : "payment_challenge_unavailable";
    if (prepayFailure) error.code = "provider_prepay_validation_failed";
    error.upstreamStatus = firstResponse.status;
    error.retryable = firstResponse.status >= 500;
    error.payload = payload;
    throw error;
  }

  const challenge = await firstResponse.json();
  const payment = challenge.payment;
  const policyManifest = currentPaymentBackend() === "circle_arc"
    ? {
        ...manifest,
        pricing: {
          ...manifest.pricing,
          network: payment.network,
          token_address: payment.token_address,
          pay_to: payment.pay_to,
          settlement_model: payment.settlement_model
        }
      }
    : manifest;
  await assertPolicyAllows({
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    providerId: manifest.provider.provider_id,
    manifest: policyManifest,
    challenge: payment
  });
  const wallet = await readWallet();
  let arcTransfer = null;
  let arcBalance = null;
  if (currentPaymentBackend() === "circle_arc") {
    arcBalance = await assertArcUsdcBalance({ wallet, payment });
    arcTransfer = await sendArcUsdcTransfer({ wallet, payment });
  }
  const proof = createArcPaymentProof({
    wallet,
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    challenge: payment,
    tx: arcTransfer
  });

  const paidResponse = await requestProviderHttp(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(input)
  }, providerTransportOptions);
  const result = await paidResponse.json();
  const event = {
    event_version: "agent_local_payment_event_v1",
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    payer: wallet.address,
    payment_tx: decodePaymentTx(proof),
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    pay_to: payment.pay_to,
    challenge_nonce: payment.nonce,
    challenge_expires_at: payment.expires_at,
    status: paidResponse.ok && result.status === "success" ? "success" : "error",
    backend: currentPaymentBackend(),
    balance_before_payment: arcBalance,
    arc_transfer: arcTransfer
  };
  event.event_hash = hashJson(event);
  await recordPayment(event);
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: result?.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: "local_agent_wallet",
    payment_tx: event.payment_tx,
    payment_collected: true,
    billing_status: event.status === "success" ? "charged_success" : "charged_provider_error",
    result_delivery_status: event.status === "success" ? "delivered" : "failed_after_payment",
    settlement_receipt: createSettlementReceipt({
      manifest: policyManifest,
      challenge: payment,
      txHash: event.payment_tx
    }),
    status: event.status,
    schema_valid: result?.status === "success",
    latency_ms: null,
    consumer_rating: event.status === "success" ? 1 : 0,
    payment_backend: currentPaymentBackend()
  };
  feedback.feedback_hash = hashJson(feedback);

  const evidenceRecording = await recordCompletedInvocation({
    baseUrl,
    serviceId,
    input,
    result,
    feedback,
    localPayment: event,
    completionGrant: payment.completion_grant,
    budget,
    routingObservation,
    routingSummary,
    request: request || {
      capability: "direct_service_invocation",
      params: input,
      constraints: {
        max_price_usdc: budget.max_amount,
        currency: budget.currency || "USDC"
      },
      consumer_context: {
        source: "local_agent_wallet"
      }
    }
  });
  if (!result?.request_id && evidenceRecording?.request_id) {
    result.request_id = evidenceRecording.request_id;
  }

  return {
    result,
    local_payment: event,
    feedback,
    evidence_recording: evidenceRecording
  };
}

function localBudgetError(validation) {
  const error = new Error(validation.message);
  error.code = validation.code;
  error.status = validation.code;
  error.statusCode = 422;
  error.field = validation.field;
  error.retryable = false;
  return error;
}

async function invokeOfficialX402Service({ baseUrl, manifest, serviceId, input, budget, request = null, routingObservation = null, routingSummary = null, transportOptions = {} }) {
  const completionAuthorization = await requestCompletionGrant(baseUrl, serviceId, input);
  const wallet = await readWallet();
  const started = Date.now();
  const body = methodAllowsBody(manifest.endpoint.method) ? JSON.stringify(input) : undefined;
  const paid = await invokeWithRealX402({
    url: manifest.endpoint.url,
    method: manifest.endpoint.method || "POST",
    body,
    wallet,
    transportOptions,
    paymentPolicy: createManifestBoundX402Policy({ manifest, budget })
  });
  const result = paid.payload;
  const settlement = paid.settlement;
  const event = {
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    payer: wallet.address,
    payment_tx: paid.payment_tx,
    amount: settlement?.amount || manifest.pricing.amount,
    currency: manifest.pricing.currency,
    network: settlement?.network || manifest.pricing.network,
    pay_to: manifest.pricing.pay_to || null,
    challenge_nonce: null,
    challenge_expires_at: null,
    status: "success",
    backend: "x402"
  };
  await recordPayment(event);
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: result?.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: "local_agent_wallet",
    payment_tx: paid.payment_tx,
    settlement_receipt: createSettlementReceipt({
      manifest,
      challenge: {
        amount: event.amount,
        asset: event.currency,
        network: event.network,
        pay_to: event.pay_to
      },
      txHash: paid.payment_tx
    }),
    status: "success",
    schema_valid: true,
    latency_ms: Date.now() - started,
    consumer_rating: 1,
    notes: ["Paid through official x402 client flow."],
    payment_backend: currentPaymentBackend()
  };
  const evidenceRecording = await recordCompletedInvocation({
    baseUrl,
    serviceId,
    input,
    result,
    feedback,
    localPayment: event,
    completionGrant: completionAuthorization.completion_grant,
    completionNonce: completionAuthorization.completion_nonce,
    budget,
    routingObservation,
    routingSummary,
    request: request || {
      capability: "direct_service_invocation",
      params: input,
      constraints: {
        max_price_usdc: budget?.max_amount ?? manifest.pricing.amount,
        currency: budget?.currency || manifest.pricing.currency
      },
      consumer_context: {
        source: "local_agent_wallet",
        x402_client: "official"
      }
    }
  });
  if (!result?.request_id && evidenceRecording?.request_id) {
    result.request_id = evidenceRecording.request_id;
  }
  return {
    result,
    local_payment: event,
    feedback,
    evidence_recording: evidenceRecording
  };
}

// The x402 SDK invokes registered policies after receiving the live 402
// requirements and before it creates a signature. Treat the catalog manifest
// and the caller's budget as an immutable quote: a provider may offer a lower
// amount, but it cannot silently change the recipient, chain, asset, or raise
// the amount beyond either boundary.
export function createManifestBoundX402Policy({ manifest, budget = {} } = {}) {
  const pricing = manifest?.pricing || {};
  const expectedNetwork = canonicalX402Network(
    pricing.caip2 || pricing.network || pricing.chain_id
  );
  const expectedPayTo = normalizeX402Address(
    pricing.pay_to || manifest?.provider?.payout_address
  );
  const currency = String(pricing.currency || "").trim().toUpperCase();
  const expectedAsset = normalizeX402Address(
    pricing.token_address || pricing.asset_address || pricing.asset || knownX402Asset(expectedNetwork, currency)
  );
  const decimals = x402AssetDecimals(pricing, expectedNetwork, currency);
  const manifestAmount = decimalToAtomicUnits(pricing.amount, decimals);
  const budgetCurrency = String(budget?.currency || currency).trim().toUpperCase();
  const budgetAmount = budget?.max_amount == null
    ? manifestAmount
    : decimalToAtomicUnits(budget.max_amount, decimals);
  const termsAreComplete = Boolean(
    expectedNetwork
    && expectedPayTo
    && expectedAsset
    && currency
    && manifestAmount != null
    && manifestAmount > 0n
    && budgetAmount != null
    && budgetAmount > 0n
    && budgetCurrency === currency
    && manifestAmount <= budgetAmount
  );

  return (_x402Version, requirements = []) => {
    if (!termsAreComplete || !Array.isArray(requirements)) return [];
    return requirements.filter((requirement) => {
      const actualAmount = atomicAmountFromRequirement(requirement);
      return String(requirement?.scheme || "").toLowerCase() === "exact"
        && canonicalX402Network(requirement?.network) === expectedNetwork
        && normalizeX402Address(requirement?.payTo || requirement?.pay_to) === expectedPayTo
        && normalizeX402Address(requirement?.asset || requirement?.token_address) === expectedAsset
        && actualAmount != null
        && actualAmount > 0n
        && actualAmount <= manifestAmount
        && actualAmount <= budgetAmount;
    });
  };
}

const X402_NETWORK_ALIASES = new Map([
  ["base", "eip155:8453"],
  ["base-mainnet", "eip155:8453"],
  ["base-sepolia", "eip155:84532"],
  ["bsc", "eip155:56"],
  ["bnb", "eip155:56"],
  ["bnb-chain", "eip155:56"],
  ["bsc-testnet", "eip155:97"],
  ["arc-testnet", "eip155:5042002"]
]);

const X402_KNOWN_ASSETS = new Map([
  ["eip155:8453:USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  ["eip155:84532:USDC", "0x036cbd53842c5426634e7929541ec2318f3dcf7c"]
]);

function canonicalX402Network(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized.length > 80) return null;
  if (X402_NETWORK_ALIASES.has(normalized)) return X402_NETWORK_ALIASES.get(normalized);
  const caip2 = /^eip155:(\d+)$/.exec(normalized);
  if (caip2) return `eip155:${BigInt(caip2[1])}`;
  if (/^\d+$/.test(normalized)) return `eip155:${BigInt(normalized)}`;
  return null;
}

function normalizeX402Address(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function knownX402Asset(network, currency) {
  return X402_KNOWN_ASSETS.get(`${network}:${currency}`) || null;
}

function x402AssetDecimals(pricing, network, currency) {
  const declared = pricing.asset_decimals ?? pricing.token_decimals ?? pricing.decimals;
  if (declared != null && /^\d+$/.test(String(declared)) && Number(declared) <= 255) {
    return Number(declared);
  }
  if (currency === "USDC" && (network === "eip155:8453" || network === "eip155:84532")) {
    return 6;
  }
  return null;
}

function decimalToAtomicUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const normalized = String(value ?? "").trim();
  if (normalized.length > 128) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const fraction = match[2] || "";
  if (fraction.length > decimals) return null;
  try {
    return BigInt(match[1]) * (10n ** BigInt(decimals))
      + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  } catch {
    return null;
  }
}

function atomicAmountFromRequirement(requirement) {
  const value = requirement?.amount ?? requirement?.maxAmountRequired;
  const normalized = String(value ?? "");
  if (normalized.length > 256 || !/^\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

async function recordCompletedInvocation({ baseUrl, serviceId, input, result, feedback, localPayment, completionGrant = null, completionNonce = null, budget, request, routingObservation = null, routingSummary = null }) {
  if (!baseUrl) return { ok: false, status: "skipped", reason: "missing_registry_url" };
  try {
    return await postJson(baseUrl, "/agent-router/calls/complete", {
      service_id: serviceId,
      request,
      input,
      result,
      feedback,
      local_payment: localPayment,
      completion_grant: completionGrant,
      completion_nonce: completionNonce,
      budget,
      ...(routingObservation ? { routing_observation: routingObservation } : {}),
      ...(routingSummary ? { routing_summary: routingSummary } : {})
    });
  } catch (error) {
    return {
      ok: false,
      status: "evidence_recording_failed",
      error: {
        message: error.message,
        payload: error.payload || null
      }
    };
  }
}

async function requestCompletionGrant(baseUrl, serviceId, input) {
  const completionNonce = `local_${crypto.randomUUID()}`;
  const result = await postJson(baseUrl, "/agent-router/calls/grant", {
    service_id: serviceId,
    input,
    completion_nonce: completionNonce
  });
  return {
    completion_grant: result.completion_grant,
    completion_nonce: completionNonce
  };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.code = payload?.error?.code || "AGENTROUTER_REQUEST_FAILED";
    error.status = response.status;
    error.statusCode = response.status;
    error.retryable = response.status >= 500;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}

function methodAllowsBody(method = "POST") {
  return !["GET", "HEAD"].includes(String(method).toUpperCase());
}

function localProviderTransportOptions(baseUrl, overrides = {}) {
  // Dependency-injection hooks (lookup/requestHop) are useful for deterministic
  // tests, but callers cannot use this object to nominate additional trusted
  // origins. Only AgentRouter's own /provider/* path may be loopback in local
  // development; every external provider remains public-address only.
  const { trustedOrigins: _ignored, ...safeOverrides } = overrides || {};
  const trustedOrigins = [];
  try {
    trustedOrigins.push({
      origin: new URL(baseUrl).origin,
      pathPrefixes: ["/provider/"]
    });
  } catch {}
  return { ...safeOverrides, trustedOrigins };
}

async function requestProviderBeforePayment(url, init, transportOptions) {
  try {
    return await requestProviderHttp(url, init, transportOptions);
  } catch (error) {
    // "retryable" means the router may exclude this service and try a
    // different verified provider. This annotation is intentionally limited
    // to the pre-payment request so it can never authorize a second charge.
    if (error?.code === "PROVIDER_HTTP_UNSAFE_TARGET") error.retryable = true;
    throw error;
  }
}
