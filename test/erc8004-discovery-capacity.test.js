import assert from "node:assert/strict";
import test from "node:test";

import { createErc8004Discovery, verifyErc8004Agent } from "../src/erc8004-discovery.js";
import { createServer } from "../src/server.js";

test("unique unauthenticated discovery bursts have a bounded pending queue and typed overload response", async () => {
  let releaseUpstream;
  let startedUpstream;
  const upstreamStarted = new Promise((resolve) => { startedUpstream = resolve; });
  const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve; });
  const discovery = createErc8004Discovery({
    minRequestIntervalMs: 0,
    maxPendingRequests: 1,
    queryCacheLimit: 3,
    fetchImpl: async () => {
      startedUpstream();
      await upstreamGate;
      return Response.json({ agents: [] });
    }
  });
  const server = createServer({ erc8004Discovery: discovery });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const first = fetch(`${baseUrl}/agent-router/erc8004/discover?q=unique-0`);
    await upstreamStarted;
    // Keep the client burst below undici's per-origin connection pool so this
    // measures the server queue rather than the test client's socket queue.
    const burst = Array.from({ length: 6 }, (_, index) =>
      fetch(`${baseUrl}/agent-router/erc8004/discover?q=unique-${index + 1}`)
    );
    const raced = await Promise.race([
      Promise.all(burst),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 75))
    ]);

    assert.notEqual(raced, "timed_out", "over-capacity requests must fail quickly instead of joining a long serial queue");
    for (const response of raced) {
      assert.equal(response.status, 503);
      assert.ok(Number(response.headers.get("retry-after")) >= 1);
      assert.equal((await response.json()).error.code, "ERC8004_DISCOVERY_OVERLOADED");
    }
    const stats = discovery.stats();
    assert.ok(stats.pending_requests <= 1);
    assert.ok(stats.query_cache_entries <= 3);
    assert.equal(stats.overload_rejections, 6);

    releaseUpstream();
    assert.equal((await first).status, 200);
  } finally {
    releaseUpstream();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("discovery query length is rejected before the injected discovery backend and limit remains capped", async () => {
  const calls = [];
  const server = createServer({
    erc8004Discovery: {
      search: async (args) => {
        calls.push(args);
        return [];
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const oversized = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=${"x".repeat(257)}&limit=999999999`);
    const oversizedPayload = await oversized.json();
    assert.equal(oversized.status, 422);
    assert.equal(oversizedPayload.error.code, "ERC8004_QUERY_TOO_LONG");
    assert.equal(calls.length, 0);

    const bounded = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=%20routing%20&limit=999999999`);
    assert.equal(bounded.status, 200);
    assert.deepEqual(calls, [{ query: "routing", limit: 25, chainId: 56 }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("verification tries the next endpoint of the same protocol when the first endpoint is unhealthy", async () => {
  const calls = [];
  const result = await verifyErc8004Agent(agentWithServices([
    { name: "MCP", endpoint: "https://1.1.1.1/broken-mcp" },
    { name: "MCP", endpoint: "https://1.1.1.1/healthy-mcp" }
  ]), {
    endpointProbe: async (endpoint) => {
      calls.push(endpoint);
      return { ok: endpoint.endsWith("/healthy-mcp"), status: endpoint.endsWith("/healthy-mcp") ? 200 : 503 };
    }
  });

  assert.deepEqual(calls, ["https://1.1.1.1/broken-mcp", "https://1.1.1.1/healthy-mcp"]);
  assert.equal(result.callable, true);
  assert.equal(result.preferred_adapter, "mcp");
  assert.equal(result.protocols.mcp.endpoint, "https://1.1.1.1/healthy-mcp");
});

test("A2A verification requires an agent-card shape rather than arbitrary JSON 200", async () => {
  const arbitrary = await verifyErc8004Agent(agentWithServices([
    { name: "A2A", endpoint: "https://1.1.1.1/a2a" }
  ]), {
    fetchImpl: async () => Response.json({ ok: true })
  });
  const valid = await verifyErc8004Agent(agentWithServices([
    { name: "A2A", endpoint: "https://1.1.1.1/a2a" }
  ]), {
    fetchImpl: async () => Response.json({
      name: "Research A2A Agent",
      description: "Researches public sources.",
      url: "https://1.1.1.1/a2a",
      version: "1.0.0",
      capabilities: {},
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"]
    }, { headers: { "content-type": "application/agent-card+json" } })
  });

  assert.equal(arbitrary.callable, false);
  assert.equal(arbitrary.protocols.a2a.status, "unreachable");
  assert.equal(valid.callable, true);
  assert.equal(valid.preferred_adapter, "a2a");
});

test("MCP verification requires a valid initialize response rather than arbitrary JSON 200", async () => {
  const requests = [];
  const arbitrary = await verifyErc8004Agent(agentWithServices([
    { name: "MCP", endpoint: "https://1.1.1.1/mcp" }
  ]), {
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return Response.json({ ok: true });
    }
  });
  const valid = await verifyErc8004Agent(agentWithServices([
    { name: "MCP", endpoint: "https://1.1.1.1/mcp" }
  ]), {
    fetchImpl: async (_url, init) => {
      requests.push(init);
      const request = JSON.parse(init.body);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "Research MCP", version: "1.0.0" }
        }
      });
    }
  });

  assert.equal(arbitrary.callable, false);
  assert.equal(valid.callable, true);
  assert.equal(valid.preferred_adapter, "mcp");
  assert.ok(requests.every((request) => request.method === "POST"));
  assert.ok(requests.every((request) => JSON.parse(request.body).method === "initialize"));
});

function agentWithServices(services) {
  return {
    chain_id: 56,
    token_id: "42",
    name: "Discovery capacity fixture",
    metadata: { services }
  };
}
