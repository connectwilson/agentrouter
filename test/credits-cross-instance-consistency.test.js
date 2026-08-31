import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../src/store.js";
import {
  accountSpendLimit,
  assertWithinSpendLimit,
  authenticateCreditRequest,
  createCreditApiKey,
  ensureCreditAccount,
  revokeCreditApiKey,
  setAccountSpendLimit
} from "../src/credits.js";

const USER = {
  provider: "github",
  id: "cross-instance-credit-owner",
  handle: "cross-instance-credit-owner",
  name: "Cross Instance Credit Owner"
};
const OWNER_KEY = "github:cross-instance-credit-owner";

function createSharedCreditPersistence() {
  const accounts = new Map();
  const keys = new Map();
  let failKeyReads = false;
  let failAccountReads = false;

  const copy = (value) => value ? structuredClone(value) : value;
  const accountById = (accountId) => [...accounts.values()].find((account) => account.account_id === accountId) || null;

  return {
    enabled: true,
    accounts,
    keys,
    failNextKeyReads() { failKeyReads = true; },
    failNextAccountReads() { failAccountReads = true; },
    seedAccount(account) { accounts.set(account.owner_key, copy(account)); },
    seedKey(key) { keys.set(key.key_hash, copy(key)); },
    async readAccountByOwner(ownerKey) {
      if (failAccountReads) throw new Error("shared account persistence unavailable");
      return copy(accounts.get(ownerKey) || null);
    },
    async readAccountByDepositAddress(address) {
      return copy([...accounts.values()].find((account) => account.deposit_address === address) || null);
    },
    async upsertAccount(account) {
      const existing = accounts.get(account.owner_key) || {};
      const saved = {
        ...existing,
        ...copy(account),
        settings: copy(account.settings || {}),
        deposit_address: account.deposit_address || existing.deposit_address || null,
        updated_at: new Date().toISOString()
      };
      accounts.set(saved.owner_key, saved);
      return copy(saved);
    },
    async writeApiKey(key) {
      const saved = copy(key);
      keys.set(saved.key_hash, saved);
      return copy(saved);
    },
    async readApiKeyByHash(keyHash) {
      if (failKeyReads) throw new Error("shared key persistence unavailable");
      const key = keys.get(keyHash);
      if (!key || key.revoked_at) return null;
      const account = accountById(key.account_id);
      if (!account) return null;
      return copy({
        ...key,
        owner_key: account.owner_key,
        user_profile: account.user_profile || {}
      });
    },
    async revokeApiKey(accountId, keyId) {
      const key = [...keys.values()].find((candidate) =>
        candidate.account_id === accountId && candidate.key_id === keyId
      );
      if (!key) return null;
      key.revoked_at ||= new Date().toISOString();
      return copy(key);
    },
    async touchApiKey() { return true; }
  };
}

async function twoInstanceFixture({ spendLimit = "2" } = {}) {
  const persistence = createSharedCreditPersistence();
  const instanceA = createMemoryStore();
  const instanceB = createMemoryStore();
  instanceA.creditPersistence = persistence;
  instanceB.creditPersistence = persistence;

  let account = await ensureCreditAccount(instanceA, USER);
  account = {
    ...account,
    settings: { ...(account.settings || {}), max_price_per_call: spendLimit }
  };
  instanceA.creditAccounts.set(OWNER_KEY, structuredClone(account));
  persistence.seedAccount(account);

  const created = await createCreditApiKey(instanceA, { account, label: "cross-instance-agent" });
  const [localKey] = [...instanceA.creditApiKeys.values()];
  persistence.seedKey(localKey);

  const authoritativeKey = await persistence.readApiKeyByHash(localKey.key_hash);
  instanceB.creditApiKeys.set(localKey.key_hash, structuredClone(authoritativeKey));
  instanceB.creditAccounts.set(OWNER_KEY, structuredClone(account));

  return { persistence, instanceA, instanceB, account, created, localKey };
}

function apiKeyRequest(apiKey) {
  return { headers: { "x-agentrouter-api-key": apiKey } };
}

test("instance B rejects its cached API key on the first request after instance A revokes it", async () => {
  const { instanceA, instanceB, account, created } = await twoInstanceFixture();

  const before = await authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key));
  assert.equal(before.account.owner_key, OWNER_KEY);

  await revokeCreditApiKey(instanceA, { accountId: account.account_id, keyId: created.key_id });

  const after = await authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key));
  assert.equal(after, null);
});

test("instance B refreshes a cached account immediately after instance A lowers its spend limit", async () => {
  const { instanceA, instanceB, account } = await twoInstanceFixture({ spendLimit: "50" });
  assert.equal(accountSpendLimit(instanceB.creditAccounts.get(OWNER_KEY)), "50");

  await setAccountSpendLimit(instanceA, { account, maxPricePerCall: "0.01" });

  const refreshed = await ensureCreditAccount(instanceB, USER);
  assert.equal(accountSpendLimit(refreshed), "0.01");
});

test("API-key authentication in instance B uses the newly lowered authoritative spend limit", async () => {
  const { instanceA, instanceB, account, created } = await twoInstanceFixture({ spendLimit: "50" });

  const before = await authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key));
  assert.equal(accountSpendLimit(before.account), "50");

  await setAccountSpendLimit(instanceA, { account, maxPricePerCall: "0.01" });

  const after = await authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key));
  assert.equal(accountSpendLimit(after.account), "0.01");
  assert.throws(
    () => assertWithinSpendLimit(after.account, "0.02"),
    (error) => error.code === "SPEND_LIMIT_EXCEEDED"
  );
});

test("persistent API-key authentication fails closed when authoritative state cannot be read", async () => {
  const { persistence, instanceB, created } = await twoInstanceFixture();
  persistence.failNextKeyReads();

  await assert.rejects(
    () => authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key)),
    /shared key persistence unavailable/
  );
});

test("persistent account settings fail closed instead of falling back to a cached spend limit", async () => {
  const { persistence, instanceB, created } = await twoInstanceFixture({ spendLimit: "50" });
  persistence.failNextAccountReads();

  await assert.rejects(
    () => authenticateCreditRequest(instanceB, apiKeyRequest(created.api_key)),
    /shared account persistence unavailable/
  );
});
