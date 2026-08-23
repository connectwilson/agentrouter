import { decodePaymentRequiredHeader } from "@x402/core/http";

import { invokeWithRealX402 } from "./real-x402-client.js";

export const ONE_DOLLAR_AUDIT = Object.freeze({
  auditUrl: "https://leftclaw.services/api/audit",
  statusUrl: "https://onedollaraudit.com/api/jobs/{jobId}",
  network: "eip155:8453",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  maxAmountAtomic: 1_000_000n,
  maxDescriptionLength: 12_000
});

export function validateOneDollarAuditInput(input = {}) {
  const description = String(input.description || "").trim();
  if (!description) return invalid("DESCRIPTION_REQUIRED", "description is required.");
  if (description.length > ONE_DOLLAR_AUDIT.maxDescriptionLength) {
    return invalid("DESCRIPTION_TOO_LONG", `description must be at most ${ONE_DOLLAR_AUDIT.maxDescriptionLength} characters.`);
  }
  // Audits are public by design. Catch the most dangerous accidental secret
  // paste before an upstream request or a payment can occur.
  if (/(?:private[ _-]?key|seed phrase|mnemonic)\s*[:=]?\s*(?:0x)?[0-9a-f]{32,}/i.test(description)) {
    return invalid("SECRET_LIKE_CONTENT", "description appears to contain a private key or seed material.");
  }
  const callbackUrl = input.callbackUrl ? String(input.callbackUrl).trim() : "";
  if (callbackUrl) {
    try {
      const parsed = new URL(callbackUrl);
      if (parsed.protocol !== "https:") return invalid("INVALID_CALLBACK_URL", "callbackUrl must use HTTPS.");
    } catch {
      return invalid("INVALID_CALLBACK_URL", "callbackUrl must be a valid HTTPS URL.");
    }
  }
  return { ok: true, value: { description, ...(callbackUrl ? { callbackUrl } : {}) } };
}

export function inspectOneDollarAuditPayment(paymentRequired = {}) {
  const accepted = (paymentRequired.accepts || []).find((item) =>
    String(item.network || "").toLowerCase() === ONE_DOLLAR_AUDIT.network
    && String(item.asset || "").toLowerCase() === ONE_DOLLAR_AUDIT.usdc
    && String(item.scheme || "exact").toLowerCase() === "exact");
  if (!accepted) {
    return invalid("UPSTREAM_PAYMENT_TERMS_MISMATCH", "ODA did not offer exact Base USDC payment terms.");
  }
  const rawAmount = String(accepted.amount ?? accepted.maxAmountRequired ?? "");
  let amount;
  try {
    amount = BigInt(rawAmount);
  } catch {
    return invalid("UPSTREAM_PAYMENT_TERMS_MISMATCH", "ODA returned an invalid payment amount.");
  }
  if (amount > ONE_DOLLAR_AUDIT.maxAmountAtomic) {
    return invalid("UPSTREAM_PRICE_EXCEEDS_LIMIT", "ODA requested more than the declared 1 USDC maximum.");
  }
  if (amount <= 0n) return invalid("UPSTREAM_PAYMENT_TERMS_MISMATCH", "ODA returned a non-positive payment amount.");
  return { ok: true, accepted, amount_atomic: rawAmount, amount_usdc: formatUsdc(amount) };
}

export async function executeOneDollarAudit(config, input = {}, options = {}) {
  const serviceId = config?.manifest?.service_id || "one_dollar_audit";
  const validated = validateOneDollarAuditInput(input);
  if (!validated.ok) return executionError(serviceId, input, validated.error.code, validated.error.message, false);

  const privateKey = String(options.privateKey ?? process.env.ADN_UPSTREAM_X402_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
    return executionError(
      serviceId,
      input,
      "UPSTREAM_X402_PAYER_NOT_CONFIGURED",
      "A dedicated ADN_UPSTREAM_X402_PRIVATE_KEY is required for ODA. The evidence-anchor key is never used for provider payments.",
      false
    );
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(config.source.upstream_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validated.value),
      signal: AbortSignal.timeout(Number(process.env.ADN_UPSTREAM_TIMEOUT_MS || 15000))
    });
  } catch (error) {
    return executionError(serviceId, input, "UPSTREAM_PREFLIGHT_FAILED", error.message, true);
  }
  if (response.status !== 402) {
    return executionError(serviceId, input, "EXPECTED_UPSTREAM_X402", `ODA preflight returned HTTP ${response.status}, expected 402.`, response.status >= 500);
  }

  let paymentRequired;
  try {
    const header = response.headers.get("payment-required");
    paymentRequired = header ? decodePaymentRequiredHeader(header) : await response.json();
  } catch {
    return executionError(serviceId, input, "INVALID_UPSTREAM_PAYMENT_TERMS", "ODA returned unreadable x402 payment terms.", false);
  }
  const terms = inspectOneDollarAuditPayment(paymentRequired);
  if (!terms.ok) return executionError(serviceId, input, terms.error.code, terms.error.message, false);

  if (!options.allowPaidUpstream) {
    return {
      status: 200,
      body: envelope(serviceId, input, {
        readiness: "payment_terms_validated",
        amount_usdc: terms.amount_usdc,
        network: ONE_DOLLAR_AUDIT.network,
        payment_collected: false
      }, "ODA x402 terms validated; no audit job was created during preflight.")
    };
  }

  try {
    const invokePaid = options.invokePaid || invokeWithRealX402;
    const paid = await invokePaid({
      url: config.source.upstream_url,
      method: "POST",
      body: JSON.stringify(validated.value),
      wallet: { private_key_hex: privateKey },
      fetchImpl,
      // Re-check the live 402 returned to the payment wrapper. The separate
      // preflight improves error messages, but this policy closes the window in
      // which an upstream could change network, asset, or price before signing.
      paymentPolicy: (_version, requirements) => requirements.filter((requirement) =>
        inspectOneDollarAuditPayment({ accepts: [requirement] }).ok)
    });
    return { status: 200, body: normalizeOneDollarAuditJob(paid.payload, input, paid) };
  } catch (error) {
    return executionError(serviceId, input, "UPSTREAM_PAID_CALL_FAILED", error.message, true);
  }
}

export function normalizeOneDollarAuditJob(payload = {}, input = {}, paid = {}) {
  const jobId = String(payload.jobId || payload.job_id || "").trim();
  if (!jobId) return executionError("one_dollar_audit", input, "INVALID_JOB_RECEIPT", "ODA did not return a jobId.", false).body;
  return envelope("one_dollar_audit", input, {
    job_id: jobId,
    job_url: payload.jobUrl || payload.job_url || null,
    status: "pending",
    status_url: ONE_DOLLAR_AUDIT.statusUrl.replace("{jobId}", encodeURIComponent(jobId)),
    status_polling_price: "0",
    payment_tx: paid.payment_tx || null
  }, "ODA accepted the audit. Persist job_id and poll the free status endpoint; do not repay.");
}

export async function readOneDollarAuditStatus(jobId, options = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return executionError("one_dollar_audit_status", {}, "JOB_ID_REQUIRED", "jobId is required.", false).body;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = ONE_DOLLAR_AUDIT.statusUrl.replace("{jobId}", encodeURIComponent(cleanJobId));
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
  if (response.status === 404) {
    return { ...envelope("one_dollar_audit_status", { jobId: cleanJobId }, { job_id: cleanJobId, status: "pending", status_url: url }, "The job is not indexed yet; retry without payment."), retry_after_seconds: Number(response.headers.get("retry-after") || 5) };
  }
  if (!response.ok) return executionError("one_dollar_audit_status", { jobId: cleanJobId }, "STATUS_LOOKUP_FAILED", `ODA status returned HTTP ${response.status}.`, response.status >= 500).body;
  const payload = await response.json();
  return envelope("one_dollar_audit_status", { jobId: cleanJobId }, {
    job_id: cleanJobId,
    status: payload.status,
    status_url: url,
    report_url: payload.reportUrl || null,
    report_html_url: payload.reportHtmlUrl || null
  }, payload.status === "complete" ? "ODA audit is complete." : "ODA audit is still processing; poll again without payment.");
}

function envelope(serviceId, query, data, summary) {
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: `oda_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    status: "success",
    query,
    data,
    metadata: {
      data_sources: ["one_dollar_audit"],
      generated_at: new Date().toISOString(),
      freshness_seconds: 0,
      is_estimated: false,
      confidence: 1,
      limitations: ["AI first-pass audit; not a substitute for a full manual audit for high-value contracts."]
    },
    agent_hints: {
      good_for: ["Fast first-pass smart-contract security review"],
      warnings: ["Audit submissions and reports are public.", "Persist job_id; never pay again to poll status."],
      suggested_followups: ["Poll status_url until complete, then review report_url."]
    },
    summary
  };
}

function executionError(serviceId, query, code, message, retryable) {
  return { status: code === "UPSTREAM_X402_PAYER_NOT_CONFIGURED" ? 503 : 422, body: {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: `oda_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    status: "error",
    query,
    payment_collected: false,
    billing_status: "not_charged",
    error: { code, message, retryable }
  } };
}

function invalid(code, message) {
  return { ok: false, error: { code, message } };
}

function formatUsdc(amount) {
  const whole = amount / 1_000_000n;
  const fraction = String(amount % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
