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

test("ERC-8004 registries resolve per chain and stay overridable", async () => {
  await withChain("bsc", ({ erc8004Registries, erc8004AgentRegistryId, erc8004ExplorerUrl }) => {
  const registries = erc8004Registries();
  for (const address of Object.values(registries)) {
    assert.match(address, /^0x8004[0-9a-fA-F]{36}$/);
  }
  // BSC's identity registry is a different contract from Arc's. An earlier
  // version assumed one address served every chain because it had bytecode on
  // BSC — but that contract is not the ERC-721 agent registry, so every card
  // pointed at the wrong place.
  assert.equal(registries.identityRegistry, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  assert.equal(erc8004AgentRegistryId(), "eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  // Verified against the live site: including the registry in the path 404s.
  assert.equal(erc8004ExplorerUrl("7"), "https://8004scan.io/agents/56/7");
  process.env.ADN_ERC8004_IDENTITY_REGISTRY = "0x1111111111111111111111111111111111111111";
  assert.equal(erc8004Registries().identityRegistry, "0x1111111111111111111111111111111111111111");
  delete process.env.ADN_ERC8004_IDENTITY_REGISTRY;
  });
});

test("payment proofs verify on whatever chain settles, not only Arc", async () => {
  // isArcNetwork gated settlement and only ever matched Arc, so a BSC proof was
  // rejected as a foreign network and BSC could not settle at all.
  await withChain("bsc", async () => {
    const { isArcNetwork, normalizeArcNetwork } = await import("../src/arc-payment.js");
    for (const network of ["bsc", "eip155:56", "56"]) {
      assert.equal(isArcNetwork(network), true, `${network} must be accepted while settling on BSC`);
    }
    // A proof from the previously configured chain must never settle after a
    // deployment switches networks.
    assert.equal(isArcNetwork("arc-testnet"), false);
    assert.equal(isArcNetwork("base"), false);
    assert.equal(isArcNetwork(""), false);
    assert.equal(normalizeArcNetwork("bsc"), "bsc");
  });
});

test("quotes and ERC-8004 cards advertise the settling chain", async () => {
  await withChain("bsc", async () => {
    const { createPaymentRequirements } = await import("../src/payment.js");
    const quote = createPaymentRequirements({ serviceId: "svc", amount: "0.01", network: "bsc", payTo: `0x${"a".repeat(40)}` });
    assert.equal(quote.network, "bsc");
    assert.equal(quote.chain_id, 56);
    assert.equal(quote.caip2, "eip155:56");

    const { createErc8004AgentMetadata } = await import("../src/erc8004.js");
    const card = createErc8004AgentMetadata({ manifest: { service_id: "svc", title: "Svc" }, baseUrl: "https://agentrouter.network" });
    assert.equal(card.registrations[0].caip2, "eip155:56");
    assert.equal(card.registrations[0].agentId, null, "unminted cards carry a null agentId, as the EIP's own cards do");
  });
});

test("a placeholder registry is reported, not paid for in gas", async () => {
  // BSC's reputation and validation addresses hold bare UUPS proxies with no
  // business logic. Bytecode at an address proves nothing about what it does,
  // so the write is simulated first rather than broadcast into a revert.
  const { assertRegistryImplements } = await import("../src/erc8004.js");
  const reverting = {
    simulateContract: async () => { throw Object.assign(new Error("execution reverted"), { shortMessage: "execution reverted" }); },
    getBytecode: async () => "0x60806040"
  };
  const message = await assertRegistryImplements({ publicClient: reverting, address: "0x8004B663056A597Dffe9eCcC1965A193B7388713", functionName: "giveFeedback" });
  assert.match(message, /does not implement giveFeedback/);

  const empty = { ...reverting, getBytecode: async () => "0x" };
  assert.match(await assertRegistryImplements({ publicClient: empty, address: "0xdead", functionName: "giveFeedback" }), /No contract is deployed/);

  const working = { simulateContract: async () => ({ result: 1n }), getBytecode: async () => "0x60806040" };
  assert.equal(await assertRegistryImplements({ publicClient: working, address: "0xok", functionName: "register" }), null);
});

test("an agent's explorer link follows the chain it was registered on", async () => {
  const { publicErc8004 } = await import("../src/store.js");
  await withChain("bsc", () => {
    // A legacy Arc token id must disappear from the active BSC marketplace. It
    // is not the same identity and must never link to an unrelated BSC agent.
    const onArc = publicErc8004({ manifest: { registration: { erc8004: { agent_id: "22197", network: "arc-testnet", chain_id: 5042002 } } } });
    assert.equal(onArc, null);

    const onBsc = publicErc8004({ manifest: { registration: { erc8004: { agent_id: "7", network: "bsc", chain_id: 56, identity_registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } } } });
    assert.equal(onBsc.explorer_url, "https://8004scan.io/agents/56/7");

    // No identity until one is actually minted.
    assert.equal(publicErc8004({ manifest: { registration: { erc8004: {} } } }), null);
    assert.equal(publicErc8004({}), null);
  });
});

test("an Arc identity token id is never reused as a BSC feedback target", async () => {
  await withChain("bsc", async () => {
    const { createErc8004FeedbackDescriptor } = await import("../src/erc8004.js");
    const staleArc = createErc8004FeedbackDescriptor({
      serviceId: "svc",
      manifest: {
        registration: {
          erc8004: { agent_id: "22914", network: "arc-testnet", chain_id: 5042002 }
        }
      }
    });
    assert.equal(staleArc.agent_id, null);

    const onBsc = createErc8004FeedbackDescriptor({
      serviceId: "svc",
      manifest: {
        registration: {
          erc8004: { agent_id: "7", network: "bsc", chain_id: 56, registry_address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
        }
      }
    });
    assert.equal(onBsc.agent_id, "7");
    assert.equal(onBsc.network, "bsc");
    assert.equal(onBsc.caip2, "eip155:56");
    assert.equal(onBsc.chain_id, 56);
  });
});
