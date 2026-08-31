import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("production container provisions writable runtime directories for the node user", async () => {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /mkdir -p \/app\/providers \/app\/\.cache/);
  assert.match(dockerfile, /chown -R node:node \/app\/providers \/app\/\.cache/);
});

test("CI builds the production image and verifies provider writes as its runtime user", async () => {
  const workflow = await fs.readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /docker build --tag agentrouter-ci \./);
  assert.match(workflow, /docker run --rm --entrypoint sh agentrouter-ci/);
  assert.match(workflow, /test \"\$\(id -u\)\" -ne 0/);
  assert.match(workflow, /test -w \/app\/providers/);
  assert.match(workflow, /touch \/app\/providers\/\.write-smoke/);
});
