import test from "node:test";
import assert from "node:assert/strict";

import {
  runDependencyAudit,
  runDependencyAuditCli,
  runNpmAudit,
  sleep,
} from "../scripts/dependency-audit.js";

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

test("npm audit subprocess uses argument arrays and normalizes its result", () => {
  const calls = [];
  const audit = runNpmAudit({
    platform: "linux",
    env: { CI: "true" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "found 0 vulnerabilities\n", stderr: "" };
    },
  });

  assert.equal(audit.status, 0);
  assert.equal(audit.stdout, "found 0 vulnerabilities\n");
  assert.deepEqual(calls[0].args, ["audit", "--audit-level=high"]);
  assert.equal(calls[0].command, "npm");
  assert.deepEqual(calls[0].options.env, { CI: "true" });
});

test("dependency audit CLI preserves audit output and reports a typed failure", async () => {
  const output = [];
  const streams = {
    stdout: { write: (value) => output.push(["stdout", value]) },
    stderr: { write: (value) => output.push(["stderr", value]) },
  };

  assert.equal(await runDependencyAuditCli({
    audit: async () => result(0, "notice\n", "clean\n"),
    ...streams,
  }), 0);
  assert.equal(await runDependencyAuditCli({
    audit: async () => {
      const error = new Error("registry unavailable");
      error.code = "DEPENDENCY_AUDIT_UNAVAILABLE";
      error.attempts = 3;
      error.result = result(1, "network error\n");
      throw error;
    },
    ...streams,
  }), 1);

  assert.deepEqual(output.slice(0, 2), [["stdout", "clean\n"], ["stderr", "notice\n"]]);
  assert.ok(output.some(([, value]) => value.includes("failed after 3 attempt(s)")));
});

test("dependency audit delay helper resolves", async () => {
  await sleep(0);
});

test("dependency audit normalizes an invalid attempt limit to one", async () => {
  let calls = 0;
  await assert.rejects(runDependencyAudit({
    attempts: 0,
    run: async () => {
      calls += 1;
      return undefined;
    },
    wait: async () => assert.fail("a single non-retryable attempt must not wait"),
  }), (error) => error.code === "DEPENDENCY_AUDIT_FAILED" && error.attempts === 1);
  assert.equal(calls, 1);
});

test("npm audit subprocess uses npm.cmd on Windows and preserves spawn errors", () => {
  const audit = runNpmAudit({
    platform: "win32",
    spawn: (command) => ({ status: null, stdout: null, stderr: null, error: new Error(`${command} missing`) }),
  });

  assert.equal(audit.status, 1);
  assert.equal(audit.stdout, "");
  assert.equal(audit.stderr, "npm.cmd missing");
});

test("dependency audit CLI handles an untyped failure", async () => {
  const output = [];
  const exitCode = await runDependencyAuditCli({
    audit: async () => { throw new Error("unexpected failure"); },
    stdout: { write: (value) => output.push(value) },
    stderr: { write: (value) => output.push(value) },
  });

  assert.equal(exitCode, 1);
  assert.ok(output.some((value) => value.includes("failed after 1 attempt(s)")));
});
