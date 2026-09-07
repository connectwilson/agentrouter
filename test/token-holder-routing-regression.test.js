import test from "node:test";
import assert from "node:assert/strict";
import { inferRoutePlan, inferStructuredRoutePlan } from "../src/routing/planner.js";
import { structuredRoutePreflight } from "../src/routing/runtime.js";
import { runExternalApiQuery } from "../src/external-api-capability.js";
import { createMemoryStore } from "../src/store.js";

const holderTasks = [
  "查robinhood链上PONS代币的前10大 token holder的地址",
  "查询 Robinhood Chain 上 PONS 前十名持币地址",
  "List the top 10 token holders of PONS on Robinhood Chain",
  "查以太坊 USDT 的前10大持有人",
  "Show the largest holders of USDC on Base",
  "查询 Solana 上 BONK 的持仓地址排名",
  "GeckoTerminal 查询 PONS 的 token holders",
  "查 BSC 代币 ABC 的持币大户",
  "查询 PONS 代币 holders 的地址"
];
for (const task of holderTasks) {
  test(`holder intent cannot become pools: ${task}`, () => {
    const plan = inferRoutePlan(task, { registered_capabilities: [], constraints: { max_price_usdc: "0.05" } });
    assert.equal(plan.capability, "token_holders");
    assert.equal(plan.abstain_reason, "capability_not_available");
    assert.equal(plan.auth_requirement.required, false);
    assert.equal(structuredRoutePreflight(plan).must_not_request_payment_authorization, true);
    assert.equal(plan.params.query, task);
  });
}

for (const task of ["Explain what token holders means", "搜索 X 上关于 token holders 的讨论", "研究证券持有人权益相关的论文"]) {
  test(`mentioning holders is not itself a holders dataset request: ${task}`, () => {
    assert.notEqual(inferRoutePlan(task).capability, "token_holders");
  });
}

for (const query of ["Robinhood Chain top pools", "robinhood链上交易量最大的池", "top pools on Moonbeam", "FooChain 热门池", "top pools on zksync", "robinhood 链上 PONS holders"]) {
  test(`unsupported chain/operation never calls default BSC: ${query}`, async () => {
    let calls = 0;
    const result = await runExternalApiQuery(createMemoryStore(), "", { source: "geckoterminal", operation: "trending", query }, {
      fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ data: [] }) }; }
    });
    assert.equal(calls, 0);
    assert.equal(result.status, "capability_not_available");
    assert.equal(result.must_not_request_payment_authorization, true);
  });
}

test("structured explicit chain cannot be silently dropped", async () => {
  const params = { source: "geckoterminal", operation: "trending", query: "top pools", chain: "robinhood" };
  const plan = inferStructuredRoutePlan({ capability: "external_api_query", params });
  assert.equal(plan.abstain_reason, "capability_not_available");
  let calls = 0;
  const result = await runExternalApiQuery(createMemoryStore(), "", params, { fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.status, "capability_not_available");
});

for (const [query, network] of [["BSC top pools", "bsc"], ["Ethereum top pools", "eth"], ["Solana top pools", "solana"], ["top pools", "bsc"]]) {
  test(`supported pools still execute: ${query}`, async () => {
    let called;
    await runExternalApiQuery(createMemoryStore(), "", { source: "geckoterminal", operation: "trending", query }, {
      fetchImpl: async (url) => { called = String(url); return { ok: true, json: async () => ({ data: [] }) }; }
    });
    assert.ok(called?.includes(`/networks/${network}/trending_pools`));
  });
}
