import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/store.js";
import { authUserKey, createDevSession } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { getCapabilityCatalog } from "../src/router.js";
import { createSocialConnection } from "../src/social-connections.js";
import { getExternalApiCatalog, runExternalApiQuery } from "../src/external-api-capability.js";
import { researchHtml } from "../src/research.js";
import { createCreditApiKey, ensureCreditAccount } from "../src/credits.js";

function secrets() {
  const values = new Map();
  return {
    writeSecret: async ({ serviceId, secretName, secretValue }) => {
      const ref = `${serviceId}:${secretName}`;
      values.set(ref, secretValue);
      return ref;
    },
    readSecret: async (ref) => values.get(ref) || ""
  };
}

test("external API catalog separates callable connectors from planned sources", () => {
  const catalog = getExternalApiCatalog();
  assert.equal(catalog.find((item) => item.source === "brave_search").implementation_status, "available");
  assert.equal(catalog.find((item) => item.source === "github").connection_required, false);
  assert.equal(catalog.find((item) => item.source === "open_meteo").implementation_status, "available");
  assert.equal(catalog.find((item) => item.source === "youtube").provider_type, "youtube_api");
  assert.equal(catalog.find((item) => item.source === "virus_total").provider_type, "virustotal_api");
  assert.equal(catalog.find((item) => item.source === "google_places").provider_type, "google_places_api");
  assert.equal(catalog.find((item) => item.source === "amadeus").operations.includes("flight_search"), true);
  assert.equal(catalog.find((item) => item.source === "easy_post").operations.includes("track"), true);
  assert.equal(catalog.find((item) => item.source === "openalex").operations.includes("search"), true);
  assert.equal(catalog.find((item) => item.source === "linkedin").implementation_status, "requires_partner_api");
  assert.equal(catalog.find((item) => item.source === "xiaohongshu").implementation_status, "browser_only");
  assert.deepEqual(
    ["xpoz", "socialcrawl", "socialdatax", "largitdata"].map((source) => ({
      source,
      status: catalog.find((item) => item.source === source)?.implementation_status,
      category: catalog.find((item) => item.source === source)?.category
    })),
    [
      { source: "xpoz", status: "available", category: "社交媒体" },
      { source: "socialcrawl", status: "requires_partner_api", category: "社交媒体" },
      { source: "socialdatax", status: "available", category: "社交媒体" },
      { source: "largitdata", status: "requires_partner_api", category: "社交媒体" }
    ]
  );
  assert.equal(catalog.find((item) => item.source === "exa").hub_category, "AI Search");
  assert.equal(catalog.find((item) => item.source === "openalex").hub_category, "AI Search");
  assert.equal(catalog.find((item) => item.source === "open_meteo").hub_category, null);
  const exa = catalog.find((item) => item.source === "exa");
  assert.equal(exa.available_to_agents, true);
  assert.equal(exa.price_label, "$0.007/call");
  assert.equal(exa.price_scope, "upstream_api");
  assert.equal(exa.upstream_pricing.amount, 0.007);
  assert.match(exa.upstream_pricing.source_url, /^https:\/\/exa\.ai\/pricing/);
  assert.equal(exa.total_calls, null);
  assert.equal(exa.connection_state, "unknown");
  assert.equal(exa.connected, null);
  assert.ok(catalog.every((item) => item.capability_manual?.best_for?.length));
  assert.ok(catalog.every((item) => item.capability_manual?.not_for?.length));
  assert.ok(catalog.every((item) => item.capability_manual?.route_only_when?.length));
  assert.match(exa.capability_manual.best_for.join(" "), /general web research/i);
  const openalex = catalog.find((item) => item.source === "openalex");
  assert.match(openalex.capability_manual.best_for.join(" "), /DOI|citation/i);
  assert.match(openalex.capability_manual.not_for.join(" "), /general web research/i);
  assert.ok(openalex.capability_manual.route_only_when.some((rule) => /paper|DOI|citation/i.test(rule)));
});

test("external API catalog separates service availability from account connection state", () => {
  const store = createMemoryStore();
  const exa = getExternalApiCatalog(store, "github:user-without-exa")
    .find((item) => item.source === "exa");

  assert.equal(exa.available_to_agents, true);
  assert.equal(exa.connection_state, "not_connected");
  assert.equal(exa.connected, false);
});

test("AI Search sources expose the same service metrics and detail metadata as registered APIs", () => {
  const store = createMemoryStore();
  store.feedbackEvents.push(
    {
      service_id: "external_api_exa",
      status: "success",
      schema_valid: true,
      latency_ms: 120,
      verification: { freshness_valid: true, coverage_valid: true, agent_friendly_score: 1 }
    },
    {
      service_id: "external_api_exa",
      status: "error",
      schema_valid: false,
      latency_ms: 500,
      verification: null
    }
  );

  const exa = getExternalApiCatalog(store, "github:user-a").find((item) => item.source === "exa");
  assert.equal(exa.service_id, "external_api_exa");
  assert.equal(exa.provider_id, "provider_exa_api");
  assert.equal(exa.price_label, "$0.007/call");
  assert.equal(exa.total_calls, 2);
  assert.equal(exa.success_rate, 0.5);
  assert.equal(typeof exa.trust_score, "number");
  assert.deepEqual(exa.capabilities.slice(0, 3), ["exa", "ai_search", "search"]);
  assert.equal(exa.detail_href, "/agent-router/service?service_id=external_api_exa");
});

test("AI Search virtual services have a standard AgentRouter detail endpoint", async () => {
  const server = createServer({ store: createMemoryStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/agent-router/service?service_id=external_api_exa`);
    const detail = await response.json();
    assert.equal(response.status, 200);
    assert.equal(detail.service.service_id, "external_api_exa");
    assert.equal(detail.service.provider_id, "provider_exa_api");
    assert.equal(detail.service.trust.operational_feedback_count, 0);
    assert.equal(detail.manifest.sample_request.params.source, "exa");
    assert.equal(detail.manifest.pricing.amount, "0");
    assert.equal(detail.manifest.upstream_pricing.amount, 0.007);

    const htmlResponse = await fetch(`${baseUrl}/agent-router/service?service_id=external_api_exa&format=html`);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /Service calls/);
    assert.match(html, /Success rate/);
    assert.match(html, /Trust score/);
    assert.match(html, /Official pricing/);
    assert.match(html, /https:\/\/exa\.ai\/pricing\?tab=api/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AI Search pricing reflects upstream billing instead of marking every BYOK API free", () => {
  const catalog = getExternalApiCatalog();
  const bySource = Object.fromEntries(catalog.map((item) => [item.source, item]));

  assert.equal(bySource.brave_search.price_label, "$0.005/call");
  assert.equal(bySource.tavily.price_label, "$0.008/call");
  assert.equal(bySource.serper.price_label, "$0.001/call");
  assert.equal(bySource.exa.price_label, "$0.007/call");
  assert.equal(bySource.firecrawl.price_label, "2 credits/10 results");
  assert.equal(bySource.jina.price_label, "From 10k tokens/call");
  assert.equal(bySource.openalex.price_label, "$0.001/call");
  assert.equal(bySource.perplexity.price_label, "From $0.005 + tokens");

  for (const source of ["github", "gdelt", "sec_edgar"]) {
    assert.equal(bySource[source].price_label, "FREE");
    assert.equal(bySource[source].price_scope, "upstream_api");
  }
});

test("agentrouter_fetch dispatches connected Exa for natural and structured requests", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  const user = { provider: "github", id: "exa-fetch-user", name: "Exa Fetch User" };
  const ownerKey = authUserKey(user);
  const account = await ensureCreditAccount(store, user);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "Exa agent" });
  await createSocialConnection(store, ownerKey, {
    platform: "exa",
    provider_type: "exa_api",
    credentials: { api_key: "exa-owner-secret" }
  }, secretStore);
  const receivedQueries = [];
  const server = createServer({
    store,
    socialConnectionOptions: {
      ...secretStore,
      fetchImpl: async (url, options) => {
        assert.equal(String(url), "https://api.exa.ai/search");
        assert.equal(options.headers["x-api-key"], "exa-owner-secret");
        const body = JSON.parse(options.body);
        receivedQueries.push(body.query);
        return { ok: true, status: 200, json: async () => ({ results: [{ title: "Agent research", url: "https://example.com/research", text: "Evidence" }] }) };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fetchViaMcp = async (arguments_, headers = { "x-agentrouter-api-key": apiKey }) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentrouter_fetch", arguments: arguments_ } })
    });
    const rpc = await response.json();
    return JSON.parse(rpc.result.content[0].text);
  };
  try {
    const natural = await fetchViaMcp({ task: "Use my connected Exa source to search for AgentRouter", max_price: "0.05" });
    assert.equal(natural.ok, true);
    assert.equal(natural.status, "data_returned");
    assert.equal(natural.results[0].source.source, "exa");

    const structured = await fetchViaMcp({
      task: "Search Exa",
      data_requirements: [{ capability: "external_api_query", params: { source: "exa", operation: "search", query: "AgentRouter", limit: 1 } }]
    });
    assert.equal(structured.ok, true);
    assert.equal(structured.status, "data_returned");
    assert.equal(structured.results[0].result.count, 1);

    const empiricalResearch = await fetchViaMcp({ task: "研究同类量化策略过去一年的实证表现。" });
    assert.equal(empiricalResearch.status, "data_returned");
    assert.equal(empiricalResearch.research_plans[0].strategy, "web_evidence_then_specialist_data");
    assert.equal(empiricalResearch.research_plans[0].supplemental_requirements[0].capability, "service_discovery");
    assert.equal(empiricalResearch.results[0].source.source, "exa");
    assert.equal(empiricalResearch.results[0].request.params.research_plan, undefined);
    assert.deepEqual(receivedQueries, ["AgentRouter", "AgentRouter", "同类量化策略过去一年的实证表现。"]);

    const connectionRequired = await fetchViaMcp(
      { task: "Use my connected Exa source to search for AgentRouter" },
      {}
    );
    assert.equal(connectionRequired.status, "connection_required");
    assert.equal(connectionRequired.next_required_action.action, "connect_agentrouter_account");
    assert.equal(connectionRequired.next_required_action.preferred_tool, "agentrouter_connect");
    assert.equal(connectionRequired.next_required_action.api_key_fallback.for_headless_clients_only, true);
    assert.doesNotMatch(JSON.stringify(connectionRequired), /provide a valid agentrouter api key/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP external API request accepts the connected account's API credential without a browser session", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  const user = { provider: "github", id: "exa-http-user", name: "Exa HTTP User" };
  const ownerKey = authUserKey(user);
  const account = await ensureCreditAccount(store, user);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "Exa HTTP" });
  await createSocialConnection(store, ownerKey, {
    platform: "exa",
    provider_type: "exa_api",
    credentials: { api_key: "exa-secret" }
  }, secretStore);
  const server = createServer({
    store,
    socialConnectionOptions: {
      ...secretStore,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [{ title: "Result", url: "https://example.com/result" }] }) })
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentrouter-api-key": apiKey },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "exa", operation: "search", query: "AgentRouter", limit: 1 } })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.count, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentRouter capability schema and connection UI expose the expanded provider set", () => {
  const capability = getCapabilityCatalog().find((item) => item.capability === "external_api_query");
  const sources = capability.input_schema.properties.source.enum;
  for (const sourceId of ["github", "gdelt", "sec_edgar", "open_meteo", "youtube", "virus_total", "google_places", "amadeus", "easy_post", "openalex", "xpoz", "socialdatax"]) {
    assert.ok(sources.includes(sourceId), sourceId);
  }
  for (const operation of ["search", "forecast", "filings", "inspect", "flight_search", "track"]) {
    assert.ok(capability.input_schema.properties.operation.enum.includes(operation), operation);
  }
  const html = researchHtml({ user: { name: "Provider User" } });
  assert.match(html, /YouTube Data API/);
  assert.match(html, /VirusTotal/);
  assert.match(html, /Google Places/);
  assert.match(html, /Amadeus/);
  assert.match(html, /EasyPost/);
  assert.match(html, /OpenAlex/);
  assert.match(html, /XPOZ/);
  assert.match(html, /SocialDataX/);
  assert.match(html, /connect_source/);
});

test("Brave API credentials stay secret and query results are normalized", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "brave_search",
    provider_type: "brave_api",
    credentials: { api_key: "brave-secret" }
  }, secretStore);
  const requests = [];
  const result = await runExternalApiQuery(store, "github:user-a", {
    source: "brave_search",
    operation: "search",
    query: "AI Web3 revenue",
    limit: 5
  }, {
    ...secretStore,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ web: { results: [{ title: "Example", url: "https://example.com", description: "Evidence" }] } }) };
    }
  });

  assert.equal(requests[0].options.headers["x-subscription-token"], "brave-secret");
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.items, [{ title: "Example", url: "https://example.com", snippet: "Evidence", published_at: null }]);
  assert.equal(JSON.stringify(result).includes("brave-secret"), false);
  assert.equal(store.feedbackEvents.length, 1);
  assert.equal(store.feedbackEvents[0].service_id, "external_api_brave_search");
  assert.equal(store.feedbackEvents[0].status, "success");
  const brave = getExternalApiCatalog(store, "github:user-a").find((item) => item.source === "brave_search");
  assert.equal(brave.total_calls, 1);
  assert.equal(brave.success_rate, 1);
});

test("external API query fails clearly when the user has not connected the source", async () => {
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "exa",
    operation: "search",
    query: "test"
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "connection_required");
  assert.equal(result.action_required, "connect_api_source");
  assert.equal(result.connection_action.preferred_tool, "agentrouter_connect_source");
  assert.deepEqual(result.connection_action.tool_arguments, { source: "exa" });
  assert.equal(result.do_not_fallback_outside_agentrouter, true);
});

test("provider rate limits are preserved as structured AgentRouter status", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "serper",
    provider_type: "serper_api",
    credentials: { api_key: "serper-secret" }
  }, secretStore);
  const result = await runExternalApiQuery(store, "github:user-a", {
    source: "serper",
    operation: "search",
    query: "test"
  }, {
    ...secretStore,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ message: "quota exceeded" }) })
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rate_limited");
});

test("public GitHub provider works without a stored connection", async () => {
  const requests = [];
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "github",
    operation: "search",
    query: "agent routing",
    limit: 3
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            title: "Agent routing discussion",
            html_url: "https://github.com/example/router/issues/1",
            body: "A real issue body",
            created_at: "2026-07-01T00:00:00Z",
            user: { login: "octocat" },
            comments: 4
          }]
        })
      };
    }
  });

  assert.match(requests[0].url, /^https:\/\/api\.github\.com\/search\/issues/);
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.result.items[0].url, "https://github.com/example/router/issues/1");
  assert.equal(result.result.items[0].metadata.author, "octocat");
  assert.equal(result.verification.source_urls_present, true);
});

test("YouTube provider uses the user's API key and normalizes video provenance", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "youtube",
    provider_type: "youtube_api",
    credentials: { api_key: "youtube-secret" }
  }, secretStore);
  const result = await runExternalApiQuery(store, "github:user-a", {
    source: "youtube",
    operation: "search",
    query: "agent router",
    limit: 5
  }, {
    ...secretStore,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("key"), "youtube-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: { videoId: "video123" },
            snippet: {
              title: "AgentRouter demo",
              description: "Demo video",
              publishedAt: "2026-07-01T00:00:00Z",
              channelTitle: "Agent Lab"
            }
          }]
        })
      };
    }
  });

  assert.equal(result.result.items[0].url, "https://www.youtube.com/watch?v=video123");
  assert.equal(result.result.items[0].metadata.channel, "Agent Lab");
  assert.equal(JSON.stringify(result).includes("youtube-secret"), false);
});

test("Open-Meteo public provider geocodes a location before returning a forecast", async () => {
  const requests = [];
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "open_meteo",
    operation: "forecast",
    query: "Taipei"
  }, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("geocoding-api")) {
        return { ok: true, status: 200, json: async () => ({ results: [{ name: "Taipei", country: "Taiwan", latitude: 25.04, longitude: 121.56, timezone: "Asia/Taipei" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ current: { time: "2026-07-23T10:00", temperature_2m: 31, weather_code: 3 }, current_units: { temperature_2m: "°C" } }) };
    }
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1], /api\.open-meteo\.com\/v1\/forecast/);
  assert.equal(result.result.items[0].title, "Taipei, Taiwan weather");
  assert.equal(result.result.items[0].metadata.temperature, 31);
});

test("public connector failures identify stage, category, retryability, and trace", async () => {
  const result = await runExternalApiQuery(createMemoryStore(), "", {
    source: "open_meteo",
    operation: "forecast",
    query: "Taipei"
  }, {
    fetchImpl: async () => {
      const error = new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } });
      throw error;
    },
    fetchRetries: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "provider_error");
  assert.equal(result.error.diagnostics.stage, "open_meteo_geocoding");
  assert.equal(result.error.diagnostics.category, "network");
  assert.equal(result.error.diagnostics.retryable, true);
  assert.match(result.error.diagnostics.trace_id, /^arup_/);
  assert.equal(result.error.diagnostics.upstream_code, "ENETUNREACH");
});

test("GDELT keeps its provider identity when direct transport needs the read-only proxy fallback", async () => {
  const requests = [];
  const result = await runExternalApiQuery(createMemoryStore(), "", {
    source: "gdelt",
    operation: "search",
    query: "AI Agent payments",
    limit: 1
  }, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).startsWith("https://api.gdeltproject.org")) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      return {
        ok: true,
        status: 200,
        text: async () => 'Markdown Content:\n{"articles":[{"title":"Agent payments","url":"https://news.example/item","domain":"news.example","seendate":"20260830T010000Z"}]}'
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.source.source, "gdelt");
  assert.equal(result.coverage.provider, "gdelt");
  assert.equal(result.coverage.retrieval_path, "jina_transport_proxy");
  assert.equal(result.result.items[0].url, "https://news.example/item");
  assert.ok(requests[1].startsWith("https://r.jina.ai/http://api.gdeltproject.org/"));
});

test("SEC EDGAR public provider resolves a ticker and preserves filing URLs", async () => {
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "sec_edgar",
    operation: "filings",
    query: "AAPL",
    limit: 2
  }, {
    fetchImpl: async (url) => {
      if (String(url).endsWith("/files/company_tickers.json")) {
        return { ok: true, status: 200, json: async () => ({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: "Apple Inc.",
          filings: { recent: {
            accessionNumber: ["0000320193-26-000001"],
            filingDate: ["2026-07-01"],
            form: ["8-K"],
            primaryDocument: ["aapl-20260701.htm"],
            primaryDocDescription: ["Current report"]
          } }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.match(result.result.items[0].url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//);
  assert.equal(result.result.items[0].metadata.form, "8-K");
});

test("credential-backed risk, places, travel, tracking, and research providers normalize results", async () => {
  const cases = [
    {
      platform: "virus_total",
      provider_type: "virustotal_api",
      params: { source: "virus_total", operation: "inspect", query: "example.com" },
      payload: { data: { id: "example.com", type: "domain", attributes: { reputation: 4, last_analysis_stats: { malicious: 1, harmless: 70 } } } },
      expectedUrl: "https://www.virustotal.com/gui/domain/example.com"
    },
    {
      platform: "google_places",
      provider_type: "google_places_api",
      params: { source: "google_places", operation: "search", query: "coffee Taipei" },
      payload: { places: [{ displayName: { text: "Coffee Lab" }, formattedAddress: "Taipei", googleMapsUri: "https://maps.google.com/?cid=1", rating: 4.8, userRatingCount: 20 }] },
      expectedUrl: "https://maps.google.com/?cid=1"
    },
    {
      platform: "amadeus",
      provider_type: "amadeus_api",
      credential: "access_token",
      params: { source: "amadeus", operation: "flight_search", query: "TPE to NRT", origin: "TPE", destination: "NRT", departure_date: "2026-08-01" },
      payload: { data: [{ id: "offer-1", price: { total: "120.00", currency: "EUR" }, itineraries: [{ duration: "PT3H", segments: [{ departure: { iataCode: "TPE", at: "2026-08-01T08:00:00" }, arrival: { iataCode: "NRT", at: "2026-08-01T12:00:00" }, carrierCode: "BR", number: "198" }] }] }] },
      expectedUrl: "https://developers.amadeus.com/"
    },
    {
      platform: "easy_post",
      provider_type: "easypost_api",
      params: { source: "easy_post", operation: "track", query: "EZ1000000001" },
      payload: { trackers: [{ id: "trk_1", tracking_code: "EZ1000000001", carrier: "USPS", status: "in_transit", public_url: "https://track.easypost.com/djE6..." }] },
      expectedUrl: "https://track.easypost.com/djE6..."
    },
    {
      platform: "openalex",
      provider_type: "openalex_api",
      params: { source: "openalex", operation: "search", query: "agent routing" },
      payload: { results: [{ id: "https://openalex.org/W1", title: "Agent routing", publication_date: "2026-01-01", doi: "https://doi.org/10.1/example", cited_by_count: 5, authorships: [{ author: { display_name: "A. Researcher" } }] }] },
      expectedUrl: "https://doi.org/10.1/example"
    }
  ];

  for (const item of cases) {
    const store = createMemoryStore();
    const secretStore = secrets();
    const credential = item.credential || "api_key";
    await createSocialConnection(store, "github:user-a", {
      platform: item.platform,
      provider_type: item.provider_type,
      credentials: { [credential]: `${item.platform}-secret` }
    }, secretStore);
    const result = await runExternalApiQuery(store, "github:user-a", item.params, {
      ...secretStore,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => item.payload })
    });
    assert.equal(result.ok, true, `${item.platform}: ${JSON.stringify(result)}`);
    assert.equal(result.result.items[0].url, item.expectedUrl);
    assert.equal(JSON.stringify(result).includes(`${item.platform}-secret`), false);
  }
});

test("provider-specific validation and empty results return actionable diagnostics", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "amadeus",
    provider_type: "amadeus_api",
    credentials: { access_token: "amadeus-token" }
  }, secretStore);
  let fetchCalled = false;
  const invalid = await runExternalApiQuery(store, "github:user-a", {
    source: "amadeus",
    operation: "flight_search",
    query: "Taipei to Tokyo"
  }, {
    ...secretStore,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    }
  });
  assert.equal(fetchCalled, false);
  assert.equal(invalid.status, "invalid_request");
  assert.deepEqual(invalid.error.missing_fields, ["origin", "destination", "departure_date"]);

  const noResults = await runExternalApiQuery(createMemoryStore(), "", {
    source: "open_meteo",
    operation: "forecast",
    query: "not-a-real-place"
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })
  });
  assert.equal(noResults.ok, true);
  assert.equal(noResults.status, "no_results");
  assert.equal(noResults.result.count, 0);
  assert.equal(noResults.diagnostics.code, "PROVIDER_RETURNED_NO_RESULTS");

  const wrongOperation = await runExternalApiQuery(createMemoryStore(), "", {
    source: "open_meteo",
    operation: "search",
    query: "Taipei"
  });
  assert.equal(wrongOperation.status, "unsupported_operation");
  assert.deepEqual(wrongOperation.error.allowed_operations, ["forecast"]);
});

test("AgentRouter exposes and invokes external_api_query for the signed-in connection owner", async () => {
  assert.ok(getCapabilityCatalog().some((item) => item.capability === "external_api_query"));
  const store = createMemoryStore();
  const secretStore = secrets();
  const session = createDevSession(store, "http://127.0.0.1");
  const cookie = session.cookie.split(";")[0];
  await createSocialConnection(store, authUserKey(session.user), {
    platform: "brave_search",
    provider_type: "brave_api",
    credentials: { api_key: "brave-secret" }
  }, secretStore);
  const server = createServer({
    store,
    socialConnectionOptions: {
      ...secretStore,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ web: { results: [{ title: "Result", url: "https://example.com", description: "Found" }] } }) })
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const catalogResponse = await fetch(`${baseUrl}/agent-router/api-sources`, { headers: { cookie } });
    const catalog = await catalogResponse.json();
    assert.equal(catalog.sources.find((item) => item.source === "brave_search").connected, true);
    assert.equal(catalog.sources.find((item) => item.source === "brave_search").connection_state, "connected");
    assert.equal(catalogResponse.headers.get("cache-control"), "private, no-store");

    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "brave_search", operation: "search", query: "test" } })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.items[0].title, "Result");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentRouter permits public providers without login but protects credential-backed providers", async () => {
  const store = createMemoryStore();
  const server = createServer({
    store,
    socialConnectionOptions: {
      fetchImpl: async (url) => {
        if (String(url).includes("name=Fail")) throw new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } });
        return String(url).includes("geocoding-api")
          ? { ok: true, status: 200, json: async () => ({ results: [{ name: "Taipei", country: "Taiwan", latitude: 25.04, longitude: 121.56, timezone: "Asia/Taipei" }] }) }
          : { ok: true, status: 200, json: async () => ({ current: { temperature_2m: 30, weather_code: 1 }, current_units: { temperature_2m: "°C" } }) };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const publicResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "open_meteo", operation: "forecast", query: "Taipei" } })
    });
    assert.equal(publicResponse.status, 200);
    const publicPayload = await publicResponse.json();
    assert.equal(publicPayload.ok, true);
    assert.match(publicPayload.consumer_feedback_request.feedback_token, /^[A-Za-z0-9_-]{32,}$/);

    const feedbackResponse = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...publicPayload.consumer_feedback_request.example,
        feedback_token: publicPayload.consumer_feedback_request.feedback_token
      })
    });
    assert.equal(feedbackResponse.status, 200);
    assert.equal((await feedbackResponse.json()).status, "consumer_feedback_recorded");

    const privateResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "youtube", operation: "search", query: "AgentRouter" } })
    });
    assert.equal(privateResponse.status, 401);
    const privatePayload = await privateResponse.json();
    assert.equal(privatePayload.status, "connection_required");
    assert.equal(privatePayload.action_required.preferred_tool, "agentrouter_connect");

    const unknownResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "not_a_real_source", operation: "search", query: "test" } })
    });
    assert.equal(unknownResponse.status, 422);
    const unknownPayload = await unknownResponse.json();
    assert.equal(unknownPayload.status, "unsupported_source");
    assert.equal(unknownPayload.error.code, "UNSUPPORTED_SOURCE");

    const providerFailure = await fetch(`${baseUrl}/agent-router/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_requirements: [{ capability: "external_api_query", params: { source: "open_meteo", operation: "forecast", query: "Fail" } }] })
    });
    assert.equal(providerFailure.status, 502);
    const providerFailurePayload = await providerFailure.json();
    assert.equal(providerFailurePayload.status, "no_data_returned");
    assert.equal(providerFailurePayload.results[0].error.diagnostics.category, "network");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote MCP routes public and credit-key-owned external providers through the built-in capability", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  const user = { provider: "github", id: "mcp-provider-user", name: "MCP Provider User", email: "mcp@example.com" };
  const ownerKey = authUserKey(user);
  const account = await ensureCreditAccount(store, user);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "MCP external providers" });
  await createSocialConnection(store, ownerKey, {
    platform: "youtube",
    provider_type: "youtube_api",
    credentials: { api_key: "youtube-owner-secret" }
  }, secretStore);
  const server = createServer({
    store,
    socialConnectionOptions: {
      ...secretStore,
      fetchImpl: async (url) => {
        if (String(url).includes("geocoding-api")) {
          return { ok: true, status: 200, json: async () => ({ results: [{ name: "Taipei", country: "Taiwan", latitude: 25.04, longitude: 121.56, timezone: "Asia/Taipei" }] }) };
        }
        if (String(url).includes("open-meteo.com")) {
          return { ok: true, status: 200, json: async () => ({ current: { temperature_2m: 30, weather_code: 1 }, current_units: { temperature_2m: "°C" } }) };
        }
        assert.equal(new URL(url).searchParams.get("key"), "youtube-owner-secret");
        return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: "mcp-video" }, snippet: { title: "MCP video", channelTitle: "Agent Lab" } }] }) };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const mcpCall = async (params, headers = {}) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentrouter_request", arguments: params } })
    });
    const rpc = await response.json();
    return JSON.parse(rpc.result.content[0].text);
  };
  try {
    const weather = await mcpCall({ capability: "external_api_query", params: { source: "open_meteo", operation: "forecast", query: "Taipei" } });
    assert.equal(weather.ok, true);
    assert.equal(weather.result.items[0].metadata.temperature, 30);

    const youtube = await mcpCall(
      { capability: "external_api_query", params: { source: "youtube", operation: "search", query: "AgentRouter" } },
      { "x-agentrouter-api-key": apiKey }
    );
    assert.equal(youtube.ok, true);
    assert.equal(youtube.result.items[0].url, "https://www.youtube.com/watch?v=mcp-video");

    const denied = await mcpCall({ capability: "external_api_query", params: { source: "youtube", operation: "search", query: "AgentRouter" } });
    assert.equal(denied.status, "connection_required");
    assert.equal(denied.action_required.action, "connect_agentrouter_account");
    assert.equal(denied.action_required.preferred_tool, "agentrouter_connect");
    assert.doesNotMatch(JSON.stringify(denied), /provide a valid agentrouter api key/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote MCP turns a missing upstream source into a browser authorization handoff", async () => {
  const store = createMemoryStore();
  const secretStore = secrets();
  const user = { provider: "github", id: "source-connect-user", name: "Source Connect User" };
  const ownerKey = authUserKey(user);
  const account = await ensureCreditAccount(store, user);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "Source connection" });
  const server = createServer({ store, socialConnectionOptions: secretStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const mcp = async (method, params = {}) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentrouter-api-key": apiKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const rpc = await response.json();
    return rpc.result;
  };

  try {
    const tools = await mcp("tools/list");
    assert.ok(tools.tools.some((tool) => tool.name === "agentrouter_connect_source"));

    const first = await mcp("tools/call", {
      name: "agentrouter_connect_source",
      arguments: { source: "openalex" }
    });
    const authorization = JSON.parse(first.content[0].text);
    assert.equal(authorization.status, "authorization_required");
    assert.equal(authorization.source, "openalex");
    assert.match(authorization.verification_uri, /^http:\/\/127\.0\.0\.1:\d+\/research\?connect_source=openalex/);
    assert.equal(authorization.retry_original_request, true);
    assert.equal(authorization.do_not_fallback_outside_agentrouter, true);

    await createSocialConnection(store, ownerKey, {
      platform: "openalex",
      provider_type: "openalex_api",
      credentials: { api_key: "openalex-secret" }
    }, secretStore);

    const second = await mcp("tools/call", {
      name: "agentrouter_connect_source",
      arguments: { source: "openalex" }
    });
    const connected = JSON.parse(second.content[0].text);
    assert.equal(connected.status, "connected");
    assert.equal(connected.retry_original_request, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote MCP routes social user voice research through the same built-in dispatcher", async () => {
  const store = createMemoryStore();
  const user = { provider: "github", id: "mcp-social-user", name: "MCP Social User" };
  const account = await ensureCreditAccount(store, user);
  const { api_key: apiKey } = await createCreditApiKey(store, { account, label: "MCP social" });
  let receivedOwnerKey = null;
  const server = createServer({
    store,
    socialProviderFactory: async (_store, ownerKey) => {
      receivedOwnerKey = ownerKey;
      return { x: [{ id: "x-owner-provider" }] };
    },
    socialResearchRunner: async (params, options) => ({
      ok: true,
      status: "completed",
      request: params,
      provider_ids: options.searchOptions.localOptions.providers.x.map((item) => item.id)
    })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentrouter-api-key": apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agentrouter_request",
          arguments: { capability: "social_user_voice_research", params: { question: "AgentRouter feedback", platforms: ["x"] } }
        }
      })
    });
    const rpc = await response.json();
    const payload = JSON.parse(rpc.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.provider_ids, ["x-owner-provider"]);
    assert.equal(receivedOwnerKey, authUserKey(user));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("newly implemented finance and answer sources are callable and normalized", async () => {
  const catalog = getExternalApiCatalog(createMemoryStore(), "github:user-a");
  const status = (id) => catalog.find((row) => row.source === id)?.implementation_status;
  for (const id of ["yahoo_finance", "fred", "finnhub", "perplexity", "tushare"]) {
    assert.equal(status(id), "available", `${id} should no longer be planned`);
  }

  // Yahoo Finance is public: no connection required for either operation.
  const quote = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "yahoo_finance", operation: "quote", query: "AAPL"
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      chart: { result: [{ meta: {
        symbol: "AAPL", currency: "USD", regularMarketPrice: 308.91, chartPreviousClose: 333.43,
        fiftyTwoWeekHigh: 344.57, fiftyTwoWeekLow: 201.68, fullExchangeName: "NasdaqGS", regularMarketTime: 1785528001
      } }] }
    }) })
  });
  assert.equal(quote.ok, true);
  assert.equal(quote.result.items[0].metadata.price, 308.91);
  assert.equal(quote.result.items[0].metadata.change, -24.52);
  assert.equal(quote.result.items[0].url, "https://finance.yahoo.com/quote/AAPL");

  const search = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "yahoo_finance", operation: "search", query: "apple", limit: 2
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      quotes: [{ symbol: "AAPL", longname: "Apple Inc.", exchDisp: "NASDAQ", sectorDisp: "Technology", quoteType: "EQUITY" }]
    }) })
  });
  assert.equal(search.result.items[0].metadata.symbol, "AAPL");

  // Key-backed sources must stay owner-scoped and never leak the credential.
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "finnhub", provider_type: "finnhub_api", credentials: { api_key: "finnhub-secret" }
  }, secretStore);
  const requests = [];
  const finnhub = await runExternalApiQuery(store, "github:user-a", {
    source: "finnhub", operation: "quote", query: "AAPL"
  }, {
    ...secretStore,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ c: 308.9, o: 305, h: 310, l: 304, pc: 333.4, d: -24.5, dp: -7.35, t: 1785528001 }) };
    }
  });
  assert.equal(requests[0].options.headers["x-finnhub-token"], "finnhub-secret");
  assert.equal(finnhub.result.items[0].metadata.percent_change, -7.35);
  assert.equal(JSON.stringify(finnhub).includes("finnhub-secret"), false);

  const fredStore = createMemoryStore();
  const fredSecrets = secrets();
  await createSocialConnection(fredStore, "github:user-a", {
    platform: "fred", provider_type: "fred_api", credentials: { api_key: "fred-secret" }
  }, fredSecrets);
  const fred = await runExternalApiQuery(fredStore, "github:user-a", {
    source: "fred", operation: "search", query: "unemployment"
  }, {
    ...fredSecrets,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      seriess: [{ id: "UNRATE", title: "Unemployment Rate", units: "Percent", frequency: "Monthly", last_updated: "2026-01-01" }]
    }) })
  });
  assert.equal(fred.result.items[0].metadata.series_id, "UNRATE");
  assert.equal(fred.result.items[0].url, "https://fred.stlouisfed.org/series/UNRATE");

  // Perplexity returns one answer plus its citations as separate items.
  const pplxStore = createMemoryStore();
  const pplxSecrets = secrets();
  await createSocialConnection(pplxStore, "github:user-a", {
    platform: "perplexity", provider_type: "perplexity_api", credentials: { api_key: "pplx-secret" }
  }, pplxSecrets);
  const perplexity = await runExternalApiQuery(pplxStore, "github:user-a", {
    source: "perplexity", operation: "search", query: "what is x402"
  }, {
    ...pplxSecrets,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      model: "sonar",
      choices: [{ message: { content: "x402 is a payment protocol." } }],
      citations: ["https://example.com/x402"]
    }) })
  });
  assert.equal(perplexity.result.items[0].snippet, "x402 is a payment protocol.");
  assert.equal(perplexity.result.items[0].url, "https://example.com/x402");
  assert.equal(JSON.stringify(perplexity).includes("pplx-secret"), false);

  // Tushare returns column-oriented rows that must be zipped back into records.
  const tsStore = createMemoryStore();
  const tsSecrets = secrets();
  await createSocialConnection(tsStore, "github:user-a", {
    platform: "tushare", provider_type: "tushare_api", credentials: { api_key: "tushare-secret" }
  }, tsSecrets);
  const tushare = await runExternalApiQuery(tsStore, "github:user-a", {
    source: "tushare", operation: "search", query: "000001.SZ"
  }, {
    ...tsSecrets,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      code: 0, data: { fields: ["ts_code", "name", "industry"], items: [["000001.SZ", "平安银行", "银行"]] }
    }) })
  });
  assert.equal(tushare.result.items[0].metadata.name, "平安银行");
  assert.equal(JSON.stringify(tushare).includes("tushare-secret"), false);
});

test("result limits are per-source, not one pessimistic cap", async () => {
  const { resolveResultLimit } = await import("../src/external-api-capability.js");

  // 10 was only ever a default; callers who ask for more now get more.
  assert.equal(resolveResultLimit("exa", undefined), 10);
  assert.equal(resolveResultLimit("exa", 50), 50);
  assert.equal(resolveResultLimit("exa", 500), 100);
  // Sources whose upstream refuses large pages stay clamped to what it accepts.
  assert.equal(resolveResultLimit("brave_search", 50), 20);
  assert.equal(resolveResultLimit("tavily", 50), 20);
  assert.equal(resolveResultLimit("youtube", 100), 50);
  // Sources that allow deep pages are not held back by the global ceiling.
  assert.equal(resolveResultLimit("gdelt", 250), 250);
  assert.equal(resolveResultLimit("openalex", 200), 200);
  // Junk input falls back to something valid rather than 0 or a negative page.
  assert.equal(resolveResultLimit("exa", 0), 10);
  assert.equal(resolveResultLimit("exa", -3), 1);

  // The clamp must reach the actual upstream request, not just the return value.
  const requests = [];
  await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "gdelt", operation: "search", query: "crypto", limit: 60
  }, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      return { ok: true, status: 200, json: async () => ({ articles: [] }) };
    }
  });
  assert.match(requests[0], /maxrecords=60/);
});

test("sources with a key-free browser path steer agents there instead of a dead end", async () => {
  const { freeLocalAlternative } = await import("../src/external-api-capability.js");

  // Without a key the API source is a dead end, so the failure has to carry the
  // call that actually works rather than only "connect this source".
  const blocked = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "x", operation: "search", query: "crypto product manager", limit: 30
  });
  assert.equal(blocked.status, "connection_required");
  assert.equal(blocked.action_required, "use_free_local_alternative");
  assert.equal(blocked.free_alternative.requires_api_key, false);
  assert.deepEqual(blocked.free_alternative.call, {
    capability: "social_search",
    params: { platform: "x", query: "crypto product manager", limit: 30 }
  });
  assert.equal(blocked.free_alternative.preferred_tool, "agentrouter_request");
  assert.deepEqual(blocked.free_alternative.tool_arguments, blocked.free_alternative.call);
  assert.equal(blocked.free_alternative.must_not_execute_via_shell, true);
  assert.equal(blocked.free_alternative.do_not_fallback_outside_agentrouter, true);
  assert.match(blocked.error.message, /social_search/);

  // Sources with no local path keep the plain connect instruction.
  const noAlternative = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "exa", operation: "search", query: "x"
  });
  assert.equal(noAlternative.action_required, "connect_api_source");
  assert.equal(noAlternative.free_alternative, undefined);
  assert.equal(freeLocalAlternative("exa"), null);

  // The catalog steers before the agent even tries, so the API path is not the
  // default for data readable through the user's own browser.
  const catalog = getExternalApiCatalog(createMemoryStore(), "github:user-a");
  const steered = catalog.filter((item) => item.preferred_path === "local_browser").map((item) => item.source);
  assert.deepEqual(steered.sort(), ["bilibili", "reddit", "weibo", "x", "xiaohongshu", "youtube", "zhihu"]);
  assert.equal(catalog.find((item) => item.source === "exa").preferred_path, undefined);

  // Once connected, the API path is legitimate again and must not be second-guessed.
  const store = createMemoryStore();
  const secretStore = secrets();
  await createSocialConnection(store, "github:user-a", {
    platform: "x", provider_type: "x_api", credentials: { bearer_token: "x-secret" }
  }, secretStore);
  const connected = getExternalApiCatalog(store, "github:user-a").find((item) => item.source === "x");
  assert.equal(connected.connected, true);
  assert.equal(connected.preferred_path, undefined);
});

test("ordinary questions reach the right API without naming the source", async () => {
  const { inferExternalApiRequest } = await import("../src/external-api-capability.js");
  const route = (task, connected = []) => inferExternalApiRequest(task, { connectedSources: connected });

  // Each vertical reaches its own source, using that source's own operation —
  // requiring "search" everywhere previously hid weather, filings and tracking.
  const expectations = [
    ["find senior crypto product manager jobs remote", "exa", "search"],
    ["有哪些远程的区块链产品经理岗位", "exa", "search"],
    ["最近关于稳定币监管的新闻", "gdelt", "search"],
    ["papers about retrieval augmented generation", "openalex", "search"],
    ["weather forecast in Tokyo tomorrow", "open_meteo", "forecast"],
    ["东京明天天气", "open_meteo", "forecast"],
    ["SEC filings for Coinbase", "sec_edgar", "filings"],
    ["flights from HKG to SIN next Monday", "amadeus", "flight_search"],
    ["track my package 1Z999AA10123456784", "easy_post", "track"],
    ["is this domain malicious example.com", "virus_total", "inspect"],
    ["AAPL stock price today", "yahoo_finance", "search"],
    ["best coffee shops near Central Hong Kong", "google_places", "search"]
  ];
  for (const [task, source, operation] of expectations) {
    const routed = route(task, ["exa"]);
    assert.equal(routed?.params.source, source, `${task} should reach ${source}`);
    assert.equal(routed.params.operation, operation, `${task} should use ${operation}`);
  }

  // Questions that belong elsewhere must not be dragged into an API call.
  assert.equal(route("BTC 最大爆仓痛点"), null, "crypto intents keep their own routing");
  assert.equal(route("hello how are you"), null, "chatter must not route anywhere");

  // Web search picks a connected source, and falls back to a key-free one.
  assert.equal(route("latest developments in AI agents", ["tavily"]).params.source, "tavily");
  assert.equal(route("search Exa for crypto pm jobs").params.source, "exa", "a named source still wins");
  assert.equal(route("research AgentRouter product positioning and competitors", ["exa"]).params.source, "exa");
  assert.equal(route("研究 AgentRouter 的产品定位和竞品", ["exa"]).params.source, "exa");
  assert.equal(route("研究同类策略的实证表现", ["exa"]).params.source, "exa");
  assert.equal(route("peer-reviewed papers and DOI citations about agent routing", ["exa"]).params.source, "openalex");
  assert.equal(route("查找 AgentRouter 相关论文的 DOI 和引用次数", ["exa"]).params.source, "openalex");
});

test("successful calls can be rated, not only failed ones", async () => {
  const { recordConsumerFeedback } = await import("../src/registry.js");
  const store = createMemoryStore();

  const ok = await runExternalApiQuery(store, "github:user-a", {
    source: "gdelt", operation: "search", query: "crypto jobs"
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      articles: [{ title: "t", url: "https://example.com/a", domain: "example.com", seendate: "20260101T000000Z" }]
    }) })
  });

  // Without a handle an agent cannot rate a result it was happy with, so
  // reputation would only ever record the calls that went wrong.
  assert.equal(ok.status, "completed");
  assert.ok(ok.request_id, "a successful call must return its request_id");
  assert.equal(ok.service_id, "external_api_gdelt");
  assert.ok(ok.consumer_feedback_request, "and the means to rate it");

  // The example must be copyable as-is: reason is required by the validator.
  assert.deepEqual(ok.consumer_feedback_request.required_fields, ["intent_fit", "answer_useful", "reason"]);
  const recorded = await recordConsumerFeedback(store, ok.consumer_feedback_request.example);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.service_id, "external_api_gdelt");

  // The rating reaches reputation, which is the whole point of the loop.
  const rated = getExternalApiCatalog(store, "github:user-a").find((item) => item.source === "gdelt");
  assert.equal(rated.reputation.has_agent_ratings, true);
  assert.equal(rated.reputation.sample_size, 1);
  assert.match(rated.reputation.display, /100% intent fit \(1 rating\)/);

  // Failures stay rateable too.
  const failed = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "gdelt", operation: "search", query: "x"
  }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.ok(failed.request_id, "a failed call keeps its handle as well");
  assert.ok(failed.consumer_feedback_request);

  // Local connector runs execute on the device, so the server has no prior
  // event; the rating must still be accepted and create one.
  const local = await recordConsumerFeedback(store, {
    request_id: "local_search_x_1786955108056_xsfutf3w",
    feedback: { intent_fit: "yes", answer_useful: "yes", reason: "used in the answer" }
  });
  assert.equal(local.ok, true);
  assert.equal(local.service_id, "local_social_x");

  // An id matching no known shape is still rejected rather than inventing a service.
  await assert.rejects(
    () => recordConsumerFeedback(store, { request_id: "bogus_id", feedback: { intent_fit: "yes", answer_useful: "yes", reason: "x" } }),
    (error) => error.statusCode === 404
  );
});

test("negative intent-fit ratings demote a service instead of being averaged away", async () => {
  const { intentMismatchPenalty, rankCandidates } = await import("../src/router.js");
  const { summarizeTrust } = await import("../src/store.js");
  const { registerService } = await import("../src/registry.js");

  const rated = (fit) => ({
    status: "success", schema_valid: true, created_at: new Date().toISOString(),
    verification: { coverage_valid: true, agent_friendly_score: 1 },
    consumer_feedback: { intent_fit: fit, answer_useful: fit, reason: "r", consumer_score: fit === "yes" ? 1 : 0 }
  });
  const trustOf = (events) => summarizeTrust({
    manifest: { provider: { provider_id: "p" } }, verification_status: "verified", feedback_events: events
  });

  // The penalty scales with how many agents said it, so one report nudges and a
  // repeated pattern bites; mixed feedback stays close to neutral.
  assert.equal(intentMismatchPenalty(trustOf([])), 0);
  assert.ok(intentMismatchPenalty(trustOf([rated("no")])) > 0);
  assert.ok(intentMismatchPenalty(trustOf([rated("no"), rated("no")])) > intentMismatchPenalty(trustOf([rated("no")])));
  assert.equal(intentMismatchPenalty(trustOf(Array(3).fill(rated("no")))), 0.35);
  assert.equal(intentMismatchPenalty(trustOf(Array(9).fill(rated("no")))), 0.35, "the penalty is capped");
  assert.ok(intentMismatchPenalty(trustOf([rated("no"), ...Array(5).fill(rated("yes"))])) < 0.05,
    "one complaint among many successes must not sink a service");

  // End to end: a service rated as mismatching loses to an equivalent one.
  const store = createMemoryStore();
  const schema = { type: "object", properties: {} };
  const register = (id) => registerService(store, {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: id, title: id,
    description_for_agent: "btc liquidation max pain data",
    capabilities: ["data_service", "perp_liquidation_max_pain", "liquidation_heatmap", "perp_liquidation", "crypto_derivatives"],
    pricing: { amount: "0.01", currency: "USDC", network: "base" },
    provider: { provider_id: `p_${id}` }, endpoint: { url: `http://example.test/${id}`, method: "POST" },
    input_schema: schema, output_schema: schema,
    sample_request: { asset: "BTC" }, sample_response: { asset: "BTC", max_pain: 1 }
  }, "http://example.test");

  const misrouting = register("misrouting_service");
  const accurate = register("accurate_service");
  for (const record of [misrouting, accurate]) {
    record.verification_status = "verified";
    record.feedback_events = [rated("yes"), rated("yes"), rated("yes")];
  }
  const intent = { capability: "perp_liquidation_max_pain", asset: "BTC" };
  const before = rankCandidates(store, intent, {});
  assert.equal(before[0].routing_score, before[1].routing_score, "equal services start tied");

  misrouting.feedback_events.push(rated("no"), rated("no"), rated("no"));
  const after = rankCandidates(store, intent, {});
  assert.equal(after[0].service_id, "accurate_service", "the mismatching service must lose the tie");
  const demoted = after.find((item) => item.service_id === "misrouting_service");
  // Three mismatch reports against three good ones is a 0.5 mismatch rate, and
  // the gap must be wide enough that any adequate alternative wins outright.
  assert.ok(after[0].routing_score - demoted.routing_score > 0.2,
    `expected a decisive gap, got ${(after[0].routing_score - demoted.routing_score).toFixed(4)}`);
});

test("every path asks for feedback on success with the same contract", async () => {
  const { runLocalSocialSearch } = await import("../packages/agentrouter-mcp/server/local-social-search.js");

  const external = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "gdelt", operation: "search", query: "x"
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      articles: [{ title: "t", url: "https://example.com/a", domain: "example.com", seendate: "20260101T000000Z" }]
    }) })
  });
  const local = await runLocalSocialSearch({ platform: "x", query: "q", limit: 1 }, {
    runCommand: async () => ({ status: "completed", data: [{ id: "1", text: "t", url: "https://x.com/1" }] })
  });

  for (const [label, request] of [["external", external.consumer_feedback_request], ["local", local.consumer_feedback_request]]) {
    // A request that says feedback is optional gets skipped, and reputation ends
    // up built only from the calls that failed.
    assert.equal(request.must_submit, true, `${label} must ask for the rating`);
    assert.equal(request.feedback_request_version, "agent_consumer_feedback_request_v1", `${label} shares the paid contract`);
    assert.ok(request.instructions.length >= 3, `${label} explains how to judge`);
    assert.deepEqual(request.required_fields, ["intent_fit", "answer_useful", "reason"]);
    assert.ok(request.example.feedback.reason, `${label} example must include the required reason`);
  }
});

test("one incidental keyword cannot hijack the route", async () => {
  const { inferExternalApiRequest } = await import("../src/external-api-capability.js");
  const route = (task, tier = "all") => inferExternalApiRequest(task, { connectedSources: ["exa"], tier });
  const source = (task, tier) => route(task, tier)?.params.source ?? null;

  // The reported failure: "track" and "deliverables" made a hackathon question a
  // parcel lookup, because the first intent whose pattern matched won outright.
  assert.notEqual(source("AltLayer 8004scan hackathon track submission rules judging criteria deliverables"), "easy_post");

  // Every weak term is ordinary English somewhere. None of these route to the
  // specialized source that owns the word.
  const notSpecialized = [
    "track leaderboards across the agent network",
    "which npm package should I use for date parsing",
    "open issues in the ERC-8004 spec discussion",
    "near the end of the quarter what happens",
    "video call software comparison",
    "stock up on inventory before the holidays",
    "press the button twice to reset",
    "revenue forecast for next quarter",
    "research on agent marketplaces"
  ];
  for (const task of notSpecialized) {
    assert.equal(source(task, "specialized"), null, `"${task}" must not reach a specialized source`);
  }

  // ...while the same words with a second signal from the same domain still do.
  const stillRouted = [
    ["track my package 1Z999AA10123456784", "easy_post"],
    ["where is my parcel", "easy_post"],
    ["tracking number for this shipment", "easy_post"],
    ["weather forecast in Tokyo tomorrow", "open_meteo"],
    ["AAPL stock price today", "yahoo_finance"],
    ["SEC filings for Coinbase", "sec_edgar"],
    ["best coffee shops near Central Hong Kong", "google_places"],
    ["github repository for viem", "github"],
    ["papers about retrieval augmented generation", "openalex"],
    ["flights from HKG to SIN next Monday", "amadeus"],
    ["is this domain malicious example.com", "virus_total"],
    ["帮我查一下这个快递到哪了", "easy_post"],
    ["东京明天天气", "open_meteo"]
  ];
  for (const [task, expected] of stillRouted) {
    assert.equal(source(task, "specialized"), expected, `"${task}" should still reach ${expected}`);
  }
});

test("a question is a lookup even when it is not phrased as a command", async () => {
  const { inferExternalApiRequest } = await import("../src/external-api-capability.js");
  const source = (task, tier = "all") => inferExternalApiRequest(task, { connectedSources: ["exa"], tier })?.params.source ?? null;

  // These reached no service at all: the fallback only recognised an explicit
  // verb ("search for…"), so a plain question was a dead end.
  for (const task of [
    "How does 8004scan.io index ERC-8004 agents?",
    "Does 8004scan have a public API to query agent reputation?",
    "8004scan 是如何收录 agent 的？"
  ]) {
    assert.equal(source(task), "exa", `"${task}" should reach web search`);
  }

  // But a question still has to ask about something. Paying a search provider
  // for a greeting is worse than answering it directly.
  for (const task of ["hello how are you", "how are you?", "thanks!", "ok", "good morning"]) {
    assert.equal(source(task), null, `"${task}" is chatter`);
    assert.equal(source(task, "web"), null, `"${task}" is chatter even as a last resort`);
  }
});

test("registered services get first refusal, web search is the last resort", async () => {
  const { inferExternalApiRequest } = await import("../src/external-api-capability.js");
  const source = (task, tier) => inferExternalApiRequest(task, { connectedSources: ["exa"], tier })?.params.source ?? null;

  // The specialized pass runs before the service router, so it must stay silent
  // on anything a registered service could answer — a generic web search
  // running first preempted services that would have matched.
  for (const task of ["BTC 最大爆仓痛点", "token smart money activity for PEPE", "aggregated liquidation history"]) {
    assert.equal(source(task, "specialized"), null, `"${task}" must reach the service router first`);
    // Once the router has found nothing, a web search is the only answer left.
    assert.equal(source(task, "web"), "exa", `"${task}" should still get an answer if nothing is registered`);
  }
});

test("a chain name is not the token being asked about", async () => {
  const { inferIntent } = await import("../src/agent-router.js");
  const of = (task) => inferIntent(task);

  // "今天BSC链交易量最高的5个meme代币" resolved chain=bsc correctly and then also
  // read BSC as the token. A token nobody asked for narrows candidate matching
  // and is passed to providers as a filter, so the request describes something
  // other than what was asked.
  for (const [task, chain] of [
    ["今天BSC链交易量最高的5个meme代币", "bsc"],
    ["BASE链上最活跃的NFT", "base"],
    ["SOLANA链上新币", "solana"],
    ["ARBITRUM 生态 TVL", "arbitrum"],
    ["HYPEREVM 交易量", "hyperevm"]
  ]) {
    const intent = of(task);
    assert.equal(intent.chain, chain, `${task} should resolve the chain`);
    assert.ok(!intent.token, `${task} must not treat the chain name as a token, got ${intent.token}`);
  }

  // Assets that happen to name a chain stay assets — they are real tickers.
  assert.equal(of("BNB 价格").token, "BNB");
  assert.equal(of("SOL 价格").token, "SOL");
  assert.equal(of("ETH 链上大额转账").token, "ETH");

  // And a real token alongside a chain is still found.
  const both = of("BSC 上 CAKE 的交易量");
  assert.equal(both.chain, "bsc");
  assert.equal(both.token, "CAKE");
});

test("on-chain volume rankings come from the provider, not a scraped table", async () => {
  const { inferExternalApiRequest, runExternalApiQuery } = await import("../src/external-api-capability.js");
  const { createMemoryStore } = await import("../src/store.js");
  const route = (task) => inferExternalApiRequest(task, { connectedSources: ["exa"], tier: "specialized" })?.params;

  // Web search answered these with page snapshots whose scraped tables had lost
  // the token name on exactly the highest-volume rows, so "top 5 by volume" was
  // unanswerable without guessing.
  for (const task of [
    "今天BSC链交易量最高的5个meme代币",
    "BSC on-chain DEX top 5 tokens by 24h trading volume",
    "BASE链上交易量最高的池子"
  ]) {
    assert.equal(route(task)?.source, "geckoterminal", `${task} should reach the on-chain source`);
    assert.equal(route(task)?.operation, "trending", `${task} should use the provider's ranking`);
  }

  // Equities keep their own source; "volume" alone must not drag a stock
  // question on-chain, nor a chain question into equities.
  assert.equal(route("AAPL stock price today")?.source, "yahoo_finance");
  assert.equal(route("hello how are you"), undefined);

  const payload = {
    data: [
      { attributes: { name: "AAA / USDT", address: "0xpool1", volume_usd: { h24: "312016152.5" },
        base_token_price_usd: "0.0018", market_cap_usd: "1000", reserve_in_usd: "500",
        price_change_percentage: { h24: "12.5" }, transactions: { h24: { buys: 10, sells: 4 } } } },
      { attributes: { name: "BBB / WBNB", address: "0xpool2", volume_usd: { h24: "246025461" },
        base_token_price_usd: "0.009" } }
    ]
  };
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a", {
    source: "geckoterminal", operation: "trending", query: "今天BSC链交易量最高的meme代币", limit: 5
  }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });

  assert.equal(result.status, "completed");
  const [first, second] = result.result.items;
  // Rank, name and a numeric volume all survive — the three things the scraped
  // table lost.
  assert.equal(first.metadata.rank, 1);
  assert.equal(first.metadata.base_token, "AAA");
  assert.equal(first.metadata.volume_24h_usd, 312016152.5);
  assert.equal(first.metadata.network, "bsc");
  assert.equal(second.metadata.rank, 2);
  assert.equal(second.metadata.base_token, "BBB");
  // A "meme" question cannot actually be filtered, so the envelope says what the
  // ranking is really over instead of implying a category it does not have.
  // Raw volume order puts wash-traded pools on top, so the default is the
  // provider's own trending ranking; the envelope always says which one ran.
  assert.match(first.metadata.ranked_among, /trending over 24h, ranked by the provider/);
  assert.ok(result.request_id, "a successful call must be rateable");
});

test("a token question reaches the token, not whatever the prose fuzzy-matched", async () => {
  const { dexscreenerTerm, inferExternalApiRequest, runExternalApiQuery } =
    await import("../src/external-api-capability.js");
  const { createMemoryStore } = await import("../src/store.js");

  // DexScreener matches a ticker or an address, not a sentence. Handing it the
  // whole question returned BscCat, BSC and ASTER for a question about CAKE.
  assert.equal(dexscreenerTerm("BSC 上 CAKE 的交易对和流动性"), "CAKE");
  assert.equal(dexscreenerTerm("PEPE pairs liquidity"), "PEPE");
  assert.equal(dexscreenerTerm("$WIF price"), "WIF");
  assert.equal(
    dexscreenerTerm("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 liquidity"),
    "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"
  );
  // Nothing ticker-shaped still searches, rather than sending an empty query.
  assert.equal(dexscreenerTerm("流动性最好的交易对"), "流动性最好的交易对");

  const route = (task) => inferExternalApiRequest(task, { connectedSources: [], tier: "specialized" })?.params;
  assert.equal(route("CAKE 的交易对和流动性")?.source, "dexscreener");
  assert.equal(route("加密货币市值排名前10")?.source, "coinmarketcap");
  // A chain-wide ranking is a different question from one token's pairs.
  assert.equal(route("今天BSC链交易量最高的5个meme代币")?.source, "geckoterminal");

  const payload = { pairs: [
    { chainId: "bsc", dexId: "pancakeswap", url: "https://dexscreener.com/bsc/a",
      baseToken: { symbol: "CAKE", address: "0xcake" }, quoteToken: { symbol: "WBNB" },
      priceUsd: "1.45", volume: { h24: 1104505 }, liquidity: { usd: 900000 },
      txns: { h24: { buys: 5, sells: 3 } } },
    { chainId: "ethereum", dexId: "uniswap", url: "https://dexscreener.com/eth/b",
      baseToken: { symbol: "CAKE" }, quoteToken: { symbol: "WETH" },
      priceUsd: "1.44", volume: { h24: 9999999 } }
  ] };
  const result = await runExternalApiQuery(createMemoryStore(), "github:user-a",
    { source: "dexscreener", operation: "search", query: "BSC 上 CAKE 的交易对", limit: 5 },
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });

  assert.equal(result.status, "completed");
  // Naming a chain filters to it, so the higher-volume Ethereum pair is excluded
  // rather than answering a question about BSC with a different chain.
  assert.equal(result.result.items.length, 1);
  const [top] = result.result.items;
  assert.equal(top.metadata.base_token, "CAKE");
  assert.equal(top.metadata.chain, "bsc");
  assert.equal(top.metadata.volume_24h_usd, 1104505);
  assert.equal(top.metadata.liquidity_usd, 900000);
});

test("the ranking a caller asked for is the ranking they get", async () => {
  const { runExternalApiQuery } = await import("../src/external-api-capability.js");
  const { createMemoryStore } = await import("../src/store.js");
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const call = (query, operation) => runExternalApiQuery(createMemoryStore(), "github:user-a",
    { source: "geckoterminal", operation, query, limit: 3 }, { fetchImpl });

  // Filtering wash-traded pools out here would put per-source domain judgement
  // in a routing layer. The provider already publishes a ranking that excludes
  // them, so the choice is which endpoint to call — routing, not filtering.
  await call("今天BSC链交易量最高的5个meme代币", "trending");
  assert.match(seen.at(-1), /trending_pools\?duration=24h/);

  // A caller who explicitly wants raw volume order still gets it, on either
  // operation, because the wording decides.
  await call("BSC 按交易量排序的池子", "trending");
  assert.match(seen.at(-1), /\/pools\?sort=h24_volume_usd_desc/);
  await call("BSC top pools", "pools");
  assert.match(seen.at(-1), /\/pools\?sort=h24_volume_usd_desc/);

  // The network still comes from the question, not a default.
  await call("BASE链上热门池子", "trending");
  assert.match(seen.at(-1), /networks\/base\//);
});
