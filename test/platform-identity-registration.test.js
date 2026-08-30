import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { createDevSession } from "../src/auth.js";
import { runExternalApiQuery } from "../src/external-api-capability.js";
import { hydrateServiceEventRows } from "../src/registry.js";

const TX_HASH = `0x${"b".repeat(64)}`;
const OWNER = "0x3333333333333333333333333333333333333333";

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("platform operator registers the BSC identity with a browser wallet and feedback uses it immediately", async () => {
  await withEnv({
    ADN_SETTLEMENT_CHAIN: "bsc",
    ADN_PLATFORM_OPERATOR_OWNER_KEY: "local:local-development-user"
  }, async () => {
    const store = createMemoryStore();
    const session = createDevSession(store, "http://127.0.0.1");
    const server = createServer({
      store,
      erc8004RegistrationVerifier: async ({ txHash, expected }) => ({
        standard: "ERC-8004",
        registry_type: "identity",
        status: "registered",
        network: "bsc",
        caip2: "eip155:56",
        chain_id: 56,
        registry_address: expected.registryAddress,
        reputation_registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
        validation_registry_address: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
        agent_id: "73352",
        owner_address: OWNER,
        metadata_uri: expected.agentUri,
        tx_hash: txHash,
        block_number: "123",
        explorer_url: `https://bscscan.com/tx/${txHash}`
      })
    });
    const baseUrl = await listen(server);
    const headers = { cookie: session.cookie.split(";")[0] };
    try {
      const configResponse = await fetch(`${baseUrl}/agent-router/erc8004/platform-registration`, { headers });
      const config = await configResponse.json();
      assert.equal(configResponse.status, 200);
      assert.equal(config.chain_id, 56);
      assert.equal(config.transaction.to, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
      assert.match(config.transaction.data, /^0x[0-9a-f]+$/i);
      assert.equal(config.current_identity, null);

      const registeredResponse = await fetch(`${baseUrl}/agent-router/erc8004/platform-registration`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER })
      });
      const registered = await registeredResponse.json();
      assert.equal(registeredResponse.status, 200);
      assert.equal(registered.identity.agent_id, "73352");
      assert.equal(store.erc8004PlatformIdentities.get("bsc").agent_id, "73352");

      const call = await runExternalApiQuery(store, "local:local-development-user", {
        source: "gdelt", operation: "search", query: "agent payments"
      }, {
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
          articles: [{ title: "Agent payments", url: "https://example.com/news", domain: "example.com", seendate: "20260830T000000Z" }]
        }) })
      });
      const feedbackResponse = await fetch(`${baseUrl}/agent-router/feedback`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(call.consumer_feedback_request.example)
      });
      const feedback = await feedbackResponse.json();
      assert.equal(feedbackResponse.status, 200);
      assert.equal(feedback.erc8004.agent_id, "73352");
      assert.equal(feedback.erc8004.agent_id_source, "manifest_registration");
      assert.equal(feedback.trust_anchor.state, "onchain_pending");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("platform identity registration is operator-only and survives event hydration", async () => {
  await withEnv({
    ADN_SETTLEMENT_CHAIN: "bsc",
    ADN_PLATFORM_OPERATOR_OWNER_KEY: "github:allowed-user"
  }, async () => {
    const store = createMemoryStore();
    const session = createDevSession(store, "http://127.0.0.1");
    const server = createServer({ store });
    const baseUrl = await listen(server);
    try {
      const denied = await fetch(`${baseUrl}/agent-router/erc8004/platform-registration`, {
        headers: { cookie: session.cookie.split(";")[0] }
      });
      assert.equal(denied.status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const restarted = createMemoryStore();
    await hydrateServiceEventRows(restarted, [{
      event_type: "erc8004_platform_identity",
      service_id: "agentrouter_external_api_platform",
      request_id: TX_HASH,
      event: {
        event_version: "agent_router_erc8004_platform_identity_v1",
        network: "bsc",
        agent_id: "73352",
        owner_address: OWNER,
        tx_hash: TX_HASH,
        created_at: "2026-08-30T00:00:00.000Z"
      }
    }]);
    assert.equal(restarted.erc8004PlatformIdentities.get("bsc").agent_id, "73352");
  });
});

test("account dashboard keeps private keys out of the platform registration flow", async () => {
  const { accountHtml } = await import("../src/home.js");
  const page = accountHtml({ auth: { user: { name: "Operator" } } });
  assert.match(page, /Register BSC identity/);
  assert.match(page, /eth_sendTransaction/);
  assert.match(page, /platform-registration/);
  assert.doesNotMatch(page, /private key|seed phrase|mnemonic/i);
});
