import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafePublicUrl,
  createSafePublicFetch,
  createSerializedTask,
  publicApiCoverageReport,
  requeuePublicApiCandidates,
  resolvePriorityCategories,
  runPublicApiConversionBatch,
  startPublicApiConversionJob,
  syncPublicApiCoverage
} from "../src/public-api-pipeline.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { discoverApiServices } from "../src/openapi-import.js";

const catalogEntries = [
  {
    category: "Weather",
    title: "Open Weather",
    documentation_url: "https://weather.example/docs",
    description: "Forecasts",
    auth: "No",
    https: true,
    cors: true
  },
  {
    category: "Security",
    title: "Secure Scan",
    documentation_url: "https://security.example/reference",
    description: "Threat intelligence",
    auth: "apiKey",
    https: true,
    cors: false
  },
  {
    category: "Legacy",
    title: "Old HTTP API",
    documentation_url: "http://legacy.example/docs",
    description: "Legacy data",
    auth: "No",
    https: false,
    cors: null
  }
];

function pipelineStore() {
  return {
    publicApiCatalog: new Map(),
    publicApiPipelineRuns: []
  };
}

test("catalog sync gives every API a durable coverage state", async () => {
  const store = pipelineStore();
  const result = await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries,
    now: () => "2026-07-29T10:00:00.000Z"
  });

  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(store.publicApiCatalog.size, 3);
  assert.deepEqual(result.coverage.by_status, {
    blocked_insecure_transport: 1,
    queued: 2
  });
  const legacy = [...store.publicApiCatalog.values()].find((item) => item.title === "Old HTTP API");
  assert.equal(legacy.status, "blocked_insecure_transport");
  assert.equal(legacy.blocking_reason, "https_required");
});

test("catalog resync preserves completed work and marks removed entries", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries,
    now: () => "2026-07-29T10:00:00.000Z"
  });
  const weather = [...store.publicApiCatalog.values()].find((item) => item.title === "Open Weather");
  weather.status = "validated_ready";
  weather.drafts = [{ service_id: "weather_forecast" }];

  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries.slice(0, 2),
    now: () => "2026-07-29T11:00:00.000Z"
  });

  assert.equal(store.publicApiCatalog.get(weather.candidate_id).status, "validated_ready");
  const removed = [...store.publicApiCatalog.values()].find((item) => item.title === "Old HTTP API");
  assert.equal(removed.catalog_presence, "removed");
});

test("catalog resync requeues an entry when an upstream HTTPS or auth blocker is removed", async () => {
  const store = pipelineStore();
  const blocked = { ...catalogEntries[2] };
  const credentialed = { ...catalogEntries[1] };
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => [blocked, credentialed]
  });
  const security = [...store.publicApiCatalog.values()].find((item) => item.title === "Secure Scan");
  security.status = "credential_required";
  security.blocking_reason = "provider_credential_required";

  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => [
      { ...blocked, documentation_url: "https://legacy.example/docs", https: true },
      { ...credentialed, auth: "No" }
    ]
  });

  const active = [...store.publicApiCatalog.values()].filter((item) => item.catalog_presence === "active");
  assert.equal(active.find((item) => item.title === "Old HTTP API").status, "queued");
  assert.equal(active.find((item) => item.title === "Secure Scan").status, "queued");
});

test("conversion discovers read-only drafts, probes public APIs, and separates credential work", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries
  });

  const result = await runPublicApiConversionBatch(store, {
    limit: 10,
    concurrency: 2,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async ({ provider_name: providerName }) => ({
      ok: true,
      mode: "api_docs",
      drafts: [{
        service_id: `${providerName.toLowerCase().replace(/\s+/g, "_")}_read`,
        method: "GET",
        upstream_url: `https://api.${providerName.toLowerCase().replace(/\s+/g, "")}.example/v1/data`,
        sample_request: { q: "test" }
      }, {
        service_id: "unsafe_write",
        method: "POST",
        upstream_url: "https://api.example/write",
        sample_request: {}
      }]
    }),
    probeDraft: async () => ({ ok: true, status: 200, result_shape: "object" }),
    now: () => "2026-07-29T12:00:00.000Z"
  });

  assert.equal(result.processed, 2);
  const weather = [...store.publicApiCatalog.values()].find((item) => item.title === "Open Weather");
  const security = [...store.publicApiCatalog.values()].find((item) => item.title === "Secure Scan");
  assert.equal(weather.status, "validated_ready");
  assert.equal(weather.drafts.length, 1);
  assert.equal(weather.drafts[0].method, "GET");
  assert.equal(security.status, "credential_required");
  assert.equal(security.blocking_reason, "provider_credential_required");
  assert.equal(result.coverage.total, 3);
});

test("conversion probes every discovered GET endpoint and keeps an auditable usable/unusable split", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => [catalogEntries[0]]
  });

  await runPublicApiConversionBatch(store, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => ({
      ok: true,
      mode: "api_docs",
      drafts: [{
        service_id: "weather_broken",
        title: "Broken weather endpoint",
        method: "GET",
        upstream_url: "https://weather.example/v1/broken"
      }, {
        service_id: "weather_current",
        title: "Current weather",
        method: "GET",
        upstream_url: "https://weather.example/v1/current"
      }]
    }),
    probeDraft: async (draft) => draft.service_id === "weather_current"
      ? { ok: true, status: 200, result_shape: "object" }
      : { ok: false, status: 404, result_shape: "object", reason: "http_error" }
  });

  const weather = [...store.publicApiCatalog.values()][0];
  assert.equal(weather.status, "validated_ready");
  assert.deepEqual(weather.usable_drafts.map((draft) => draft.service_id), ["weather_current"]);
  assert.deepEqual(weather.unusable_drafts.map((draft) => ({
    service_id: draft.service_id,
    status: draft.validation.status,
    reason: draft.validation.reason
  })), [{
    service_id: "weather_broken",
    status: 404,
    reason: "http_error"
  }]);
  assert.equal(weather.validation.usable_endpoint_count, 1);
  assert.equal(weather.validation.tested_endpoint_count, 2);
});

test("catalog conversion does not publish repository and issue links extracted from documentation", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => [catalogEntries[0]]
  });
  await runPublicApiConversionBatch(store, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => ({
      drafts: [{
        service_id: "weather_current",
        method: "GET",
        upstream_url: "https://api.weather.example/v1/current"
      }, {
        service_id: "documentation_issue",
        method: "GET",
        upstream_url: "https://gitlab.com/example/project/-/issues/101"
      }]
    }),
    probeDraft: async () => ({ ok: true, status: 200, result_shape: "object" })
  });

  const weather = [...store.publicApiCatalog.values()][0];
  assert.deepEqual(weather.usable_drafts.map((draft) => draft.service_id), ["weather_current"]);
  assert.equal(weather.discovered_endpoint_count, 1);
});

test("catalog discovery accepts a live JSON URL as a read-only direct endpoint", async () => {
  const discovered = await discoverApiServices({
    api_url: "https://random.example/woof.json",
    provider_name: "Random Example",
    default_method: "GET"
  }, "https://random.example", {
    allowDirectJsonEndpoint: true,
    fetchImpl: async () => new Response(JSON.stringify({ url: "https://random.example/dog.jpg" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  assert.equal(discovered.mode, "direct_endpoint");
  assert.equal(discovered.drafts[0].method, "GET");
  assert.equal(discovered.drafts[0].upstream_url, "https://random.example/woof.json");
});

test("catalog discovery scans ordinary documentation homepages when explicitly enabled", async () => {
  const discovered = await discoverApiServices({
    api_url: "https://weather.example/",
    provider_name: "Weather Example",
    default_method: "GET"
  }, "https://weather.example", {
    allowDocsFallback: true,
    fetchImpl: async (url) => {
      if (String(url).endsWith(".md")) return new Response("", { status: 404 });
      return new Response("<html><body><code>GET https://api.weather.example/v1/current</code></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
  });

  assert.equal(discovered.mode, "api_docs");
  assert.ok(discovered.drafts.some((draft) => draft.upstream_url === "https://api.weather.example/v1/current"));
});

test("serialized tasks prevent concurrent local-state writers from racing", async () => {
  let active = 0;
  let maxActive = 0;
  const completed = [];
  const runSerialized = createSerializedTask(async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(value);
    active -= 1;
  });

  await Promise.all([runSerialized(1), runSerialized(2), runSerialized(3)]);

  assert.equal(maxActive, 1);
  assert.deepEqual(completed, [1, 2, 3]);
});

test("conversion failures are recorded as retryable instead of disappearing", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries.slice(0, 1)
  });

  await runPublicApiConversionBatch(store, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => {
      const error = new Error("No endpoint found");
      error.code = "NO_HTTP_ENDPOINTS_IN_DOCS";
      throw error;
    }
  });

  const candidate = [...store.publicApiCatalog.values()][0];
  assert.equal(candidate.status, "retryable_failure");
  assert.equal(candidate.last_error.code, "NO_HTTP_ENDPOINTS_IN_DOCS");
  assert.equal(candidate.attempt_count, 1);
});

test("new queued candidates are processed before retryable failures so catalog coverage cannot starve", async () => {
  const store = pipelineStore();
  store.publicApiCatalog.set("failed-first", {
    candidate_id: "failed-first",
    catalog_presence: "active",
    category: "Test",
    title: "Failed first",
    documentation_url: "https://failed.example/docs",
    auth: "No",
    https: true,
    status: "retryable_failure",
    attempt_count: 1
  });
  store.publicApiCatalog.set("queued-second", {
    candidate_id: "queued-second",
    catalog_presence: "active",
    category: "Test",
    title: "Queued second",
    documentation_url: "https://queued.example/docs",
    auth: "No",
    https: true,
    status: "queued",
    attempt_count: 0
  });

  await runPublicApiConversionBatch(store, {
    limit: 1,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async ({ provider_name: providerName }) => ({
      drafts: [{
        service_id: providerName.toLowerCase().replaceAll(" ", "_"),
        method: "GET",
        upstream_url: "https://api.example/data"
      }]
    }),
    probeDraft: async () => ({ ok: true, status: 200, result_shape: "object" }),
    persistCandidates: async () => true,
    persistRun: async () => true
  });

  assert.equal(store.publicApiCatalog.get("queued-second").status, "validated_ready");
  assert.equal(store.publicApiCatalog.get("failed-first").attempt_count, 1);
});

test("an HTTP 200 HTML page is not accepted as a validated data API", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries.slice(0, 1)
  });
  await runPublicApiConversionBatch(store, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => ({
      ok: true,
      drafts: [{ service_id: "html_homepage", method: "GET", upstream_url: "https://api.example.com/" }]
    }),
    probeDraft: async () => ({ ok: true, status: 200, result_shape: "non_json" })
  });

  const candidate = [...store.publicApiCatalog.values()][0];
  assert.equal(candidate.status, "retryable_failure");
  assert.equal(candidate.last_error.code, "PUBLIC_API_VALIDATION_FAILED");
});

test("conversion checkpoints each candidate so a later process crash does not lose progress", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries.slice(0, 1)
  });
  const checkpoints = [];
  await runPublicApiConversionBatch(store, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => {
      throw Object.assign(new Error("Temporary docs failure"), { code: "DOCS_TIMEOUT" });
    },
    persistCandidate: async (candidate) => checkpoints.push(structuredClone(candidate))
  });

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].status, "retryable_failure");
  assert.equal(checkpoints[0].attempt_count, 1);
});

test("background conversion jobs reject overlap and expose completion state", async () => {
  const store = pipelineStore();
  await syncPublicApiCoverage(store, {
    fetchCatalogEntries: async () => catalogEntries.slice(0, 1)
  });
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const options = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    discoverApiServices: async () => {
      await discoveryGate;
      return { ok: true, drafts: [] };
    }
  };

  const first = startPublicApiConversionJob(store, options);
  const duplicate = startPublicApiConversionJob(store, options);
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.job.status, "running");

  releaseDiscovery();
  await first.completion;
  assert.equal(store.publicApiPipelineJob.status, "completed");
});

test("coverage report accounts for every active and removed catalog item", () => {
  const store = pipelineStore();
  store.publicApiCatalog.set("one", { candidate_id: "one", status: "queued", catalog_presence: "active", category: "A" });
  store.publicApiCatalog.set("two", { candidate_id: "two", status: "validated_ready", catalog_presence: "active", category: "B" });
  store.publicApiCatalog.set("three", { candidate_id: "three", status: "removed", catalog_presence: "removed", category: "B" });

  const report = publicApiCoverageReport(store);
  assert.equal(report.total, 3);
  assert.equal(report.active, 2);
  assert.equal(report.removed, 1);
  assert.equal(Object.values(report.by_status).reduce((sum, value) => sum + value, 0), 3);
});

test("automatic conversion rejects local and private network targets", async () => {
  for (const url of [
    "http://127.0.0.1/admin",
    "http://localhost/internal",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/data",
    "http://[::1]/"
  ]) {
    await assert.rejects(
      assertSafePublicUrl(url, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] }),
      (error) => error.code === "UNSAFE_CATALOG_TARGET"
    );
  }

  await assert.doesNotReject(
    assertSafePublicUrl("https://api.example.com/data", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }]
    })
  );
});

test("synthetic proxy DNS can be allowed explicitly without allowing real private targets", async () => {
  await assert.rejects(
    assertSafePublicUrl("https://api.example.com/data", {
      lookup: async () => [{ address: "198.18.0.42", family: 4 }]
    }),
    (error) => error.code === "UNSAFE_CATALOG_TARGET"
  );
  await assert.doesNotReject(
    assertSafePublicUrl("https://api.example.com/data", {
      allowSyntheticProxyAddresses: true,
      lookup: async () => [{ address: "198.18.0.42", family: 4 }]
    })
  );
  await assert.rejects(
    assertSafePublicUrl("https://api.example.com/data", {
      allowSyntheticProxyAddresses: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }]
    }),
    (error) => error.code === "UNSAFE_CATALOG_TARGET"
  );
});

test("operators can requeue a specific failure reason without reopening unrelated manual reviews", async () => {
  const store = pipelineStore();
  store.publicApiCatalog.set("dns", {
    candidate_id: "dns",
    catalog_presence: "active",
    status: "manual_review",
    blocking_reason: "unsafe_network_target",
    last_error: { code: "UNSAFE_CATALOG_TARGET" }
  });
  store.publicApiCatalog.set("docs", {
    candidate_id: "docs",
    catalog_presence: "active",
    status: "manual_review",
    blocking_reason: "no_read_only_endpoint_discovered"
  });

  const result = await requeuePublicApiCandidates(store, {
    status: "manual_review",
    reason: "unsafe_network_target",
    persistCandidates: async () => true
  });

  assert.equal(result.requeued, 1);
  assert.equal(store.publicApiCatalog.get("dns").status, "queued");
  assert.equal(store.publicApiCatalog.get("dns").blocking_reason, null);
  assert.equal(store.publicApiCatalog.get("dns").retry_priority, true);
  assert.equal(store.publicApiCatalog.get("docs").status, "manual_review");
});

test("safe documentation fetch rejects HTTPS redirects to private or insecure targets", async () => {
  const requests = [];
  const safeFetch = createSafePublicFetch({
    lookup: async (hostname) => [{
      address: hostname === "docs.example.com" ? "93.184.216.34" : "127.0.0.1",
      family: 4
    }],
    rawFetch: async (url) => {
      requests.push(String(url));
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" }
      });
    }
  });

  await assert.rejects(
    safeFetch("https://docs.example.com/api"),
    (error) => error.code === "UNSAFE_CATALOG_TARGET"
  );
  assert.equal(requests.length, 1);
});

test("safe documentation fetch times out stalled public sites", async () => {
  const safeFetch = createSafePublicFetch({
    requestTimeoutMs: 10,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    rawFetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("request timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });

  await assert.rejects(
    safeFetch("https://docs.example.com/api"),
    (error) => error.name === "AbortError"
  );
});

test("pipeline HTTP API requires an admin token and exposes durable coverage", async (t) => {
  const previousAdminToken = process.env.ADN_ADMIN_API_TOKEN;
  const previousStudioToken = process.env.ADN_STUDIO_API_TOKEN;
  process.env.ADN_ADMIN_API_TOKEN = "admin-test-token";
  process.env.ADN_STUDIO_API_TOKEN = "studio-test-token";
  t.after(() => {
    if (previousAdminToken == null) delete process.env.ADN_ADMIN_API_TOKEN;
    else process.env.ADN_ADMIN_API_TOKEN = previousAdminToken;
    if (previousStudioToken == null) delete process.env.ADN_STUDIO_API_TOKEN;
    else process.env.ADN_STUDIO_API_TOKEN = previousStudioToken;
  });

  const store = createMemoryStore();
  const server = createServer({
    store,
    publicApiPipelineOptions: {
      fetchCatalogEntries: async () => catalogEntries,
      persistCandidates: async () => false,
      persistRun: async () => false
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const forbidden = await fetch(`${baseUrl}/studio/public-api-pipeline/sync`, {
    method: "POST",
    headers: { authorization: "Bearer studio-test-token" }
  });
  assert.equal(forbidden.status, 403);

  const synced = await fetch(`${baseUrl}/studio/public-api-pipeline/sync`, {
    method: "POST",
    headers: { authorization: "Bearer admin-test-token" }
  });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).coverage.total, 3);

  const status = await fetch(`${baseUrl}/studio/public-api-pipeline/status`, {
    headers: { authorization: "Bearer admin-test-token" }
  });
  assert.equal(status.status, 200);
  const payload = await status.json();
  assert.equal(payload.coverage.active, 3);
  assert.equal(payload.candidates.length, 3);
  assert.equal(payload.runs.length, 1);
});

test("public website exposes tested Public APIs with availability reasons without login", async (t) => {
  const store = createMemoryStore();
  store.publicApiCatalog.set("usable", {
    candidate_id: "usable",
    catalog_presence: "active",
    category: "Weather",
    title: "Open Weather",
    description: "Forecasts",
    documentation_url: "https://weather.example/docs",
    auth: "No",
    https: true,
    cors: true,
    status: "validated_ready",
    usable_drafts: [{
      service_id: "weather_current",
      title: "Current weather",
      method: "GET",
      upstream_url: "https://weather.example/v1/current",
      capabilities: ["weather"]
    }],
    validation: {
      ok: true,
      status: 200,
      result_shape: "object",
      tested_endpoint_count: 2,
      usable_endpoint_count: 1
    }
  });
  store.publicApiCatalog.set("blocked", {
    candidate_id: "blocked",
    catalog_presence: "active",
    category: "Legacy",
    title: "Old HTTP API",
    description: "Legacy data",
    documentation_url: "http://legacy.example/docs",
    auth: "No",
    https: false,
    status: "blocked_insecure_transport",
    blocking_reason: "https_required"
  });
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/public-apis?availability=usable`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.usable, 1);
  assert.equal(payload.summary.unavailable, 1);
  assert.equal(payload.total, 1);
  assert.equal(payload.apis[0].title, "Open Weather");
  assert.equal(payload.apis[0].availability, "usable");
  assert.deepEqual(payload.apis[0].endpoints.map((item) => item.service_id), ["weather_current"]);

  const page = await fetch(`${baseUrl}/public-apis`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Public APIs coverage/);
  assert.match(html, /\/api\/public-apis/);

  const home = await fetch(baseUrl);
  assert.match(await home.text(), /href="\/public-apis"/);
});

function tierStore(rows) {
  const store = createMemoryStore();
  store.publicApiCatalog = new Map(rows.map((row, index) => [`c${index}`, {
    candidate_id: `c${index}`,
    catalog_presence: "active",
    status: "queued",
    attempt_count: 0,
    documentation_url: `https://example.com/${index}`,
    https: true,
    ...row
  }]));
  return store;
}

async function runTierBatch(store, options) {
  const attempted = [];
  await runPublicApiConversionBatch(store, {
    limit: 10,
    concurrency: 1,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    persistCandidates: async () => {},
    persistCandidate: async () => {},
    persistRun: async () => {},
    discoverApiServices: async (input) => {
      attempted.push(input.provider_name);
      return { drafts: [] };
    },
    rawFetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "" }),
    ...options
  });
  return attempted;
}

test("priority tiers resolve to the agent-useful public-api categories", () => {
  assert.deepEqual(resolvePriorityCategories("P0"), ["Government", "Open Data", "Science & Math"]);
  assert.deepEqual(resolvePriorityCategories("P1"), ["Geocoding", "Cryptocurrency"]);
  assert.deepEqual(resolvePriorityCategories("P2"), ["Health", "Transportation"]);
  assert.deepEqual(resolvePriorityCategories("P0,P1").slice(0, 4), ["Government", "Open Data", "Science & Math", "Geocoding"]);
  // No tier means every prioritized category, not the whole 1600-row catalog.
  assert.equal(resolvePriorityCategories("").length, 7);
  assert.equal(resolvePriorityCategories("ALL").length, 7);
  assert.throws(() => resolvePriorityCategories("P9"), /Unknown priority tier/);
});

test("conversion batches only work the requested categories", async () => {
  const store = tierStore([
    { title: "Gov A", category: "Government", auth: "No" },
    { title: "Games B", category: "Games & Comics", auth: "No" },
    { title: "Animals C", category: "Animals", auth: "No" }
  ]);
  const attempted = await runTierBatch(store, { categories: resolvePriorityCategories("P0") });
  assert.deepEqual(attempted, ["Gov A"]);
});

test("candidates that already declare a credential are settled without a document fetch", async () => {
  const store = tierStore([
    { title: "Keyed", category: "Government", auth: "apiKey" },
    { title: "OAuthed", category: "Government", auth: "OAuth" },
    { title: "Open", category: "Government", auth: "No" }
  ]);
  const attempted = await runTierBatch(store, { categories: resolvePriorityCategories("P0") });
  // Only the key-free candidate is worth a discovery fetch...
  assert.deepEqual(attempted, ["Open"]);
  // ...but the credentialed ones are still classified, not left queued forever.
  const byTitle = Object.fromEntries([...store.publicApiCatalog.values()].map((row) => [row.title, row]));
  assert.equal(byTitle.Keyed.status, "credential_required");
  assert.equal(byTitle.Keyed.blocking_reason, "provider_credential_required");
  assert.equal(byTitle.OAuthed.status, "credential_required");
  assert.equal(byTitle.Open.status !== "credential_required", true);
});

test("higher tiers are converted before lower ones", async () => {
  const store = tierStore([
    { title: "Health P2", category: "Health", auth: "No" },
    { title: "Crypto P1", category: "Cryptocurrency", auth: "No" },
    { title: "Gov P0", category: "Government", auth: "No" }
  ]);
  const attempted = await runTierBatch(store, { categories: resolvePriorityCategories("P0,P1,P2") });
  assert.deepEqual(attempted, ["Gov P0", "Crypto P1", "Health P2"]);
});

test("APIs.guru entries arrive spec-first so conversion skips doc scraping", async () => {
  const { fetchApisGuruCatalogEntries } = await import("../src/openapi-import.js");
  const listing = {
    "1forge.com": {
      preferred: "0.0.1",
      versions: {
        "0.0.1": {
          swaggerUrl: "https://api.apis.guru/v2/specs/1forge.com/0.0.1/swagger.json",
          info: { title: "1Forge Finance APIs", description: "Forex", "x-apisguru-categories": ["financial"], "x-providerName": "1forge.com" }
        }
      }
    },
    "insecure.example": {
      preferred: "1",
      versions: { 1: { swaggerUrl: "http://insecure.example/spec.json", info: { title: "Insecure" } } }
    },
    "nospec.example": {
      preferred: "1",
      versions: { 1: { info: { title: "No spec" } } }
    }
  };
  const entries = await fetchApisGuruCatalogEntries({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => listing })
  });
  // Plain-HTTP and spec-less rows are dropped before they reach the pipeline.
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.title, "1Forge Finance APIs");
  assert.equal(entry.category, "Finance");
  assert.equal(entry.source_catalog, "apis.guru");
  assert.equal(entry.https, true);
  // The documentation target is the spec itself, not a human docs homepage.
  assert.equal(entry.documentation_url, entry.spec_url);
  assert.match(entry.documentation_url, /swagger\.json$/);
});

test("Swagger 2.0 endpoints resolve against the spec's own host, not its download URL", async () => {
  const { discoverApiServices } = await import("../src/openapi-import.js");
  const spec = {
    swagger: "2.0",
    schemes: ["https", "http"],
    host: "1forge.com",
    basePath: "/forex-quotes",
    paths: { "/quotes": { get: { summary: "Get quotes", responses: { 200: { description: "ok" } } } } }
  };
  const body = JSON.stringify(spec);
  const mirroredSpecUrl = "https://api.apis.guru/v2/specs/1forge.com/0.0.1/swagger.json";
  const result = await discoverApiServices(
    { api_url: mirroredSpecUrl, provider_name: "1Forge", default_method: "GET", default_price: "0" },
    mirroredSpecUrl,
    {
      allowDirectJsonEndpoint: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (key) => (key.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => body,
        json: async () => spec
      })
    }
  );
  assert.equal(result.mode, "openapi");
  assert.equal(result.drafts.length, 1);
  // Mirrored specs would otherwise point every endpoint at the mirror host.
  assert.equal(result.drafts[0].upstream_url, "https://1forge.com/forex-quotes/quotes");
});

test("syncing one catalog source does not retire another source's rows", async () => {
  const store = createMemoryStore();
  const noop = { persistCandidates: async () => {}, persistCandidate: async () => {}, persistRun: async () => {} };

  await syncPublicApiCoverage(store, {
    ...noop,
    fetchCatalogEntries: async () => [
      { category: "Books", title: "Legacy Row", documentation_url: "https://legacy.example/1", https: true, auth: "No" }
    ]
  });
  await syncPublicApiCoverage(store, {
    ...noop,
    fetchCatalogEntries: async () => [
      { category: "Finance", title: "Guru Row", documentation_url: "https://api.apis.guru/v2/specs/x/openapi.json", https: true, auth: null, source_catalog: "apis.guru" }
    ]
  });

  const byTitle = Object.fromEntries([...store.publicApiCatalog.values()].map((row) => [row.title, row]));
  // Adding a second catalog must not mark the first catalog's work as removed.
  assert.equal(byTitle["Legacy Row"].catalog_presence, "active");
  assert.equal(byTitle["Guru Row"].catalog_presence, "active");
  assert.equal(byTitle["Legacy Row"].source_catalog, "github:public-apis/public-apis");
  assert.equal(byTitle["Guru Row"].source_catalog, "apis.guru");

  // A genuine upstream removal inside the same source still registers.
  await syncPublicApiCoverage(store, {
    ...noop,
    fetchCatalogEntries: async () => [
      { category: "Finance", title: "Guru Row 2", documentation_url: "https://api.apis.guru/v2/specs/y/openapi.json", https: true, auth: null, source_catalog: "apis.guru" }
    ]
  });
  const after = Object.fromEntries([...store.publicApiCatalog.values()].map((row) => [row.title, row]));
  assert.equal(after["Guru Row"].catalog_presence, "removed");
  assert.equal(after["Legacy Row"].catalog_presence, "active");
});

test("credential-settled candidates are still persisted, and source filtering isolates catalogs", async () => {
  const store = createMemoryStore();
  const rows = [
    { candidate_id: "a", title: "Legacy Gov", category: "Government", auth: "No", source_catalog: "github:public-apis/public-apis" },
    { candidate_id: "b", title: "Guru Open", category: "Development", auth: "No", source_catalog: "apis.guru" },
    { candidate_id: "c", title: "Guru Keyed", category: "Development", auth: "apiKey", source_catalog: "apis.guru" }
  ];
  for (const row of rows) {
    store.publicApiCatalog.set(row.candidate_id, {
      ...row, https: true, status: "queued", catalog_presence: "active", attempt_count: 0,
      documentation_url: `https://example.com/${row.candidate_id}`
    });
  }

  const persisted = [];
  const discovered = [];
  await runPublicApiConversionBatch(store, {
    limit: 10,
    concurrency: 1,
    sources: ["apis.guru"],
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    persistCandidate: async (candidate) => { persisted.push(candidate.title); },
    persistCandidates: async () => {},
    persistRun: async () => {},
    discoverApiServices: async (input) => { discovered.push(input.provider_name); return { drafts: [] }; },
    rawFetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "" })
  });

  // The other catalog is untouched by a source-scoped run.
  assert.equal(discovered.includes("Legacy Gov"), false);
  assert.equal(store.publicApiCatalog.get("a").status, "queued");
  // Only the key-free row costs a discovery fetch...
  assert.deepEqual(discovered, ["Guru Open"]);
  // ...but the credentialed row must still be written out, or its status is
  // lost on restart and it gets retried forever.
  assert.deepEqual(persisted.sort(), ["Guru Keyed", "Guru Open"]);
  assert.equal(store.publicApiCatalog.get("c").status, "credential_required");
});
