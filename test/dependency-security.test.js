import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("solc uses a patched tmp release instead of the vulnerable pinned transitive dependency", () => {
  assert.equal(packageJson.overrides?.tmp, "0.2.7");
  assert.equal(packageLock.packages["node_modules/tmp"].version, "0.2.7");
  assert.equal(packageLock.packages["node_modules/solc"].dependencies.tmp, "0.0.33");
});
