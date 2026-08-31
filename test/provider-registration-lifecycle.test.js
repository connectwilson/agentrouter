import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-registration-lifecycle-"));
const providerDir = path.join(runtimeRoot, "providers");
const previousEnv = new Map([
  ["ADN_DIR", process.env.ADN_DIR],
  ["ADN_PROVIDER_DIR", process.env.ADN_PROVIDER_DIR],
  ["ADN_PROVIDER_SECRET_PASSPHRASE", process.env.ADN_PROVIDER_SECRET_PASSPHRASE],
  ["ADN_REQUIRE_PERSISTENT_REGISTRY", process.env.ADN_REQUIRE_PERSISTENT_REGISTRY],
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["RENDER", process.env.RENDER]
]);

process.env.ADN_DIR = path.join(runtimeRoot, ".agentrouter");
process.env.ADN_PROVIDER_DIR = providerDir;
process.env.ADN_PROVIDER_SECRET_PASSPHRASE = "registration-lifecycle-test-passphrase";
delete process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
delete process.env.DATABASE_URL;
delete process.env.RENDER;

const { createServer } = await import("../src/server.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const {
  loadProviderConfigs,
  searchServices
} = await import("../src/registry.js");
const {
  createStaticProviderConfig,
  deleteProviderConfig,
  writeProviderConfig
} = await import("../src/provider-config.js");
const { promoteValidatedPublicApiDrafts } = await import("../src/public-api-pipeline.js");
const { createMemoryStore } = await import("../src/store.js");

const ALICE = {
  provider: "github",
  id: "lease-owner-alice-id",
  handle: "private-alice-handle-sentinel",
  name: "Private Alice Name Sentinel",
  email: "private-alice-email-sentinel@example.test"
};
const BOB = {
  provider: "github",
  id: "lease-owner-bob-id",
  handle: "private-bob-handle-sentinel",
  name: "Private Bob Name Sentinel",
  email: "private-bob-email-sentinel@example.test"
};
const ALICE_KEY = `${ALICE.provider}:${ALICE.id}`;
const BOB_KEY = `${BOB.provider}:${BOB.id}`;
const ALICE_COOKIE = "ar_session=registration-lifecycle-alice-session";
const BOB_COOKIE = "ar_session=registration-lifecycle-bob-session";

test.after(async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * In-memory model of the desired Postgres boundary. It intentionally keeps
 * pending reservations separate from published ownership, stores only a token
 * hash, and makes takeover decisions atomically inside claimRegistration.
 */
function createLeaseRegistrationPersistence({ now = 1_900_000_000_000, failFinalize = false } = {}) {
  let clock = now;
  let tokenSequence = 0;
  const serviceClaims = new Map();
  const claimCalls = [];
  const finalizeCalls = [];
  const releaseCalls = [];
  const issuedTokens = [];
  const beginSnapshots = [];
  const events = [];

  function tokenHash(token) {
    return createHash("sha256").update(String(token)).digest("hex");
  }

  function isLive(row) {
    return row.claim_state === "active"
      || (row.claim_state === "pending" && Number(row.lease_expires_at_ms) > clock);
  }

  function publicRow(row, status, claimToken) {
    return {
      status,
      claim_state: row.claim_state,
      service_id: row.service_id,
      provider_id: row.provider_id,
      owner_key: row.owner_key,
      claimed_at: row.claimed_at,
      lease_expires_at: row.lease_expires_at,
      ...(claimToken ? { claim_token: claimToken } : {})
    };
  }

  function providerOwner(providerId, { liveOnly = true } = {}) {
    const rows = [...serviceClaims.values()].filter((row) => row.provider_id === providerId && (!liveOnly || isLive(row)));
    const owners = [...new Set(rows.map((row) => row.owner_key))];
    return owners.length === 1 ? owners[0] : null;
  }

  async function claimRegistration({ serviceId, providerId, ownerKey, leaseMs } = {}) {
    claimCalls.push({ serviceId, providerId, ownerKey, leaseMs });
    events.push({ type: "claim", service_id: serviceId, provider_id: providerId, owner_key: ownerKey });
    await Promise.resolve();

    const existing = serviceClaims.get(serviceId);
    if (existing?.claim_state === "active") {
      const same = existing.provider_id === providerId && existing.owner_key === ownerKey;
      return publicRow(existing, same ? "owned" : "service_conflict");
    }
    if (existing?.claim_state === "pending" && Number(existing.lease_expires_at_ms) > clock) {
      const same = existing.provider_id === providerId && existing.owner_key === ownerKey;
      return publicRow(existing, same ? "pending" : "service_conflict");
    }

    // An expired pending row has no ownership force. Remove it inside the same
    // atomic decision before evaluating the requested service/provider pair.
    if (existing?.claim_state === "pending") serviceClaims.delete(serviceId);

    const liveProviderOwner = providerOwner(providerId);
    if (liveProviderOwner && liveProviderOwner !== ownerKey) {
      return {
        status: "provider_conflict",
        claim_state: "active",
        service_id: serviceId,
        provider_id: providerId,
        owner_key: liveProviderOwner
      };
    }

    const effectiveLeaseMs = Math.max(1, Number(leaseMs) || 60_000);
    const claimToken = `registration-claim-token-${++tokenSequence}`;
    const row = {
      service_id: serviceId,
      provider_id: providerId,
      owner_key: ownerKey,
      claim_state: "pending",
      claim_token_hash: tokenHash(claimToken),
      claimed_at: new Date(clock).toISOString(),
      lease_expires_at_ms: clock + effectiveLeaseMs,
      lease_expires_at: new Date(clock + effectiveLeaseMs).toISOString(),
      persisted_config: null,
      persisted_manifest: null
    };
    serviceClaims.set(serviceId, row);
    issuedTokens.push(claimToken);
    beginSnapshots.push(structuredClone(row));
    return publicRow(row, "claimed", claimToken);
  }

  async function finalizeRegistration({
    serviceId,
    providerId,
    ownerKey,
    claimToken,
    config = null,
    manifest = null
  } = {}) {
    finalizeCalls.push({ serviceId, providerId, ownerKey, claimToken, config, manifest });
    events.push({ type: "finalize", service_id: serviceId, provider_id: providerId, owner_key: ownerKey });
    const row = serviceClaims.get(serviceId);
    assert.ok(row, "finalizeRegistration requires a pending durable claim");
    assert.equal(row.claim_state, "pending");
    assert.equal(row.provider_id, providerId);
    assert.equal(row.owner_key, ownerKey);
    assert.equal(row.claim_token_hash, tokenHash(claimToken));
    assert.ok(Number(row.lease_expires_at_ms) > clock, "an expired claim token cannot finalize");
    assert.ok(config || manifest, "finalization must persist a sanitized config or manifest");
    if (failFinalize) {
      const error = new Error("registration finalization database unavailable");
      error.code = "REGISTRATION_FINALIZE_UNAVAILABLE";
      throw error;
    }

    row.claim_state = "active";
    row.activated_at = new Date(clock).toISOString();
    row.lease_expires_at_ms = null;
    row.lease_expires_at = null;
    delete row.claim_token_hash;
    row.persisted_config = config ? structuredClone(config) : null;
    row.persisted_manifest = manifest ? structuredClone(manifest) : null;
    return publicRow(row, "owned");
  }

  async function releaseRegistration({ serviceId, providerId, ownerKey, claimToken } = {}) {
    releaseCalls.push({ serviceId, providerId, ownerKey, claimToken });
    events.push({ type: "release", service_id: serviceId, provider_id: providerId, owner_key: ownerKey });
    const row = serviceClaims.get(serviceId);
    if (!row || row.claim_state !== "pending") return { released: false };
    if (row.provider_id !== providerId || row.owner_key !== ownerKey) return { released: false };
    if (row.claim_token_hash !== tokenHash(claimToken)) return { released: false };
    serviceClaims.delete(serviceId);
    return { released: true };
  }

  return {
    enabled: () => true,
    required: () => true,
    claimRegistration,
    finalizeRegistration,
    releaseRegistration,
    serviceClaims,
    claimCalls,
    finalizeCalls,
    releaseCalls,
    issuedTokens,
    beginSnapshots,
    events,
    advance(ms) {
      clock += Number(ms);
    },
    now() {
      return clock;
    },
    providerOwner,
    row(serviceId) {
      const row = serviceClaims.get(serviceId);
      return row ? structuredClone(row) : null;
    },
    finalizedConfig(serviceId) {
      const row = serviceClaims.get(serviceId);
      if (!row || row.claim_state !== "active") return null;
      if (row.persisted_config) return structuredClone(row.persisted_config);
      if (!row.persisted_manifest) return null;
      return {
        provider_config_version: "manifest_only_runtime_config_v1",
        source: { type: "manifest_only" },
        manifest: structuredClone(row.persisted_manifest)
      };
    }
  };
}

async function startServer({ persistence, store = createMemoryStore() } = {}) {
  store.authSessions.set("registration-lifecycle-alice-session", {
    user: ALICE,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  store.authSessions.set("registration-lifecycle-bob-session", {
    user: BOB,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  const server = createServer({ store, providerClaimPersistence: persistence });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function serviceManifest(serviceId, providerId) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = serviceId;
  manifest.provider = { ...manifest.provider, provider_id: providerId };
  manifest.endpoint = {
    ...manifest.endpoint,
    url: `https://provider.example.test/${serviceId}`
  };
  delete manifest.registration;
  return manifest;
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
  return { status: response.status, payload: await response.json() };
}

function studioBody({ serviceId, providerId, upstreamUrl, secretValue = "" }) {
  return {
    mode: "hosted-http",
    service_id: serviceId,
    provider_id: providerId,
    provider_name: providerId,
    title: `${serviceId} lifecycle test`,
    description_for_agent: "Use this hosted service to verify registration lifecycle behavior.",
    capabilities: "data_service,registration_lifecycle",
    price: "0.01",
    sample_request: "{}",
    sample_data: JSON.stringify({ status: "success", rows: [{ metric: "sample", value: 1 }] }),
    summary: "Registration lifecycle fixture.",
    upstream_url: upstreamUrl,
    upstream_method: "GET",
    secret_name: "PROVIDER_SECRET",
    secret_value: secretValue,
    auth_header: secretValue ? "auto" : "authorization"
  };
}

function importedDraft({ serviceId, providerId, upstreamUrl }) {
  return {
    selected: true,
    service_id: serviceId,
    provider_id: providerId,
    provider_name: providerId,
    title: `${serviceId} imported lifecycle test`,
    description_for_agent: "Use this imported endpoint to verify registration release behavior.",
    capabilities: ["data_service", "registration_lifecycle"],
    price: "0.01",
    method: "GET",
    upstream_url: upstreamUrl,
    sample_request: {},
    preview_data: { status: "success", rows: [{ value: 1 }] },
    summary: "Imported registration lifecycle fixture."
  };
}

function assertNoPrivateOwnerFields(owner) {
  assert.equal(owner?.user_key, ALICE_KEY);
  for (const key of ["email", "name", "handle", "user_id"]) {
    assert.equal(Object.hasOwn(owner || {}, key), false, `${key} must not cross the persistence boundary`);
  }
}

test("hosted registration begins with a token-hashed pending lease and finalizes before 201", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  try {
    const outcome = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("lease_then_finalize_service", "lease_then_finalize_provider"),
      ALICE_COOKIE
    );

    assert.equal(outcome.status, 201);
    assert.equal(persistence.claimCalls.length, 1);
    assert.ok(Number(persistence.claimCalls[0].leaseMs) > 0, "the caller must bound the pending reservation lease");
    assert.equal(persistence.beginSnapshots[0].claim_state, "pending");
    assert.ok(persistence.beginSnapshots[0].lease_expires_at_ms > persistence.now());
    assert.match(persistence.beginSnapshots[0].claim_token_hash, /^[a-f0-9]{64}$/);
    assert.equal(
      JSON.stringify(persistence.beginSnapshots[0]).includes(persistence.issuedTokens[0]),
      false,
      "durable storage must never contain the raw claim token"
    );
    assert.deepEqual(persistence.events.map((event) => event.type), ["claim", "finalize"]);
    const active = persistence.row("lease_then_finalize_service");
    assert.equal(active.claim_state, "active");
    assert.equal(active.lease_expires_at, null);
    assert.equal(Object.hasOwn(active, "claim_token_hash"), false);
    assert.equal(active.persisted_manifest.registration.publish_state, "registered");
  } finally {
    await instance.close();
  }
});

test("an active pending lease blocks a different owner from both the service and provider namespaces", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const pending = await persistence.claimRegistration({
    serviceId: "crashed_pending_service",
    providerId: "crashed_pending_provider",
    ownerKey: ALICE_KEY,
    leaseMs: 30_000
  });
  assert.equal(pending.claim_state, "pending");
  const instance = await startServer({ persistence });
  try {
    const sameService = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("crashed_pending_service", "bob_other_provider"),
      BOB_COOKIE
    );
    const sameProvider = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("bob_other_service", "crashed_pending_provider"),
      BOB_COOKIE
    );

    assert.equal(sameService.status, 409);
    assert.equal(sameService.payload.error.code, "SERVICE_ALREADY_REGISTERED");
    assert.equal(sameProvider.status, 409);
    assert.equal(sameProvider.payload.error.code, "PROVIDER_ID_ALREADY_CLAIMED");
    assert.equal(persistence.row("crashed_pending_service").owner_key, ALICE_KEY);
    assert.equal(instance.store.services.size, 0);
  } finally {
    await instance.close();
  }
});

test("after pending expiry another owner atomically takes service and provider when no published sibling exists", async () => {
  const persistence = createLeaseRegistrationPersistence();
  await persistence.claimRegistration({
    serviceId: "expired_takeover_service",
    providerId: "expired_takeover_provider",
    ownerKey: ALICE_KEY,
    leaseMs: 1_000
  });
  persistence.advance(1_001);
  const instance = await startServer({ persistence });
  try {
    const outcome = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("expired_takeover_service", "expired_takeover_provider"),
      BOB_COOKIE
    );
    assert.equal(outcome.status, 201);
    const active = persistence.row("expired_takeover_service");
    assert.equal(active.claim_state, "active");
    assert.equal(active.owner_key, BOB_KEY);
    assert.equal(persistence.providerOwner("expired_takeover_provider"), BOB_KEY);
    assert.equal(persistence.serviceClaims.size, 1);
  } finally {
    await instance.close();
  }
});

test("the same owner can retry an expired pending registration with a fresh token", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const first = await persistence.claimRegistration({
    serviceId: "same_owner_retry_service",
    providerId: "same_owner_retry_provider",
    ownerKey: ALICE_KEY,
    leaseMs: 500
  });
  persistence.advance(501);
  const instance = await startServer({ persistence });
  try {
    const outcome = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("same_owner_retry_service", "same_owner_retry_provider"),
      ALICE_COOKIE
    );
    assert.equal(outcome.status, 201);
    assert.equal(persistence.row("same_owner_retry_service").claim_state, "active");
    assert.equal(persistence.issuedTokens.length, 2);
    assert.notEqual(persistence.issuedTokens[0], persistence.issuedTokens[1]);
    assert.equal(first.claim_token, persistence.issuedTokens[0]);
  } finally {
    await instance.close();
  }
});

test("a finalized claim never expires and its published sibling prevents provider takeover", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  try {
    const published = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("non_expiring_service", "non_expiring_provider"),
      ALICE_COOKIE
    );
    assert.equal(published.status, 201);
    persistence.advance(365 * 24 * 60 * 60 * 1_000);

    const sameService = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("non_expiring_service", "bob_takeover_provider"),
      BOB_COOKIE
    );
    const sibling = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("bob_sibling_service", "non_expiring_provider"),
      BOB_COOKIE
    );
    assert.equal(sameService.status, 409);
    assert.equal(sibling.status, 409);
    assert.equal(persistence.row("non_expiring_service").claim_state, "active");
    assert.equal(persistence.providerOwner("non_expiring_provider"), ALICE_KEY);
  } finally {
    await instance.close();
  }
});

test("a finalize storage failure releases the pending claim and fails closed before 201", async () => {
  const persistence = createLeaseRegistrationPersistence({ failFinalize: true });
  const instance = await startServer({ persistence });
  try {
    const outcome = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest("finalize_failure_service", "finalize_failure_provider"),
      ALICE_COOKIE
    );
    assert.equal(outcome.status, 503);
    assert.equal(outcome.payload.error.code, "PROVIDER_CLAIM_PERSISTENCE_UNAVAILABLE");
    assert.equal(persistence.finalizeCalls.length, 1);
    assert.equal(persistence.releaseCalls.length, 1);
    assert.equal(persistence.serviceClaims.size, 0);
    assert.equal(persistence.providerOwner("finalize_failure_provider"), null);
    assert.equal(instance.store.services.has("finalize_failure_service"), false);
    assert.equal(instance.store.providers.has("finalize_failure_provider"), false);
  } finally {
    await instance.close();
  }
});

test("Provider Studio validation failure releases its pending service and provider claim", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  const serviceId = "studio_validation_release";
  try {
    const outcome = await postJson(
      instance.baseUrl,
      "/studio/providers",
      studioBody({
        serviceId,
        providerId: "studio_validation_release_provider",
        upstreamUrl: `${instance.baseUrl}/mock/upstream/not-a-real-provider-endpoint`
      }),
      ALICE_COOKIE
    );
    assert.equal(outcome.status, 422);
    assert.equal(outcome.payload.error.code, "VALIDATION_FAILED");
    assert.equal(persistence.finalizeCalls.length, 0);
    assert.equal(persistence.releaseCalls.length, 1);
    assert.equal(persistence.serviceClaims.size, 0);
    assert.equal(persistence.providerOwner("studio_validation_release_provider"), null);
    assert.equal(instance.store.services.has(serviceId), false);
  } finally {
    await instance.close();
    await deleteProviderConfig(serviceId).catch(() => {});
  }
});

test("OpenAPI publish validation failure releases its pending service and provider claim", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  const serviceId = "openapi_validation_release";
  try {
    const outcome = await postJson(instance.baseUrl, "/studio/import/publish", {
      publish_scope: "local_only",
      drafts: [importedDraft({
        serviceId,
        providerId: "openapi_validation_release_provider",
        upstreamUrl: `${instance.baseUrl}/mock/api/not-a-real-provider-endpoint`
      })]
    }, ALICE_COOKIE);
    assert.equal(outcome.status, 422);
    assert.equal(outcome.payload.failed[0].error, "VALIDATION_FAILED");
    assert.equal(persistence.finalizeCalls.length, 0);
    assert.equal(persistence.releaseCalls.length, 1);
    assert.equal(persistence.serviceClaims.size, 0);
    assert.equal(persistence.providerOwner("openapi_validation_release_provider"), null);
    assert.equal(instance.store.services.has(serviceId), false);
  } finally {
    await instance.close();
    await deleteProviderConfig(serviceId).catch(() => {});
  }
});

test("public API pipeline validation failure releases its pending platform claim", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  const candidate = {
    candidate_id: "pipeline-validation-release-candidate",
    title: "Pipeline validation release candidate",
    description: "A public API candidate whose promoted endpoint fails validation.",
    source_catalog: "test:provider-registration-lifecycle",
    category: "Development"
  };
  let result;
  try {
    result = await promoteValidatedPublicApiDrafts(instance.store, candidate, [{
      title: "Pipeline invalid endpoint",
      capabilities: ["data_service"],
      sample_request: {},
      upstream_url: `${instance.baseUrl}/mock/upstream/not-a-real-provider-endpoint`
    }], {
      baseUrl: instance.baseUrl,
      registrationPersistence: persistence
    });

    assert.equal(result.ok, false);
    assert.equal(result.failed[0].error, "PROMOTION_VALIDATION_FAILED");
    assert.equal(persistence.finalizeCalls.length, 0);
    assert.equal(persistence.releaseCalls.length, 1);
    assert.equal(persistence.serviceClaims.size, 0);
    assert.equal(persistence.providerOwner("public_apis_catalog"), null);
    assert.equal(instance.store.services.size, 0);
  } finally {
    await instance.close();
    if (result?.failed?.[0]?.service_id) await deleteProviderConfig(result.failed[0].service_id).catch(() => {});
  }
});

test("a persisted config left in validating state is never auto-verified after restart", async () => {
  const serviceId = "crash_window_validating_config";
  const config = createStaticProviderConfig({
    baseUrl: "http://127.0.0.1:1",
    serviceId,
    providerId: "crash_window_validating_provider",
    title: "Crash window validating config",
    description: "A config persisted before validation completed.",
    capabilities: ["data_service", "registration_lifecycle"],
    price: "0.01",
    sampleRequest: {},
    sampleData: { rows: [{ value: 1 }] },
    liveData: { rows: [{ value: 1 }] },
    summary: "Must remain unavailable after restart."
  });
  config.manifest.registration = {
    ...(config.manifest.registration || {}),
    owner: { user_key: ALICE_KEY },
    publish_state: "validating"
  };
  await writeProviderConfig(config);
  try {
    const restartedStore = createMemoryStore();
    await loadProviderConfigs(restartedStore, "http://127.0.0.1:1", {
      validate: false,
      force: true,
      listConfigs: async () => [structuredClone(config)]
    });
    const record = restartedStore.services.get(serviceId);
    assert.notEqual(record?.verification_status, "verified");
    assert.equal(
      searchServices(restartedStore, { query: serviceId, verifiedOnly: true }).some((item) => item.service_id === serviceId),
      false,
      "a crash-window config must never become routable merely because the process restarted"
    );
  } finally {
    await deleteProviderConfig(serviceId);
  }
});

test("successful hosted /services/register persists a restart-recoverable registered manifest without elevating trust", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const first = await startServer({ persistence });
  const serviceId = "restart_recoverable_registered_manifest";
  try {
    const outcome = await postJson(
      first.baseUrl,
      "/services/register",
      serviceManifest(serviceId, "restart_recoverable_provider"),
      ALICE_COOKIE
    );
    assert.equal(outcome.status, 201);
  } finally {
    await first.close();
  }

  const persisted = persistence.finalizedConfig(serviceId);
  assert.ok(persisted, "201 requires a durable manifest that can be replayed after restart");
  assert.equal(persisted.manifest.registration.publish_state, "registered");

  const restartedStore = createMemoryStore();
  await loadProviderConfigs(restartedStore, "https://agentrouter.example.test", {
    validate: false,
    force: true,
    listConfigs: async () => [persisted]
  });
  assert.equal(restartedStore.services.has(serviceId), true);
  assert.equal(
    restartedStore.services.get(serviceId).verification_status,
    "pending",
    "registration durability must not be confused with provider-response verification"
  );
});

test("finalized manifests and Provider Studio configs persist owner_key but omit PII and raw secrets", async () => {
  const persistence = createLeaseRegistrationPersistence();
  const instance = await startServer({ persistence });
  const directServiceId = "privacy_sanitized_manifest";
  const studioServiceId = "privacy_sanitized_config";
  try {
    const direct = await postJson(
      instance.baseUrl,
      "/services/register",
      serviceManifest(directServiceId, "privacy_manifest_provider"),
      ALICE_COOKIE
    );
    assert.equal(direct.status, 201);

    const studio = await postJson(
      instance.baseUrl,
      "/studio/providers",
      studioBody({
        serviceId: studioServiceId,
        providerId: "privacy_config_provider",
        upstreamUrl: `${instance.baseUrl}/mock/upstream/header-key`,
        secretValue: "demo-provider-secret"
      }),
      ALICE_COOKIE
    );
    assert.equal(studio.status, 201);

    const manifestRow = persistence.row(directServiceId);
    assert.equal(manifestRow.claim_state, "active");
    assertNoPrivateOwnerFields(manifestRow.persisted_manifest.registration.owner);

    const configRow = persistence.row(studioServiceId);
    assert.equal(configRow.claim_state, "active");
    assert.equal(configRow.persisted_config.manifest.registration.publish_state, "published");
    assertNoPrivateOwnerFields(configRow.persisted_config.manifest.registration.owner);
    assert.equal(JSON.stringify(configRow.persisted_config).includes("demo-provider-secret"), false);

    const diskConfig = JSON.parse(await fs.readFile(path.join(providerDir, `${studioServiceId}.json`), "utf8"));
    assertNoPrivateOwnerFields(diskConfig.manifest.registration.owner);
    assert.equal(diskConfig.manifest.registration.publish_state, "published");
    assert.equal(JSON.stringify(diskConfig).includes("demo-provider-secret"), false);
  } finally {
    await instance.close();
    await Promise.all([
      deleteProviderConfig(directServiceId).catch(() => {}),
      deleteProviderConfig(studioServiceId).catch(() => {})
    ]);
  }
});
