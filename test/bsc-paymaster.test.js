import assert from "node:assert/strict";
import test from "node:test";
import { submitSponsoredErc8004Feedback } from "../src/bsc-paymaster.js";

const descriptor = {
  standard: "ERC-8004",
  registry_type: "reputation",
  status: "consumer_submission_required",
  chain_id: 56,
  network: "bsc",
  registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  agent_id: "7",
  value: 95,
  value_decimals: 2,
  tag1: "data_quality",
  tag2: "intent_fit",
  endpoint: "https://agentrouter.network/agent-router/feedback?request_id=req_1",
  feedback_uri: "https://agentrouter.network/agent-router/feedback?request_id=req_1",
  feedback_hash: `0x${"a".repeat(64)}`
};

const bsc = {
  id: 56,
  network: "bsc",
  rpcUrl: "https://bsc.example/rpc",
  blockExplorers: { default: { url: "https://bscscan.com" } }
};

test("BNB Paymaster sponsors one consumer-signed ERC-8004 feedback transaction", async () => {
  const rpcCalls = [];
  const signed = [];
  const account = {
    address: "0x1111111111111111111111111111111111111111",
    async signTransaction(transaction) {
      signed.push(transaction);
      return `0x${"f".repeat(130)}`;
    }
  };
  const publicClient = {
    async getTransactionCount() { return 12; },
    async estimateGas() { return 180000n; },
    async waitForTransactionReceipt() { return { status: "success", blockNumber: 123n }; }
  };
  const rpc = async (method, params) => {
    rpcCalls.push({ method, params });
    if (method === "pm_isSponsorable") return { Sponsorable: true, SponsorPolicy: "agentrouter-feedback" };
    if (method === "eth_sendRawTransaction") return `0x${"b".repeat(64)}`;
    throw new Error(`Unexpected method ${method}`);
  };

  const result = await submitSponsoredErc8004Feedback({
    descriptor,
    account,
    publicClient,
    paymasterRpc: rpc,
    paymasterUrl: "https://paymaster.example/rpc",
    chain: bsc
  });

  assert.deepEqual(rpcCalls.map((call) => call.method), ["pm_isSponsorable", "eth_sendRawTransaction"]);
  const sponsorshipTx = rpcCalls[0].params[0];
  assert.equal(sponsorshipTx.from, account.address);
  assert.equal(sponsorshipTx.to, descriptor.registry_address);
  assert.equal(sponsorshipTx.value, "0x0");
  assert.match(sponsorshipTx.data, /^0x[0-9a-f]+$/i);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].gasPrice, 0n);
  assert.equal(signed[0].chainId, 56);
  assert.equal(result.status, "submitted");
  assert.equal(result.feedback_account, account.address);
  assert.equal(result.gas_sponsorship.sponsored, true);
  assert.equal(result.gas_sponsorship.sponsor_policy, "agentrouter-feedback");
});

test("a denied sponsorship never falls back to a consumer-paid transaction", async () => {
  let signed = false;
  let rawSubmission = false;
  const result = await submitSponsoredErc8004Feedback({
    descriptor,
    account: {
      address: "0x1111111111111111111111111111111111111111",
      async signTransaction() { signed = true; }
    },
    publicClient: {
      async getTransactionCount() { return 1; },
      async estimateGas() { return 180000n; }
    },
    paymasterRpc: async (method) => {
      if (method === "pm_isSponsorable") return { Sponsorable: false, SponsorPolicy: "not-allowed" };
      rawSubmission = true;
    },
    paymasterUrl: "https://paymaster.example/rpc",
    chain: bsc
  });

  assert.equal(result.status, "sponsorship_unavailable");
  assert.equal(result.recorded_offchain, true);
  assert.equal(signed, false);
  assert.equal(rawSubmission, false);
});

test("configured Paymaster URL handles JSON-RPC with a real local signer", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    methods.push(request.method);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "pm_isSponsorable"
            ? { Sponsorable: "true", SponsorPolicy: "url-policy" }
            : `0x${"9".repeat(64)}`
        };
      }
    };
  };
  try {
    const result = await submitSponsoredErc8004Feedback({
      descriptor,
      privateKey: `0x${"1".repeat(64)}`,
      publicClient: {
        async getTransactionCount() { return 0; },
        async estimateGas() { return 180000n; },
        async waitForTransactionReceipt() { return { status: "success", blockNumber: 1n }; }
      },
      paymasterUrl: "https://paymaster.example/rpc",
      chain: bsc
    });
    assert.deepEqual(methods, ["pm_isSponsorable", "eth_sendRawTransaction"]);
    assert.equal(result.status, "submitted");
    assert.equal(result.gas_sponsorship.sponsored, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
