import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createDevSession } from "../src/auth.js";
import { createMemoryStore } from "../src/store.js";
import { agentHtml } from "../src/home.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function indexedAgent(overrides = {}) {
  return {
    chain_id: 56,
    token_id: "4242",
    name: "Research Agent",
    description: "Searches public research sources.",
    metadata_uri: "https://agents.example/4242.json",
    average_score: 91,
    total_feedbacks: 18,
    x402_supported: true,
    ...overrides
  };
}

test("discovery is on demand and returns registered agents as unverified marketplace candidates", async () => {
  const calls = [];
  const discovery = {
    search: async ({ query, limit, chainId }) => {
      calls.push({ query, limit, chainId });
      return [{
        agent_id: "4242", chain_id: 56, name: "Research Agent", description: "Searches public research sources.",
        explorer_url: "https://8004scan.io/agents/56/4242", trust: { average_score: 91, total_feedbacks: 18 },
        protocols: ["x402"], verification_state: "registered_unverified"
      }];
    }
  };
  const server = createServer({ erc8004Discovery: discovery });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/discover?q=research&limit=5`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.discovery_mode, "on_demand");
    assert.equal(payload.agents[0].verification_state, "registered_unverified");
    assert.equal(payload.agents[0].callable, false);
    assert.deepEqual(calls, [{ query: "research", limit: 5, chainId: 56 }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("import verifies advertised protocols before an external agent becomes callable", async () => {
  const store = createMemoryStore();
  const session = createDevSession(store, "http://127.0.0.1");
  const discovery = {
    get: async () => indexedAgent(),
    verify: async () => ({
      verification_state: "verified_callable",
      callable: true,
      protocols: {
        mcp: { status: "verified", endpoint: "https://agents.example/mcp" },
        a2a: { status: "not_declared", endpoint: null },
        http: { status: "verified", endpoint: "https://agents.example/query" },
        x402: { status: "declared", endpoint: "https://agents.example/query" }
      },
      preferred_adapter: "mcp",
      verified_at: "2026-08-31T00:00:00.000Z"
    })
  };
  const server = createServer({ store, erc8004Discovery: discovery });
  const baseUrl = await listen(server);
  const headers = { cookie: session.cookie.split(";")[0], "content-type": "application/json" };
  try {
    const response = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "4242" })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.agent.verification_state, "verified_callable");
    assert.equal(payload.agent.preferred_adapter, "mcp");
    assert.equal(store.erc8004Imports.get("56:4242").callable, true);

    const hire = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "4242", input: { query: "BNB agents" } })
    });
    const hired = await hire.json();
    assert.equal(hire.status, 200);
    assert.equal(hired.status, "ready_to_call");
    assert.equal(hired.dispatch.adapter, "mcp");
    assert.deepEqual(hired.dispatch.input, { query: "BNB agents" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("registered but unverified agents cannot enter the hire path", async () => {
  const store = createMemoryStore();
  const session = createDevSession(store, "http://127.0.0.1");
  const discovery = {
    get: async () => indexedAgent({ token_id: "5000" }),
    verify: async () => ({
      verification_state: "registered_unverified", callable: false,
      protocols: { mcp: { status: "not_declared", endpoint: null }, a2a: { status: "not_declared", endpoint: null }, http: { status: "unreachable", endpoint: "https://agents.example/down" }, x402: { status: "not_declared", endpoint: null } },
      preferred_adapter: null,
      verification_error: "No advertised endpoint passed validation."
    })
  };
  const server = createServer({ store, erc8004Discovery: discovery });
  const baseUrl = await listen(server);
  const headers = { cookie: session.cookie.split(";")[0], "content-type": "application/json" };
  try {
    const imported = await fetch(`${baseUrl}/agent-router/erc8004/import`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "5000" })
    });
    assert.equal(imported.status, 200);

    const hire = await fetch(`${baseUrl}/agent-router/erc8004/hire`, {
      method: "POST", headers, body: JSON.stringify({ chain_id: 56, agent_id: "5000", input: {} })
    });
    const payload = await hire.json();
    assert.equal(hire.status, 409);
    assert.equal(payload.error.code, "ERC8004_AGENT_NOT_CALLABLE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("agent marketplace explains imported identity state and exposes ERC-8004 discovery", () => {
  const page = agentHtml();
  assert.match(page, /agent-router\/erc8004\/discover/);
  assert.match(page, /Registered on-chain, not verified|registered_unverified/);
  assert.match(page, /Hire \/ call/);
});
