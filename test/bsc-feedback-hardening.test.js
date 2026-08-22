import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { encodeFunctionData } from "viem";

import {
  assertEvidenceAnchorReady,
  evidenceAnchorConfig
} from "../src/arc-anchor.js";
import {
  ERC8004_REPUTATION_ABI,
  verifyErc8004FeedbackTransaction
} from "../src/erc8004.js";

const BSC_REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const FEEDBACK_HASH = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Render services declare BSC explicitly and do not reuse the Arc anchor address", async () => {
  const blueprint = await fs.readFile(new URL("../render.yaml", import.meta.url), "utf8");
  assert.equal((blueprint.match(/key: ADN_SETTLEMENT_CHAIN/g) || []).length, 2);
  assert.equal((blueprint.match(/value: bsc/g) || []).length, 2);
  assert.equal((blueprint.match(/key: ADN_SETTLEMENT_RPC_URL/g) || []).length, 2);
  assert.doesNotMatch(blueprint, /0x65274c73f39bf1654f9aaf261ea16d0b08fdb8d0/i);
  assert.equal((blueprint.match(/key: ADN_EVIDENCE_ANCHOR_CONTRACT/g) || []).length, 2);
});

test("evidence anchor config prefers chain-neutral names and preflight rejects an empty BSC address", async () => {
  await withEnv({
    ADN_SETTLEMENT_CHAIN: "bsc",
    ADN_EVIDENCE_ANCHOR_CONTRACT: "0x1111111111111111111111111111111111111111",
    ADN_EVIDENCE_ANCHOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    ADN_ARC_ANCHOR_CONTRACT: "0x2222222222222222222222222222222222222222",
    ADN_ARC_ANCHOR_PRIVATE_KEY: `0x${"2".repeat(64)}`
  }, async () => {
    const config = evidenceAnchorConfig();
    assert.equal(config.contractAddress, "0x1111111111111111111111111111111111111111");
    assert.equal(config.privateKey, `0x${"1".repeat(64)}`);

    const noCode = async (_url, { body }) => {
      const { method } = JSON.parse(body);
      return { json: async () => ({ result: method === "eth_chainId" ? "0x38" : "0x" }) };
    };
    await assert.rejects(
      assertEvidenceAnchorReady({ fetchImpl: noCode }),
      (error) => error.code === "EVIDENCE_ANCHOR_NOT_DEPLOYED"
    );
  });
});

function feedbackInput() {
  return encodeFunctionData({
    abi: ERC8004_REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [22914n, 9500n, 2, "data_quality", "intent_fit", "", "https://agentrouter.network/agent-router/feedback?request_id=req_1", FEEDBACK_HASH]
  });
}

function publicClient(overrides = {}) {
  return {
    getChainId: async () => 56,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 123n }),
    getTransaction: async () => ({
      chainId: 56,
      to: BSC_REPUTATION_REGISTRY,
      from: "0x3333333333333333333333333333333333333333",
      input: feedbackInput()
    }),
    ...overrides
  };
}

const expected = {
  chainId: 56,
  registryAddress: BSC_REPUTATION_REGISTRY,
  agentId: "22914",
  feedbackHash: FEEDBACK_HASH,
  value: 9500,
  valueDecimals: 2,
  tag1: "data_quality",
  tag2: "intent_fit",
  endpoint: "",
  feedbackUri: "https://agentrouter.network/agent-router/feedback?request_id=req_1"
};

test("ERC-8004 client feedback is accepted only after authoritative on-chain verification", async () => {
  const verified = await verifyErc8004FeedbackTransaction({
    txHash: TX_HASH,
    expected,
    publicClient: publicClient()
  });
  assert.equal(verified.status, "submitted");
  assert.equal(verified.chain_id, 56);
  assert.equal(verified.registry_address, BSC_REPUTATION_REGISTRY);
  assert.equal(verified.agent_id, "22914");
  assert.equal(verified.feedback_hash, FEEDBACK_HASH);
  assert.equal(verified.block_number, "123");
});

test("ERC-8004 client feedback rejects fake, reverted, foreign-chain and mismatched calls", async () => {
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getTransactionReceipt: async () => null }) }),
    (error) => error.code === "ERC8004_RECEIPT_NOT_FOUND"
  );
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getTransactionReceipt: async () => ({ status: "reverted" }) }) }),
    (error) => error.code === "ERC8004_TRANSACTION_REVERTED"
  );
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getChainId: async () => 97 }) }),
    (error) => error.code === "ERC8004_CHAIN_MISMATCH"
  );
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getTransaction: async () => ({ chainId: 56, to: "0x4444444444444444444444444444444444444444", input: feedbackInput() }) }) }),
    (error) => error.code === "ERC8004_REGISTRY_MISMATCH"
  );
  const wrongHashInput = encodeFunctionData({
    abi: ERC8004_REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [22914n, 9500n, 2, "data_quality", "intent_fit", "", expected.feedbackUri, `0x${"c".repeat(64)}`]
  });
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getTransaction: async () => ({ chainId: 56, to: BSC_REPUTATION_REGISTRY, input: wrongHashInput }) }) }),
    (error) => error.code === "ERC8004_FEEDBACK_HASH_MISMATCH"
  );
  const wrongValueInput = encodeFunctionData({
    abi: ERC8004_REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [22914n, 100n, 2, "data_quality", "intent_fit", "", expected.feedbackUri, FEEDBACK_HASH]
  });
  await assert.rejects(
    verifyErc8004FeedbackTransaction({ txHash: TX_HASH, expected, publicClient: publicClient({ getTransaction: async () => ({ chainId: 56, to: BSC_REPUTATION_REGISTRY, input: wrongValueInput }) }) }),
    (error) => error.code === "ERC8004_FEEDBACK_VALUE_MISMATCH"
  );
});
