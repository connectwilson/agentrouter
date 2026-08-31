import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { hydrateServiceEventRows } from "../src/registry.js";
import { createMemoryStore } from "../src/store.js";

const ALICE = {
  provider: "github",
  id: "provider-owner-alice",
  handle: "provider-owner-alice",
  name: "Provider Owner Alice"
};

const BOB = {
  provider: "github",
  id: "provider-owner-bob",
  handle: "provider-owner-bob",
  name: "Provider Owner Bob"
};

const ALICE_KEY = "github:provider-owner-alice";
const BOB_KEY = "github:provider-owner-bob";
const ALICE_COOKIE = "ar_session=provider-owner-alice-session";
const BOB_COOKIE = "ar_session=provider-owner-bob-session";
const TX_HASH = `0x${"e".repeat(64)}`;
const OWNER_ADDRESS = "0x5555555555555555555555555555555555555555";

async function withOwnershipServer(run, { store = createMemoryStore(), ...serverOptions } = {}) {
  const server = createServer({ store, ...serverOptions });
  const expiresAt = Date.now() + 60_000;
  store.authSessions.set("provider-owner-alice-session", {
    user: ALICE,
    created_at: Date.now(),
    expires_at: expiresAt
  });
  store.authSessions.set("provider-owner-bob-session", {
    user: BOB,
    created_at: Date.now(),
    expires_at: expiresAt
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ server, store, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function serviceManifest(serviceId, providerId, endpointSuffix = serviceId) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = serviceId;
  manifest.provider = {
    ...manifest.provider,
    provider_id: providerId
  };
  manifest.endpoint = {
    ...manifest.endpoint,
    url: `https://provider.example/${endpointSuffix}`
  };
  return manifest;
}

async function register(baseUrl, manifest, cookie) {
  return fetch(`${baseUrl}/services/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie
    },
    body: JSON.stringify(manifest)
  });
}

function verifiedIdentity(expected, agentId = "91001") {
  return {
    standard: "ERC-8004",
    registry_type: "identity",
    status: "registered",
    network: "bsc",
    caip2: "eip155:56",
    chain_id: 56,
    registry_address: expected.registryAddress,
    reputation_registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation_registry_address: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    agent_id: agentId,
    owner_address: OWNER_ADDRESS,
    metadata_uri: expected.agentUri,
    tx_hash: TX_HASH,
    block_number: "456"
  };
}

test("a provider_id claimed by one account cannot be registered by another account", async () => {
  await withOwnershipServer(async ({ store, baseUrl }) => {
    const first = await register(
      baseUrl,
      serviceManifest("alice_market_data", "durable_vendor"),
      ALICE_COOKIE
    );
    assert.equal(first.status, 201);

    const conflicting = await register(
      baseUrl,
      serviceManifest("bob_market_data", "durable_vendor"),
      BOB_COOKIE
    );
    const payload = await conflicting.json();

    assert.equal(conflicting.status, 409);
    assert.equal(payload.error.code, "PROVIDER_ID_ALREADY_CLAIMED");
    assert.equal(store.services.has("bob_market_data"), false);
    assert.equal(store.services.get("alice_market_data").manifest.registration.owner.user_key, ALICE_KEY);
  });
});

test("the account that claimed a provider_id may register multiple distinct services", async () => {
  await withOwnershipServer(async ({ store, baseUrl }) => {
    const prices = await register(
      baseUrl,
      serviceManifest("alice_prices", "multi_service_vendor", "prices"),
      ALICE_COOKIE
    );
    const news = await register(
      baseUrl,
      serviceManifest("alice_news", "multi_service_vendor", "news"),
      ALICE_COOKIE
    );

    assert.equal(prices.status, 201);
    assert.equal(news.status, 201);
    assert.equal(store.services.get("alice_prices").manifest.registration.owner.user_key, ALICE_KEY);
    assert.equal(store.services.get("alice_news").manifest.registration.owner.user_key, ALICE_KEY);
    assert.equal(store.providerClaims?.get("multi_service_vendor")?.owner_key, ALICE_KEY);
  });
});

test("hydrating a durable provider claim preserves ownership across restart", async () => {
  const restartedStore = createMemoryStore();
  await hydrateServiceEventRows(restartedStore, [{
    event_type: "provider_claim",
    service_id: "provider:restart_vendor",
    request_id: "restart_vendor",
    event: {
      event_version: "agent_router_provider_claim_v1",
      provider_id: "restart_vendor",
      owner_key: ALICE_KEY,
      claimed_at: "2026-08-31T00:00:00.000Z"
    }
  }]);

  assert.equal(restartedStore.providerClaims?.get("restart_vendor")?.owner_key, ALICE_KEY);

  await withOwnershipServer(async ({ baseUrl }) => {
    const conflicting = await register(
      baseUrl,
      serviceManifest("bob_after_restart", "restart_vendor"),
      BOB_COOKIE
    );
    const conflictPayload = await conflicting.json();
    assert.equal(conflicting.status, 409);
    assert.equal(conflictPayload.error.code, "PROVIDER_ID_ALREADY_CLAIMED");

    const sameOwner = await register(
      baseUrl,
      serviceManifest("alice_after_restart", "restart_vendor"),
      ALICE_COOKIE
    );
    assert.equal(sameOwner.status, 201);
  }, { store: restartedStore });
});

test("Vendor ERC-8004 registration authorizes the provider claimant, not any same-id service owner", async () => {
  const previousChain = process.env.ADN_SETTLEMENT_CHAIN;
  process.env.ADN_SETTLEMENT_CHAIN = "bsc";
  const verifierCalls = [];
  try {
    await withOwnershipServer(async ({ store, baseUrl }) => {
      const claimed = await register(
        baseUrl,
        serviceManifest("alice_identity_service", "identity_vendor"),
        ALICE_COOKIE
      );
      assert.equal(claimed.status, 201);

      // Simulate a legacy/corrupted record that predates provider-claim enforcement.
      // Authorization must not be widened merely because this record uses the same
      // provider_id and contains a different service-level owner.
      const rogueRecord = structuredClone(store.services.get("alice_identity_service"));
      rogueRecord.manifest.service_id = "legacy_bob_same_provider";
      rogueRecord.manifest.registration.owner = {
        user_key: BOB_KEY,
        provider: BOB.provider,
        user_id: BOB.id,
        handle: BOB.handle,
        created_at: new Date().toISOString()
      };
      store.services.set("legacy_bob_same_provider", rogueRecord);

      const forbidden = await fetch(`${baseUrl}/agent-router/erc8004/vendors/identity_vendor/registration`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: BOB_COOKIE },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER_ADDRESS })
      });
      const forbiddenPayload = await forbidden.json();
      assert.equal(forbidden.status, 403);
      assert.equal(forbiddenPayload.error.code, "VENDOR_IDENTITY_OWNER_REQUIRED");
      assert.equal(verifierCalls.length, 0, "an arbitrary same-id service owner must not reach chain verification");

      const allowed = await fetch(`${baseUrl}/agent-router/erc8004/vendors/identity_vendor/registration`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ALICE_COOKIE },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER_ADDRESS })
      });
      assert.equal(allowed.status, 200);
      assert.equal(verifierCalls.length, 1);
    }, {
      erc8004RegistrationVerifier: async ({ expected }) => {
        verifierCalls.push(expected);
        return verifiedIdentity(expected);
      }
    });
  } finally {
    if (previousChain === undefined) delete process.env.ADN_SETTLEMENT_CHAIN;
    else process.env.ADN_SETTLEMENT_CHAIN = previousChain;
  }
});
