import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { createMemoryStore } from "../src/store.js";

const previousEnvironment = {
  chain: process.env.ADN_SETTLEMENT_CHAIN,
  treasury: process.env.ADN_CREDITS_TREASURY_ADDRESS,
  proofSecret: process.env.ADN_DEPOSIT_OWNERSHIP_SECRET
};
process.env.ADN_SETTLEMENT_CHAIN = "bsc";
process.env.ADN_CREDITS_TREASURY_ADDRESS = "0x00000000000000000000000000000000000abcde";
process.env.ADN_DEPOSIT_OWNERSHIP_SECRET = "deposit-proof-test-secret-with-at-least-32-characters";

const creditCrypto = await import("../src/credit-crypto.js");
const credits = await import("../src/credits.js");

const SIGNER = privateKeyToAccount(`0x${"1".repeat(64)}`);
const SENDER = SIGNER.address.toLowerCase();
const OTHER_SENDER = "0x2222222222222222222222222222222222222222";
const TREASURY_TOPIC = "0x00000000000000000000000000000000000000000000000000000000000abcde";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const TX_A = `0x${"a".repeat(64)}`;
const TX_B = `0x${"b".repeat(64)}`;
const TX_C = `0x${"c".repeat(64)}`;
const DOMAIN = "agentrouter.network";

test.after(() => {
  restoreEnvironment("ADN_SETTLEMENT_CHAIN", previousEnvironment.chain);
  restoreEnvironment("ADN_CREDITS_TREASURY_ADDRESS", previousEnvironment.treasury);
  restoreEnvironment("ADN_DEPOSIT_OWNERSHIP_SECRET", previousEnvironment.proofSecret);
});

test("a public transaction hash cannot claim a fresh sender without a signed ownership challenge", async () => {
  assert.equal(typeof creditCrypto.createDepositOwnershipChallenge, "function");
  assert.equal(typeof creditCrypto.verifyDepositOwnershipProof, "function");

  const store = createMemoryStore();
  const alice = await credits.ensureCreditAccount(store, { provider: "github", id: "proof-alice", login: "alice" });
  const bob = await credits.ensureCreditAccount(store, { provider: "github", id: "proof-bob", login: "bob" });
  const wiring = claimWiring(store);

  const challenge = await expectOwnershipChallenge(() => creditCrypto.claimCryptoTopup(store, {
    account: alice,
    txHash: TX_A,
    proofDomain: DOMAIN,
    ...wiring
  }));
  assert.equal(challenge.domain, DOMAIN);
  assert.equal(challenge.owner, alice.account_id);
  assert.equal(challenge.tx_hash, TX_A);
  assert.equal(challenge.sender_address, SENDER);
  assert.match(challenge.nonce, /^deposit_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(challenge.message, new RegExp(alice.account_id));
  assert.match(challenge.message, new RegExp(TX_A));
  assert.equal(await credits.getCreditBalance(store, alice.account_id), "0");
  assert.equal(store.creditAccounts.get(alice.owner_key).deposit_address, null);

  const signature = await SIGNER.signMessage({ message: challenge.message });
  const claimed = await creditCrypto.claimCryptoTopup(store, {
    account: alice,
    txHash: TX_A,
    proofDomain: DOMAIN,
    ownershipProof: { nonce: challenge.nonce, signature, sender_address: SENDER },
    ...wiring
  });
  assert.equal(claimed.deposit.from_address, SENDER);
  assert.equal(await credits.getCreditBalance(store, alice.account_id), "1");
  assert.equal(store.creditAccounts.get(alice.owner_key).deposit_address, SENDER);

  // The verified binding is durable policy: later deposits from the same
  // sender remain one-click/idempotent and do not ask for another signature.
  await creditCrypto.claimCryptoTopup(store, { account: alice, txHash: TX_B, proofDomain: DOMAIN, ...wiring });
  assert.equal(await credits.getCreditBalance(store, alice.account_id), "2");

  await assert.rejects(
    () => creditCrypto.claimCryptoTopup(store, { account: bob, txHash: TX_C, proofDomain: DOMAIN, ...wiring }),
    (error) => error.code === "DEPOSIT_ADDRESS_BOUND_ELSEWHERE"
  );
  assert.equal(await credits.getCreditBalance(store, bob.account_id), "0");
});

test("ownership proof is bound to owner, transaction, sender, and domain without burning on tamper", async () => {
  const store = createMemoryStore();
  const alice = await credits.ensureCreditAccount(store, { provider: "github", id: "bound-alice", login: "alice" });
  const bob = await credits.ensureCreditAccount(store, { provider: "github", id: "bound-bob", login: "bob" });
  const deposit = await creditCrypto.readCryptoDeposit({ txHash: TX_A, fetchImpl: chainStub(SENDER) });
  const otherTxDeposit = await creditCrypto.readCryptoDeposit({ txHash: TX_B, fetchImpl: chainStub(SENDER) });
  const challenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now: 1_000_000 });
  const signature = await SIGNER.signMessage({ message: challenge.message });
  const proof = { nonce: challenge.nonce, signature, sender_address: SENDER };

  await expectProofFailure({ account: bob, deposit, proof, domain: DOMAIN, now: 1_000_001 }, "DEPOSIT_OWNERSHIP_OWNER_MISMATCH");
  await expectProofFailure({ account: alice, deposit: otherTxDeposit, proof, domain: DOMAIN, now: 1_000_001 }, "DEPOSIT_OWNERSHIP_TX_MISMATCH");
  await expectProofFailure({ account: alice, deposit, proof, domain: "evil.example", now: 1_000_001 }, "DEPOSIT_OWNERSHIP_DOMAIN_MISMATCH");
  await expectProofFailure({ account: alice, deposit, proof: { ...proof, sender_address: OTHER_SENDER }, domain: DOMAIN, now: 1_000_001 }, "DEPOSIT_OWNERSHIP_SENDER_MISMATCH");

  assert.equal(await creditCrypto.verifyDepositOwnershipProof({ account: alice, deposit, proof, domain: DOMAIN, now: 1_000_001 }), true);
  await expectProofFailure({ account: alice, deposit, proof, domain: DOMAIN, now: 1_000_002 }, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
});

test("expired or altered wallet signatures fail closed and a concurrent proof has one winner", async () => {
  const store = createMemoryStore();
  const alice = await credits.ensureCreditAccount(store, { provider: "github", id: "expiry-alice", login: "alice" });
  const deposit = await creditCrypto.readCryptoDeposit({ txHash: TX_A, fetchImpl: chainStub(SENDER) });
  const now = 2_000_000;

  const alteredChallenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now });
  const alteredSignature = await SIGNER.signMessage({ message: alteredChallenge.message });
  const tampered = `0x${alteredSignature[2] === "0" ? "1" : "0"}${alteredSignature.slice(3)}`;
  await expectProofFailure({
    account: alice,
    deposit,
    proof: { nonce: alteredChallenge.nonce, signature: tampered, sender_address: SENDER },
    domain: DOMAIN,
    now: now + 1
  }, "DEPOSIT_OWNERSHIP_SIGNATURE_INVALID");

  // An invalid attempt cannot consume the victim's nonce.
  assert.equal(await creditCrypto.verifyDepositOwnershipProof({
    account: alice,
    deposit,
    proof: { nonce: alteredChallenge.nonce, signature: alteredSignature, sender_address: SENDER },
    domain: DOMAIN,
    now: now + 2
  }), true);

  const expiredChallenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now });
  const expiredSignature = await SIGNER.signMessage({ message: expiredChallenge.message });
  await expectProofFailure({
    account: alice,
    deposit,
    proof: { nonce: expiredChallenge.nonce, signature: expiredSignature, sender_address: SENDER },
    domain: DOMAIN,
    now: now + creditCrypto.DEPOSIT_OWNERSHIP_TTL_MS + 1
  }, "DEPOSIT_OWNERSHIP_PROOF_EXPIRED");

  const concurrentChallenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now });
  const concurrentSignature = await SIGNER.signMessage({ message: concurrentChallenge.message });
  const concurrentProof = { nonce: concurrentChallenge.nonce, signature: concurrentSignature, sender_address: SENDER };
  const results = await Promise.allSettled([
    creditCrypto.verifyDepositOwnershipProof({ account: alice, deposit, proof: concurrentProof, domain: DOMAIN, now: now + 1 }),
    creditCrypto.verifyDepositOwnershipProof({ account: alice, deposit, proof: concurrentProof, domain: DOMAIN, now: now + 1 })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "DEPOSIT_OWNERSHIP_PROOF_REPLAYED").length, 1);

  const sharedGuardChallenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now: now + 10 });
  const sharedGuardSignature = await SIGNER.signMessage({ message: sharedGuardChallenge.message });
  let claimedNonce = null;
  await expectProofFailure({
    account: alice,
    deposit,
    proof: { nonce: sharedGuardChallenge.nonce, signature: sharedGuardSignature, sender_address: SENDER },
    domain: DOMAIN,
    now: now + 11,
    claimOwnershipNonce: async (nonce, expiresAt) => {
      claimedNonce = { nonce, expiresAt };
      return false;
    }
  }, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
  assert.equal(claimedNonce.nonce, sharedGuardChallenge.nonce);
  assert.equal(claimedNonce.expiresAt, sharedGuardChallenge.expires_at);
});

test("the authenticated deposit endpoint returns a signable challenge and accepts browser-wallet proof", async () => {
  const { createServer } = await import("../src/server.js");
  const store = createMemoryStore();
  store.authSessions.set("deposit-proof-session", {
    user: { provider: "github", id: "http-proof-owner", handle: "http-proof-owner" },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => String(typeof input === "string" ? input : input?.url).startsWith("https://bsc-dataseed.binance.org")
    ? chainStub(SENDER)(input, options)
    : originalFetch(input, options);
  try {
    const accountPage = await fetch(`${baseUrl}/account`, { headers: { cookie: "ar_session=deposit-proof-session" } });
    const html = await accountPage.text();
    assert.match(html, /personal_sign/);
    assert.match(html, /ownership_proof/);
    assert.match(html, /never paste wallet secrets/);

    const challenged = await fetch(`${baseUrl}/account/credits/deposit`, {
      method: "POST",
      headers: { cookie: "ar_session=deposit-proof-session", "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: TX_A })
    });
    const challengePayload = await challenged.json();
    assert.equal(challenged.status, 428);
    assert.equal(challengePayload.error.code, "DEPOSIT_OWNERSHIP_PROOF_REQUIRED");
    assert.equal(challengePayload.ownership_challenge.sender_address, SENDER);
    assert.equal(challengePayload.ownership_challenge.domain, `127.0.0.1:${server.address().port}`);

    const signature = await SIGNER.signMessage({ message: challengePayload.ownership_challenge.message });
    const claimed = await fetch(`${baseUrl}/account/credits/deposit`, {
      method: "POST",
      headers: { cookie: "ar_session=deposit-proof-session", "content-type": "application/json" },
      body: JSON.stringify({
        tx_hash: TX_A,
        ownership_proof: {
          nonce: challengePayload.ownership_challenge.nonce,
          signature,
          sender_address: SENDER
        }
      })
    });
    const payload = await claimed.json();
    assert.equal(claimed.status, 201, JSON.stringify(payload));
    assert.equal(payload.deposit.from_address, SENDER);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an opaque signed challenge verifies in a fresh runtime with the shared server secret", async () => {
  const store = createMemoryStore();
  const alice = await credits.ensureCreditAccount(store, { provider: "github", id: "cross-runtime-owner", login: "alice" });
  const deposit = await creditCrypto.readCryptoDeposit({ txHash: TX_A, fetchImpl: chainStub(SENDER) });
  const now = Date.now();
  const challenge = creditCrypto.createDepositOwnershipChallenge({ account: alice, deposit, domain: DOMAIN, now });
  const signature = await SIGNER.signMessage({ message: challenge.message });
  const result = await verifyInFreshRuntime({
    account: alice,
    deposit,
    proof: { nonce: challenge.nonce, signature, sender_address: SENDER },
    domain: DOMAIN,
    now: now + 1
  });
  assert.deepEqual(result, { ok: true });
});

function claimWiring(store) {
  return {
    fetchImpl: chainStub(SENDER),
    findAccountByDepositAddress: (address) => credits.findAccountByDepositAddress(store, address),
    bindDepositAddress: (account, address) => credits.bindDepositAddress(store, account, address)
  };
}

function chainStub(sender) {
  const senderTopic = `0x${sender.replace(/^0x/, "").padStart(64, "0")}`;
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = body.method === "eth_blockNumber"
      ? "0x1010"
      : {
          status: "0x1",
          blockNumber: "0x1000",
          logs: [{
            address: USDT_BSC,
            topics: [TRANSFER, senderTopic, TREASURY_TOPIC],
            data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`
          }]
        };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

async function expectOwnershipChallenge(operation) {
  try {
    await operation();
    assert.fail("an unbound sender must require wallet ownership proof");
  } catch (error) {
    assert.equal(error.code, "DEPOSIT_OWNERSHIP_PROOF_REQUIRED");
    assert.equal(error.statusCode, 428);
    assert.ok(error.challenge);
    return error.challenge;
  }
}

async function expectProofFailure(options, code) {
  await assert.rejects(
    () => creditCrypto.verifyDepositOwnershipProof(options),
    (error) => error.code === code,
    code
  );
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function verifyInFreshRuntime(payload) {
  const script = [
    'const payload = JSON.parse(process.env.DEPOSIT_PROOF_CASE);',
    'const { verifyDepositOwnershipProof } = await import("./src/credit-crypto.js");',
    'try {',
    '  await verifyDepositOwnershipProof(payload);',
    '  process.stdout.write(JSON.stringify({ ok:true }));',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ ok:false, code:error.code, message:error.message }));',
    '  process.exitCode = 1;',
    '}'
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DEPOSIT_PROOF_CASE: JSON.stringify(payload) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!stdout) return reject(new Error(`fresh runtime produced no result (${code}): ${stderr}`));
      try {
        const result = JSON.parse(stdout);
        if (code !== 0) return reject(Object.assign(new Error(result.message || stderr), result));
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
