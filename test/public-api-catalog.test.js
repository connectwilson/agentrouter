import test from "node:test";
import assert from "node:assert/strict";
import { discoverApiServices, discoverPublicApiCatalog, publishApiDrafts } from "../src/openapi-import.js";
import { createMemoryStore } from "../src/store.js";
import { studioHtml } from "../src/studio.js";

const SAMPLE_CATALOG = `# Public APIs

### Social

| API | Description | Auth | HTTPS | CORS |
|---|---|---|---|---|
| [Mastodon](https://docs.joinmastodon.org/api/) | Federated social network API | OAuth | Yes | Yes |
| [Legacy Social](http://legacy.example/docs) | Old social endpoint | No | No | Unknown |

### Weather

| API | Description | Auth | HTTPS | CORS |
|---|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/en/docs) | Weather forecasts | No | Yes | Yes |
`;

test("Public APIs repository imports as non-publishable AgentRouter discovery candidates", async () => {
  const requested = [];
  const discovered = await discoverPublicApiCatalog({
    api_url: "https://github.com/public-apis/public-apis",
    catalog_categories: ["Social"],
    catalog_limit: 10
  }, {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(SAMPLE_CATALOG, { status: 200, headers: { "content-type": "text/markdown" } });
    }
  });

  assert.equal(discovered.mode, "public_api_catalog");
  assert.equal(requested[0], "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md");
  assert.equal(discovered.catalog.candidate_count, 1);
  assert.equal(discovered.catalog.skipped_count, 1);
  assert.equal(discovered.drafts.length, 1);
  assert.deepEqual(discovered.skipped, [{ category: "Social", title: "Legacy Social", reason: "https_required" }]);

  const candidate = discovered.drafts[0];
  assert.equal(candidate.title, "Mastodon");
  assert.equal(candidate.source_type, "public_api_catalog");
  assert.equal(candidate.discovery_status, "catalog_candidate");
  assert.equal(candidate.registry_eligible, false);
  assert.equal(candidate.publish_blocked, true);
  assert.equal(candidate.selected, false);
  assert.equal(candidate.discovery_url, "https://docs.joinmastodon.org/api/");
  assert.equal(candidate.catalog_metadata.category, "Social");
  assert.equal(candidate.catalog_metadata.auth, "OAuth");
  assert.equal(candidate.catalog_metadata.https, true);
  assert.equal("upstream_url" in candidate, false);
});

test("catalog candidates cannot bypass endpoint discovery and live validation", async () => {
  const store = createMemoryStore();
  const result = await publishApiDrafts({
    publish_scope: "local_only",
    drafts: [{
      selected: true,
      service_id: "catalog_mastodon",
      title: "Mastodon",
      source_type: "public_api_catalog",
      publish_blocked: true,
      discovery_url: "https://docs.joinmastodon.org/api/"
    }]
  }, store, "http://127.0.0.1:8800");

  assert.equal(result.ok, false);
  assert.equal(result.published.length, 0);
  assert.equal(result.failed[0].error, "CATALOG_CANDIDATE_REQUIRES_ENDPOINT_DISCOVERY");
  assert.equal(store.services.size, 0);
});

test("normal Provider Studio discovery recognizes the Public APIs repository", async () => {
  const discovered = await discoverApiServices({
    api_url: "https://github.com/public-apis/public-apis",
    catalog_query: "Mastodon"
  }, "http://127.0.0.1:8800", {
    fetchImpl: async () => new Response(SAMPLE_CATALOG, { status: 200 })
  });

  assert.equal(discovered.mode, "public_api_catalog");
  assert.equal(discovered.drafts[0].discovery_url, "https://docs.joinmastodon.org/api/");
});

test("Provider Studio renders catalog candidates as documentation discovery actions", () => {
  const html = studioHtml({ auth: { user: { name: "Provider", email: "provider@example.com" } } });
  assert.match(html, /Public APIs catalog/);
  assert.match(html, /Inspect API docs/);
  assert.match(html, /public_api_catalog/);
});
