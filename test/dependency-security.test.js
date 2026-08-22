import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("solc uses a patched tmp release instead of the vulnerable pinned transitive dependency", () => {
  assert.equal(packageJson.overrides?.tmp, "0.2.7");
  assert.equal(packageLock.packages["node_modules/tmp"].version, "0.2.7");
  assert.equal(packageLock.packages["node_modules/solc"].dependencies.tmp, "0.0.33");

  const require = createRequire(import.meta.url);
  const solc = require("solc");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "Smoke.sol": { content: "pragma solidity ^0.8.0; contract Smoke { function ok() external pure returns (bool) { return true; } }" } },
    settings: { outputSelection: { "*": { "*": ["abi"] } } }
  })));
  assert.ok(output.contracts["Smoke.sol"].Smoke.abi);
});
