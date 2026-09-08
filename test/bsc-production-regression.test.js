import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc8004Registries, settlementChain } from "../src/chains.js";
import { createErc8004AgentMetadata, resolveErc8004AgentId } from "../src/erc8004.js";
import * as anchor from "../src/arc-anchor.js";

const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const account = privateKeyToAccount(`0x${"1".repeat(64)}`); // test-only key
const contract = "0x1111111111111111111111111111111111111111";
const zero = `0x${"0".repeat(64)}`;
const call = { address: contract, abi: anchor.AGENT_ROUTER_EVIDENCE_ANCHOR_ABI, functionName: "anchorEvidence", args: ["regression", zero, zero, zero, zero, zero, zero, zero], nonce: 7n };

async function onBsc(run) {
  const keys = ["ADN_SETTLEMENT_CHAIN", "ADN_ERC8004_AGENT_ID", "ADN_ERC8004_IDENTITY_REGISTRY", "ADN_ERC8004_REPUTATION_REGISTRY", "ADN_BSC_PAYMASTER_URL"];
  const before = keys.map(k => process.env[k]);
  for (const key of keys) delete process.env[key];
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  try { await run(); } finally { keys.forEach((k,i) => before[i] === undefined ? delete process.env[k] : process.env[k] = before[i]); }
}

test("BSC mainnet and testnet use their canonical, distinct registries", async () => onBsc(async () => {
  assert.equal(erc8004Registries("bsc").reputationRegistry, REPUTATION);
  assert.equal(erc8004Registries("bsc").identityRegistry, IDENTITY);
  assert.equal(erc8004Registries("bsc-testnet").identityRegistry, "0x8004A818BFB912233c491871b3d84c89A494BD9e");
}));

for (const [name, registration] of [
  ["legacy provider ID", undefined],
  ["unscoped registration", { agent_id: "22914" }],
  ["foreign chain", { agent_id: "22914", chain_id: 5042002, registry_address: IDENTITY }],
  ["foreign registry", { agent_id: "22914", chain_id: 56, registry_address: contract }],
  ["contradictory chain fields", { agent_id: "22914", chain_id: 56, network: "arc-testnet", registry_address: IDENTITY }]
]) test(`BSC vendor metadata rejects ${name} without relabeling or global fallback`, async () => onBsc(async () => {
  process.env.ADN_ERC8004_AGENT_ID = "319032";
  const manifest = { manifest_type: "agentrouter_vendor_identity", service_id: "vendor:provider_nansen_api", provider: { provider_id: "provider_nansen_api", erc8004_agent_id: "22914" }, registration: { erc8004: registration } };
  const before = JSON.stringify(manifest);
  const card = createErc8004AgentMetadata({ manifest, baseUrl: "https://agentrouter.network" });
  assert.equal(card.registrations[0].agentId, null);
  assert.equal(card.explorer_url, undefined);
  assert.equal(JSON.stringify(manifest), before, "historical identity evidence stays immutable");
}));

test("a scoped canonical BSC registration remains usable", async () => onBsc(async () => {
  const manifest = { registration: { erc8004: { agent_id: "81001", chain_id: 56, registry_address: IDENTITY } } };
  assert.equal(resolveErc8004AgentId({ serviceId: "registered", manifest }), "81001");
}));

function clients(overrides = {}, rpcOverride) {
  const signed = [], methods = [];
  const publicClient = {
    getChainId: async () => 56,
    simulateContract: async () => ({}),
    estimateGas: async () => 80000n,
    getBalance: async () => { throw new Error("must not require EOA BNB"); },
    ...overrides
  };
  const signer = { address: account.address, signTransaction: async tx => { signed.push(tx); return account.signTransaction(tx); } };
  const rpc = async (method, params) => {
    methods.push(method);
    if (rpcOverride) return rpcOverride(method, params);
    return method === "pm_isSponsorable" ? { sponsorable: true, sponsorName: "test-policy" } : keccak256(params[0]);
  };
  return { publicClient, signer, rpc, signed, methods };
}

test("BSC anchor uses sponsored zero-gas signing with the durable reserved nonce, even at zero balance", async () => onBsc(async () => {
  const f = clients();
  assert.equal(typeof anchor.createAnchorClients, "function");
  const c = anchor.createAnchorClients({ account: f.signer, chain: settlementChain(), publicClient: f.publicClient, paymasterRpc: f.rpc });
  const hash = await c.walletClient.writeContract(call);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(f.methods, ["pm_isSponsorable", "eth_sendRawTransaction"]);
  assert.equal(f.signed[0].gasPrice, 0n);
  assert.equal(f.signed[0].nonce, 7);
  assert.equal(f.signed[0].chainId, 56);
  assert.equal(f.signed[0].value, 0n);
}));

for (const failure of ["denied", "rpc outage", "wrong chain", "simulation reverts", "gas exceeds limit", "missing paymaster"]) {
  test(`BSC anchor ${failure} cannot sign or fall back to paid RPC`, async () => onBsc(async () => {
    const overrides = failure === "wrong chain" ? { getChainId: async () => 97 }
      : failure === "simulation reverts" ? { simulateContract: async () => { throw new Error("simulation reverts"); } }
      : failure === "gas exceeds limit" ? { estimateGas: async () => 999999n } : {};
    const f = clients(overrides, failure === "denied" ? async () => ({ sponsorable: false }) : failure === "rpc outage" ? async () => { throw new Error("rpc outage"); } : undefined);
    assert.equal(typeof anchor.createAnchorClients, "function");
    const c = anchor.createAnchorClients({ account: f.signer, chain: settlementChain(), publicClient: f.publicClient, paymasterRpc: failure === "missing paymaster" ? undefined : f.rpc });
    await assert.rejects(c.walletClient.writeContract(call));
    assert.equal(f.signed.length, 0);
    assert.ok(!f.methods.includes("eth_sendRawTransaction"));
  }));
}

test("retry after an uncertain broadcast reproduces the same signed transaction", async () => onBsc(async () => {
  const raw = [];
  const f = clients({}, async (method, params) => {
    if (method === "pm_isSponsorable") return { sponsorable: true };
    raw.push(params[0]);
    if (raw.length === 1) throw new Error("response lost after broadcast");
    return keccak256(params[0]);
  });
  assert.equal(typeof anchor.createAnchorClients, "function");
  const c = anchor.createAnchorClients({ account: f.signer, chain: settlementChain(), publicClient: f.publicClient, paymasterRpc: f.rpc });
  await assert.rejects(c.walletClient.writeContract(call));
  await c.walletClient.writeContract(call);
  assert.equal(raw[0], raw[1]);
  assert.equal(parseTransaction(raw[0]).nonce, 7);
}));
