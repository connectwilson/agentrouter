import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { hydratePersistentServiceEvents } from "../src/registry.js";
import { createConfigHash, createManifestHash, prepareProviderConfigForPersistence } from "../src/provider-config.js";
import { createMemoryStore } from "../src/store.js";

const ALICE = {
  provider: "github",
  id: "persistent-claim-alice",
  handle: "persistent-claim-alice",
  name: "Persistent Claim Alice",
  email: "owner-private-sentinel@example.test"
};

const BOB = {
  provider: "github",
  id: "persistent-claim-bob",
  handle: "persistent-claim-bob",
  name: "Persistent Claim Bob"
};

const ALICE_KEY = "github:persistent-claim-alice";
const ALICE_COOKIE = "ar_session=persistent-claim-alice-session";
const BOB_COOKIE = "ar_session=persistent-claim-bob-session";

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

function createSharedProviderClaimPersistence({ barrierCount = 0 } = {}) {
  const claims = new Map();
  const serviceClaims = new Map();
  const calls = [];
  const registrationCalls = [];
  let arrivals = 0;
  let releaseBarrier;
  let barrierTimer;
  const barrier = barrierCount
    ? new Promise((resolve) => { releaseBarrier = resolve; })
    : null;
  return {
    claims,
    serviceClaims,
    calls,
    registrationCalls,
    enabled: () => true,
    async claim({ providerId, ownerKey }) {
      calls.push({ providerId, ownerKey });
      // Force concurrent callers to yield before the atomic in-memory check/set.
      if (barrier) {
        arrivals += 1;
        if (arrivals === 1) barrierTimer = setTimeout(releaseBarrier, 25);
        if (arrivals >= barrierCount) {
          clearTimeout(barrierTimer);
          releaseBarrier();
        }
        await barrier;
      } else {
        await Promise.resolve();
      }
      const existing = claims.get(providerId);
      if (existing) {
        return {
          status: existing.owner_key === ownerKey ? "owned" : "conflict",
          ...existing
        };
      }
      const claim = {
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: new Date().toISOString()
      };
      claims.set(providerId, claim);
      return { status: "claimed", ...claim };
    },
    async claimRegistration({ serviceId, providerId, ownerKey }) {
      registrationCalls.push({ serviceId, providerId, ownerKey });
      await Promise.resolve();
      const providerClaim = claims.get(providerId);
      if (providerClaim && providerClaim.owner_key !== ownerKey) {
        return { status: "provider_conflict", provider_id: providerId };
      }
      const serviceClaim = serviceClaims.get(serviceId);
      if (serviceClaim) {
        const sameRegistration = serviceClaim.provider_id === providerId && serviceClaim.owner_key === ownerKey;
        return { status: sameRegistration ? "owned" : "service_conflict", ...serviceClaim };
      }
      const claimedAt = new Date().toISOString();
      const nextProviderClaim = providerClaim || {
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: claimedAt
      };
      const nextServiceClaim = {
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: claimedAt
      };
      claims.set(providerId, nextProviderClaim);
      serviceClaims.set(serviceId, nextServiceClaim);
      return {
        status: "claimed",
        ...nextServiceClaim,
        provider_claimed: !providerClaim
      };
    }
  };
}

async function startOwnershipServer({
  store = createMemoryStore(),
  providerClaimPersistence
} = {}) {
  const server = createServer({ store, providerClaimPersistence });
  const expiresAt = Date.now() + 60_000;
  store.authSessions.set("persistent-claim-alice-session", {
    user: ALICE,
    created_at: Date.now(),
    expires_at: expiresAt
  });
  store.authSessions.set("persistent-claim-bob-session", {
    user: BOB,
    created_at: Date.now(),
    expires_at: expiresAt
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
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

test("two instances atomically allow only one owner to claim the same provider_id", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instanceA = await startOwnershipServer({ providerClaimPersistence: persistence });
  const instanceB = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const [alice, bob] = await Promise.all([
      register(instanceA.baseUrl, serviceManifest("atomic_alice_service", "atomic_vendor", "alice"), ALICE_COOKIE),
      register(instanceB.baseUrl, serviceManifest("atomic_bob_service", "atomic_vendor", "bob"), BOB_COOKIE)
    ]);
    const responses = [alice, bob];
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const conflict = responses.find((response) => response.status === 409);
    assert.equal((await conflict.json()).error.code, "PROVIDER_ID_ALREADY_CLAIMED");
    assert.equal(instanceA.store.services.size + instanceB.store.services.size, 1);
    assert.equal(persistence.claims.size, 1);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("two instances atomically allow only one registration for the same service_id", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instanceA = await startOwnershipServer({ providerClaimPersistence: persistence });
  const instanceB = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const registrations = await Promise.all([
      register(instanceA.baseUrl, serviceManifest("global_service_id", "global_provider_alice", "alice"), ALICE_COOKIE),
      register(instanceB.baseUrl, serviceManifest("global_service_id", "global_provider_bob", "bob"), BOB_COOKIE)
    ]);
    assert.deepEqual(registrations.map((response) => response.status).sort(), [201, 409]);
    const conflict = registrations.find((response) => response.status === 409);
    assert.equal((await conflict.json()).error.code, "SERVICE_ALREADY_REGISTERED");
    assert.equal(persistence.serviceClaims.size, 1);
    assert.equal(persistence.claims.size, 1, "the losing service registration must roll back its provider claim");
    assert.equal(instanceA.store.services.size + instanceB.store.services.size, 1);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("a provider ownership conflict cannot leave behind a service_id claim", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instanceA = await startOwnershipServer({ providerClaimPersistence: persistence });
  const instanceB = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const registrations = await Promise.all([
      register(instanceA.baseUrl, serviceManifest("provider_winner_service", "single_owner_provider", "alice"), ALICE_COOKIE),
      register(instanceB.baseUrl, serviceManifest("provider_loser_service", "single_owner_provider", "bob"), BOB_COOKIE)
    ]);
    assert.deepEqual(registrations.map((response) => response.status).sort(), [201, 409]);
    assert.equal(persistence.claims.size, 1);
    assert.equal(persistence.serviceClaims.size, 1);
    const winningServiceId = registrations[0].status === 201 ? "provider_winner_service" : "provider_loser_service";
    const losingServiceId = registrations[0].status === 201 ? "provider_loser_service" : "provider_winner_service";
    assert.equal(persistence.serviceClaims.has(winningServiceId), true);
    assert.equal(persistence.serviceClaims.has(losingServiceId), false);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("a concurrent duplicate service_id cannot strand an unrelated provider claim", async () => {
  const persistence = createSharedProviderClaimPersistence({ barrierCount: 2 });
  const instance = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const [alice, bob] = await Promise.all([
      register(instance.baseUrl, serviceManifest("shared_service_id", "alice_namespace", "alice"), ALICE_COOKIE),
      register(instance.baseUrl, serviceManifest("shared_service_id", "bob_namespace", "bob"), BOB_COOKIE)
    ]);
    assert.deepEqual([alice.status, bob.status].sort(), [201, 409]);
    assert.equal(persistence.claims.size, 1);
    assert.equal(
      persistence.claims.has(instance.store.services.get("shared_service_id").manifest.provider.provider_id),
      true
    );
  } finally {
    await instance.close();
  }
});

test("the same durable owner may register multiple services from different instances", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instanceA = await startOwnershipServer({ providerClaimPersistence: persistence });
  const instanceB = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const [prices, news] = await Promise.all([
      register(instanceA.baseUrl, serviceManifest("durable_owner_prices", "same_owner_vendor", "prices"), ALICE_COOKIE),
      register(instanceB.baseUrl, serviceManifest("durable_owner_news", "same_owner_vendor", "news"), ALICE_COOKIE)
    ]);
    assert.equal(prices.status, 201);
    assert.equal(news.status, 201);
    assert.equal(persistence.claims.get("same_owner_vendor")?.owner_key, ALICE_KEY);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("a durable provider claim survives an application restart", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const first = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const claimed = await register(
      first.baseUrl,
      serviceManifest("before_restart", "restart_persistent_vendor", "before"),
      ALICE_COOKIE
    );
    assert.equal(claimed.status, 201);
  } finally {
    await first.close();
  }

  const restarted = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const conflicting = await register(
      restarted.baseUrl,
      serviceManifest("bob_after_restart", "restart_persistent_vendor", "bob"),
      BOB_COOKIE
    );
    assert.equal(conflicting.status, 409);
    assert.equal((await conflicting.json()).error.code, "PROVIDER_ID_ALREADY_CLAIMED");
    assert.equal(restarted.store.services.has("bob_after_restart"), false);

    const sameOwner = await register(
      restarted.baseUrl,
      serviceManifest("alice_after_restart", "restart_persistent_vendor", "alice"),
      ALICE_COOKIE
    );
    assert.equal(sameOwner.status, 201);
  } finally {
    await restarted.close();
  }
});

test("legacy services without claim events are backfilled into the authoritative claim store", async () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("legacy_service", "legacy_vendor");
  manifest.registration = {
    owner: {
      user_key: ALICE_KEY,
      email: ALICE.email
    }
  };
  store.services.set("legacy_service", {
    manifest,
    feedback_events: [],
    quality_events: [],
    validation_runs: [],
    health_checks: []
  });
  const claimed = [];
  const finalized = [];
  const rewrittenLocalConfigs = [];
  const legacyConfig = {
    provider_config_version: "adn_provider_config_v1",
    version: "1.0.0",
    source: { type: "static_json", data: { ok: true } },
    manifest: structuredClone(manifest)
  };

  const result = await hydratePersistentServiceEvents(store, {
    enabled: () => true,
    listRegistrations: async () => [],
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    readConfig: async () => structuredClone(legacyConfig),
    prepareConfig: prepareProviderConfigForPersistence,
    writePreparedConfig: async (config) => { rewrittenLocalConfigs.push(structuredClone(config)); },
    claimRegistration: async ({ serviceId, providerId, ownerKey }) => {
      claimed.push({ serviceId, providerId, ownerKey });
      return {
        status: "claimed",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claim_state: "pending",
        claim_token: "legacy-registration-token",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        claimed_at: new Date().toISOString()
      };
    },
    finalizeRegistration: async (registration) => {
      finalized.push(registration);
      return {
        status: "published",
        service_id: registration.serviceId,
        provider_id: registration.providerId,
        owner_key: registration.ownerKey,
        claim_state: "active",
        claimed_at: new Date().toISOString()
      };
    }
  });

  assert.deepEqual(claimed, [{ serviceId: "legacy_service", providerId: "legacy_vendor", ownerKey: ALICE_KEY }]);
  assert.equal(finalized.length, 1);
  assert.deepEqual(
    {
      serviceId: finalized[0].serviceId,
      providerId: finalized[0].providerId,
      ownerKey: finalized[0].ownerKey,
      claimToken: finalized[0].claimToken
    },
    {
      serviceId: "legacy_service",
      providerId: "legacy_vendor",
      ownerKey: ALICE_KEY,
      claimToken: "legacy-registration-token"
    }
  );
  assert.equal(finalized[0].manifest.registration.owner.user_key, ALICE_KEY);
  assert.equal(finalized[0].manifest.registration.owner.email, undefined);
  assert.equal(finalized[0].config.manifest.registration.owner.email, undefined);
  assert.equal(finalized[0].config.manifest.integrity.manifest_hash, createManifestHash(finalized[0].config.manifest));
  assert.equal(finalized[0].config.manifest.integrity.config_hash, createConfigHash(finalized[0].config));
  assert.equal(rewrittenLocalConfigs.length, 1);
  assert.equal(store.providerClaims.get("legacy_vendor")?.owner_key, ALICE_KEY);
  assert.equal(store.providerClaims.get("legacy_vendor")?.claim_state, "active");
  assert.equal(store.serviceClaims.get("legacy_service")?.claim_state, "active");
  assert.equal(result.provider_claims, 1);
  assert.equal(JSON.stringify(claimed).includes(ALICE.email), false);
  assert.equal(JSON.stringify(finalized).includes(ALICE.email), false);

  const restarted = createMemoryStore();
  let restartFinalizations = 0;
  await hydratePersistentServiceEvents(restarted, {
    enabled: () => true,
    listRegistrations: async () => [structuredClone(finalized[0].manifest)],
    listClaims: async () => [{
      status: "owned",
      provider_id: "legacy_vendor",
      owner_key: ALICE_KEY,
      claim_state: "active"
    }],
    listServiceClaims: async () => [{
      status: "owned",
      service_id: "legacy_service",
      provider_id: "legacy_vendor",
      owner_key: ALICE_KEY,
      claim_state: "active"
    }],
    listEvents: async () => [],
    claimRegistration: async () => ({
      status: "owned",
      service_id: "legacy_service",
      provider_id: "legacy_vendor",
      owner_key: ALICE_KEY,
      claim_state: "active"
    }),
    finalizeRegistration: async () => { restartFinalizations += 1; }
  });
  assert.equal(restarted.services.has("legacy_service"), true);
  assert.equal(restarted.serviceClaims.get("legacy_service")?.claim_state, "active");
  assert.equal(restartFinalizations, 0, "an active durable registration must hydrate idempotently");
});

test("concurrent legacy backfills share one pending owner without stealing its token", async () => {
  const serviceId = "concurrent_legacy_service";
  const providerId = "concurrent_legacy_vendor";
  const ownerKey = ALICE_KEY;
  let claimState = null;
  let tokenSequence = 0;
  let finalizeCalls = 0;
  let rewriteCalls = 0;
  let releaseActivation;
  const activated = new Promise((resolve) => { releaseActivation = resolve; });
  const persistence = {
    async claimRegistration() {
      if (!claimState) {
        const claimToken = `token-${++tokenSequence}`;
        claimState = { claim_state: "pending", claim_token: claimToken };
        return {
          status: "claimed",
          service_id: serviceId,
          provider_id: providerId,
          owner_key: ownerKey,
          ...claimState
        };
      }
      return {
        status: claimState.claim_state === "active" ? "owned" : "pending",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claim_state: claimState.claim_state
      };
    },
    async finalizeRegistration({ claimToken }) {
      finalizeCalls += 1;
      assert.equal(claimToken, "token-1");
      await new Promise((resolve) => setImmediate(resolve));
      claimState = { claim_state: "active" };
      releaseActivation();
      return {
        status: "published",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claim_state: "active"
      };
    },
    async waitForRegistration() {
      await activated;
      return {
        status: "owned",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claim_state: "active"
      };
    }
  };

  function legacyStore() {
    const store = createMemoryStore();
    const legacyManifest = serviceManifest(serviceId, providerId);
    legacyManifest.registration = { owner: { user_key: ownerKey } };
    store.services.set(serviceId, {
      manifest: legacyManifest,
      feedback_events: [],
      quality_events: [],
      validation_runs: [],
      health_checks: []
    });
    return store;
  }
  const options = {
    enabled: () => true,
    listRegistrations: async () => [],
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    readConfig: async () => null,
    claimRegistration: persistence.claimRegistration,
    finalizeRegistration: persistence.finalizeRegistration,
    waitForRegistration: persistence.waitForRegistration,
    rewriteRegistration: async ({ serviceId, providerId, ownerKey }) => {
      rewriteCalls += 1;
      return {
        status: "owned",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claim_state: "active"
      };
    }
  };

  const stores = [legacyStore(), legacyStore()];
  const results = await Promise.all(stores.map((store) => hydratePersistentServiceEvents(store, options)));

  assert.equal(results.length, 2);
  assert.equal(tokenSequence, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(rewriteCalls, 1);
  assert.ok(stores.every((store) => store.serviceClaims.get(serviceId)?.claim_state === "active"));
});

test("a hash-valid local config is persisted when its legacy claim is first activated", async () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("modern_local_service", "modern_local_vendor");
  manifest.registration = { owner: { user_key: ALICE_KEY } };
  const modernConfig = await prepareProviderConfigForPersistence({
    provider_config_version: "adn_provider_config_v1",
    version: "1.0.0",
    source: { type: "static_json", data: { ok: true } },
    manifest
  });
  store.services.set(manifest.service_id, {
    manifest: structuredClone(modernConfig.manifest),
    feedback_events: [],
    quality_events: [],
    validation_runs: [],
    health_checks: []
  });
  const finalized = [];

  await hydratePersistentServiceEvents(store, {
    enabled: () => true,
    listRegistrations: async () => [],
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    readConfig: async () => structuredClone(modernConfig),
    writePreparedConfig: async () => {},
    claimRegistration: async () => ({
      status: "claimed",
      service_id: manifest.service_id,
      provider_id: manifest.provider.provider_id,
      owner_key: ALICE_KEY,
      claim_state: "pending",
      claim_token: "modern-local-token"
    }),
    finalizeRegistration: async (registration) => {
      finalized.push(structuredClone(registration));
      return {
        status: "published",
        service_id: registration.serviceId,
        provider_id: registration.providerId,
        owner_key: registration.ownerKey,
        claim_state: "active"
      };
    }
  });

  assert.equal(finalized.length, 1);
  assert.ok(finalized[0].config, "first activation must durably copy the safe local provider config");
  assert.deepEqual(finalized[0].config.manifest.registration.owner, { user_key: ALICE_KEY });
  assert.equal(finalized[0].config.manifest.integrity.config_hash, createConfigHash(finalized[0].config));
});

test("an already-active legacy claim atomically rewrites PII-bearing config and manifest hashes", async () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("active_legacy_service", "active_legacy_vendor");
  manifest.registration = {
    owner: {
      user_key: ALICE_KEY,
      email: ALICE.email,
      name: ALICE.name,
      handle: ALICE.handle
    }
  };
  store.services.set(manifest.service_id, {
    manifest,
    feedback_events: [],
    quality_events: [],
    validation_runs: [],
    health_checks: []
  });
  const legacyConfig = {
    provider_config_version: "adn_provider_config_v1",
    version: "1.0.0",
    source: { type: "static_json", data: { ok: true } },
    manifest: structuredClone(manifest)
  };
  const rewrites = [];
  const localWrites = [];

  await hydratePersistentServiceEvents(store, {
    enabled: () => true,
    listRegistrations: async () => [],
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    readConfig: async () => structuredClone(legacyConfig),
    prepareConfig: prepareProviderConfigForPersistence,
    writePreparedConfig: async (config) => { localWrites.push(structuredClone(config)); },
    claimRegistration: async () => ({
      status: "owned",
      service_id: manifest.service_id,
      provider_id: manifest.provider.provider_id,
      owner_key: ALICE_KEY,
      claim_state: "active"
    }),
    finalizeRegistration: async () => { throw new Error("active claims must not finalize again"); },
    rewriteRegistration: async (registration) => {
      rewrites.push(structuredClone(registration));
      return {
        status: "owned",
        service_id: registration.serviceId,
        provider_id: registration.providerId,
        owner_key: registration.ownerKey,
        claim_state: "active"
      };
    }
  });

  assert.equal(rewrites.length, 1);
  assert.equal(localWrites.length, 1);
  assert.deepEqual(rewrites[0].config.manifest.registration.owner, { user_key: ALICE_KEY });
  assert.deepEqual(rewrites[0].manifest.registration.owner, { user_key: ALICE_KEY });
  assert.equal(rewrites[0].manifest.integrity.manifest_hash, createManifestHash(rewrites[0].manifest));
  assert.equal(rewrites[0].manifest.integrity.config_hash, createConfigHash(rewrites[0].config));
  assert.deepEqual(store.services.get(manifest.service_id).manifest.registration.owner, { user_key: ALICE_KEY });
  assert.deepEqual(store.providerClaims.get(manifest.provider.provider_id).owner, { user_key: ALICE_KEY });
  assert.equal(JSON.stringify(rewrites).includes(ALICE.email), false);
  assert.equal(JSON.stringify(localWrites).includes(ALICE.email), false);
});

test("an active manifest-only legacy claim rewrites durable PII and hashes when no local config exists", async () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("active_manifest_only_service", "active_manifest_only_vendor");
  manifest.registration = {
    owner: {
      user_key: ALICE_KEY,
      email: ALICE.email,
      name: ALICE.name,
      handle: ALICE.handle
    },
    manifest_hash: "legacy-manifest-hash",
    config_hash: "legacy-config-hash"
  };
  manifest.integrity = {
    manifest_hash: "legacy-manifest-hash",
    config_hash: "legacy-config-hash"
  };
  manifest.erc8257 = { metadata_hash: "legacy-manifest-hash" };
  store.services.set(manifest.service_id, {
    manifest,
    feedback_events: [],
    quality_events: [],
    validation_runs: [],
    health_checks: []
  });
  const rewrites = [];

  await hydratePersistentServiceEvents(store, {
    enabled: () => true,
    listRegistrations: async () => [],
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    readConfig: async () => {
      const error = new Error("missing local config");
      error.code = "ENOENT";
      throw error;
    },
    claimRegistration: async () => ({
      status: "owned",
      service_id: manifest.service_id,
      provider_id: manifest.provider.provider_id,
      owner_key: ALICE_KEY,
      claim_state: "active"
    }),
    finalizeRegistration: async () => { throw new Error("active claims must not finalize again"); },
    rewriteRegistration: async (registration) => {
      rewrites.push(structuredClone(registration));
      return {
        status: "owned",
        service_id: registration.serviceId,
        provider_id: registration.providerId,
        owner_key: registration.ownerKey,
        claim_state: "active"
      };
    }
  });

  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].config, null);
  assert.deepEqual(rewrites[0].manifest.registration.owner, { user_key: ALICE_KEY });
  assert.equal(rewrites[0].manifest.integrity.manifest_hash, createManifestHash(rewrites[0].manifest));
  assert.equal(rewrites[0].manifest.registration.manifest_hash, rewrites[0].manifest.integrity.manifest_hash);
  assert.equal(rewrites[0].manifest.erc8257.metadata_hash, rewrites[0].manifest.integrity.manifest_hash);
  assert.deepEqual(store.services.get(manifest.service_id).manifest.registration.owner, { user_key: ALICE_KEY });
  assert.equal(JSON.stringify(rewrites).includes(ALICE.email), false);
});

test("hosted registration fails closed before service mutation when claim persistence is unavailable", async () => {
  const previousRender = process.env.RENDER;
  process.env.RENDER = "true";
  const persistence = {
    enabled: () => true,
    async claimRegistration() {
      throw new Error("provider claim database unavailable");
    }
  };
  const instance = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const response = await register(
      instance.baseUrl,
      serviceManifest("must_not_register", "unavailable_vendor"),
      ALICE_COOKIE
    );
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "PROVIDER_CLAIM_PERSISTENCE_UNAVAILABLE");
    assert.equal(instance.store.services.has("must_not_register"), false);
    assert.equal(instance.store.providers.has("unavailable_vendor"), false);
  } finally {
    await instance.close();
    if (previousRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = previousRender;
  }
});

test("hosted registration fails closed when no durable provider registry is configured", async () => {
  const previousRender = process.env.RENDER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.RENDER = "true";
  delete process.env.DATABASE_URL;
  const instance = await startOwnershipServer();
  try {
    const response = await register(
      instance.baseUrl,
      serviceManifest("no_database_service", "no_database_vendor"),
      ALICE_COOKIE
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "PERSISTENT_REGISTRY_REQUIRED");
    assert.equal(instance.store.services.has("no_database_service"), false);
  } finally {
    await instance.close();
    if (previousRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = previousRender;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("manifest validation finishes before a durable provider_id is claimed", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instance = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const invalid = serviceManifest("INVALID SERVICE ID", "must_not_be_squatted");
    const response = await register(instance.baseUrl, invalid, ALICE_COOKIE);
    assert.equal(response.status, 422);
    assert.equal(persistence.calls.length, 0);
    assert.equal(persistence.claims.has("must_not_be_squatted"), false);
  } finally {
    await instance.close();
  }
});

test("the durable claim boundary receives only provider_id and opaque owner_key", async () => {
  const persistence = createSharedProviderClaimPersistence();
  const instance = await startOwnershipServer({ providerClaimPersistence: persistence });
  try {
    const response = await register(
      instance.baseUrl,
      serviceManifest("minimal_claim_payload", "minimal_claim_vendor"),
      ALICE_COOKIE
    );
    assert.equal(response.status, 201);
    assert.equal(persistence.registrationCalls.length, 1);
    assert.deepEqual(persistence.registrationCalls[0], {
      serviceId: "minimal_claim_payload",
      providerId: "minimal_claim_vendor",
      ownerKey: ALICE_KEY
    });
    assert.equal(JSON.stringify(persistence.registrationCalls).includes(ALICE.email), false);
  } finally {
    await instance.close();
  }
});
