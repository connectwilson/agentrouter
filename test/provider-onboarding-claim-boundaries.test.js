import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-provider-onboarding-claims-"));
const providerDir = path.join(runtimeRoot, "providers");
const previousEnv = new Map([
  ["ADN_DIR", process.env.ADN_DIR],
  ["ADN_PROVIDER_DIR", process.env.ADN_PROVIDER_DIR],
  ["ADN_ADMIN_API_TOKEN", process.env.ADN_ADMIN_API_TOKEN],
  ["ADN_REQUIRE_PERSISTENT_REGISTRY", process.env.ADN_REQUIRE_PERSISTENT_REGISTRY],
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["RENDER", process.env.RENDER]
]);

process.env.ADN_DIR = path.join(runtimeRoot, ".agentrouter");
process.env.ADN_PROVIDER_DIR = providerDir;
process.env.ADN_ADMIN_API_TOKEN = "provider-onboarding-claims-admin-token";
delete process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
delete process.env.DATABASE_URL;
delete process.env.RENDER;

const { createServer } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");

const ALICE = {
  provider: "github",
  id: "onboarding-claim-alice",
  handle: "onboarding-claim-alice",
  name: "Onboarding Claim Alice",
  email: "alice-onboarding-claim@example.test"
};
const BOB = {
  provider: "github",
  id: "onboarding-claim-bob",
  handle: "onboarding-claim-bob",
  name: "Onboarding Claim Bob",
  email: "bob-onboarding-claim@example.test"
};
const ALICE_COOKIE = "ar_session=onboarding-claim-alice-session";
const BOB_COOKIE = "ar_session=onboarding-claim-bob-session";

test.after(async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function createSharedRegistrationPersistence() {
  const providerClaims = new Map();
  const serviceClaims = new Map();
  const registrationCalls = [];

  return {
    providerClaims,
    serviceClaims,
    registrationCalls,
    enabled: () => true,
    required: () => true,
    async claimRegistration({ serviceId, providerId, ownerKey }) {
      registrationCalls.push({ serviceId, providerId, ownerKey });
      // Yield once so Promise.all callers can enter through different HTTP
      // servers before this shared persistence performs its atomic decision.
      await Promise.resolve();

      const providerClaim = providerClaims.get(providerId);
      if (providerClaim && providerClaim.owner_key !== ownerKey) {
        return {
          status: "provider_conflict",
          service_id: serviceId,
          provider_id: providerId
        };
      }

      const serviceClaim = serviceClaims.get(serviceId);
      if (serviceClaim) {
        const sameRegistration = serviceClaim.provider_id === providerId
          && serviceClaim.owner_key === ownerKey;
        return {
          status: sameRegistration ? "owned" : "service_conflict",
          ...serviceClaim
        };
      }

      const claimedAt = new Date().toISOString();
      const durableProviderClaim = providerClaim || {
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: claimedAt
      };
      const durableServiceClaim = {
        service_id: serviceId,
        provider_id: providerId,
        owner_key: ownerKey,
        claimed_at: claimedAt
      };
      providerClaims.set(providerId, durableProviderClaim);
      serviceClaims.set(serviceId, durableServiceClaim);
      return {
        status: serviceClaim ? "owned" : "claimed",
        ...durableServiceClaim,
        provider_claimed: !providerClaim
      };
    }
  };
}

async function startServer({
  providerClaimPersistence,
  publicApiPipelineOptions,
  store = createMemoryStore()
} = {}) {
  store.authSessions.set("onboarding-claim-alice-session", {
    user: ALICE,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  store.authSessions.set("onboarding-claim-bob-session", {
    user: BOB,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  const server = createServer({ store, providerClaimPersistence, publicApiPipelineOptions });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function staticProviderBody({ serviceId, providerId, owner }) {
  return {
    mode: "static-json",
    service_id: serviceId,
    provider_id: providerId,
    provider_name: "Shared Atomic Vendor",
    title: `${owner} Static Claim Service`,
    description_for_agent: "Use this deterministic static service to test Provider Studio ownership claims.",
    capabilities: "data_service,provider_claim_boundary",
    price: "0.01",
    sample_request: "{}",
    sample_data: JSON.stringify({ records: [{ owner, value: 1 }] }),
    live_data: JSON.stringify({ records: [{ owner, value: 2 }] }),
    summary: "Deterministic static Provider Studio ownership fixture."
  };
}

function importedDraft({ baseUrl, serviceId, providerId, owner }) {
  return {
    selected: true,
    service_id: serviceId,
    provider_id: providerId,
    provider_name: "Shared Imported Vendor",
    title: `${owner} Imported Claim Service`,
    description_for_agent: "Use this local mock endpoint to test imported provider ownership claims.",
    capabilities: ["data_service", "funding_rate", "provider_claim_boundary"],
    price: "0.01",
    method: "GET",
    upstream_url: `${baseUrl}/mock/api/v1/funding-rate`,
    sample_request: { asset: "BTC" },
    preview_data: {
      asset: "BTC",
      funding_rate: 0.00018,
      venue: "Binance",
      source: "mock_openapi"
    },
    summary: "Deterministic imported ownership fixture."
  };
}

async function postJson(baseUrl, pathname, body, cookie) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    payload: await response.json()
  };
}

function conflictCode(outcome) {
  return outcome.payload?.error?.code || outcome.payload?.failed?.[0]?.error || null;
}

function assertOneDurableWinner({ outcomes, instances, persistence, serviceIds, providerId }) {
  const winners = outcomes.filter((outcome) => outcome.status === 201);
  const losers = outcomes.filter((outcome) => outcome.status !== 201);
  assert.equal(winners.length, 1, `expected one 201 response, received ${outcomes.map((item) => item.status)}`);
  assert.equal(losers.length, 1, `expected one rejected response, received ${outcomes.map((item) => item.status)}`);
  assert.equal(conflictCode(losers[0]), "PROVIDER_ID_ALREADY_CLAIMED");
  assert.equal(persistence.providerClaims.get(providerId)?.owner_key.length > 0, true);
  assert.equal(persistence.providerClaims.size, 1);
  assert.equal(persistence.serviceClaims.size, 1);

  const winnerIndex = outcomes.findIndex((outcome) => outcome.status === 201);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  const winningServiceId = serviceIds[winnerIndex];
  const losingServiceId = serviceIds[loserIndex];
  assert.equal(persistence.serviceClaims.has(winningServiceId), true);
  assert.equal(persistence.serviceClaims.has(losingServiceId), false);
  assert.equal(instances[0].store.services.has(losingServiceId), false);
  assert.equal(instances[1].store.services.has(losingServiceId), false);
  return { winningServiceId, losingServiceId };
}

async function assertConfigAbsent(serviceId) {
  await assert.rejects(
    fs.access(path.join(providerDir, `${serviceId}.json`)),
    (error) => error?.code === "ENOENT"
  );
}

test("POST /studio/providers uses one atomic provider claim across two server instances", async () => {
  const persistence = createSharedRegistrationPersistence();
  const instanceA = await startServer({ providerClaimPersistence: persistence });
  const instanceB = await startServer({ providerClaimPersistence: persistence });
  const providerId = "studio_atomic_shared_vendor";
  const serviceIds = ["studio_atomic_alice", "studio_atomic_bob"];

  try {
    const outcomes = await Promise.all([
      postJson(
        instanceA.baseUrl,
        "/studio/providers",
        staticProviderBody({ serviceId: serviceIds[0], providerId, owner: "Alice" }),
        ALICE_COOKIE
      ),
      postJson(
        instanceB.baseUrl,
        "/studio/providers",
        staticProviderBody({ serviceId: serviceIds[1], providerId, owner: "Bob" }),
        BOB_COOKIE
      )
    ]);

    const { losingServiceId } = assertOneDurableWinner({
      outcomes,
      instances: [instanceA, instanceB],
      persistence,
      serviceIds,
      providerId
    });
    assert.equal(persistence.registrationCalls.length, 2);
    await assertConfigAbsent(losingServiceId);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("POST /studio/import/publish uses one atomic provider claim across two server instances", async () => {
  const persistence = createSharedRegistrationPersistence();
  const instanceA = await startServer({ providerClaimPersistence: persistence });
  const instanceB = await startServer({ providerClaimPersistence: persistence });
  const providerId = "import_atomic_shared_vendor";
  const serviceIds = ["import_atomic_alice", "import_atomic_bob"];

  try {
    const outcomes = await Promise.all([
      postJson(instanceA.baseUrl, "/studio/import/publish", {
        publish_scope: "local_only",
        drafts: [importedDraft({
          baseUrl: instanceA.baseUrl,
          serviceId: serviceIds[0],
          providerId,
          owner: "Alice"
        })]
      }, ALICE_COOKIE),
      postJson(instanceB.baseUrl, "/studio/import/publish", {
        publish_scope: "local_only",
        drafts: [importedDraft({
          baseUrl: instanceB.baseUrl,
          serviceId: serviceIds[1],
          providerId,
          owner: "Bob"
        })]
      }, BOB_COOKIE)
    ]);

    const { losingServiceId } = assertOneDurableWinner({
      outcomes,
      instances: [instanceA, instanceB],
      persistence,
      serviceIds,
      providerId
    });
    assert.equal(persistence.registrationCalls.length, 2);
    await assertConfigAbsent(losingServiceId);
  } finally {
    await Promise.all([instanceA.close(), instanceB.close()]);
  }
});

test("admin public API promotion fails closed through the shared registration persistence", async () => {
  const registrationCalls = [];
  const unavailablePersistence = {
    enabled: () => true,
    required: () => true,
    async claimRegistration(claim) {
      registrationCalls.push(claim);
      throw new Error("registration database unavailable");
    }
  };
  const store = createMemoryStore();
  const candidate = {
    candidate_id: "admin_atomic_promotion_candidate",
    title: "Admin Atomic Promotion Candidate",
    description: "A deterministic public pipeline promotion fixture.",
    category: "Development",
    documentation_url: "https://docs.example.test/public-api",
    source_catalog: "test:provider-onboarding-claim-boundaries",
    auth: "No",
    https: true,
    cors: true,
    catalog_presence: "active",
    status: "queued",
    attempt_count: 0
  };
  store.publicApiCatalog.set(candidate.candidate_id, candidate);
  const instance = await startServer({
    store,
    providerClaimPersistence: unavailablePersistence,
    publicApiPipelineOptions: {
      claimCandidateLease: async () => null,
      persistCandidates: async () => {},
      persistRun: async () => {},
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      discoverApiServices: async () => ({
        ok: true,
        mode: "direct_endpoint",
        drafts: [{
          service_id: "admin_atomic_promotion_draft",
          title: "Admin Atomic Promotion Draft",
          method: "GET",
          upstream_url: "https://api.example.test/public-data",
          capabilities: ["data_service"],
          sample_request: {}
        }]
      }),
      probeDraft: async () => ({ ok: true, status: 200, result_shape: "object" })
    }
  });

  try {
    const response = await fetch(`${instance.baseUrl}/studio/public-api-pipeline/run`, {
      method: "POST",
      headers: {
        authorization: "Bearer provider-onboarding-claims-admin-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ candidate_ids: [candidate.candidate_id], limit: 1, concurrency: 1 })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.processed, 1);
    assert.equal(registrationCalls.length, 1, "promotion must use the server's atomic registration persistence");
    assert.equal(registrationCalls[0].providerId, "public_apis_catalog");
    assert.equal(registrationCalls[0].ownerKey, "platform:public_api_pipeline");
    assert.equal(store.services.size, 0, "a persistence outage must not leave a callable service");
    assert.equal(store.providers.has("public_apis_catalog"), false);

    const promotion = store.publicApiCatalog.get(candidate.candidate_id)?.promotion;
    assert.equal(promotion?.ok, false);
    assert.equal(promotion?.service_ids?.length, 0);
    assert.equal(promotion?.failed?.[0]?.error, "PROVIDER_CLAIM_PERSISTENCE_UNAVAILABLE");
    await assertConfigAbsent(promotion.failed[0].service_id);
  } finally {
    await instance.close();
  }
});
