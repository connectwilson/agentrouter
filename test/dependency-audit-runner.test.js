import test from "node:test";
import assert from "node:assert/strict";

import { runDependencyAudit } from "../scripts/dependency-audit.js";

function result(status, stderr = "", stdout = "") {
  return { status, stderr, stdout };
}

test("dependency audit returns immediately when npm audit succeeds", async () => {
  const calls = [];
  const audit = await runDependencyAudit({
    run: async () => {
      calls.push("audit");
      return result(0, "", "found 0 vulnerabilities");
    },
    wait: async () => assert.fail("successful audit must not wait"),
  });

  assert.equal(audit.status, 0);
  assert.equal(calls.length, 1);
});

test("dependency audit retries npm registry infrastructure failures", async () => {
  const responses = [
    result(1, "npm error audit endpoint returned an error\nInvalid package tree"),
    result(1, "npm error 429 Too Many Requests"),
    result(0, "", "found 0 vulnerabilities"),
  ];
  const waits = [];

  const audit = await runDependencyAudit({
    run: async () => responses.shift(),
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(audit.status, 0);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("dependency audit never retries or hides a vulnerability result", async () => {
  let calls = 0;

  await assert.rejects(
    runDependencyAudit({
      run: async () => {
        calls += 1;
        return result(1, "", "1 high severity vulnerability");
      },
      wait: async () => assert.fail("vulnerability result must not wait"),
    }),
    (error) => error.code === "DEPENDENCY_AUDIT_FAILED"
      && error.result.stdout.includes("high severity vulnerability"),
  );
  assert.equal(calls, 1);
});

test("dependency audit fails after its bounded infrastructure retries", async () => {
  let calls = 0;

  await assert.rejects(
    runDependencyAudit({
      run: async () => {
        calls += 1;
        return result(1, "npm error audit endpoint returned an error");
      },
      wait: async () => {},
    }),
    (error) => error.code === "DEPENDENCY_AUDIT_UNAVAILABLE"
      && error.attempts === 3,
  );
  assert.equal(calls, 3);
});
