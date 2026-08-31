import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { hydratePersistentServiceEvents } from "../src/registry.js";
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

  const result = await hydratePersistentServiceEvents(store, {
    enabled: () => true,
    listClaims: async () => [],
    listServiceClaims: async () => [],
    listEvents: async () => [],
    claimRegistration: async ({ serviceId, providerId, ownerKey }) => {
      claimed.push({ serviceId, providerId, ownerKey });
      return {
        status: "claimed",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: new Date().toISOString()
      };
    }
  });

  assert.deepEqual(claimed, [{ serviceId: "legacy_service", providerId: "legacy_vendor", ownerKey: ALICE_KEY }]);
  assert.equal(store.providerClaims.get("legacy_vendor")?.owner_key, ALICE_KEY);
  assert.equal(result.provider_claims, 1);
  assert.equal(JSON.stringify(claimed).includes(ALICE.email), false);
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
