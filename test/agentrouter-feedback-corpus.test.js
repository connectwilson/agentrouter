import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const corpusPath = path.join(here, "fixtures", "agentrouter-feedback-regressions.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

test("feedback regression corpus keeps the original 30 prompts as first-class cases", () => {
  assert.equal(corpus.schema_version, "agentrouter_feedback_regression_corpus_v1");
  assert.equal(corpus.routing_cases.length, 30);
  assert.deepEqual(corpus.routing_cases.map((entry) => entry.id),
    Array.from({ length: 30 }, (_, index) => `AR-FB-${String(index + 1).padStart(3, "0")}`));
  for (const entry of corpus.routing_cases) {
    assert.equal(entry.reported_at, "2026-08-17");
    assert.ok(entry.prompt);
    assert.ok(entry.category);
    assert.ok(entry.expected?.kind);
  }
});

test("every historical feedback bug is linked to an executable regression test", () => {
  assert.ok(corpus.bug_regressions.length >= 20);
  const ids = new Set();
  for (const entry of corpus.bug_regressions) {
    assert.match(entry.id, /^AR-BUG-\d{3}$/);
    assert.equal(ids.has(entry.id), false, `duplicate feedback regression id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.reported_at);
    assert.ok(entry.category);
    assert.ok(entry.scenario);
    assert.ok(entry.expected);
    assert.ok(entry.test_files.length > 0);
    for (const relative of entry.test_files) {
      const absolute = path.join(repoRoot, relative);
      assert.equal(fs.existsSync(absolute), true, `${entry.id} references missing test ${relative}`);
      assert.match(fs.readFileSync(absolute, "utf8"), /test\s*\(/, `${relative} is not an executable node:test file`);
    }
  }
});

test("the corpus records the append-on-feedback policy", () => {
  assert.equal(corpus.policy.source, "user_feedback");
  assert.match(corpus.policy.append_rule, /Every confirmed user-reported AgentRouter failure/i);
  assert.match(corpus.policy.append_rule, /before the fix is merged/i);
});
