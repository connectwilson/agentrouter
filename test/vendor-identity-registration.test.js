import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { createDevSession } from "../src/auth.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { hydrateServiceEventRows, registerService } from "../src/registry.js";
import { createMemoryStore } from "../src/store.js";
import { runExternalApiQuery } from "../src/external-api-capability.js";

const OWNER = "0x5555555555555555555555555555555555555555";
const TX_HASH = `0x${"d".repeat(64)}`;

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

function ownedManifest(serviceId, providerId, ownerKey, endpointPath) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = serviceId;
  manifest.provider = { ...manifest.provider, provider_id: providerId };
  manifest.endpoint = { ...manifest.endpoint, url: `http://provider.example${endpointPath}` };
  manifest.registration = { ...(manifest.registration || {}), owner: { user_key: ownerKey } };
  return manifest;
}

function verifiedIdentity(expected, agentId = "81001") {
  return {
    standard: "ERC-8004", registry_type: "identity", status: "registered",
    network: "bsc", caip2: "eip155:56", chain_id: 56,
    registry_address: expected.registryAddress,
    reputation_registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation_registry_address: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    agent_id: agentId, owner_address: OWNER, metadata_uri: expected.agentUri,
    tx_hash: TX_HASH, block_number: "456", explorer_url: `https://bscscan.com/tx/${TX_HASH}`
  };
}

test("one chain-generated Vendor Agent ID is shared by every service from that Vendor", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const session = createDevSession(store, "http://127.0.0.1");
    const ownerKey = "local:local-development-user";
    registerService(store, ownedManifest("vendor_alpha_prices", "vendor_alpha", ownerKey, "/prices"), "http://127.0.0.1");
    registerService(store, ownedManifest("vendor_alpha_news", "vendor_alpha", ownerKey, "/news"), "http://127.0.0.1");
    const server = createServer({ store, erc8004RegistrationVerifier: async ({ expected }) => verifiedIdentity(expected) });
    const baseUrl = await listen(server);
    const headers = { cookie: session.cookie.split(";")[0] };
    try {
      const vendorsResponse = await fetch(`${baseUrl}/agent-router/erc8004/vendors`, { headers });
      const vendors = await vendorsResponse.json();
      assert.equal(vendorsResponse.status, 200);
      assert.deepEqual(vendors.vendors.map((item) => item.provider_id), ["vendor_alpha"]);

      const configResponse = await fetch(`${baseUrl}/agent-router/erc8004/vendors/vendor_alpha/registration`, { headers });
      const config = await configResponse.json();
      assert.equal(configResponse.status, 200);
      assert.match(config.agent_uri, /\.well-known\/erc8004\/vendors\/vendor_alpha\.json$/);
      assert.equal(config.current_identity, null);
      assert.equal(config.transaction.value, "0x0");

      const response = await fetch(`${baseUrl}/agent-router/erc8004/vendors/vendor_alpha/registration`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER })
      });
      const registered = await response.json();
      assert.equal(response.status, 200);
      assert.equal(registered.identity.agent_id, "81001", "the registry event, not user input, supplies the Agent ID");
      assert.equal(store.erc8004VendorIdentities.get("bsc:vendor_alpha").agent_id, "81001");
      assert.equal(store.services.get("vendor_alpha_prices").manifest.registration.erc8004.agent_id, "81001");
      assert.equal(store.services.get("vendor_alpha_news").manifest.registration.erc8004.agent_id, "81001");

      const metadataResponse = await fetch(`${baseUrl}/.well-known/erc8004/vendors/vendor_alpha.json`);
      const metadata = await metadataResponse.json();
      assert.equal(metadataResponse.status, 200);
      assert.equal(metadata.registrations[0].agentId, "81001");
      assert.deepEqual(metadata.services.map((item) => item.service_id).sort(), ["vendor_alpha_news", "vendor_alpha_prices"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("account dashboard exposes Vendor identity registration without accepting a manual Agent ID", async () => {
  const { accountHtml } = await import("../src/home.js");
  const page = accountHtml({ auth: { user: { name: "Vendor owner" } } });
  assert.match(page, /Vendor identities/);
  assert.match(page, /agent-router\/erc8004\/vendors/);
  assert.doesNotMatch(page, /name=["']agent[_-]?id|id=["']agent[_-]?id/i);
});

test("an AgentRouter-managed external Vendor gets its own identity instead of inheriting the Platform ID", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc", ADN_PLATFORM_OPERATOR_OWNER_KEY: "local:local-development-user" }, async () => {
    const store = createMemoryStore();
    store.erc8004PlatformIdentities.set("bsc", verifiedIdentity({ registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", agentUri: "platform" }, "70000"));
    const session = createDevSession(store, "http://127.0.0.1");
    const server = createServer({ store, erc8004RegistrationVerifier: async ({ expected }) => verifiedIdentity(expected, "82002") });
    const baseUrl = await listen(server);
    const headers = { cookie: session.cookie.split(";")[0] };
    try {
      const registeredResponse = await fetch(`${baseUrl}/agent-router/erc8004/vendors/provider_gdelt/registration`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER })
      });
      assert.equal(registeredResponse.status, 200);

      const call = await runExternalApiQuery(store, "local:local-development-user", {
        source: "gdelt", operation: "search", query: "agent payments"
      }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        articles: [{ title: "Agent payments", url: "https://example.com/news", domain: "example.com", seendate: "20260830T000000Z" }]
      }) }) });
      const feedbackResponse = await fetch(`${baseUrl}/agent-router/feedback`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(call.consumer_feedback_request.example)
      });
      const feedback = await feedbackResponse.json();
      assert.equal(feedbackResponse.status, 200);
      assert.equal(feedback.erc8004.agent_id, "82002");
      assert.equal(feedback.erc8004.provider_id, "provider_gdelt");
      assert.notEqual(feedback.erc8004.agent_id, "70000");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("Vendor identities survive restart and reattach to all hydrated services", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    registerService(store, ownedManifest("vendor_restart_a", "vendor_restart", "github:owner", "/a"), "http://127.0.0.1");
    registerService(store, ownedManifest("vendor_restart_b", "vendor_restart", "github:owner", "/b"), "http://127.0.0.1");
    await hydrateServiceEventRows(store, [{
      event_type: "erc8004_vendor_identity", service_id: "vendor:vendor_restart", request_id: TX_HASH,
      event: {
        event_version: "agent_router_erc8004_vendor_identity_v1", provider_id: "vendor_restart",
        ...verifiedIdentity({ registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", agentUri: "https://agentrouter.network/.well-known/erc8004/vendors/vendor_restart.json" }, "83003")
      }
    }]);
    assert.equal(store.erc8004VendorIdentities.get("bsc:vendor_restart").agent_id, "83003");
    assert.equal(store.services.get("vendor_restart_a").manifest.registration.erc8004.agent_id, "83003");
    assert.equal(store.services.get("vendor_restart_b").manifest.registration.erc8004.agent_id, "83003");
  });
});
