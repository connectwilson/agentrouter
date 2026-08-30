import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { relaySponsoredErc8004Registration } from "../src/bsc-registration-paymaster.js";
import { ERC8004_IDENTITY_ABI } from "../src/erc8004.js";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const AGENT_URI = "https://agentrouter.network/.well-known/erc8004/vendors/vendor_alpha.json";
const account = privateKeyToAccount(`0x${"3".repeat(64)}`);
const data = encodeFunctionData({ abi: ERC8004_IDENTITY_ABI, functionName: "register", args: [AGENT_URI] });
const registration = {
  chain_id: 56,
  agent_uri: AGENT_URI,
  transaction: { to: REGISTRY, data, value: "0x0" }
};
const bsc = { id: 56 };

test("BNB Paymaster sponsors an exact Vendor registration while Vendor remains transaction sender", async () => {
  const calls = [];
  const paymasterRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "pm_isSponsorable") return { Sponsorable: true, SponsorPolicy: "agentrouter-vendor-registration" };
    return `0x${"a".repeat(64)}`;
  };
  const unsigned = {
    type: "legacy", chainId: 56, nonce: 7, gas: 180000n, gasPrice: 0n,
    to: REGISTRY, value: 0n, data
  };
  const signed = await account.signTransaction(unsigned);

  const check = await relaySponsoredErc8004Registration({
    method: "pm_isSponsorable",
    params: [{ from: account.address, to: REGISTRY, value: "0x0", data, gas: "0x2bf20" }],
    registration, chain: bsc,
    paymasterRpc
  });
  const submission = await relaySponsoredErc8004Registration({
    method: "eth_sendRawTransaction", params: [signed], registration, paymasterRpc, chain: bsc
  });

  assert.equal(check.ok, true);
  assert.equal(check.gas_sponsorship.vendor_pays_gas, false);
  assert.equal(submission.ok, true);
  assert.equal(submission.owner_address.toLowerCase(), account.address.toLowerCase());
  assert.equal(submission.result, `0x${"a".repeat(64)}`);
  assert.deepEqual(calls.map((call) => call.method), ["pm_isSponsorable", "eth_sendRawTransaction"]);
});

test("registration Paymaster returns the Vendor pending nonce from MegaFuel", async () => {
  const calls = [];
  const paymasterRpc = async (method, params) => {
    calls.push({ method, params });
    return "0x7";
  };
  const result = await relaySponsoredErc8004Registration({
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
    registration,
    chain: bsc,
    paymasterRpc
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "nonce_ready");
  assert.equal(result.result, "0x7");
  assert.deepEqual(calls, [{ method: "eth_getTransactionCount", params: [account.address, "pending"] }]);
});

test("registration Paymaster rejects unsafe nonce queries", async () => {
  let calls = 0;
  const paymasterRpc = async () => { calls += 1; return "0x0"; };
  const result = await relaySponsoredErc8004Registration({
    method: "eth_getTransactionCount",
    params: ["not-an-address", "latest"],
    registration,
    chain: bsc,
    paymasterRpc
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_paymaster_params");
  assert.equal(calls, 0);
});

test("registration sponsorship fails closed for wrong URI, nonzero gas price, and Paymaster denial", async () => {
  let submissions = 0;
  const paymasterRpc = async (method) => {
    if (method === "pm_isSponsorable") return { Sponsorable: false, SponsorPolicy: "not-eligible" };
    submissions += 1;
    return `0x${"b".repeat(64)}`;
  };
  const wrongData = encodeFunctionData({ abi: ERC8004_IDENTITY_ABI, functionName: "register", args: [`${AGENT_URI}?attacker=1`] });
  const wrongUri = await relaySponsoredErc8004Registration({
    method: "pm_isSponsorable",
    params: [{ from: account.address, to: REGISTRY, value: "0x0", data: wrongData, gas: "0x2bf20" }],
    registration, chain: bsc,
    paymasterRpc
  });
  const paidRaw = await account.signTransaction({
    type: "legacy", chainId: 56, nonce: 8, gas: 180000n, gasPrice: 1n,
    to: REGISTRY, value: 0n, data
  });
  const nonzeroGas = await relaySponsoredErc8004Registration({
    method: "eth_sendRawTransaction", params: [paidRaw], registration, paymasterRpc, chain: bsc
  });
  const denied = await relaySponsoredErc8004Registration({
    method: "pm_isSponsorable",
    params: [{ from: account.address, to: REGISTRY, value: "0x0", data, gas: "0x2bf20" }],
    registration, chain: bsc,
    paymasterRpc
  });

  assert.equal(wrongUri.status, "invalid_paymaster_transaction");
  assert.equal(nonzeroGas.status, "invalid_paymaster_transaction");
  assert.equal(denied.status, "sponsorship_unavailable");
  assert.equal(denied.gas_sponsorship.vendor_pays_gas, false);
  assert.equal(submissions, 0, "invalid or denied sponsorship never falls back to a Vendor-paid submission");
});
