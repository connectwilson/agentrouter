import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  inspectOneDollarAuditPayment,
  normalizeOneDollarAuditJob,
  readOneDollarAuditStatus,
  validateOneDollarAuditInput
} from "../src/one-dollar-audit.js";
import { executeProviderConfig } from "../src/provider-runtime.js";

const configPath = new URL("../providers/one_dollar_audit.json", import.meta.url);

test("One Dollar Audit is registered as a one-time async x402 service", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.source.type, "external_x402_async");
  assert.equal(config.source.upstream_url, "https://leftclaw.services/api/audit");
  assert.equal(config.source.status_url_template, "https://onedollaraudit.com/api/jobs/{jobId}");
  assert.equal(config.manifest.pricing.amount, "1.00");
  assert.equal(config.manifest.pricing.network, "base");
  assert.equal(config.manifest.pricing.protocol, "x402");
  assert.equal(config.manifest.pricing.payment_timing, "once_on_job_creation");
  assert.equal(config.manifest.async_result.status_polling.price, "0");
});

test("audit input is rejected before payment when unsafe or malformed", () => {
  assert.equal(validateOneDollarAuditInput({}).error.code, "DESCRIPTION_REQUIRED");
  assert.equal(validateOneDollarAuditInput({ description: "x".repeat(12001) }).error.code, "DESCRIPTION_TOO_LONG");
  assert.equal(validateOneDollarAuditInput({ description: "audit 0xabc, private key: 0x" + "1".repeat(64) }).error.code, "SECRET_LIKE_CONTENT");
  assert.equal(validateOneDollarAuditInput({ description: "Audit verified contract 0x1111111111111111111111111111111111111111" }).ok, true);
});

test("upstream x402 terms must match the declared one-dollar Base USDC ceiling", () => {
  const valid = inspectOneDollarAuditPayment({
    accepts: [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000000" }]
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.amount_usdc, "1");

  assert.equal(inspectOneDollarAuditPayment({
    accepts: [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000001" }]
  }).error.code, "UPSTREAM_PRICE_EXCEEDS_LIMIT");
  assert.equal(inspectOneDollarAuditPayment({
    accepts: [{ network: "eip155:1", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000000" }]
  }).error.code, "UPSTREAM_PAYMENT_TERMS_MISMATCH");
});

test("job creation response is normalized and preserves the durable polling handle", () => {
  const envelope = normalizeOneDollarAuditJob(
    { jobId: "job_123", jobUrl: "https://onedollaraudit.com/jobs/job_123" },
    { description: "Audit contract 0x1111111111111111111111111111111111111111" }
  );
  assert.equal(envelope.status, "success");
  assert.equal(envelope.data.job_id, "job_123");
  assert.equal(envelope.data.status, "pending");
  assert.equal(envelope.data.status_url, "https://onedollaraudit.com/api/jobs/job_123");
  assert.equal(envelope.data.status_polling_price, "0");
});

test("status polling is free and normalizes pending and complete jobs", async () => {
  const calls = [];
  const result = await readOneDollarAuditStatus("job_123", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "complete", reportUrl: "https://onedollaraudit.com/reports/job_123" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers?.["payment-signature"], undefined);
  assert.equal(result.data.status, "complete");
  assert.equal(result.data.report_url, "https://onedollaraudit.com/reports/job_123");
});

test("missing upstream payer is a dry-run failure and never reuses the evidence anchor key", async () => {
  const oldUpstream = process.env.ADN_UPSTREAM_X402_PRIVATE_KEY;
  const oldEvidence = process.env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY;
  delete process.env.ADN_UPSTREAM_X402_PRIVATE_KEY;
  process.env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY = `0x${"1".repeat(64)}`;
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const result = await executeProviderConfig(config, config.manifest.sample_request);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.error.code, "UPSTREAM_X402_PAYER_NOT_CONFIGURED");
    assert.equal(result.body.payment_collected, false);
  } finally {
    if (oldUpstream === undefined) delete process.env.ADN_UPSTREAM_X402_PRIVATE_KEY;
    else process.env.ADN_UPSTREAM_X402_PRIVATE_KEY = oldUpstream;
    if (oldEvidence === undefined) delete process.env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY;
    else process.env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY = oldEvidence;
  }
});
