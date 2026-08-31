import assert from "node:assert/strict";
import test from "node:test";
import { firstSpecifiedBudget } from "../src/budget-normalization.js";
import { remoteMcpTools } from "../packages/agentrouter-mcp/server/tool-catalog.js";

test("budget precedence preserves numeric and string zero", () => {
  assert.equal(firstSpecifiedBudget(0, "0.05"), 0);
  assert.equal(firstSpecifiedBudget("0", "0.05"), "0");
  assert.equal(firstSpecifiedBudget(undefined, 0, "0.05"), 0);
  assert.equal(firstSpecifiedBudget(null, undefined, "0.05"), "0.05");
});

test("MCP schemas accept numeric zero for documented free-only calls", () => {
  for (const name of ["agentrouter_fetch", "agentrouter_ask"]) {
    const tool = remoteMcpTools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool.inputSchema.properties.max_price.type, ["string", "number"]);
  }
});
