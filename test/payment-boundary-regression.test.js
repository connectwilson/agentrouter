import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-payment-boundary-"));
const priorEnvironment = Object.fromEntries([
  "ADN_DIR",
  "ADN_PAYMENT_BACKEND",
  "ADN_SETTLEMENT_CHAIN",
  "ADN_PROVIDER_RECEIVE_ADDRESS",
  "ADN_ARC_VERIFY_MODE",
  "ADN_EVIDENCE_ANCHOR_MODE",
  "DATABASE_URL"
].map((key) => [key, process.env[key]]));

process.env.ADN_DIR = path.join(runtimeRoot, "shared-adn-state");
process.env.ADN_PAYMENT_BACKEND = "circle_arc";
process.env.ADN_SETTLEMENT_CHAIN = "bsc";
process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.ADN_ARC_VERIFY_MODE = "mock";
process.env.ADN_EVIDENCE_ANCHOR_MODE = "mock";
delete process.env.DATABASE_URL;

const { createServer } = await import("../src/server.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const { createArcPaymentProof } = await import("../src/payment.js");
const { registerService } = await import("../src/registry.js");
const { createMemoryStore } = await import("../src/store.js");
const { deriveAddress } = await import("../src/wallet.js");

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYMENT_TX = `0x${"9".repeat(64)}`;
const BASE_USDC = "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913";

test.after(async () => {
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(runtimeRoot, { recursive: true, force: true });
});

test("completed-call payment verification cannot be bypassed with a caller-selected foreign network", async () => {
  const store = createMemoryStore();
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = "payment_network_boundary";
  manifest.provider = {
    ...manifest.provider,
    provider_id: "provider_payment_network_boundary",
    payout_address: PAY_TO
  };
  manifest.pricing = {
    ...manifest.pricing,
    network: "bsc",
    caip2: "eip155:56",
    chain_id: 56,
    pay_to: PAY_TO
  };
  manifest.sample_response.service_id = manifest.service_id;
  registerService(store, manifest, "http://127.0.0.1");
  store.authSessions.set("payment-owner", {
    user: { provider: "github", id: "payment-owner", handle: "payment-owner" },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });

  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = structuredClone(manifest.sample_response);
    result.request_id = "req_network_cannot_be_caller_selected";
    result.metadata.generated_at = new Date().toISOString();
    const response = await fetch(`${baseUrl}/agent-router/calls/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ar_session=payment-owner"
      },
      body: JSON.stringify({
        service_id: manifest.service_id,
        input: manifest.sample_request,
        result,
        feedback: {
          request_id: result.request_id,
          service_id: manifest.service_id,
          status: "success",
          payment_tx: PAYMENT_TX,
          settlement_receipt: {
            network: "base",
            caip2: "eip155:8453",
            chain_id: 8453,
            asset: "USDC",
            amount: manifest.pricing.amount,
            pay_to: PAY_TO,
            tx_hash: PAYMENT_TX,
            status: "settled"
          }
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 422);
    assert.equal(payload.status, "payment_verification_failed");
    assert.equal(payload.error.code, "PAYMENT_NETWORK_MISMATCH");
    assert.equal(store.feedbackEvents.length, 0);
    assert.equal(store.evidenceEvents.length, 0);
    assert.equal(store.qualityEvents.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one settlement transaction cannot buy a second result after a fresh runtime starts", { timeout: 20_000 }, async () => {
  const wallet = createTestWallet();
  let firstRuntime;
  let secondRuntime;
  try {
    firstRuntime = await startProviderRuntime();
    const firstChallenge = await issueFundFlowChallenge(firstRuntime.baseUrl);
    const firstResponse = await submitFundFlowPayment(firstRuntime.baseUrl, firstChallenge, wallet, PAYMENT_TX);
    assert.equal(firstResponse.status, 200, "the original settlement should buy exactly one result");
    await stopProviderRuntime(firstRuntime);
    firstRuntime = null;

    secondRuntime = await startProviderRuntime();
    const secondChallenge = await issueFundFlowChallenge(secondRuntime.baseUrl);
    const replay = await submitFundFlowPayment(secondRuntime.baseUrl, secondChallenge, wallet, PAYMENT_TX);
    const payload = await replay.json();

    assert.equal(replay.status, 402);
    assert.equal(payload.code, "ARC_TX_ALREADY_SETTLED");
  } finally {
    if (firstRuntime) await stopProviderRuntime(firstRuntime);
    if (secondRuntime) await stopProviderRuntime(secondRuntime);
  }
});

test("official x402 policy filters live terms that raise price or change payTo, chain, or asset before signing", async () => {
  const localInvoke = await import("../src/local-invoke.js");
  assert.equal(
    typeof localInvoke.createManifestBoundX402Policy,
    "function",
    "local paid invocation must expose the manifest/budget-bound policy used by the x402 signer"
  );

  const manifest = {
    service_id: "manifest_bound_x402",
    provider: { provider_id: "provider_manifest_bound_x402" },
    pricing: {
      amount: "0.01",
      currency: "USDC",
      network: "base",
      caip2: "eip155:8453",
      token_address: BASE_USDC,
      pay_to: PAY_TO
    }
  };
  const policy = localInvoke.createManifestBoundX402Policy({
    manifest,
    budget: { max_amount: "0.02", currency: "USDC" }
  });
  const declared = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: BASE_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {}
  };

  assert.deepEqual(policy(2, [declared]), [declared]);
  assert.deepEqual(policy(2, [{ ...declared, amount: "10001" }]), [], "a live price increase must not reach the signer");
  assert.deepEqual(policy(2, [{ ...declared, payTo: "0x2222222222222222222222222222222222222222" }]), [], "a changed recipient must not reach the signer");
  assert.deepEqual(policy(2, [{ ...declared, network: "eip155:1" }]), [], "a changed chain must not reach the signer");
  assert.deepEqual(policy(2, [{ ...declared, asset: "0x3333333333333333333333333333333333333333" }]), [], "a changed asset must not reach the signer");
});

function createTestWallet() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  return {
    address: deriveAddress(publicKeyPem),
    public_key_pem: publicKeyPem,
    private_key_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

async function issueFundFlowChallenge(baseUrl) {
  const response = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: "base", days: 7 })
  });
  assert.equal(response.status, 402);
  return (await response.json()).payment;
}

async function submitFundFlowPayment(baseUrl, challenge, wallet, txHash) {
  const proof = createArcPaymentProof({
    wallet,
    serviceId: "chain_fund_flow_7d_base",
    amount: challenge.amount,
    currency: challenge.asset,
    network: challenge.network,
    payTo: challenge.pay_to,
    challenge,
    tx: {
      tx_hash: txHash,
      amount_atomic: "10000000000000000",
      explorer_url: `https://bscscan.com/tx/${txHash}`
    }
  });
  return fetch(`${baseUrl}/provider/chain-fund-flow`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": proof },
    body: JSON.stringify({ chain: "base", days: 7 })
  });
}

async function startProviderRuntime() {
  const script = [
    'import { createServer } from "./src/server.js";',
    "const server = createServer();",
    'server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));'
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADN_DIR: process.env.ADN_DIR,
      ADN_PAYMENT_BACKEND: "circle_arc",
      ADN_SETTLEMENT_CHAIN: "bsc",
      ADN_PROVIDER_RECEIVE_ADDRESS: PAY_TO,
      ADN_ARC_VERIFY_MODE: "mock",
      ADN_EVIDENCE_ANCHOR_MODE: "mock"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`provider runtime did not start: ${stderr}`));
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`provider runtime exited before listening (${code}): ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const { port } = JSON.parse(stdout.slice(0, newline));
        clearTimeout(timer);
        resolve({ child, baseUrl: `http://127.0.0.1:${port}` });
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(error);
      }
    });
  });
}

async function stopProviderRuntime(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  await once(runtime.child, "exit");
}
