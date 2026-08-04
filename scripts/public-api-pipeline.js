#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryStore } from "../src/store.js";
import { fetchApisGuruCatalogEntries } from "../src/openapi-import.js";
import { persistenceEnabled, writePersistentPublicApiCandidates } from "../src/persistence.js";
import {
  createSerializedTask,
  hydratePublicApiCoverage,
  publicApiCoverageReport,
  requeuePublicApiCandidates,
  resolvePriorityCategories,
  runPublicApiConversionBatch,
  syncPublicApiCoverage
} from "../src/public-api-pipeline.js";

const command = process.argv[2] || "coverage";
const store = createMemoryStore();
await hydratePublicApiCoverage(store);
const localStatePath = path.resolve(process.env.ADN_PUBLIC_API_PIPELINE_STATE_PATH || ".adn/public-api-pipeline.json");
if (!persistenceEnabled()) await loadLocalState();
const saveLocalStateSerialized = createSerializedTask(saveLocalState);
const persistenceOptions = persistenceEnabled()
  ? {}
  : {
      persistCandidates: saveLocalStateSerialized,
      persistCandidate: saveLocalStateSerialized,
      persistRun: saveLocalStateSerialized
    };
const pipelineOptions = {
  ...persistenceOptions,
  allowSyntheticProxyAddresses: process.env.ADN_PUBLIC_API_ALLOW_SYNTHETIC_DNS === "1"
    || process.argv.includes("--allow-synthetic-dns")
};

if (command === "sync") {
  const sourceName = argumentValue("--source", "public-apis");
  const result = await syncPublicApiCoverage(store, {
    ...pipelineOptions,
    ...(sourceName === "apis-guru" ? { fetchCatalogEntries: fetchApisGuruCatalogEntries } : {})
  });
  print(result);
} else if (command === "run") {
  const explicitCategories = argumentValue("--category", "");
  const limit = argumentNumber("--limit", 25);
  // A batch makes several network calls per candidate, so without progress the
  // run looks hung for minutes. Report each candidate as it settles.
  const quiet = process.argv.includes("--quiet");
  let settled = 0;
  const reportProgress = (candidate) => {
    if (quiet) return;
    settled += 1;
    const reason = candidate.blocking_reason || candidate.last_error?.code || "";
    process.stderr.write(`[${settled}/${limit}] ${candidate.status.padEnd(22)} ${String(candidate.title || "").slice(0, 40)}${reason ? `  (${reason})` : ""}\n`);
  };
  const persistCandidate = pipelineOptions.persistCandidate;
  const result = await runPublicApiConversionBatch(store, {
    ...pipelineOptions,
    persistCandidate: async (candidate) => {
      reportProgress(candidate);
      // Overriding the hook replaces the pipeline's default writer, so keep
      // persisting through whichever backend this run actually uses.
      if (persistCandidate) await persistCandidate(candidate);
      else await writePersistentPublicApiCandidates([candidate]);
    },
    limit,
    concurrency: argumentNumber("--concurrency", 3),
    sources: argumentValue("--source", "") === "apis-guru"
      ? ["apis.guru"]
      : (argumentValue("--source", "") || null),
    categories: explicitCategories
      ? explicitCategories.split(",")
      : resolvePriorityCategories(argumentValue("--tier", "P0"))
  });
  print(result);
} else if (command === "retry") {
  const result = await requeuePublicApiCandidates(store, {
    ...pipelineOptions,
    status: argumentValue("--status", "manual_review"),
    reason: argumentValue("--reason", "")
  });
  print(result);
} else if (command === "coverage") {
  print({ ok: true, coverage: publicApiCoverageReport(store) });
} else {
  console.error("Usage: node scripts/public-api-pipeline.js <sync|run|retry|coverage> [--limit N] [--concurrency N] [--status STATUS] [--reason REASON] [--allow-synthetic-dns]");
  process.exitCode = 2;
}

function argumentNumber(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : String(process.argv[index + 1] || fallback);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function loadLocalState() {
  try {
    const saved = JSON.parse(await fs.readFile(localStatePath, "utf8"));
    for (const candidate of saved.candidates || []) {
      if (candidate?.candidate_id) store.publicApiCatalog.set(candidate.candidate_id, candidate);
    }
    store.publicApiPipelineRuns = saved.runs || [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function saveLocalState() {
  await fs.mkdir(path.dirname(localStatePath), { recursive: true });
  const temporaryPath = `${localStatePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({
    schema_version: "public_api_pipeline_state_v1",
    candidates: [...store.publicApiCatalog.values()],
    runs: store.publicApiPipelineRuns.slice(0, 100)
  }, null, 2));
  await fs.rename(temporaryPath, localStatePath);
  return true;
}
