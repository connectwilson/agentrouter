import { createArcPaymentProof } from "./payment.js";
import { validateEnvelope, validateJsonSchema } from "./schema.js";
import { publicServiceRecord, summarizeTrust } from "./store.js";
import { normalizeEndpoint } from "./http-utils.js";
import { suggestCapabilities } from "./id-utils.js";
import { createSettlementReceipt, currentPaymentBackend } from "./payment-adapter.js";
import { hashJson } from "./evidence.js";
import { normalizeConsumerFeedback, verifyServiceResult } from "./verifier.js";
import { listPersistentServiceEvents, writePersistentServiceEvent } from "./persistence.js";
import { finalizeManifest, readProviderConfig, writeProviderConfig } from "./provider-config.js";
import { assertArcUsdcBalance, sendArcUsdcTransfer, isEvmAddress } from "./arc-payment.js";
import { assertPolicyAllows, readWallet, recordPayment } from "./wallet.js";
import { registerErc8004AgentIdentity } from "./erc8004.js";
import { executeProviderConfig } from "./provider-runtime.js";
import { settlementChain } from "./chains.js";
import { agentRouterConnectionRequired } from "./agentrouter-connection.js";

export function registerService(store, manifest, baseUrl) {
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) {
    const error = new Error(`Invalid manifest: ${manifestErrors.join(", ")}`);
    error.statusCode = 422;
    throw error;
  }
  if (store.services.has(manifest.service_id)) {
    const error = new Error(`Service ${manifest.service_id} is already registered.`);
    error.statusCode = 409;
    error.code = "SERVICE_ALREADY_REGISTERED";
    throw error;
  }

  const normalized = finalizeManifest({
    ...manifest,
    capabilities: normalizeManifestCapabilities(manifest),
    endpoint: {
      ...manifest.endpoint,
      url: normalizeEndpoint(manifest.endpoint.url, baseUrl)
    }
  });
  const duplicate = findDuplicateService(store, normalized);
  if (duplicate) {
    const error = new Error(`Service source is already registered as ${duplicate.manifest.service_id}.`);
    error.statusCode = 409;
    error.code = "SERVICE_SOURCE_ALREADY_REGISTERED";
    error.existingServiceId = duplicate.manifest.service_id;
    throw error;
  }

  const record = {
    manifest: normalized,
    verification_status: "pending",
    validation_runs: [],
    feedback_events: [],
    quality_events: [],
    health_checks: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  store.providers.set(normalized.provider.provider_id, normalized.provider);
  store.services.set(normalized.service_id, record);
  return record;
}

export function findDuplicateService(store, manifest) {
  const fingerprint = manifest?.registration?.source_fingerprint;
  const providerId = manifest?.provider?.provider_id;
  if (!fingerprint || !providerId) return null;
  for (const record of store.services.values()) {
    if (record.manifest.service_id === manifest.service_id) continue;
    if (record.manifest.provider?.provider_id !== providerId) continue;
    if (record.manifest.registration?.source_fingerprint === fingerprint) return record;
  }
  return null;
}

export function unregisterService(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return false;
  store.services.delete(serviceId);
  const providerId = record.manifest?.provider?.provider_id;
  if (providerId) {
    const providerStillUsed = [...store.services.values()].some((item) => item.manifest?.provider?.provider_id === providerId);
    if (!providerStillUsed) store.providers.delete(providerId);
  }
  return true;
}

export async function updateServicePayoutWallet(store, serviceId, payoutAddress) {
  const record = store.services.get(serviceId);
  if (!record) {
    const error = new Error(`Service ${serviceId} was not found.`);
    error.statusCode = 404;
    error.code = "SERVICE_NOT_FOUND";
    throw error;
  }
  if (!isEvmAddress(payoutAddress)) {
    const error = new Error("Arc payout wallet must be a valid EVM address.");
    error.statusCode = 422;
    error.code = "INVALID_PAYOUT_ADDRESS";
    throw error;
  }

  applyPayoutToManifest(record.manifest, payoutAddress);
  record.updated_at = new Date().toISOString();
  if (record.manifest.provider?.provider_id) {
    store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
  }

  let persisted = false;
  try {
    const config = await readProviderConfig(serviceId);
    applyPayoutToManifest(config.manifest, payoutAddress);
    await writeProviderConfig(config);
    persisted = true;
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
  }

  return {
    ok: true,
    service_id: serviceId,
    payout_address: payoutAddress,
    persisted,
    manifest: record.manifest,
    service: publicServiceRecord(record)
  };
}

export async function registerServiceErc8004Identity(store, serviceId, { baseUrl = "", metadataUri = "" } = {}) {
  const record = store.services.get(serviceId);
  if (!record) {
    const error = new Error(`Service ${serviceId} was not found.`);
    error.statusCode = 404;
    error.code = "SERVICE_NOT_FOUND";
    throw error;
  }
  const registration = await registerErc8004AgentIdentity({
    manifest: record.manifest,
    baseUrl,
    metadataUri
  });
  if (!["registered", "submitted"].includes(registration.status)) {
    const error = new Error(registration.error || "ERC-8004 identity registration failed.");
    error.statusCode = 422;
    error.code = "ERC8004_REGISTRATION_FAILED";
    error.registration = registration;
    throw error;
  }

  applyErc8004RegistrationToManifest(record.manifest, registration);
  record.updated_at = new Date().toISOString();
  if (record.manifest.provider?.provider_id) {
    store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
  }

  let persisted = false;
  try {
    const config = await readProviderConfig(serviceId);
    applyErc8004RegistrationToManifest(config.manifest, registration);
    await writeProviderConfig(config);
    persisted = true;
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
  }

  await writePersistentServiceEvent({
    eventType: "erc8004_identity",
    serviceId,
    requestId: registration.tx_hash || registration.agent_id || null,
    event: {
      event_version: "agent_router_erc8004_identity_v1",
      service_id: serviceId,
      provider_id: record.manifest.provider.provider_id,
      erc8004: registration,
      created_at: new Date().toISOString()
    }
  });

  return {
    ok: true,
    service_id: serviceId,
    persisted,
    erc8004: registration,
    manifest: record.manifest,
    service: publicServiceRecord(record)
  };
}

function applyPayoutToManifest(manifest, payoutAddress) {
  manifest.provider = manifest.provider || {};
  manifest.provider.payout_address = payoutAddress;
  manifest.pricing = manifest.pricing || {};
  manifest.pricing.pay_to = payoutAddress;
  manifest.pricing.settlement_model = "direct_provider_wallet";
}

function applyErc8004RegistrationToManifest(manifest, registration = {}) {
  manifest.registration = {
    ...(manifest.registration || {}),
    erc8004: {
      ...(manifest.registration?.erc8004 || {}),
      standard: "ERC-8004",
      network: registration.network || settlementChain().network,
      caip2: registration.caip2 || settlementChain().caip2,
      chain_id: registration.chain_id || settlementChain().id,
      agent_id: registration.agent_id || manifest.registration?.erc8004?.agent_id || null,
      metadata_uri: registration.metadata_uri || manifest.registration?.erc8004?.metadata_uri || null,
      metadata_hash: registration.metadata_hash || manifest.registration?.erc8004?.metadata_hash || null,
      identity_registry: registration.registry_address || manifest.registration?.erc8004?.identity_registry || null,
      reputation_registry: registration.reputation_registry_address || manifest.registration?.erc8004?.reputation_registry || null,
      validation_registry: registration.validation_registry_address || manifest.registration?.erc8004?.validation_registry || null,
      tx_hash: registration.tx_hash || manifest.registration?.erc8004?.tx_hash || null,
      status: registration.status,
      updated_at: new Date().toISOString()
    }
  };
  manifest.provider = manifest.provider || {};
  if (registration.agent_id) manifest.provider.erc8004_agent_id = String(registration.agent_id);
}

function normalizeManifestCapabilities(manifest) {
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const inferred = suggestCapabilities([
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    declared.join(" ")
  ].join(" ")).split(",");
  return [...new Set([...declared, ...inferred])];
}

export async function validateService(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return { ok: false, error: "SERVICE_NOT_FOUND" };

  const manifest = record.manifest;
  const requestBody = manifest.sample_request || {};
  const config = await readProviderConfig(serviceId).catch(() => null);
  if (config) {
    const result = await executeProviderConfig(config, requestBody);
    const originBinding = await verifyOriginBinding(manifest);
    return storeProviderValidationResult({ record, serviceId, status: result.status, responseBody: result.body, originBinding });
  }

  const firstResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody)
  });

  if (firstResponse.status !== 402) {
    return storeValidation(record, {
      ok: false,
      service_id: serviceId,
      error: "EXPECTED_402_PAYMENT_REQUIRED",
      status: firstResponse.status,
      created_at: new Date().toISOString()
    });
  }

  const paymentChallenge = await firstResponse.json();
  const proof = await createArcProofForProviderChallenge({
    serviceId,
    manifest,
    payment: paymentChallenge.payment,
    consumerId: "validator"
  });

  const paidResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(requestBody)
  });
  const responseBody = await paidResponse.json();
  const originBinding = await verifyOriginBinding(manifest);
  return storeProviderValidationResult({ record, serviceId, status: paidResponse.status, responseBody, originBinding });
}

function storeProviderValidationResult({ record, serviceId, status, responseBody, originBinding = null }) {
  const manifest = record.manifest;
  const schemaErrors = validateJsonSchema(responseBody, manifest.output_schema);
  const envelopeErrors = validateEnvelope(responseBody);
  const resultErrors = validateRealResultFeedback(responseBody);
  const ok = status >= 200 && status < 300 && schemaErrors.length === 0 && envelopeErrors.length === 0 && resultErrors.length === 0;

  return storeValidation(record, {
    ok,
    service_id: serviceId,
    status,
    provider_error: responseBody?.error || null,
    schema_errors: schemaErrors,
    envelope_errors: envelopeErrors,
    result_errors: resultErrors,
    result_preview: previewResultData(responseBody?.data),
    origin_binding: originBinding,
    created_at: new Date().toISOString()
  });
}

async function verifyOriginBinding(manifest) {
  const binding = manifest?.origin_binding;
  if (!binding?.well_known_url) return null;
  const result = {
    binding_version: "agentrouter_origin_binding_v1",
    required: Boolean(binding.required),
    well_known_url: binding.well_known_url,
    origin: binding.origin || "",
    status: "not_found",
    ok: false,
    checked_at: new Date().toISOString()
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(binding.well_known_url, { signal: controller.signal });
    result.http_status = response.status;
    if (response.status === 404) return result;
    if (!response.ok) {
      result.status = "unavailable";
      return result;
    }
    const payload = await response.json();
    const serviceId = manifest.service_id;
    const providerId = manifest.provider?.provider_id;
    const services = Array.isArray(payload.services) ? payload.services : [];
    const directMatch = payload.service_id === serviceId || payload.provider_id === providerId;
    const serviceMatch = services.some((service) =>
      service?.service_id === serviceId ||
      service?.manifest_hash === manifest.integrity?.manifest_hash ||
      service?.upstream_url === manifest.source?.upstream_url
    );
    result.payload_hash = payload ? hashPayload(payload) : null;
    result.status = directMatch || serviceMatch ? "verified" : "mismatch";
    result.ok = directMatch || serviceMatch;
    return result;
  } catch (error) {
    result.status = error?.name === "AbortError" ? "timeout" : "unavailable";
    result.error = error.message;
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function hashPayload(payload) {
  return hashJson(payload);
}

export function searchServices(store, { query = "", capabilities = [], maxPrice, verifiedOnly = false } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const results = [];

  for (const record of store.services.values()) {
    if (verifiedOnly && record.verification_status !== "verified") continue;
    const manifest = record.manifest;
    if (max != null && Number(manifest.pricing.amount) > max) continue;
    if (capabilities.length && !capabilities.every((capability) => manifest.capabilities.includes(capability))) continue;

    const haystack = [
      manifest.title,
      manifest.description_for_agent,
      ...(manifest.capabilities || []),
      manifest.service_id,
      manifest.agent_contract?.summary,
      manifest.agent_contract?.request_shape_summary,
      manifest.agent_contract?.response_shape_summary,
      JSON.stringify(manifest.routing || {}),
      JSON.stringify(manifest.agent_contract?.request_data || {}),
      JSON.stringify(manifest.agent_contract?.response_data || {}),
      JSON.stringify(manifest.pricing || {}),
      JSON.stringify(manifest.freshness || {}),
      JSON.stringify(manifest.data_source_claim || {}),
      JSON.stringify(manifest.sample_response?.metadata || {}),
      JSON.stringify(manifest.sample_response?.agent_hints || {}),
      JSON.stringify(manifest.sample_request || {}),
      JSON.stringify(manifest.sample_response?.data || {}),
      JSON.stringify(record.validation_runs?.at(-1)?.result_preview || {})
    ].join(" ").toLowerCase();

    const matchCount = terms.filter((term) => haystack.includes(term)).length;
    if (terms.length && matchCount === 0) continue;

    results.push({
      ...publicServiceRecord(record),
      match_score: terms.length ? matchCount / terms.length : 1
    });
  }

  return results.sort((a, b) => b.match_score - a.match_score);
}

export async function invokePaidService(store, serviceId, input, budget = {}, options = {}) {
  const record = store.services.get(serviceId);
  if (!record) return { statusCode: 404, body: { error: { code: "SERVICE_NOT_FOUND" } } };

  const manifest = record.manifest;
  if (budget.max_amount != null && Number(manifest.pricing.amount) > Number(budget.max_amount)) {
    return {
      statusCode: 402,
      body: {
        error: {
          code: "BUDGET_TOO_LOW",
          message: `Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}.`
        }
      }
    };
  }

  const started = Date.now();
  let paidResponse;
  let body;
  let paymentTx = null;
  let settlementReceipt;
  if (currentPaymentBackend() === "credits") {
    if (!options.consumerApiKey) {
      return {
        statusCode: 401,
        body: agentRouterConnectionRequired()
      };
    }
    paidResponse = await fetch(manifest.endpoint.url, {
      method: manifest.endpoint.method || "POST",
      headers: {
        "content-type": "application/json",
        "x-agentrouter-api-key": options.consumerApiKey
      },
      body: JSON.stringify(input)
    });
    body = await paidResponse.json().catch(() => ({}));
    const billing = body?.metadata?.billing || {};
    paymentTx = billing.ledger_entry_id ? `credits:${billing.ledger_entry_id}` : null;
    settlementReceipt = {
      receipt_version: "agent_router_settlement_receipt_v1",
      payment_backend: "credits",
      mode: "credits",
      network: "agentrouter",
      protocol: "platform_credits",
      asset: "credits",
      amount: billing.amount || manifest.pricing.amount,
      payer: options.consumerId || "agentrouter_consumer",
      ledger_entry_id: billing.ledger_entry_id || null,
      balance_after: billing.balance_after || null,
      status: billing.billing_status || (paidResponse.ok ? "charged" : "not_charged"),
      created_at: new Date().toISOString()
    };
  } else {
    const firstResponse = await fetch(manifest.endpoint.url, {
      method: manifest.endpoint.method || "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    if (firstResponse.status !== 402) {
      let providerPayload = null;
      try {
        providerPayload = await firstResponse.json();
      } catch {}
      const prepayFailure = providerPayload?.error?.code === "PREPAY_VALIDATION_FAILED";
      const feedback = await recordOperationalFailure(store, record, {
        input,
        statusCode: firstResponse.status,
        error: {
          code: prepayFailure ? "PREPAY_VALIDATION_FAILED" : "EXPECTED_402_PAYMENT_REQUIRED",
          message: prepayFailure
            ? providerPayload.error.message
            : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`,
          provider_payload: providerPayload
        },
        started
      });
      return {
        statusCode: prepayFailure ? 422 : firstResponse.status >= 500 ? 503 : 502,
        body: {
          error: {
            code: prepayFailure
              ? "PROVIDER_PREPAY_VALIDATION_FAILED"
              : firstResponse.status >= 500 ? "PROVIDER_UNAVAILABLE_BEFORE_PAYMENT" : "EXPECTED_402_PAYMENT_REQUIRED",
            message: prepayFailure
              ? "Provider preflight validation failed before payment. No payment was collected."
              : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`,
            upstream_status: firstResponse.status,
            retryable: firstResponse.status >= 500,
            provider_payload: providerPayload
          },
          feedback
        }
      };
    }
    const challenge = await firstResponse.json();
    const proof = await createArcProofForProviderChallenge({
      serviceId,
      manifest,
      payment: challenge.payment,
      consumerId: "agentrouter_consumer"
    });
    paidResponse = await fetch(manifest.endpoint.url, {
      method: manifest.endpoint.method || "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": proof
      },
      body: JSON.stringify(input)
    });
    body = await paidResponse.json();
    paymentTx = decodePaymentTx(proof);
    settlementReceipt = createSettlementReceipt({
      manifest,
      challenge: challenge.payment,
      txHash: paymentTx
    });
  }
  const schemaErrors = validateJsonSchema(body, manifest.output_schema);
  const envelopeErrors = validateEnvelope(body);
  const resultErrors = validateRealResultFeedback(body);
  const schemaValid = schemaErrors.length === 0 && envelopeErrors.length === 0;
  const verification = verifyServiceResult({ result: body, manifest, intent: input, constraints: {} });
  const qualityErrors = verification.sanity_valid === false
    ? [
        ...resultErrors,
        {
          code: "RESULT_DATA_QUALITY_FAILED",
          message: "Provider returned data that failed deterministic quality sanity checks.",
          issues: (verification.data_quality_issues || []).map((issue) => issue.code)
        }
      ]
    : resultErrors;
  const creditBilling = currentPaymentBackend() === "credits" ? body?.metadata?.billing || {} : null;
  const paymentCollected = currentPaymentBackend() === "credits"
    ? creditBilling?.billing_status === "charged"
    : true;
  const billingStatus = currentPaymentBackend() === "credits"
    ? creditBilling?.billing_status || "not_charged"
    : paidResponse.ok && schemaValid && !qualityErrors.length ? "charged_success" : "charged_provider_error";
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: body.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: options.ownerKey || "agentrouter_consumer",
    invocation_actor_key: options.ownerKey || undefined,
    payment_backend: currentPaymentBackend(),
    payment_tx: paymentTx,
    payment_collected: paymentCollected,
    billing_status: billingStatus,
    result_delivery_status: paidResponse.ok && schemaValid && !qualityErrors.length ? "delivered" : "failed_after_payment",
    settlement_receipt: settlementReceipt,
    status: paidResponse.ok ? "success" : "error",
    http_status: paidResponse.status,
    schema_valid: schemaValid,
    verification,
    business_error: qualityErrors[0] || null,
    latency_ms: Date.now() - started,
    consumer_rating: paidResponse.ok && schemaValid && !qualityErrors.length ? 1 : 0,
    created_at: new Date().toISOString()
  };
  const qualityEvent = createQualityEvent({
    serviceId,
    providerId: manifest.provider.provider_id,
    requestId: feedback.request_id,
    input,
    result: body,
    feedback,
    verification,
    schemaErrors,
    envelopeErrors,
    resultErrors: qualityErrors
  });
  record.feedback_events.push(feedback);
  record.quality_events = record.quality_events || [];
  record.quality_events.push(qualityEvent);
  store.feedbackEvents = store.feedbackEvents || [];
  store.qualityEvents = store.qualityEvents || [];
  store.invocationLogs = store.invocationLogs || [];
  store.feedbackEvents.push(feedback);
  store.qualityEvents.push(qualityEvent);
  store.invocationLogs.push({ service_id: serviceId, input, feedback });
  await writePersistentServiceEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId: feedback.request_id,
    event: feedback
  });
  await writePersistentServiceEvent({
    eventType: "quality_event",
    serviceId,
    requestId: feedback.request_id,
    event: qualityEvent
  });

  return {
    statusCode: paidResponse.status,
    body: {
      result: body,
      feedback
    }
  };
}

async function recordOperationalFailure(store, record, { input, statusCode, error, started }) {
  const serviceId = record.manifest.service_id;
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: `prepay_fail_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    service_id: serviceId,
    provider_id: record.manifest.provider.provider_id,
    consumer_id: "agentrouter_consumer",
    payment_tx: null,
    payment_collected: false,
    billing_status: "not_charged",
    result_delivery_status: "not_delivered",
    status: "error",
    http_status: statusCode,
    schema_valid: false,
    verification: null,
    business_error: error,
    latency_ms: Date.now() - started,
    consumer_rating: 0,
    created_at: new Date().toISOString()
  };
  record.feedback_events = record.feedback_events || [];
  record.feedback_events.push(feedback);
  store.feedbackEvents = store.feedbackEvents || [];
  store.invocationLogs = store.invocationLogs || [];
  store.feedbackEvents.push(feedback);
  store.invocationLogs.push({ service_id: serviceId, input, feedback });
  await writePersistentServiceEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId: feedback.request_id,
    event: feedback
  });
  return feedback;
}

async function createArcProofForProviderChallenge({ serviceId, manifest, payment, consumerId }) {
  const wallet = await readWallet();
  const policyManifest = {
    ...manifest,
    pricing: {
      ...manifest.pricing,
      network: payment.network,
      token_address: payment.token_address,
      pay_to: payment.pay_to,
      settlement_model: payment.settlement_model
    }
  };
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
  const balance = await assertArcUsdcBalance({ wallet, payment });
  const tx = await sendArcUsdcTransfer({ wallet, payment });
  const proof = createArcPaymentProof({
    wallet,
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    challenge: payment,
    tx
  });
  await recordPayment({
    event_version: "agent_server_side_arc_payment_event_v1",
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: consumerId,
    payer: wallet.address,
    payment_tx: tx.tx_hash,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    pay_to: payment.pay_to,
    challenge_nonce: payment.nonce,
    balance_before_payment: balance,
    arc_transfer: tx,
    status: "success"
  });
  return proof;
}

export async function runServiceHealthCheck(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return { ok: false, error: "SERVICE_NOT_FOUND" };
  const validation = await validateService(store, serviceId);
  record.health_checks = record.health_checks || [];
  const healthEvent = {
    event_version: "agent_service_health_check_v1",
    service_id: serviceId,
    provider_id: record.manifest.provider.provider_id,
    ok: validation.ok,
    validation,
    created_at: new Date().toISOString()
  };
  record.health_checks.push(healthEvent);
  await writePersistentServiceEvent({
    eventType: "health_check",
    serviceId,
    requestId: healthEvent.created_at,
    event: healthEvent
  });
  return healthEvent;
}

export function recordConsumerFeedback(store, body = {}, {
  actorKey = "",
  requireKnownInvocation = false
} = {}) {
  const serviceId = body.service_id;
  const record = store.services.get(serviceId);
  const requestId = body.request_id || body.feedback?.request_id;
  if (!requestId) {
    const error = new Error("request_id is required");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  // External API sources are callable and rateable but are not registry
  // entries, so their invocations live in the global event list. Without this
  // branch a successful Exa call could never be rated — only registry services
  // could — and reputation would only ever reflect failures.
  if (!record) {
    const external = [...(store.feedbackEvents || [])]
      .reverse()
      .find((event) => event.request_id === requestId && (!serviceId || event.service_id === serviceId));
    if (external) {
      assertFeedbackActor(external, actorKey);
      const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
      external.consumer_feedback = consumerFeedback;
      external.consumer_rating = consumerFeedback.consumer_score;
      if (actorKey) {
        external.consumer_feedback_actor_key = actorKey;
        external.consumer_id = actorKey;
      }
      external.updated_at = new Date().toISOString();
      return {
        ok: true,
        service_id: external.service_id,
        request_id: requestId,
        consumer_feedback: consumerFeedback,
        recorded_at: external.updated_at
      };
    }
    // Local connector runs execute on the user's device, so the server has no
    // prior event to attach to. Accept the rating and create the record, or
    // free local paths could never build a reputation at all.
    const localMatch = /^local_(?:search|post)_([a-z]+)_/.exec(requestId);
    if (localMatch) {
      const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
      const localServiceId = serviceId || `local_social_${localMatch[1]}`;
      const event = {
        event_version: "agent_local_connector_feedback_v1",
        request_id: requestId,
        service_id: localServiceId,
        provider_id: "local_browser_connector",
        consumer_id: actorKey || body.consumer_id || "unknown_consumer_agent",
        consumer_feedback_actor_key: actorKey || undefined,
        status: "success",
        schema_valid: true,
        execution_location: "user_device",
        consumer_feedback: consumerFeedback,
        consumer_rating: consumerFeedback.consumer_score,
        created_at: new Date().toISOString()
      };
      (store.feedbackEvents ||= []).push(event);
      return {
        ok: true,
        service_id: localServiceId,
        request_id: requestId,
        consumer_feedback: consumerFeedback,
        recorded_at: event.created_at
      };
    }
    const error = new Error("SERVICE_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
  const targetEvent = [...(record.feedback_events || [])].reverse().find((event) => event.request_id === requestId);
  if (targetEvent) {
    assertFeedbackActor(targetEvent, actorKey);
    targetEvent.consumer_feedback = consumerFeedback;
    targetEvent.consumer_rating = consumerFeedback.consumer_score;
    if (actorKey) {
      targetEvent.consumer_feedback_actor_key = actorKey;
      targetEvent.consumer_id = actorKey;
    }
    targetEvent.updated_at = new Date().toISOString();
  } else {
    if (requireKnownInvocation) {
      const error = new Error("INVOCATION_NOT_FOUND");
      error.statusCode = 404;
      error.code = "INVOCATION_NOT_FOUND";
      throw error;
    }
    record.feedback_events.push({
      event_version: "agent_service_feedback_v1",
      request_id: requestId,
      service_id: serviceId,
      provider_id: record.manifest.provider.provider_id,
      consumer_id: actorKey || body.consumer_id || "unknown_consumer_agent",
      consumer_feedback_actor_key: actorKey || undefined,
      status: "consumer_feedback_only",
      schema_valid: null,
      latency_ms: null,
      consumer_rating: consumerFeedback.consumer_score,
      consumer_feedback: consumerFeedback,
      created_at: new Date().toISOString()
    });
  }
  const event = {
    event_version: "agent_consumer_feedback_v1",
    service_id: serviceId,
    provider_id: record.manifest.provider.provider_id,
    request_id: requestId,
    consumer_id: actorKey || body.consumer_id || "unknown_consumer_agent",
    consumer_feedback_actor_key: actorKey || undefined,
    consumer_feedback: consumerFeedback,
    created_at: new Date().toISOString()
  };
  store.feedbackEvents.push(event);
  writePersistentServiceEvent({
    eventType: "consumer_feedback",
    serviceId,
    requestId,
    event
  }).catch(() => {});
  return {
    ok: true,
    service_id: serviceId,
    request_id: requestId,
    consumer_feedback: consumerFeedback,
    trust: summarizeTrust(record)
  };
}

function assertFeedbackActor(event, actorKey) {
  if (!actorKey) return;
  const invocationActor = event.invocation_actor_key || "";
  if (invocationActor && invocationActor !== actorKey) {
    const error = new Error("Feedback can only be submitted by the account that made this invocation.");
    error.statusCode = 403;
    error.code = "FORBIDDEN_FEEDBACK_ACTOR";
    throw error;
  }
  const existingActor = event.consumer_feedback_actor_key || "";
  if (!existingActor || existingActor === actorKey) return;
  const error = new Error("Feedback for this invocation was already claimed by another authenticated account.");
  error.statusCode = 403;
  error.code = "FORBIDDEN_FEEDBACK_ACTOR";
  throw error;
}

export async function hydratePersistentServiceEvents(store) {
  const events = await listPersistentServiceEvents();
  for (const row of events) {
    const event = row.event;
    if (row.event_type === "operational_feedback") {
      const record = store.services.get(row.service_id);
      if (record && !record.feedback_events.some((item) => item.request_id === event.request_id && item.payment_tx === event.payment_tx)) {
        record.feedback_events.push(event);
      }
      if (!store.feedbackEvents.some((item) => item.request_id === event.request_id && item.payment_tx === event.payment_tx)) {
        store.feedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "consumer_feedback") {
      const record = store.services.get(row.service_id);
      if (record) {
        const existing = [...record.feedback_events].reverse().find((item) => item.request_id === row.request_id);
        if (existing) {
          existing.consumer_feedback = event.consumer_feedback;
          existing.consumer_rating = event.consumer_feedback?.consumer_score ?? existing.consumer_rating;
        } else if (!record.feedback_events.some((item) => item.request_id === row.request_id && item.status === "consumer_feedback_only")) {
          record.feedback_events.push({
            event_version: "agent_service_feedback_v1",
            request_id: row.request_id,
            service_id: row.service_id,
            provider_id: record.manifest.provider.provider_id,
            consumer_id: event.consumer_id,
            status: "consumer_feedback_only",
            schema_valid: null,
            latency_ms: null,
            consumer_rating: event.consumer_feedback?.consumer_score ?? null,
            consumer_feedback: event.consumer_feedback,
            created_at: event.created_at
          });
        }
      }
      if (!store.feedbackEvents.some((item) => item.event_version === event.event_version && item.request_id === event.request_id && item.consumer_id === event.consumer_id)) {
        store.feedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "consumer_feedback_anchor") {
      const record = store.services.get(row.service_id);
      if (record) {
        const target = [...record.feedback_events].reverse().find((item) => item.request_id === row.request_id);
        if (target) {
          target.consumer_feedback_arc_anchor = event.arc_anchor;
          if (event.erc8004) target.consumer_feedback_erc8004 = event.erc8004;
          if (event.trust_anchor) target.consumer_feedback_trust_anchor = event.trust_anchor;
        }
      }
      const target = [...store.feedbackEvents].reverse().find((item) =>
        item.request_id === row.request_id &&
        item.service_id === row.service_id &&
        item.event_version === "agent_consumer_feedback_v1"
      );
      if (target) {
        target.arc_anchor = event.arc_anchor;
        if (event.erc8004) target.erc8004 = event.erc8004;
        if (event.trust_anchor) target.trust_anchor = event.trust_anchor;
      }
      continue;
    }
    if (row.event_type === "erc8004_identity") {
      const record = store.services.get(row.service_id);
      if (record && event.erc8004) {
        applyErc8004RegistrationToManifest(record.manifest, event.erc8004);
        if (record.manifest.provider?.provider_id) {
          store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
        }
      }
      continue;
    }
    if (row.event_type === "quality_event") {
      const record = store.services.get(row.service_id);
      if (record) {
        record.quality_events = record.quality_events || [];
        if (!record.quality_events.some((item) => item.quality_event_id === event.quality_event_id)) {
          record.quality_events.push(event);
        }
      }
      if (!store.qualityEvents.some((item) => item.quality_event_id === event.quality_event_id)) {
        store.qualityEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "health_check") {
      const record = store.services.get(row.service_id);
      if (record) {
        record.health_checks = record.health_checks || [];
        if (!record.health_checks.some((item) => item.created_at === event.created_at)) record.health_checks.push(event);
      }
      continue;
    }
    if (row.event_type === "route_observation") {
      if (!store.routeObservations.some((item) => item.observation_id === event.observation_id)) {
        store.routeObservations.push(event);
      }
      continue;
    }
    if (row.event_type === "evidence") {
      if (!store.evidenceEvents.some((item) => item.trace_hash === event.trace_hash)) {
        store.evidenceEvents.push(event);
      }
    }
  }
  return {
    ok: true,
    loaded: events.length
  };
}

function createQualityEvent({
  serviceId,
  providerId,
  requestId,
  input,
  result,
  feedback,
  verification,
  schemaErrors = [],
  envelopeErrors = [],
  resultErrors = []
}) {
  const businessError = resultErrors[0] || null;
  const blockingIssues = [
    ...schemaErrors.map((message) => ({ code: "SCHEMA_ERROR", message })),
    ...envelopeErrors.map((message) => ({ code: "ENVELOPE_ERROR", message })),
    ...resultErrors
  ];
  return {
    quality_event_id: `qe_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    event_version: "agent_service_quality_event_v1",
    service_id: serviceId,
    provider_id: providerId,
    request_id: requestId,
    input,
    status: blockingIssues.length ? "quality_issue" : "passed",
    deterministic_verification: verification,
    business_error: businessError ? { detected: true, ...businessError } : { detected: false },
    http_status: feedback.http_status,
    payment_tx: feedback.payment_tx,
    blocking_issue_count: blockingIssues.length,
    blocking_issues: blockingIssues,
    agent_feedback_expected: true,
    created_at: new Date().toISOString()
  };
}

export async function loadProviderConfigs(store, baseUrl, { validate = true } = {}) {
  const { listProviderConfigs } = await import("./provider-config.js");
  const configs = await listProviderConfigs();
  const loaded = [];
  for (const config of configs) {
    const manifest = withCurrentRuntimeEndpoint(config.manifest, baseUrl);
    if (store.services.has(manifest.service_id)) {
      const record = store.services.get(manifest.service_id);
      record.manifest = manifest;
      record.updated_at = record.updated_at || new Date().toISOString();
      store.providers.set(manifest.provider.provider_id, manifest.provider);
      loaded.push({ service_id: manifest.service_id, record, validation: record.validation_runs?.at(-1) || null, already_loaded: true });
      continue;
    }
    let record;
    try {
      record = registerService(store, manifest, baseUrl);
    } catch (error) {
      // A previous successful import can leave an equivalent config behind
      // under a different generated service id. Loading persisted configs must
      // be idempotent; keep the first verified source rather than breaking the
      // entire service catalogue with a 409 on every request.
      if (error.code === "SERVICE_SOURCE_ALREADY_REGISTERED" && error.existingServiceId) {
        const existing = store.services.get(error.existingServiceId);
        loaded.push({
          service_id: manifest.service_id,
          record: existing || null,
          validation: existing?.validation_runs?.at(-1) || null,
          duplicate_source: true,
          existing_service_id: error.existingServiceId
        });
        continue;
      }
      throw error;
    }
    let validation = null;
    if (validate) {
      try {
        validation = await validateService(store, manifest.service_id);
        if (!validation.ok) {
          unregisterService(store, manifest.service_id);
        }
      } catch (error) {
        validation = storeValidation(record, {
          ok: false,
          service_id: manifest.service_id,
          error: "VALIDATION_REQUEST_FAILED",
          message: error.message,
          created_at: new Date().toISOString()
        });
        unregisterService(store, manifest.service_id);
      }
    } else {
      validation = {
        ok: true,
        service_id: manifest.service_id,
        source: "persisted_provider_config",
        message: "Loaded from a provider config that was persisted after successful publish validation.",
        created_at: new Date().toISOString()
      };
      record.validation_runs.push(validation);
      record.verification_status = "verified";
    }
    loaded.push({ service_id: manifest.service_id, record, validation });
  }
  return loaded;
}

export function withCurrentRuntimeEndpoint(manifest, baseUrl) {
  const endpointUrl = manifest?.endpoint?.url || "";
  if (!baseUrl || !endpointUrl) return manifest;
  let pathname = "";
  try {
    pathname = new URL(endpointUrl).pathname;
  } catch {
    return manifest;
  }
  if (!pathname.startsWith("/provider/custom/")) return manifest;
  return finalizeManifest({
    ...manifest,
    endpoint: {
      ...manifest.endpoint,
      url: `${baseUrl.replace(/\/$/, "")}${pathname}`
    }
  });
}

function validateManifest(manifest) {
  const errors = [];
  for (const key of ["manifest_version", "service_id", "provider", "title", "description_for_agent", "capabilities", "input_schema", "output_schema", "sample_request", "sample_response", "pricing", "endpoint"]) {
    if (!manifest?.[key]) errors.push(`${key} is required`);
  }
  if (!manifest?.provider?.provider_id) errors.push("provider.provider_id is required");
  if (!manifest?.pricing?.amount || !manifest?.pricing?.currency || !manifest?.pricing?.network) errors.push("pricing amount/currency/network are required");
  if (!manifest?.endpoint?.url) errors.push("endpoint.url is required");
  if (manifest?.service_id && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(manifest.service_id)) errors.push("service_id must be 3-64 chars and use lowercase letters, numbers, _ or -");
  if (manifest?.pricing?.amount && !(Number(manifest.pricing.amount) > 0)) errors.push("pricing.amount must be positive");
  if (manifest?.capabilities && (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0)) errors.push("capabilities must be a non-empty array");
  return errors;
}

function storeValidation(record, result) {
  record.validation_runs.push(result);
  record.verification_status = result.ok ? "verified" : "failed";
  record.updated_at = new Date().toISOString();
  return result;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}

function validateRealResultFeedback(envelope) {
  const errors = [];
  if (envelope?.status !== "success") {
    errors.push({ code: "RESULT_STATUS_NOT_SUCCESS", message: "Provider envelope status is not success." });
  }
  const data = envelope?.data;
  if (isEmptyData(data)) {
    errors.push({ code: "RESULT_DATA_EMPTY", message: "Provider returned no usable data." });
    return errors;
  }
  if (looksLikePlaceholderData(data)) {
    errors.push({ code: "RESULT_DATA_PLACEHOLDER", message: "Provider returned placeholder data instead of a real result." });
  }
  const applicationError = detectApplicationErrorData(data);
  if (applicationError) errors.push(applicationError);
  return errors;
}

function isEmptyData(data) {
  if (data === undefined || data === null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") {
    const keys = Object.keys(data);
    if (!keys.length) return true;
    if (Object.prototype.hasOwnProperty.call(data, "data") && data.data === null) return true;
    if (Array.isArray(data.data) && data.data.length === 0) return true;
  }
  return data === "";
}

function looksLikePlaceholderData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && data.ok === true;
}

function detectApplicationErrorData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const message = String(data.message || data.error || data.msg || "").toLowerCase();
  if (/missing api key|api key missing|invalid api key|unauthorized|forbidden|token|auth/.test(message)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "auth_or_permission_error",
      message: data.message || data.error || data.msg || "Upstream API reported an authentication or permission error."
    };
  }
  const status = data.status ?? data.code;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : status;
  const successStatuses = new Set([0, 1, 200, "0", "1", "200", "ok", "success", "succeeded"]);
  if (status !== undefined && !successStatuses.has(normalizedStatus) && (data.message || data.error || data.data === null)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "non_success_status",
      message: data.message || data.error || `Upstream API returned non-success status ${status}.`
    };
  }
  if (data.data === null && (data.message || data.error)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "empty_error_payload",
      message: data.message || data.error || "Upstream API returned null data with an error-like message."
    };
  }
  return null;
}

function previewResultData(data) {
  if (data === undefined) return null;
  return compactPreview(data);
}

function compactPreview(value, { maxArrayItems = 5, maxObjectKeys = 24, maxStringLength = 240 } = {}) {
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems).map((item) => compactPreview(item, { maxArrayItems, maxObjectKeys, maxStringLength }));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const output = {};
    for (const [key, child] of entries.slice(0, maxObjectKeys)) {
      output[key] = compactPreview(child, { maxArrayItems, maxObjectKeys, maxStringLength });
    }
    if (entries.length > maxObjectKeys) {
      output.__preview_truncated_keys = entries.length - maxObjectKeys;
    }
    return output;
  }
  if (typeof value === "string" && value.length > maxStringLength) {
    return `${value.slice(0, maxStringLength)}...`;
  }
  return value;
}
