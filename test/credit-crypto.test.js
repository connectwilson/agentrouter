import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../src/store.js";

// The chain and treasury are read at call time, so they have to stay set for
// the duration of the assertions.
async function withTreasury(run) {
  const previous = { chain: process.env.ADN_SETTLEMENT_CHAIN, treasury: process.env.ADN_CREDITS_TREASURY_ADDRESS };
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  process.env.ADN_CREDITS_TREASURY_ADDRESS = "0x00000000000000000000000000000000000abcde";
  try {
    return await run();
  } finally {
    if (previous.chain === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previous.chain;
    if (previous.treasury === undefined) delete process.env.ADN_CREDITS_TREASURY_ADDRESS;
    else process.env.ADN_CREDITS_TREASURY_ADDRESS = previous.treasury;
  }
}

const TREASURY_TOPIC = "0x00000000000000000000000000000000000000000000000000000000000abcde";
const SENDER_TOPIC = "0x000000000000000000000000c493e53188679833f56506eed1e3efc094b41a73";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const TX = `0x${"a".repeat(64)}`;

// 58.8904 USDT at 18 decimals, derived rather than written as a hex literal —
// a hand-computed constant is exactly the kind of quiet arithmetic error this
// test exists to catch. In atomic units this is far past Number's safe integer
// range, which is where a naive parse loses money.
const ATOMIC_58_8904 = `0x${(588904n * 10n ** 14n).toString(16).padStart(64, "0")}`;

function chainStub({ logs, status = "0x1", blockNumber = "0x1000", head = "0x1010", receipt = undefined }) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = body.method === "eth_blockNumber"
      ? head
      : receipt !== undefined ? receipt : { status, blockNumber, logs };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

const treasuryTransfer = {
  address: USDT_BSC,
  topics: [TRANSFER, SENDER_TOPIC, TREASURY_TOPIC],
  data: ATOMIC_58_8904
};

test("a deposit is read from the chain, at the token's own decimals", async () => {
  await withTreasury(async () => {
    const { readCryptoDeposit } = await import("../src/credit-crypto.js");
    const deposit = await readCryptoDeposit({ txHash: TX, fetchImpl: chainStub({ logs: [treasuryTransfer] }) });
    // BEP-20 USDT is 18 decimals, not the 6 USDC uses elsewhere. Crediting
    // 18-decimal units as 6 would inflate this deposit by 10^12.
    assert.equal(deposit.asset, "USDT");
    assert.equal(deposit.decimals, 18);
    assert.equal(deposit.amount, "58.8904");
    assert.equal(deposit.from_address, "0xc493e53188679833f56506eed1e3efc094b41a73");
    assert.equal(deposit.chain_id, 56);
  });
});

test("only a confirmed treasury transfer of an accepted token counts", async () => {
  await withTreasury(async () => {
    const { readCryptoDeposit } = await import("../src/credit-crypto.js");
    const rejects = async (options, code, why) => {
      await assert.rejects(
        () => readCryptoDeposit({ txHash: TX, fetchImpl: chainStub(options) }),
        (error) => error.code === code,
        why
      );
    };
    // Paying someone else does not credit the account.
    await rejects(
      { logs: [{ ...treasuryTransfer, topics: [TRANSFER, SENDER_TOPIC, SENDER_TOPIC] }] },
      "DEPOSIT_NOT_A_TREASURY_TRANSFER",
      "a transfer to another address is not a deposit"
    );
    // Nor does an unrelated token that happens to pay the treasury.
    await rejects(
      { logs: [{ ...treasuryTransfer, address: `0x${"9".repeat(40)}` }] },
      "DEPOSIT_NOT_A_TREASURY_TRANSFER",
      "an unaccepted token is not a deposit"
    );
    await rejects({ logs: [treasuryTransfer], status: "0x0" }, "DEPOSIT_TX_REVERTED", "a reverted tx credits nothing");
    await rejects({ logs: [treasuryTransfer], receipt: null }, "DEPOSIT_NOT_FOUND", "an unknown tx credits nothing");
    // A reorg can still take a young block, so confirmations are required.
    await rejects(
      { logs: [treasuryTransfer], blockNumber: "0x1000", head: "0x1000" },
      "DEPOSIT_NOT_CONFIRMED",
      "one confirmation is not enough"
    );

    await assert.rejects(
      () => readCryptoDeposit({ txHash: "0xnope", fetchImpl: chainStub({ logs: [] }) }),
      (error) => error.code === "INVALID_TX_HASH"
    );
  });
});

test("a deposit credits one account, once", async () => {
  await withTreasury(async () => {
    const { claimCryptoTopup } = await import("../src/credit-crypto.js");
    const { ensureCreditAccount, getCreditBalance, findAccountByDepositAddress, bindDepositAddress } =
      await import("../src/credits.js");
    const store = createMemoryStore();
    const alice = await ensureCreditAccount(store, { provider: "github", id: "u1", login: "alice" });
    const wiring = {
      fetchImpl: chainStub({ logs: [treasuryTransfer] }),
      findAccountByDepositAddress: (address) => findAccountByDepositAddress(store, address),
      bindDepositAddress: (account, address) => bindDepositAddress(store, account, address)
    };

    await claimCryptoTopup(store, { account: alice, txHash: TX, ...wiring });
    assert.equal(await getCreditBalance(store, alice.account_id), "58.8904");

    // Submitting the same hash again must not pay twice.
    const current = store.creditAccounts.get(alice.owner_key);
    await claimCryptoTopup(store, { account: current, txHash: TX, ...wiring });
    assert.equal(await getCreditBalance(store, alice.account_id), "58.8904");

    // A transaction hash is public. Once an address has paid one account, it
    // can never credit another — otherwise every deposit is a race with
    // whoever is watching the chain.
    const bob = await ensureCreditAccount(store, { provider: "github", id: "u2", login: "bob" });
    await assert.rejects(
      () => claimCryptoTopup(store, { account: bob, txHash: TX, ...wiring }),
      (error) => error.code === "DEPOSIT_ADDRESS_BOUND_ELSEWHERE"
    );
    assert.equal(await getCreditBalance(store, bob.account_id), "0");
  });
});

test("a per-call ceiling refuses the call instead of charging for it", async () => {
  const { ensureCreditAccount, accountSpendLimit, assertWithinSpendLimit, setAccountSpendLimit } =
    await import("../src/credits.js");
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, { provider: "github", id: "u3", login: "carol" });

  // A balance an agent spends unattended needs a ceiling on any one call.
  assert.equal(accountSpendLimit(account), "2");
  assert.doesNotThrow(() => assertWithinSpendLimit(account, "2"));
  assert.throws(() => assertWithinSpendLimit(account, "2.01"), (error) => error.code === "SPEND_LIMIT_EXCEEDED");

  const updated = await setAccountSpendLimit(store, { account, maxPricePerCall: "5" });
  assert.equal(updated.max_price_per_call, "5");
  assert.doesNotThrow(() => assertWithinSpendLimit(store.creditAccounts.get(account.owner_key), "2.01"));

  for (const bad of ["0", "-1", "abc", ""]) {
    await assert.rejects(
      () => setAccountSpendLimit(store, { account, maxPricePerCall: bad }),
      (error) => error.code === "INVALID_SPEND_LIMIT",
      `${JSON.stringify(bad)} is not a limit`
    );
  }
});

test("a spend limit set by the owner applies to the agent's own calls", async () => {
  const { ensureCreditAccount, createCreditApiKey, setAccountSpendLimit,
          authenticateCreditRequest, accountSpendLimit, assertWithinSpendLimit } =
    await import("../src/credits.js");
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, { provider: "github", id: "u9", login: "dave" });
  const created = await createCreditApiKey(store, { account, label: "agent" });
  await setAccountSpendLimit(store, { account, maxPricePerCall: "50" });

  // Settings live on the account, not the key. Returning an account without
  // them made every API-key call fall back to the default, so a limit raised
  // in the dashboard had no effect on the one path that actually spends.
  const auth = await authenticateCreditRequest(store, {
    headers: { authorization: `Bearer ${created.api_key}` }
  });
  assert.equal(accountSpendLimit(auth.account), "50");
  assert.doesNotThrow(() => assertWithinSpendLimit(auth.account, "10"));
  assert.throws(() => assertWithinSpendLimit(auth.account, "50.01"), (error) => error.code === "SPEND_LIMIT_EXCEEDED");
});

test("a key can be told apart without ever being shown again", async () => {
  const { ensureCreditAccount, createCreditApiKey, listCreditApiKeys, authenticateCreditRequest } =
    await import("../src/credits.js");
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, { provider: "github", id: "u10", login: "erin" });
  const created = await createCreditApiKey(store, { account, label: "CI server" });

  const [listed] = await listCreditApiKeys(store, account.account_id);
  // A row identified only by a UUID matches nothing the holder has. The hint
  // is the ends of the real key and nothing in between.
  assert.match(listed.key_prefix, /^ar_live_.{6}….{4}$/);
  assert.ok(created.api_key.startsWith(listed.key_prefix.split("…")[0]));
  assert.ok(created.api_key.endsWith(listed.key_prefix.split("…")[1]));
  // Never enough to reconstruct: 192 bits of entropy, ~11 characters shown.
  assert.ok(listed.key_prefix.length < created.api_key.length - 20);
  assert.equal(listed.last_used_at, null, "a key that has never run reports so");

  await authenticateCreditRequest(store, { headers: { authorization: `Bearer ${created.api_key}` } });
  const [afterUse] = await listCreditApiKeys(store, account.account_id);
  assert.ok(afterUse.last_used_at, "using a key records that it was used");
});

test("a payment code cannot be pointed somewhere else by its link", async () => {
  await withTreasury(async () => {
    const { depositPaymentUri, depositAtomicAmount } = await import("../src/credit-crypto.js");
    const treasury = "0x00000000000000000000000000000000000abcde";

    // EIP-681 is what a wallet expects from a scanned code: token, chain, and
    // a transfer already filled in.
    const uri = depositPaymentUri({ asset: "USDT", amount: "10" });
    assert.match(uri, /^ethereum:0x55d398326f99059fF775485246999027B3197955@56\/transfer\?/);
    assert.ok(uri.includes(`address=${treasury}`));
    assert.ok(uri.endsWith("uint256=10000000000000000000"));

    // The recipient is server configuration. A code whose destination could be
    // set from the outside would let anyone send a link that renders a QR
    // paying them, which is the whole risk of drawing these codes at all.
    const evil = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.ok(!depositPaymentUri({ asset: "USDT", amount: "10", address: evil }).includes(evil));
    await assert.rejects(
      async () => depositPaymentUri({ asset: `ethereum:${evil}@56/transfer`, amount: "1" }),
      (error) => error.code === "UNSUPPORTED_DEPOSIT_ASSET"
    );

    // An amount that rounds is a wrong payment, so it is refused rather than
    // truncated.
    assert.equal(depositAtomicAmount("10.5", 18), "10500000000000000000");
    for (const [bad, code] of [["abc", "INVALID_DEPOSIT_AMOUNT"], ["0", "INVALID_DEPOSIT_AMOUNT"],
                               ["-1", "INVALID_DEPOSIT_AMOUNT"], ["1.1234567890123456789", "DEPOSIT_AMOUNT_TOO_PRECISE"]]) {
      assert.throws(() => depositAtomicAmount(bad, 18), (error) => error.code === code, `${bad} is not payable`);
    }
  });
});
