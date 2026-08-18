import test from "node:test";
import assert from "node:assert/strict";

// The active chain is read from the environment at call time, not import time,
// so it has to stay set for the duration of the assertions.
async function withChain(chain, run) {
  const previous = process.env.ADN_SETTLEMENT_CHAIN;
  process.env.ADN_SETTLEMENT_CHAIN = chain;
  try {
    return await run(await import("../src/chains.js"));
  } finally {
    if (previous === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previous;
  }
}

test("settlement chain, token address and decimals are per chain", async () => {
  await withChain("bsc", ({ SETTLEMENT_CHAINS, settlementChain, settlementAsset }) => {
  assert.deepEqual(SETTLEMENT_CHAINS, ["arc-testnet", "bsc", "bsc-testnet"]);

  const expectations = [
    ["arc-testnet", 5042002, 6],
    ["bsc", 56, 18],
    ["bsc-testnet", 97, 18]
  ];
  for (const [chainId, id, decimals] of expectations) {
    assert.equal(settlementChain(chainId).id, id, chainId);
    assert.equal(settlementChain(chainId).caip2, `eip155:${id}`, chainId);
    // BEP-20 USDC is 18 decimals while Arc USDC is 6. Treating one as the other
    // misprices a payment by 10^12, so this must never be a shared constant.
    assert.equal(settlementAsset("USDC", chainId).decimals, decimals, chainId);
  }
  assert.equal(settlementAsset("USDT", "bsc").decimals, 18);
  });
});

test("an unknown chain or asset fails loudly rather than defaulting", async () => {
  await withChain("ethereum", ({ activeSettlementChainId, settlementAsset }) => {
    assert.throws(() => activeSettlementChainId(), (error) => error.code === "UNKNOWN_SETTLEMENT_CHAIN");
    assert.throws(() => settlementAsset("DOGE", "bsc"), (error) => error.code === "UNSUPPORTED_SETTLEMENT_ASSET");
  });
});

test("startup preflight refuses a mismatched chain id or token scale", async () => {
  await withChain("bsc", async ({ assertSettlementChainReady }) => {
  const rpc = (chainId, decimals) => async (_url, { body }) => {
    const { method } = JSON.parse(body);
    return { json: async () => ({ result: `0x${(method === "eth_chainId" ? chainId : decimals).toString(16)}` }) };
  };

  const ok = await assertSettlementChainReady({ backend: "circle_arc", fetchImpl: rpc(56, 18) });
  assert.equal(ok.chain_id, 56);
  assert.equal(ok.decimals, 18);

  // An RPC pointing at a different chain would have us sign for the wrong network.
  await assert.rejects(
    assertSettlementChainReady({ backend: "circle_arc", fetchImpl: rpc(97, 18) }),
    (error) => error.code === "SETTLEMENT_CHAIN_MISMATCH"
  );
  // Configured decimals disagreeing with the contract is the 10^12 money bug.
  await assert.rejects(
    assertSettlementChainReady({ backend: "circle_arc", fetchImpl: rpc(56, 6) }),
    (error) => error.code === "SETTLEMENT_DECIMALS_MISMATCH"
  );

  // Credits settle off chain, so there is nothing to verify.
  const credits = await assertSettlementChainReady({ backend: "credits" });
  assert.equal(credits.skipped, true);
  });
});

test("advertised pricing network matches where funds actually settle", async () => {
  await withChain("bsc", ({ settlementPricingNetwork }) => {
  // Pricing used to be hardcoded "base" while settlement went to arc-testnet,
  // so a quote could not tell an agent where money moves.
  assert.equal(settlementPricingNetwork("circle_arc"), "bsc");
  assert.equal(settlementPricingNetwork("credits"), "offchain_credits");
  });
});

test("ERC-8004 registries are shared across chains and overridable", async () => {
  await withChain("bsc", ({ erc8004Registries }) => {
  const registries = erc8004Registries();
  // Verified on chain: the same 0x8004… addresses answer on Arc, BSC and BSC
  // testnet, so switching chains needs no redeployment.
  for (const address of Object.values(registries)) {
    assert.match(address, /^0x8004[0-9a-fA-F]{36}$/);
  }
  process.env.ADN_ERC8004_IDENTITY_REGISTRY = "0x1111111111111111111111111111111111111111";
  assert.equal(erc8004Registries().identityRegistry, "0x1111111111111111111111111111111111111111");
  delete process.env.ADN_ERC8004_IDENTITY_REGISTRY;
  });
});
