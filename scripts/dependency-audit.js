#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RETRYABLE_AUDIT_ERROR = /audit endpoint returned an error|too many requests|\b(?:429|502|503|504)\b|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up/i;

export async function runDependencyAudit({
  run = runNpmAudit,
  wait = sleep,
  attempts = 3,
} = {}) {
  const maximumAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = await run();
    if (result?.status === 0) return result;

    const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    const retryable = RETRYABLE_AUDIT_ERROR.test(output);
    if (!retryable) {
      throw auditError("DEPENDENCY_AUDIT_FAILED", "npm audit found a vulnerability or configuration error", result, attempt);
    }
    if (attempt === maximumAttempts) {
      throw auditError("DEPENDENCY_AUDIT_UNAVAILABLE", "npm audit infrastructure remained unavailable", result, attempt);
    }

    await wait(1_000 * (2 ** (attempt - 1)));
  }

  throw new Error("Dependency audit exhausted without a result");
}

export function runNpmAudit({
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  const command = platform === "win32" ? "npm.cmd" : "npm";
  const completed = spawn(command, ["audit", "--audit-level=high"], {
    encoding: "utf8",
    env,
  });
  return {
    status: Number.isInteger(completed.status) ? completed.status : 1,
    stdout: completed.stdout || "",
    stderr: completed.stderr || completed.error?.message || "",
  };
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function auditError(code, message, result, attempts) {
  const error = new Error(message);
  error.code = code;
  error.result = result;
  error.attempts = attempts;
  return error;
}

export async function runDependencyAuditCli({
  audit = runDependencyAudit,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await audit();
    stdout.write(result.stdout);
    stderr.write(result.stderr);
    return 0;
  } catch (error) {
    stdout.write(error.result?.stdout || "");
    stderr.write(error.result?.stderr || "");
    stderr.write(`Dependency audit failed after ${error.attempts || 1} attempt(s): ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDependencyAuditCli();
}
