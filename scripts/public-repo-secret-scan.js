#!/usr/bin/env node
// Fast, dependency-free guard for a repository that is mirrored publicly.
// It intentionally reports only file paths and commit ids, never matching text.
import { spawnSync } from "node:child_process";

const FORBIDDEN_PATH = /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_PATTERNS = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "AKIA[0-9A-Z]{16}",
  "ASIA[0-9A-Z]{16}",
  "gh[pousr]_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "sk_(live|test|proj|ant)_[A-Za-z0-9_-]{16,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}"
];

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function trackedForbiddenFiles() {
  return runGit(["ls-files"]).split("\n").filter((path) => FORBIDDEN_PATH.test(path));
}

function historicalSecretCommits() {
  return SECRET_PATTERNS.flatMap((pattern) => {
    const output = runGit(["log", "--format=%H", "HEAD", "-G", pattern, "--", "."]);
    return output ? output.split("\n") : [];
  });
}

const forbidden = trackedForbiddenFiles();
const commits = [...new Set(historicalSecretCommits())];
if (forbidden.length || commits.length) {
  if (forbidden.length) console.error(`Tracked sensitive paths: ${forbidden.join(", ")}`);
  if (commits.length) console.error(`Potential secret patterns in commits: ${commits.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Public mirror secret scan passed: no tracked secret files or known key patterns in HEAD history.");
}
