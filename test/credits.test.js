import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../src/store.js";
import {
  atomicToCredits,
  authenticateCreditRequest,
  createCreditApiKey,
  creditsToAtomic,
  debitCredits,
  ensureCreditAccount,
  getCreditBalance,
  grantCredits,
  listCreditLedger
} from "../src/credits.js";

const testUser = {
  provider: "github",
  id: "credit-user",
  name: "Credit User",
  email: "credit@example.com",
  handle: "credit-user"
};

test("credit amounts round-trip without floating point drift", () => {
  assert.equal(creditsToAtomic("0.01"), 10_000);
  assert.equal(creditsToAtomic("12.345678"), 12_345_678);
  assert.equal(atomicToCredits(12_345_678), "12.345678");
  assert.throws(() => creditsToAtomic("0.0000001"), /six decimal places/i);
  assert.throws(() => creditsToAtomic("-1"), /positive/i);
});

test("a signed-in user gets one stable credit account", async () => {
  const store = createMemoryStore();
  const first = await ensureCreditAccount(store, testUser);
  const second = await ensureCreditAccount(store, testUser);

  assert.equal(first.account_id, second.account_id);
  assert.equal(first.owner_key, "github:credit-user");
  assert.equal(store.creditAccounts.size, 1);
});

test("API keys authenticate an account and raw keys are not stored", async () => {
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, testUser);
  const created = await createCreditApiKey(store, { account, label: "Claude Desktop" });

  assert.match(created.api_key, /^ar_live_/);
  assert.equal(JSON.stringify([...store.creditApiKeys.values()]).includes(created.api_key), false);

  const authenticated = await authenticateCreditRequest(store, {
    headers: { "x-agentrouter-api-key": created.api_key }
  });
  assert.equal(authenticated.account.account_id, account.account_id);
  assert.equal(authenticated.key.label, "Claude Desktop");

  const missing = await authenticateCreditRequest(store, { headers: {} });
  assert.equal(missing, null);
});

test("topups and debits produce an immutable balance ledger", async () => {
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, testUser);

  const topup = await grantCredits(store, {
    accountId: account.account_id,
    amount: "2.50",
    kind: "topup",
    metadata: { source: "test" }
  });
  assert.equal(topup.balance, "2.5");

  const debit = await debitCredits(store, {
    accountId: account.account_id,
    amount: "0.01",
    serviceId: "market_data",
    requestId: "req_credit_1"
  });
  assert.equal(debit.balance, "2.49");
  assert.equal(await getCreditBalance(store, account.account_id), "2.49");

  const ledger = await listCreditLedger(store, account.account_id);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].kind, "service_call");
  assert.equal(ledger[0].service_id, "market_data");
  assert.equal(ledger[1].kind, "topup");
});

test("a failed debit never changes the balance", async () => {
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, testUser);
  await grantCredits(store, { accountId: account.account_id, amount: "0.005" });

  await assert.rejects(
    debitCredits(store, {
      accountId: account.account_id,
      amount: "0.01",
      serviceId: "premium_data",
      requestId: "req_credit_2"
    }),
    (error) => error.code === "INSUFFICIENT_CREDITS" && error.statusCode === 402
  );
  assert.equal(await getCreditBalance(store, account.account_id), "0.005");
  assert.equal((await listCreditLedger(store, account.account_id)).length, 1);
});
