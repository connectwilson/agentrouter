import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-provider-depth-"));
const managedEnvironment = [
  "ADN_DIR",
  "ADN_PAYMENT_BACKEND",
  "ADN_SETTLEMENT_CHAIN",
  "ADN_PROVIDER_RECEIVE_ADDRESS",
  "ADN_ARC_VERIFY_MODE",
  "ADN_EVIDENCE_ANCHOR_MODE",
  "DATABASE_URL"
];
const previousEnvironment = Object.fromEntries(managedEnvironment.map((key) => [key, process.env[key]]));

process.env.ADN_DIR = runtimeRoot;
process.env.ADN_PAYMENT_BACKEND = "circle_arc";
process.env.ADN_SETTLEMENT_CHAIN = "bsc";
process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.ADN_ARC_VERIFY_MODE = "mock";
process.env.ADN_EVIDENCE_ANCHOR_MODE = "mock";
delete process.env.DATABASE_URL;

const { issueCompletionGrant } = await import("../src/completion-grant.js");
const { hashJson } = await import("../src/evidence.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const { invokePaidService, registerService } = await import("../src/registry.js");
const { createServer } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

test.after(async () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(runtimeRoot, { recursive: true, force: true });
});

test("direct provider route rejects pending and failed services before issuing a payment challenge", async () => {
  const store = createMemoryStore();
  const manifest = bscManifest("chain_fund_flow_7d_base", "http://127.0.0.1/provider/chain-fund-flow");
  const record = registerService(store, manifest, "http://127.0.0.1");
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const status of ["pending", "failed"]) {
      record.verification_status = status;
      const response = await postJson(`${baseUrl}/provider/chain-fund-flow`, manifest.sample_request);
      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.error.code, "SERVICE_NOT_VERIFIED");
      assert.equal(payload.payment, undefined, "an unverified provider must not receive a payment challenge");
    }

    record.verification_status = "verified";
    const verifiedResponse = await postJson(`${baseUrl}/provider/chain-fund-flow`, manifest.sample_request);
    assert.equal(verifiedResponse.status, 402, "verified provider challenge flow remains compatible");
    assert.ok((await verifiedResponse.json()).payment?.completion_grant);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("completed-call ingestion rejects pending and failed services before evidence trust or anchoring writes", async () => {
  const store = createMemoryStore();
  const manifest = bscManifest("completion_unverified_service", "https://provider.example/data");
  const record = registerService(store, manifest, "https://registry.example");
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [index, status] of ["pending", "failed"].entries()) {
      record.verification_status = status;
      const before = trustMutationCounts(store, record);
      const completion = validCompletionBody(manifest, index);
      const response = await postJson(`${baseUrl}/agent-router/calls/complete`, completion);
      const payload = await response.json();

      assert.equal(response.status, 409);
      assert.equal(payload.error.code, "SERVICE_NOT_VERIFIED");
      assert.deepEqual(trustMutationCounts(store, record), before);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("completed-call ingestion remains compatible for a verified service", async () => {
  const store = createMemoryStore();
  const manifest = bscManifest("completion_verified_service", "https://provider.example/data");
  const record = registerService(store, manifest, "https://registry.example");
  record.verification_status = "verified";
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await postJson(`${baseUrl}/agent-router/calls/complete`, validCompletionBody(manifest, 9));
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.status, "completed_invocation_recorded");
    assert.equal(store.feedbackEvents.length, 1);
    assert.equal(store.evidenceEvents.length, 1);
    assert.equal(store.qualityEvents.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credits invocation uses bounded safe transport and blocks redirects before forwarding credentials", { concurrency: false }, async () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousFetch = globalThis.fetch;
  process.env.ADN_PAYMENT_BACKEND = "credits";
  let globalFetches = 0;
  let safeHops = 0;
  globalThis.fetch = async () => {
    globalFetches += 1;
    return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  };
  try {
    const { store, manifest } = verifiedCreditsService("credits_redirect_safe_transport");
    const result = await invokePaidService(store, manifest.service_id, manifest.sample_request, {}, {
      consumerApiKey: "consumer-secret-must-not-escape",
      providerTransportOptions: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHop: async () => {
          safeHops += 1;
          return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
        }
      }
    });

    assert.equal(result.statusCode, 502);
    assert.equal(result.body.error.code, "CREDITS_PROVIDER_REDIRECT_BLOCKED");
    assert.equal(globalFetches, 0, "credits calls must not use raw global fetch");
    assert.equal(safeHops, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  }
});

test("credits invocation has a typed timeout before any billing result is accepted", { concurrency: false }, async () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousFetch = globalThis.fetch;
  process.env.ADN_PAYMENT_BACKEND = "credits";
  let globalFetches = 0;
  globalThis.fetch = async () => {
    globalFetches += 1;
    return Response.json({ status: "success", data: { unsafe: true } });
  };
  try {
    const { store, manifest } = verifiedCreditsService("credits_timeout_safe_transport");
    const result = await invokePaidService(store, manifest.service_id, manifest.sample_request, {}, {
      consumerApiKey: "consumer-secret",
      providerTransportOptions: {
        timeoutMs: 15,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHop: async () => new Promise(() => {})
      }
    });

    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error.code, "CREDITS_PROVIDER_UNAVAILABLE");
    assert.equal(result.body.error.cause_code, "PROVIDER_HTTP_TIMEOUT");
    assert.equal(globalFetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  }
});

test("credits invocation rejects an oversized response before JSON parsing", { concurrency: false }, async () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousFetch = globalThis.fetch;
  process.env.ADN_PAYMENT_BACKEND = "credits";
  let globalFetches = 0;
  globalThis.fetch = async () => {
    globalFetches += 1;
    return Response.json({ status: "success", data: { unsafe: true } });
  };
  try {
    const { store, manifest } = verifiedCreditsService("credits_size_safe_transport");
    const result = await invokePaidService(store, manifest.service_id, manifest.sample_request, {}, {
      consumerApiKey: "consumer-secret",
      providerTransportOptions: {
        maxResponseBytes: 32,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHop: async () => new Response(JSON.stringify({ status: "success", data: "x".repeat(100) }))
      }
    });

    assert.equal(result.statusCode, 502);
    assert.equal(result.body.error.code, "CREDITS_PROVIDER_RESPONSE_TOO_LARGE");
    assert.equal(globalFetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  }
});

function bscManifest(serviceId, endpointUrl) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.provider = {
    ...manifest.provider,
    provider_id: `provider_${serviceId}`,
    payout_address: PAY_TO
  };
  manifest.endpoint = { ...manifest.endpoint, url: endpointUrl };
  manifest.pricing = {
    ...manifest.pricing,
    network: "bsc",
    caip2: "eip155:56",
    chain_id: 56,
    pay_to: PAY_TO
  };
  manifest.sample_response.service_id = serviceId;
  return manifest;
}

function validCompletionBody(manifest, suffix) {
  const input = structuredClone(manifest.sample_request);
  const result = structuredClone(manifest.sample_response);
  delete result.sample_type;
  result.service_id = manifest.service_id;
  result.request_id = `req_completion_depth_${suffix}`;
  result.metadata.generated_at = new Date().toISOString();
  result.metadata.is_estimated = false;
  const completionNonce = `completion_nonce_${suffix}`;
  const paymentTx = `0x${String(suffix + 1).slice(-1).repeat(64)}`;
  return {
    service_id: manifest.service_id,
    input,
    result,
    completion_nonce: completionNonce,
    completion_grant: issueCompletionGrant({
      serviceId: manifest.service_id,
      inputHash: hashJson(input),
      challengeNonce: completionNonce,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    local_payment: {
      payer: PAYER,
      payment_tx: paymentTx,
      amount: manifest.pricing.amount,
      currency: "USDC",
      network: "bsc",
      pay_to: PAY_TO,
      challenge_nonce: completionNonce,
      status: "success",
      backend: "circle_arc"
    },
    feedback: {
      request_id: result.request_id,
      service_id: manifest.service_id,
      status: "success",
      payment_tx: paymentTx,
      settlement_receipt: {
        network: "bsc",
        caip2: "eip155:56",
        chain_id: 56,
        asset: "USDC",
        amount: manifest.pricing.amount,
        pay_to: PAY_TO,
        tx_hash: paymentTx,
        status: "settled"
      }
    }
  };
}

function verifiedCreditsService(serviceId) {
  const store = createMemoryStore();
  const manifest = bscManifest(serviceId, `https://agentrouter.network/provider/custom/${serviceId}`);
  const record = registerService(store, manifest, "https://agentrouter.network");
  record.verification_status = "verified";
  return { store, manifest: record.manifest };
}

function trustMutationCounts(store, record) {
  return {
    record_feedback: record.feedback_events.length,
    record_quality: record.quality_events.length,
    store_feedback: store.feedbackEvents.length,
    store_evidence: store.evidenceEvents.length,
    store_quality: store.qualityEvents.length,
    feedback_grants: store.feedbackGrants?.size || 0
  };
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
