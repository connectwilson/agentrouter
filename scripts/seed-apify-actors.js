#!/usr/bin/env node
// Registers the seed Apify actors from PRD_APIFY_INTEGRATION.md §12.5 as
// AgentRouter services.
//
//   APIFY_TOKEN=apify_api_... node scripts/seed-apify-actors.js
//
// The token is read from the environment, stored through the normal provider
// secret path, and never written into a manifest or printed. Registration runs
// validateService, which invokes each actor once, so a bad token or a broken
// actor fails here rather than at a buyer's first paid call.

import { createMemoryStore } from "../src/store.js";
import { createApifyActorProviderConfig, writeProviderConfig } from "../src/provider-config.js";
import { loadProviderConfigs, registerService, validateService } from "../src/registry.js";
import { pathToFileURL } from "node:url";
import { fetchApifyActorMetadata } from "../src/provider-runtime.js";

const token = String(process.env.APIFY_TOKEN || "").trim();
const baseUrl = String(process.env.AGENT_ROUTER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const dryRun = process.argv.includes("--dry-run");

export const SEED_ACTORS = [
  {
    serviceId: "apify_google_search",
    actorId: "apify~google-search-scraper",
    title: "Google Search Results (Apify)",
    description: "Runs a Google search and returns organic result titles, URLs, and descriptions.",
    capabilities: ["data_service", "web_search", "serp"],
    price: "0.02",
    inputAllowlist: ["queries", "maxPagesPerQuery", "resultsPerPage", "countryCode", "languageCode"],
    inputTemplate: { resultsPerPage: 10, maxPagesPerQuery: 1 },
    datasetFields: ["title", "url", "description"],
    maxItems: 20,
    sampleRequest: { queries: "agent data marketplace" },
    summary: "Google SERP via the Apify google-search-scraper actor."
  },
  {
    serviceId: "apify_rag_web_browser",
    actorId: "apify~rag-web-browser",
    title: "Web Search and Page Reader (Apify)",
    description: "Searches the web and returns page content as markdown, shaped for agent consumption.",
    capabilities: ["data_service", "web_search", "web_content"],
    price: "0.03",
    inputAllowlist: ["query", "maxResults", "outputFormats", "requestTimeoutSecs"],
    inputTemplate: { maxResults: 3, outputFormats: ["markdown"] },
    datasetFields: [],
    maxItems: 10,
    sampleRequest: { query: "what is the x402 payment protocol" },
    summary: "Agent-native web search and page reading via the Apify rag-web-browser actor."
  }
];

export function buildSeedConfig(seed, { baseUrl: base, secretValue }) {
  return createApifyActorProviderConfig({
    baseUrl: base,
    serviceId: seed.serviceId,
    providerId: "apify",
    title: seed.title,
    description: seed.description,
    capabilities: seed.capabilities,
    price: seed.price,
    sampleRequest: seed.sampleRequest,
    sampleData: { items: [], item_count: 0, actor_id: seed.actorId },
    actorId: seed.actorId,
    inputTemplate: seed.inputTemplate,
    inputAllowlist: seed.inputAllowlist,
    datasetFields: seed.datasetFields,
    maxItems: seed.maxItems,
    secretValue,
    summary: seed.summary
  });
}

export async function seedApifyActors() {
  if (!token) {
    process.stderr.write("APIFY_TOKEN is required.\nUsage: APIFY_TOKEN=apify_api_... node scripts/seed-apify-actors.js\n");
    return 1;
  }
  const store = createMemoryStore();
  await loadProviderConfigs(store, baseUrl);

  let failed = 0;
  for (const seed of SEED_ACTORS) {
    try {
      // Confirm the actor exists and the token can read it before writing config.
      const metadata = await fetchApifyActorMetadata(seed.actorId, token);
      process.stdout.write(`\n${seed.actorId}\n  actor: ${metadata.title}\n`);

      const unknown = seed.inputAllowlist.filter((key) => !metadata.input_allowlist.includes(key));
      if (unknown.length) {
        process.stdout.write(`  note: allowlist keys not in the actor's input schema: ${unknown.join(", ")}\n`);
      }
      if (dryRun) {
        process.stdout.write("  dry-run: config not written\n");
        continue;
      }

      const config = buildSeedConfig(seed, { baseUrl, secretValue: token });
      await writeProviderConfig(config);
      registerService(store, config.manifest, baseUrl);
      const validation = await validateService(store, seed.serviceId);
      if (!validation.ok) {
        failed += 1;
        process.stdout.write(`  FAILED validation: ${validation.error || JSON.stringify(validation).slice(0, 200)}\n`);
        continue;
      }
      process.stdout.write(`  registered and validated as ${seed.serviceId} (${seed.price} USDC/call)\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`\n${seed.actorId}\n  FAILED: ${error.code || "ERROR"} ${error.message}\n`);
    }
  }

  process.stdout.write(`\n${SEED_ACTORS.length - failed}/${SEED_ACTORS.length} seed actors registered.\n`);
  return failed;
}

// Only run when executed directly; importing (tests) must not seed anything.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await seedApifyActors() ? 1 : 0);
}
