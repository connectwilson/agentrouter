import test from "node:test";
import assert from "node:assert/strict";

import { createDevSession } from "../src/auth.js";
import { createErc8004Discovery, normalizeErc8004Agent, verifyErc8004Agent } from "../src/erc8004-discovery.js";
import { createServer } from "../src/server.js";
import { createMemoryStore, publicErc8004Status } from "../src/store.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function withServer(options, run) {
  const server = createServer(options);
  const baseUrl = await listen(server);
  try { return await run({ baseUrl, server }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function signedInStore() {
  const store = createMemoryStore();
  const session = createDevSession(store, "http://127.0.0.1");
  return { store, headers: { cookie: session.cookie.split(";")[0], "content-type": "application/json" } };
}

function scanAgent(overrides = {}) {
  return {
    chain_id: 56,
    token_id: "42",
    name: "Regression Agent",
    description: "Regression fixture",
    metadata: { services: [{ name: "HTTP", endpoint: "https://1.1.1.1/query" }] },
    ...overrides
  };
}

function verifiedImport(overrides = {}) {
  return {
    chain_id: 56,
    agent_id: "42",
    name: "Regression Agent",
    callable: true,
    verification_state: "verified_callable",
    preferred_adapter: "http",
    protocols: {
      mcp: { status: "not_declared", endpoint: null },
      a2a: { status: "not_declared", endpoint: null },
      http: { status: "verified", endpoint: "https://1.1.1.1/query" },
      x402: { status: "not_declared", endpoint: null }
    },
    ...overrides
  };
}

test("normalizer accepts camelCase records and preserves trust metadata", () => {
  const agent = normalizeErc8004Agent({
    chainId: 56, tokenId: 7, contractAddress: "0xregistry", metadataUri: "https://1.1.1.1/meta",
    averageScore: "88.5", totalFeedbacks: "4", totalValidations: "3", successfulValidations: "2",
    x402Supported: true
  });
  assert.equal(agent.agent_id, "7");
  assert.equal(agent.registry, "0xregistry");
  assert.equal(agent.metadata_uri, "https://1.1.1.1/meta");
  assert.equal(agent.trust.average_score, 88.5);
  assert.equal(agent.trust.total_feedbacks, 4);
  assert.deepEqual(agent.protocols, ["x402"]);
});

test("normalizer accepts agent and data wrappers", () => {
  assert.equal(normalizeErc8004Agent({ agent: { token_id: "8" } }).agent_id, "8");
  assert.equal(normalizeErc8004Agent({ data: { token_id: "9" } }).agent_id, "9");
});

test("normalizer derives an id from a composite id when token_id is absent", () => {
  assert.equal(normalizeErc8004Agent({ agent_id: "56:0xregistry:123" }).agent_id, "123");
});

test("normalizer does not invent an 8004scan link for another chain", () => {
  const agent = normalizeErc8004Agent({ chain_id: 97, token_id: "10" });
  assert.equal(agent.explorer_url, null);
  assert.equal(agent.verification_state, "registered_unverified");
  assert.equal(agent.callable, false);
});

test("normalizer ignores unsupported protocol labels and malformed services", () => {
  const agent = normalizeErc8004Agent({
    token_id: "11", supported_protocols: ["MCP", "SMTP"],
    metadata: { services: [null, "bad", { name: "A2A", endpoint: "https://1.1.1.1/a2a" }] }
  });
  assert.deepEqual(agent.protocols, ["a2a", "mcp"]);
  assert.equal(agent.services.length, 1);
});

test("normalizer reports missing and nonnumeric trust values without NaN", () => {
  const agent = normalizeErc8004Agent({ token_id: "12", average_score: "unknown", rank: "" });
  assert.equal(agent.trust.average_score, null);
  assert.equal(agent.trust.rank, null);
  assert.equal(agent.trust.total_feedbacks, 0);
});

test("empty discovery uses the chain listing endpoint and clamps a low limit", async () => {
  const urls = [];
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async (url) => {
    urls.push(url); return { ok: true, json: async () => ({ data: [scanAgent()] }) };
  } });
  await discovery.search({ query: "", limit: -4, chainId: 56 });
  assert.match(urls[0], /\/agents\?chainId=56&limit=1$/);
});

test("discovery clamps a high limit and encodes the query", async () => {
  const urls = [];
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async (url) => {
    urls.push(url); return { ok: true, json: async () => ({ results: [scanAgent()] }) };
  } });
  await discovery.search({ query: "agent routing/支付", limit: 500, chainId: 56 });
  assert.match(urls[0], /q=agent%20routing%2F%E6%94%AF%E4%BB%98&chainId=56&limit=25$/);
});

test("discovery filters rows without a usable identity", async () => {
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => ({
    ok: true, json: async () => [scanAgent(), { name: "missing id" }]
  }) });
  assert.equal((await discovery.search()).length, 1);
});

test("discovery filters identities returned for a different chain", async () => {
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => ({
    ok: true, json: async () => ({ agents: [scanAgent(), scanAgent({ chain_id: 97, token_id: "97" })] })
  }) });
  const agents = await discovery.search({ chainId: 56 });
  assert.deepEqual(agents.map((agent) => agent.agent_id), ["42"]);
});

test("identical concurrent discovery calls share one upstream request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => {
    calls += 1; await gate; return { ok: true, json: async () => ({ agents: [scanAgent()] }) };
  } });
  const first = discovery.search({ query: "same" });
  const second = discovery.search({ query: "same" });
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("expired discovery cache refreshes from upstream", async () => {
  let time = 1_000;
  let calls = 0;
  const discovery = createErc8004Discovery({ now: () => time, minRequestIntervalMs: 0, fetchImpl: async () => {
    calls += 1; return { ok: true, json: async () => ({ agents: [scanAgent()] }) };
  } });
  await discovery.search({ query: "ttl" });
  time += 60_001;
  await discovery.search({ query: "ttl" });
  assert.equal(calls, 2);
});

test("failed discovery is evicted so the next request can recover", async () => {
  let attempts = 0;
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("offline");
    return { ok: true, json: async () => ({ agents: [scanAgent()] }) };
  } });
  await assert.rejects(discovery.search({ query: "recover" }));
  assert.equal((await discovery.search({ query: "recover" })).length, 1);
  assert.equal(attempts, 3);
});

test("search-populated agent cache avoids a second detail request", async () => {
  let calls = 0;
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => {
    calls += 1; return { ok: true, json: async () => ({ agents: [scanAgent()] }) };
  } });
  await discovery.search({ query: "cached" });
  assert.equal((await discovery.get({ chainId: 56, agentId: "42" })).agent_id, "42");
  assert.equal(calls, 1);
});

test("search-populated agent cache expires before a later detail import", async () => {
  let time = 1_000;
  let calls = 0;
  const discovery = createErc8004Discovery({ now: () => time, minRequestIntervalMs: 0, cacheTtlMs: 60_000, fetchImpl: async (url) => {
    calls += 1;
    return url.includes("/search")
      ? { ok: true, json: async () => ({ agents: [scanAgent({ name: "stale" })] }) }
      : { ok: true, json: async () => scanAgent({ name: "fresh" }) };
  } });
  await discovery.search({ query: "cache-expiry" });
  time += 60_001;
  const agent = await discovery.get({ chainId: 56, agentId: "42" });
  assert.equal(agent.name, "fresh");
  assert.equal(calls, 2);
});

test("agent detail cache evicts old identities at its configured capacity", async () => {
  let calls = 0;
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, agentCacheLimit: 2, fetchImpl: async (url) => {
    calls += 1;
    const queryId = new URL(url).searchParams.get("q")?.replace("agent-", "");
    const detailId = url.match(/\/agents\/56\/(\d+)$/)?.[1];
    const tokenId = queryId || detailId || "1";
    return { ok: true, json: async () => url.includes("/search")
      ? ({ agents: [scanAgent({ token_id: tokenId })] })
      : scanAgent({ token_id: tokenId }) };
  } });
  await discovery.search({ query: "agent-1" });
  await discovery.search({ query: "agent-2" });
  await discovery.search({ query: "agent-3" });
  await discovery.get({ chainId: 56, agentId: "1" });
  assert.equal(calls, 4);
});

test("direct agent lookup accepts a data-wrapped detail response", async () => {
  const urls = [];
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async (url) => {
    urls.push(url); return { ok: true, json: async () => ({ data: scanAgent({ token_id: "77" }) }) };
  } });
  assert.equal((await discovery.get({ chainId: 56, agentId: "77" })).agent_id, "77");
  assert.match(urls[0], /\/agents\/56\/77$/);
});

for (const invalidId of ["", "abc", "-1", "1.5", "1/2"]) {
  test(`direct lookup rejects invalid agent id: ${JSON.stringify(invalidId)}`, async () => {
    const discovery = createErc8004Discovery({ fetchImpl: async () => { throw new Error("must not call"); } });
    await assert.rejects(discovery.get({ chainId: 56, agentId: invalidId }), (error) => error.code === "ERC8004_AGENT_ID_INVALID");
  });
}

test("non-2xx 8004scan responses become stable gateway errors", async () => {
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(discovery.search({ query: "down" }), (error) => error.code === "ERC8004_SCAN_UNAVAILABLE" && error.statusCode === 502);
});

test("malformed 8004scan JSON becomes a stable gateway error", async () => {
  const discovery = createErc8004Discovery({ minRequestIntervalMs: 0, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); }
  }) });
  await assert.rejects(discovery.search({ query: "bad-json" }), (error) => error.code === "ERC8004_SCAN_INVALID_RESPONSE" && error.statusCode === 502);
});

test("verification recognizes legacy endpoints and endpoint aliases", async () => {
  const result = await verifyErc8004Agent(scanAgent({ metadata: {
    endpoints: [
      { type: "MCP", url: "https://1.1.1.1/mcp" },
      { protocol: "A2A", href: "https://1.1.1.1/a2a" },
      { name: "REST", uri: "https://1.1.1.1/http" }
    ]
  } }), { endpointProbe: async () => ({ ok: true, status: 200 }) });
  assert.equal(result.protocols.mcp.status, "verified");
  assert.equal(result.protocols.a2a.status, "verified");
  assert.equal(result.protocols.http.status, "verified");
  assert.equal(result.preferred_adapter, "mcp");
});

test("verification keeps the first endpoint declared for each protocol", async () => {
  const result = await verifyErc8004Agent(scanAgent({ metadata: { services: [
    { name: "MCP", endpoint: "https://1.1.1.1/first" },
    { name: "MCP", endpoint: "https://1.1.1.1/second" }
  ] } }), { endpointProbe: async () => ({ ok: true }) });
  assert.equal(result.protocols.mcp.endpoint, "https://1.1.1.1/first");
});

test("x402 capability alone never makes an agent callable", async () => {
  const result = await verifyErc8004Agent(scanAgent({ x402_supported: true, metadata: { services: [] } }), {
    endpointProbe: async () => ({ ok: true })
  });
  assert.equal(result.protocols.x402.status, "declared");
  assert.equal(result.callable, false);
  assert.equal(result.preferred_adapter, null);
});

test("x402 uses the declared HTTP endpoint as its payment target", async () => {
  const result = await verifyErc8004Agent(scanAgent({ x402_supported: true }), { endpointProbe: async () => ({ ok: true }) });
  assert.equal(result.protocols.x402.endpoint, "https://1.1.1.1/query");
});

test("transport preference is deterministic: MCP, then A2A, then HTTP", async () => {
  const metadata = { services: [
    { name: "HTTP", endpoint: "https://1.1.1.1/http" },
    { name: "A2A", endpoint: "https://1.1.1.1/a2a" },
    { name: "MCP", endpoint: "https://1.1.1.1/mcp" }
  ] };
  const all = await verifyErc8004Agent(scanAgent({ metadata }), { endpointProbe: async () => ({ ok: true }) });
  const noMcp = await verifyErc8004Agent(scanAgent({ metadata }), { endpointProbe: async (_endpoint, { protocol }) => ({ ok: protocol !== "mcp" }) });
  const onlyHttp = await verifyErc8004Agent(scanAgent({ metadata }), { endpointProbe: async (_endpoint, { protocol }) => ({ ok: protocol === "http" }) });
  assert.equal(all.preferred_adapter, "mcp");
  assert.equal(noMcp.preferred_adapter, "a2a");
  assert.equal(onlyHttp.preferred_adapter, "http");
});

test("probe exceptions mark one protocol unreachable without aborting verification", async () => {
  const result = await verifyErc8004Agent(scanAgent({ metadata: { services: [
    { name: "MCP", endpoint: "https://1.1.1.1/mcp" },
    { name: "A2A", endpoint: "https://1.1.1.1/a2a" }
  ] } }), { endpointProbe: async (_endpoint, { protocol }) => {
    if (protocol === "mcp") throw new Error("broken stream");
    return { ok: true, status: 204 };
  } });
  assert.equal(result.protocols.mcp.status, "unreachable");
  assert.match(result.protocols.mcp.error, /broken stream/);
  assert.equal(result.preferred_adapter, "a2a");
});

test("default HTTP probe treats a 402 challenge as reachable", async () => {
  const methods = [];
  const result = await verifyErc8004Agent(scanAgent(), { fetchImpl: async (_url, options) => {
    methods.push(options.method); return { ok: false, status: 402 };
  } });
  assert.equal(result.protocols.http.status, "verified");
  assert.deepEqual(methods, ["HEAD"]);
});

for (const status of [400, 401, 403, 404, 429]) {
  test(`default HTTP probe does not verify HTTP ${status} as callable`, async () => {
    const result = await verifyErc8004Agent(scanAgent(), { fetchImpl: async () => ({ status }) });
    assert.equal(result.callable, false);
    assert.equal(result.protocols.http.status, "unreachable");
    assert.equal(result.protocols.http.http_status, status);
  });
}

test("default HTTP probe retries GET when HEAD is unsupported", async () => {
  const methods = [];
  const result = await verifyErc8004Agent(scanAgent(), { fetchImpl: async (_url, options) => {
    methods.push(options.method);
    return { status: options.method === "HEAD" ? 405 : 200 };
  } });
  assert.equal(result.callable, true);
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("default MCP probe uses GET and advertises event-stream support", async () => {
  const calls = [];
  const result = await verifyErc8004Agent(scanAgent({ metadata: { services: [{ name: "MCP", endpoint: "https://1.1.1.1/mcp" }] } }), {
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
    }
  });
  assert.equal(result.preferred_adapter, "mcp");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].headers.accept, /text\/event-stream/);
  assert.equal(calls[0].redirect, "manual");
});

test("an HTML page at a declared MCP endpoint is reachable but not protocol-verified", async () => {
  const result = await verifyErc8004Agent(scanAgent({ metadata: {
    services: [{ name: "MCP", endpoint: "https://1.1.1.1/mcp" }]
  } }), { fetchImpl: async () => ({ status: 200, headers: new Headers({ "content-type": "text/html" }) }) });
  assert.equal(result.callable, false);
  assert.equal(result.protocols.mcp.status, "unreachable");
});

test("private transport endpoints are marked unreachable rather than promoted", async () => {
  const result = await verifyErc8004Agent(scanAgent({ metadata: { services: [{ name: "HTTP", endpoint: "https://127.0.0.1/private" }] } }), {
    fetchImpl: async () => { throw new Error("must not fetch"); }
  });
  assert.equal(result.callable, false);
  assert.equal(result.protocols.http.status, "unreachable");
  assert.match(result.protocols.http.error, /public address/);
});

test("metadata can be fetched from a public HTTPS address before verification", async () => {
  const calls = [];
  const result = await verifyErc8004Agent(scanAgent({ metadata: null, metadata_uri: "https://1.1.1.1/meta" }), {
    endpointProbe: async () => ({ ok: true }),
    fetchImpl: async (url) => {
      calls.push(url); return { ok: true, json: async () => ({ services: [{ name: "A2A", endpoint: "https://1.1.1.1/a2a" }] }) };
    }
  });
  assert.deepEqual(calls, ["https://1.1.1.1/meta"]);
  assert.equal(result.preferred_adapter, "a2a");
});

test("metadata HTTP failures retain a typed validation error", async () => {
  await assert.rejects(verifyErc8004Agent(scanAgent({ metadata: null, metadata_uri: "https://1.1.1.1/meta" }), {
    fetchImpl: async () => ({ ok: false, status: 404 })
  }), (error) => error.code === "ERC8004_METADATA_UNAVAILABLE" && error.statusCode === 422);
});

test("malformed metadata JSON retains a typed validation error", async () => {
  await assert.rejects(verifyErc8004Agent(scanAgent({ metadata: null, metadata_uri: "https://1.1.1.1/meta" }), {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("bad metadata"); } })
  }), (error) => error.code === "ERC8004_METADATA_INVALID_RESPONSE" && error.statusCode === 422);
});

test("metadata redirects are handled manually and cannot cross into a private network", async () => {
  let followedAutomatically = false;
  let privateFetch = false;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("169.254.169.254")) {
      privateFetch = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (options.redirect !== "manual") {
      followedAutomatically = true;
      return fetchImpl("http://169.254.169.254/latest/meta-data", options);
    }
    return {
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data" })
    };
  };
  await assert.rejects(verifyErc8004Agent(scanAgent({ metadata: null, metadata_uri: "https://1.1.1.1/redirect" }), {
    fetchImpl
  }), (error) => ["ERC8004_ENDPOINT_INVALID", "ERC8004_ENDPOINT_NOT_PUBLIC"].includes(error.code));
  assert.equal(followedAutomatically, false);
  assert.equal(privateFetch, false);
});

for (const blocked of [
  "not a url",
  "http://1.1.1.1/meta",
  "https://user:pass@1.1.1.1/meta",
  "https://127.0.0.1/meta",
  "https://10.0.0.1/meta",
  "https://169.254.1.1/meta",
  "https://172.16.0.1/meta",
  "https://192.168.1.1/meta",
  "https://192.0.2.1/meta",
  "https://198.18.0.1/meta",
  "https://198.51.100.1/meta",
  "https://203.0.113.1/meta",
  "https://100.64.0.1/meta",
  "https://224.0.0.1/meta",
  "https://240.0.0.1/meta",
  "https://[::]/meta",
  "https://[::1]/meta",
  "https://[fe80::1]/meta",
  "https://[fc00::1]/meta",
  "https://[fd00::1]/meta",
  "https://[ff02::1]/meta",
  "https://[2001:db8::1]/meta",
  "https://[::ffff:127.0.0.1]/meta"
]) {
  test(`metadata SSRF guard blocks ${blocked}`, async () => {
    let fetched = false;
    await assert.rejects(verifyErc8004Agent(scanAgent({ metadata: null, metadata_uri: blocked }), {
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; }
    }), (error) => ["ERC8004_ENDPOINT_INVALID", "ERC8004_ENDPOINT_NOT_PUBLIC"].includes(error.code));
    assert.equal(fetched, false);
  });
}

test("marketplace identity state distinguishes submitted registration", () => {
  const previous = process.env.ADN_SETTLEMENT_CHAIN;
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  try {
    const status = publicErc8004Status({ manifest: { registration: { erc8004: {
      agent_id: "90", network: "bsc", status: "submitted"
    } } } });
    assert.equal(status.state, "submitted");
  } finally {
    if (previous === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previous;
  }
});

test("discovery API trims query and clamps limit", async () => {
  const calls = [];
  await withServer({ erc8004Discovery: { search: async (args) => { calls.push(args); return []; } } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=%20routing%20&limit=999`);
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, [{ query: "routing", limit: 25, chainId: 56 }]);
});

test("discovery API returns a stable upstream error shape", async () => {
  const error = Object.assign(new Error("upstream down"), { code: "ERC8004_SCAN_UNAVAILABLE", statusCode: 502 });
  await withServer({ erc8004Discovery: { search: async () => { throw error; } } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=routing`);
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "ERC8004_SCAN_UNAVAILABLE");
    assert.equal(payload.error.message, "The server could not complete this request.");
  });
});

test("discovery API overlays an imported state without exposing imported_by", async () => {
  const store = createMemoryStore();
  store.erc8004Imports.set("56:42", verifiedImport({ imported_by: "github:secret-user" }));
  await withServer({ store, erc8004Discovery: { search: async () => [scanAgent()] } }, async ({ baseUrl }) => {
    const payload = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=regression`).then((response) => response.json());
    assert.equal(payload.agents[0].verification_state, "verified_callable");
    assert.equal(payload.agents[0].imported_by, undefined);
  });
});

test("import API requires authentication before discovery or verification", async () => {
  let called = false;
  const discovery = { get: async () => { called = true; }, verify: async () => { called = true; } };
  await withServer({ erc8004Discovery: discovery }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "42" })
    });
    assert.equal(response.status, 401);
  });
  assert.equal(called, false);
});

test("import API rejects non-BSC identities before lookup", async () => {
  const { store, headers } = signedInStore();
  let called = false;
  await withServer({ store, erc8004Discovery: { get: async () => { called = true; } } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 97, agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.error.code, "ERC8004_CHAIN_UNSUPPORTED");
  });
  assert.equal(called, false);
});

test("import API cannot promote a callable claim without a verified endpoint", async () => {
  const { store, headers } = signedInStore();
  const discovery = {
    get: async () => scanAgent(),
    verify: async () => ({ verification_state: "verified_callable", callable: true, preferred_adapter: "mcp", protocols: { mcp: { status: "verified", endpoint: null } } })
  };
  await withServer({ store, erc8004Discovery: discovery }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.agent.callable, false);
    assert.equal(payload.agent.verification_state, "registered_unverified");
  });
});

test("import API rejects a detail response for a different token id", async () => {
  const { store, headers } = signedInStore();
  const discovery = { get: async () => scanAgent({ token_id: "99" }), verify: async () => verifiedImport() };
  await withServer({ store, erc8004Discovery: discovery }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.error.code, "ERC8004_INDEX_ID_MISMATCH");
  });
});

test("import API rejects a detail response for a different chain", async () => {
  const { store, headers } = signedInStore();
  const discovery = { get: async () => scanAgent({ chain_id: 97 }), verify: async () => verifiedImport() };
  await withServer({ store, erc8004Discovery: discovery }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.error.code, "ERC8004_INDEX_CHAIN_MISMATCH");
  });
});

test("hire API requires authentication", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "42" })
    });
    assert.equal(response.status, 401);
  });
});

test("hire API refuses a missing imported identity", async () => {
  const { store, headers } = signedInStore();
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "404" })
    });
    assert.equal(response.status, 409);
  });
});

test("hire API fails closed when a persisted adapter has no endpoint", async () => {
  const { store, headers } = signedInStore();
  store.erc8004Imports.set("56:42", verifiedImport({ protocols: { http: { status: "verified", endpoint: null } } }));
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42" })
    });
    assert.equal(response.status, 409);
  });
});

test("hire API does not label payment x402 when x402 was never declared", async () => {
  const { store, headers } = signedInStore();
  store.erc8004Imports.set("56:42", verifiedImport({ protocols: { http: { status: "verified", endpoint: "https://1.1.1.1/query" } } }));
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(payload.dispatch.payment, "provider_declared");
  });
});

test("hire API labels payment x402 only when it is explicitly declared", async () => {
  const { store, headers } = signedInStore();
  store.erc8004Imports.set("56:42", verifiedImport({ protocols: {
    http: { status: "verified", endpoint: "https://1.1.1.1/query" },
    x402: { status: "declared", endpoint: "https://1.1.1.1/query" }
  } }));
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(payload.dispatch.payment, "x402");
  });
});

test("hire API rejects a callable import whose verification has expired", async () => {
  const { store, headers } = signedInStore();
  store.erc8004Imports.set("56:42", verifiedImport({ verified_at: "2020-01-01T00:00:00.000Z" }));
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42" })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "ERC8004_VERIFICATION_EXPIRED");
  });
});

test("hire API defaults omitted and null input to an empty object", async () => {
  for (const input of [undefined, null]) {
    const { store, headers } = signedInStore();
    store.erc8004Imports.set("56:42", verifiedImport());
    await withServer({ store }, async ({ baseUrl }) => {
      const body = input === undefined ? { agent_id: "42" } : { agent_id: "42", input };
      const payload = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
        method: "POST", headers, body: JSON.stringify(body)
      }).then((response) => response.json());
      assert.deepEqual(payload.dispatch.input, {});
    });
  }
});

test("hire API accepts only object-shaped input", async () => {
  const { store, headers } = signedInStore();
  store.erc8004Imports.set("56:42", verifiedImport());
  await withServer({ store }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ agent_id: "42", input: ["not", "an", "object"] })
    });
    const payload = await response.json();
    assert.deepEqual(payload.dispatch.input, {});
  });
});
