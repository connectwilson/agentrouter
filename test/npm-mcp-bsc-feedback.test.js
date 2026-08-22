import assert from "node:assert/strict";
import test from "node:test";
import { submitSponsoredFeedback } from "../packages/agentrouter-mcp/server/bsc-feedback.js";

test("published MCP bridge signs BSC feedback at zero gas price and submits through the server Paymaster proxy", async () => {
  const methods = [];
  let signedTransaction;
  const result = await submitSponsoredFeedback({
    descriptor: {
      chain_id: 56,
      network: "bsc",
      registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      agent_id: "42",
      value: 97,
      value_decimals: 2,
      tag1: "data_quality",
      tag2: "intent_fit",
      endpoint: "https://agentrouter.network/agent-router/feedback?request_id=req_package",
      feedback_uri: "https://agentrouter.network/agent-router/feedback?request_id=req_package",
      feedback_hash: `0x${"c".repeat(64)}`
    },
    account: {
      address: "0x2222222222222222222222222222222222222222",
      async signTransaction(transaction) {
        signedTransaction = transaction;
        return `0x${"e".repeat(130)}`;
      }
    },
    publicClient: {
      async getTransactionCount() { return 3; },
      async estimateGas() { return 190000n; },
      async waitForTransactionReceipt() { return { status: "success", blockNumber: 88n }; }
    },
    paymasterRpc: async (method) => {
      methods.push(method);
      if (method === "pm_isSponsorable") return { Sponsorable: true, SponsorPolicy: "feedback-only" };
      return `0x${"d".repeat(64)}`;
    }
  });

  assert.deepEqual(methods, ["pm_isSponsorable", "eth_sendRawTransaction"]);
  assert.equal(signedTransaction.gasPrice, 0n);
  assert.equal(result.status, "submitted");
  assert.equal(result.gas_sponsorship.sponsored, true);
  assert.equal(result.gas_sponsorship.sponsor_policy, "feedback-only");
});
