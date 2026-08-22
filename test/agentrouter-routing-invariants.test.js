import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inferDataRequirement, inferExternalApiRequest } from "../src/external-api-capability.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(
  path.join(here, "fixtures", "agentrouter-routing-invariants.json"), "utf8"
));

const route = (prompt) => inferExternalApiRequest(prompt, { connectedSources: ["exa"] });

test("paraphrases preserve the same typed data requirement and provider route", () => {
  for (const group of corpus.paraphrase_groups) {
    for (const prompt of group.prompts) {
      const requirement = inferDataRequirement(prompt);
      const routed = route(prompt);
      assert.equal(requirement.capability, group.expected_capability, `${group.id}: ${prompt}`);
      assert.equal(requirement.evidence_type, group.expected_evidence_type, `${group.id}: ${prompt}`);
      assert.equal(routed.params.source, group.expected_source, `${group.id}: ${prompt}`);
      assert.deepEqual(routed.data_requirement, requirement.public_contract);
    }
  }
});

test("contrast pairs remain distinct instead of sharing a keyword route", () => {
  for (const pair of corpus.contrast_pairs) {
    assert.equal(route(pair.left.prompt)?.params.source, pair.left.source, `${pair.id}: left`);
    assert.equal(route(pair.right.prompt)?.params.source, pair.right.source, `${pair.id}: right`);
  }
});

test("typed requirements keep provider choice out of the public intent contract", () => {
  const requirement = inferDataRequirement("查询下周五从台北飞往东京的直飞航班");
  assert.equal(requirement.capability, "flight_search");
  assert.equal(requirement.data_object, "flight_options");
  assert.equal(requirement.operation, "flight_search");
  assert.equal(requirement.read_only, true);
  assert.equal("source" in requirement.public_contract, false);
  assert.equal("candidate_sources" in requirement.public_contract, false);
});
