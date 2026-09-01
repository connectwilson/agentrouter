import crypto from "node:crypto";
import { createArcPaymentProof } from "./payment.js";
import { validateEnvelope, validateJsonSchema } from "./schema.js";
import { publicServiceRecord, summarizeTrust } from "./store.js";
import { normalizeEndpoint } from "./http-utils.js";
import { suggestCapabilities } from "./id-utils.js";
import { createSettlementReceipt, currentPaymentBackend } from "./payment-adapter.js";
import { hashJson } from "./evidence.js";
import { normalizeConsumerFeedback, verifyServiceResult } from "./verifier.js";
import {
  claimPersistentProviderId,
  claimPersistentServiceRegistration,
  finalizePersistentServiceRegistration,
  listPersistentProviderClaims,
  listPersistentRegisteredServices,
  listPersistentServiceRegistrationClaims,
  listPersistentServiceEvents,
  persistenceEnabled,
  persistentRegistryRequired,
  rewritePersistentServiceRegistration,
  releasePersistentServiceRegistration,
  waitForPersistentServiceRegistrationActivation,
  writePersistentServiceEvent,
  writePersistentServiceEventsAtomically
} from "./persistence.js";
import {
  createConfigHash,
  createManifestHash,
  finalizeManifest,
  prepareProviderConfigForPersistence,
  readProviderConfig,
  writePreparedProviderConfigFile,
  writeProviderConfig
} from "./provider-config.js";
import { assertArcUsdcBalance, sendArcUsdcTransfer, isEvmAddress } from "./arc-payment.js";
import { assertPolicyAllows, readWallet, recordPayment } from "./wallet.js";
import { registerErc8004AgentIdentity } from "./erc8004.js";
import { executeProviderConfig } from "./provider-runtime.js";
import { settlementChain } from "./chains.js";
import { agentRouterConnectionRequired } from "./agentrouter-connection.js";
import { requestProviderHttp } from "./provider-http-transport.js";
import { createRouteObservationV2 } from "./routing/metrics.js";
import { validateBudgetAmount } from "./budget-normalization.js";
import { internalProviderValidationHeaders } from "./provider-validation-auth.js";

export { validateBudgetAmount } from "./budget-normalization.js";

const providerRegistrationQueues = new WeakMap();
const serviceRegistrationLifecycles = new WeakMap();
const serviceEventRefreshes = new WeakMap();

export function registerService(store, manifest, baseUrl) {
  const normalized = prepareServiceRegistration(store, manifest, baseUrl);
  const providerClaim = claimProviderOwnership(store, normalized);
  if (providerClaim) materializeServiceRegistrationClaim(store, {
    service_id: normalized.service_id,
    provider_id: normalized.provider.provider_id,
    owner_key: providerClaim.owner_key,
    claimed_at: providerClaim.claimed_at
  });
  return commitPreparedServiceRegistration(store, normalized);
}

// Only bootstrap/migration code may bypass durable registration claims. User,
// provider, imported, and admin-created services must use registerServiceDurably.
export function registerTrustedService(store, manifest, baseUrl) {
  return registerService(store, manifest, baseUrl);
}

export async function registerServiceDurably(store, manifest, baseUrl, persistence = {}) {
  const registrationPersistence = {
    enabled: persistenceEnabled,
    required: persistentRegistryRequired,
    claimRegistration: claimPersistentServiceRegistration,
    finalizeRegistration: finalizePersistentServiceRegistration,
    releaseRegistration: releasePersistentServiceRegistration,
    ...persistence
  };
  return withProviderRegistrationLock(store, async () => {
    const normalized = prepareServiceRegistration(store, manifest, baseUrl);
    const releaseReservation = reserveServiceRegistration(store, normalized.service_id);
    let registrationClaim = null;
    let record = null;
    try {
      record = createServiceRecord(store, normalized);
      registrationClaim = await claimProviderOwnershipDurably(store, normalized, registrationPersistence);
      const committed = commitPreparedServiceRegistration(store, normalized, record);
      if (registrationClaim) {
        serviceRegistrationLifecycles.set(committed, { claim: registrationClaim, persistence: registrationPersistence });
      }
      return committed;
    } catch (error) {
      if (registrationClaim?.claim_state === "pending") {
        await releaseRegistrationClaim(registrationClaim, registrationPersistence).catch(() => {});
        cleanupPendingRegistrationClaim(store, registrationClaim);
      }
      throw error;
    } finally {
      releaseReservation();
    }
  });
}

export async function finalizeServiceRegistration(store, record, { config = null, manifest = null } = {}) {
  const lifecycle = serviceRegistrationLifecycles.get(record);
  if (!lifecycle) return null;
  const { claim, persistence } = lifecycle;
  if (claim.claim_state !== "pending") {
    serviceRegistrationLifecycles.delete(record);
    return claim;
  }
  const finalize = persistence?.finalizeRegistration || finalizePersistentServiceRegistration;
  const enabled = Boolean(typeof persistence?.enabled === "function" ? persistence.enabled() : persistence?.enabled);
  let finalized;
  if (enabled) {
    if (typeof finalize !== "function") throw providerClaimPersistenceUnavailable();
    try {
      finalized = await finalize({
        serviceId: claim.service_id,
        providerId: claim.provider_id,
        ownerKey: claim.owner_key,
        claimToken: claim.claim_token,
        config: config ? minimalRegistrationPersistenceDocument(config) : null,
        manifest: manifest ? minimalRegistrationPersistenceDocument(manifest) : null
      });
    } catch (error) {
      if (error?.code === "REGISTRATION_LEASE_LOST") throw error;
      throw providerClaimPersistenceUnavailable(error);
    }
    if (!finalized || String(finalized.claim_state || "active") !== "active") {
      throw providerClaimPersistenceUnavailable();
    }
  } else {
    finalized = { ...claim, status: "published", claim_state: "active", lease_expires_at: null };
  }
  materializeServiceRegistrationClaim(store, finalized);
  const providerClaim = store.providerClaims?.get(claim.provider_id);
  if (providerClaim) providerClaim.claim_state = "active";
  serviceRegistrationLifecycles.delete(record);
  return finalized;
}

function minimalRegistrationPersistenceDocument(document = {}) {
  const next = structuredClone(document || {});
  const manifest = next.manifest && typeof next.manifest === "object" ? next.manifest : next;
  const ownerKey = String(manifest?.registration?.owner?.user_key || "").trim();
  if (manifest?.registration?.owner) {
    if (ownerKey) manifest.registration.owner = { user_key: ownerKey };
    else delete manifest.registration.owner;
  }
  if (next.source?.auth) delete next.source.auth.secret_value;
  return next;
}

export async function abortServiceRegistration(store, record) {
  if (!record) return false;
  const lifecycle = serviceRegistrationLifecycles.get(record);
  if (lifecycle?.claim?.claim_state === "pending") {
    await releaseRegistrationClaim(lifecycle.claim, lifecycle.persistence).catch(() => {});
    cleanupPendingRegistrationClaim(store, lifecycle.claim);
  }
  serviceRegistrationLifecycles.delete(record);
  return unregisterService(store, record.manifest?.service_id);
}

async function releaseRegistrationClaim(claim, persistence = {}) {
  const enabled = Boolean(typeof persistence.enabled === "function" ? persistence.enabled() : persistence.enabled);
  if (!enabled) return { status: "released" };
  const release = persistence.releaseRegistration || releasePersistentServiceRegistration;
  if (typeof release !== "function") return null;
  return release({
    serviceId: claim.service_id,
    providerId: claim.provider_id,
    ownerKey: claim.owner_key,
    claimToken: claim.claim_token
  });
}

function cleanupPendingRegistrationClaim(store, claim) {
  const localService = store.serviceClaims?.get(claim.service_id);
  if (localService?.claim_state === "pending" && localService.owner_key === claim.owner_key) {
    store.serviceClaims.delete(claim.service_id);
  }
  const providerStillUsed = [...(store.serviceClaims?.values?.() || [])]
    .some((item) => item.provider_id === claim.provider_id);
  const providerClaim = store.providerClaims?.get(claim.provider_id);
  if (!providerStillUsed && providerClaim?.claim_state === "pending" && providerClaim.owner_key === claim.owner_key) {
    store.providerClaims.delete(claim.provider_id);
  }
}

function createServiceRecord(store, normalized) {
  const record = {
    manifest: normalized,
    verification_status: "pending",
    validation_runs: [],
    feedback_events: [],
    quality_events: [],
    health_checks: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const vendorIdentity = store.erc8004VendorIdentities?.get(vendorIdentityStoreKey(normalized.provider.provider_id));
  if (vendorIdentity) applyErc8004RegistrationToManifest(record.manifest, vendorIdentity);
  return record;
}

function commitPreparedServiceRegistration(store, normalized, record = createServiceRecord(store, normalized)) {
  store.providers.set(normalized.provider.provider_id, normalized.provider);
  store.services.set(normalized.service_id, record);
  return record;
}

function reserveServiceRegistration(store, serviceId) {
  store.providerRegistrationReservations ||= new Set();
  if (store.services.has(serviceId) || store.providerRegistrationReservations.has(serviceId)) {
    throw serviceAlreadyRegisteredError(serviceId);
  }
  store.providerRegistrationReservations.add(serviceId);
  return () => store.providerRegistrationReservations.delete(serviceId);
}

async function withProviderRegistrationLock(store, action) {
  const previous = providerRegistrationQueues.get(store) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn, () => turn);
  providerRegistrationQueues.set(store, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (providerRegistrationQueues.get(store) === tail) providerRegistrationQueues.delete(store);
  }
}

export function prepareServiceRegistration(store, manifest, baseUrl) {
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) {
    const error = new Error(`Invalid manifest: ${manifestErrors.join(", ")}`);
    error.statusCode = 422;
    throw error;
  }
  if (store.services.has(manifest.service_id)) {
    throw serviceAlreadyRegisteredError(manifest.service_id);
  }
  if (store.providerRegistrationReservations?.has(manifest.service_id)) {
    throw serviceAlreadyRegisteredError(manifest.service_id);
  }

  const normalized = finalizeManifest({
    ...manifest,
    capabilities: normalizeManifestCapabilities(manifest),
    endpoint: {
      ...manifest.endpoint,
      url: normalizeEndpoint(manifest.endpoint.url, baseUrl)
    }
  });
  const duplicate = findDuplicateService(store, normalized);
  if (duplicate) {
    const error = new Error(`Service source is already registered as ${duplicate.manifest.service_id}.`);
    error.statusCode = 409;
    error.code = "SERVICE_SOURCE_ALREADY_REGISTERED";
    error.existingServiceId = duplicate.manifest.service_id;
    throw error;
  }
  return normalized;
}

function serviceAlreadyRegisteredError(serviceId) {
  const error = new Error(`Service ${serviceId} is already registered.`);
  error.statusCode = 409;
  error.code = "SERVICE_ALREADY_REGISTERED";
  return error;
}

export async function claimProviderOwnershipDurably(store, manifest, {
  enabled = persistenceEnabled,
  required = persistentRegistryRequired,
  claimRegistration = claimPersistentServiceRegistration,
  leaseMs = 5 * 60 * 1000
} = {}) {
  const serviceId = String(manifest?.service_id || "").trim();
  const providerId = String(manifest?.provider?.provider_id || "").trim();
  const ownerKey = String(manifest?.registration?.owner?.user_key || "").trim();
  if (!serviceId || !providerId || !ownerKey) return null;

  // Never let a stale/empty durable table overwrite an ownership claim already
  // established by the services and events hydrated into this process.
  store.providerClaims ||= new Map();
  let localClaim = store.providerClaims.get(providerId) || null;
  if (!localClaim) {
    localClaim = providerClaimFromExistingServices(store, providerId);
    if (localClaim) materializeProviderClaim(store, localClaim);
  }
  if (localClaim && localClaim.owner_key !== ownerKey) throw providerAlreadyClaimedError(providerId);

  let persistenceIsEnabled;
  let persistenceIsRequired;
  try {
    persistenceIsEnabled = Boolean(typeof enabled === "function" ? enabled() : enabled);
    persistenceIsRequired = Boolean(typeof required === "function" ? required() : required);
  } catch (error) {
    throw providerClaimPersistenceUnavailable(error);
  }
  if (!persistenceIsEnabled) {
    if (persistenceIsRequired) throw persistentRegistryRequiredError();
    const pending = {
      status: "claimed",
      claim_state: "pending",
      service_id: serviceId,
      provider_id: providerId,
      owner_key: ownerKey,
      claim_token: crypto.randomBytes(32).toString("base64url"),
      lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      claimed_at: new Date().toISOString()
    };
    materializeServiceRegistrationClaim(store, pending);
    return pending;
  }

  let durableRegistration;
  try {
    durableRegistration = await claimRegistration({ serviceId, providerId, ownerKey, leaseMs });
  } catch (error) {
    throw providerClaimPersistenceUnavailable(error);
  }
  if (!durableRegistration) throw providerClaimPersistenceUnavailable();
  if (durableRegistration.status === "provider_conflict") {
    throw providerAlreadyClaimedError(providerId);
  }
  if (durableRegistration.status === "service_conflict") throw serviceAlreadyRegisteredError(serviceId);
  if (
    String(durableRegistration.service_id || "") !== serviceId
    || String(durableRegistration.provider_id || "") !== providerId
    || String(durableRegistration.owner_key || "") !== ownerKey
  ) {
    throw providerClaimPersistenceUnavailable();
  }

  materializeServiceRegistrationClaim(store, durableRegistration);
  return durableRegistration;
}

export function claimProviderOwnership(store, manifest, { persist = true } = {}) {
  const providerId = String(manifest?.provider?.provider_id || "").trim();
  const owner = manifest?.registration?.owner;
  const ownerKey = String(owner?.user_key || "").trim();
  if (!providerId || !ownerKey) return null;

  store.providerClaims ||= new Map();
  let existing = store.providerClaims.get(providerId) || null;
  if (!existing) {
    existing = providerClaimFromExistingServices(store, providerId);
    if (existing) materializeProviderClaim(store, existing, { persist });
  }
  if (existing) {
    if (existing.owner_key !== ownerKey) throw providerAlreadyClaimedError(providerId);
    return existing;
  }

  const claim = {
    event_version: "agent_router_provider_claim_v1",
    provider_id: providerId,
    owner_key: ownerKey,
    owner: {
      user_key: ownerKey,
      provider: String(owner.provider || ""),
      user_id: String(owner.user_id || ""),
      handle: String(owner.handle || ""),
      email: String(owner.email || ""),
      name: String(owner.name || "")
    },
    claimed_at: new Date().toISOString()
  };
  return materializeProviderClaim(store, claim, { persist });
}

function providerClaimFromExistingServices(store, providerId) {
  const owners = new Map();
  for (const record of store.services.values()) {
    if (record.manifest?.provider?.provider_id !== providerId) continue;
    const owner = record.manifest?.registration?.owner;
    const ownerKey = String(owner?.user_key || "").trim();
    if (ownerKey) owners.set(ownerKey, owner);
  }
  if (!owners.size) return null;
  if (owners.size > 1) throw providerAlreadyClaimedError(providerId);
  const [ownerKey, owner] = owners.entries().next().value;
  return {
    event_version: "agent_router_provider_claim_v1",
    provider_id: providerId,
    owner_key: ownerKey,
    owner: {
      user_key: ownerKey,
      provider: String(owner.provider || ""),
      user_id: String(owner.user_id || ""),
      handle: String(owner.handle || ""),
      email: String(owner.email || ""),
      name: String(owner.name || "")
    },
    claimed_at: String(owner.created_at || new Date().toISOString())
  };
}

function materializeProviderClaim(store, claim, { persist = false } = {}) {
  const providerId = String(claim?.provider_id || "").trim();
  const ownerKey = String(claim?.owner_key || claim?.owner?.user_key || "").trim();
  if (!providerId || !ownerKey) return null;
  store.providerClaims ||= new Map();
  const existing = store.providerClaims.get(providerId);
  if (existing) {
    if (existing.owner_key !== ownerKey) throw providerAlreadyClaimedError(providerId);
    if (claim.claim_state === "active") existing.claim_state = "active";
    return existing;
  }
  const normalized = {
    ...claim,
    event_version: "agent_router_provider_claim_v1",
    provider_id: providerId,
    owner_key: ownerKey,
    owner: {
      ...(claim.owner || {}),
      user_key: ownerKey
    },
    claimed_at: claim.claimed_at || claim.created_at || new Date().toISOString()
  };
  store.providerClaims.set(providerId, normalized);
  if (persist) persistProviderClaim(normalized);
  return normalized;
}

function materializeServiceRegistrationClaim(store, claim) {
  const serviceId = String(claim?.service_id || "").trim();
  const providerId = String(claim?.provider_id || "").trim();
  const ownerKey = String(claim?.owner_key || "").trim();
  if (!serviceId || !providerId || !ownerKey) return null;
  store.serviceClaims ||= new Map();
  const existing = store.serviceClaims.get(serviceId);
  if (existing) {
    if (existing.provider_id !== providerId || existing.owner_key !== ownerKey) {
      throw serviceAlreadyRegisteredError(serviceId);
    }
    existing.claim_state = claim.claim_state || existing.claim_state || "active";
    existing.lease_expires_at = claim.lease_expires_at || null;
    return existing;
  }
  const record = store.services?.get(serviceId);
  if (record) {
    const recordProviderId = String(record.manifest?.provider?.provider_id || "").trim();
    const recordOwnerKey = String(record.manifest?.registration?.owner?.user_key || "").trim();
    if (recordProviderId && recordProviderId !== providerId) throw serviceAlreadyRegisteredError(serviceId);
    if (recordOwnerKey && recordOwnerKey !== ownerKey) throw serviceAlreadyRegisteredError(serviceId);
  }
  materializeProviderClaim(store, {
    event_version: "agent_router_provider_claim_v1",
    provider_id: providerId,
    owner_key: ownerKey,
    claim_state: claim.claim_state || "active",
    claimed_at: claim.claimed_at || new Date().toISOString()
  });
  const normalized = {
    service_id: serviceId,
    provider_id: providerId,
    owner_key: ownerKey,
    claim_state: claim.claim_state || "active",
    lease_expires_at: claim.lease_expires_at || null,
    claimed_at: claim.claimed_at || new Date().toISOString()
  };
  store.serviceClaims.set(serviceId, normalized);
  return normalized;
}

function persistProviderClaim(claim) {
  const durableEvent = {
    event_version: "agent_router_provider_claim_v1",
    provider_id: claim.provider_id,
    owner_key: claim.owner_key,
    claimed_at: claim.claimed_at || new Date().toISOString()
  };
  void writePersistentServiceEvent({
    eventType: "provider_claim",
    serviceId: `provider:${claim.provider_id}`,
    requestId: claim.provider_id,
    event: durableEvent
  }).catch((error) => {
    console.error("[provider-claim] persistence failed", JSON.stringify({
      provider_id: claim.provider_id,
      code: error.code || "PERSISTENCE_FAILED",
      message: error.message
    }));
  });
}

function providerAlreadyClaimedError(providerId) {
  const error = new Error(`Provider ID ${providerId} is already claimed by another account.`);
  error.statusCode = 409;
  error.code = "PROVIDER_ID_ALREADY_CLAIMED";
  return error;
}

function providerClaimPersistenceUnavailable(cause) {
  const error = new Error("The durable provider ownership registry is temporarily unavailable.");
  error.statusCode = 503;
  error.code = "PROVIDER_CLAIM_PERSISTENCE_UNAVAILABLE";
  if (cause) error.cause = cause;
  return error;
}

function persistentRegistryRequiredError() {
  const error = new Error("Persistent registry storage is required before provider services can be registered on this deployment.");
  error.statusCode = 503;
  error.code = "PERSISTENT_REGISTRY_REQUIRED";
  return error;
}

export function findDuplicateService(store, manifest) {
  const fingerprint = manifest?.registration?.source_fingerprint;
  const providerId = manifest?.provider?.provider_id;
  if (!fingerprint || !providerId) return null;
  for (const record of store.services.values()) {
    if (record.manifest.service_id === manifest.service_id) continue;
    if (record.manifest.provider?.provider_id !== providerId) continue;
    if (record.manifest.registration?.source_fingerprint === fingerprint) return record;
  }
  return null;
}

export function unregisterService(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return false;
  store.services.delete(serviceId);
  store.serviceClaims?.delete(serviceId);
  const providerId = record.manifest?.provider?.provider_id;
  if (providerId) {
    const providerStillUsed = [...store.services.values()].some((item) => item.manifest?.provider?.provider_id === providerId);
    if (!providerStillUsed) store.providers.delete(providerId);
  }
  return true;
}

export async function updateServicePayoutWallet(store, serviceId, payoutAddress) {
  const record = store.services.get(serviceId);
  if (!record) {
    const error = new Error(`Service ${serviceId} was not found.`);
    error.statusCode = 404;
    error.code = "SERVICE_NOT_FOUND";
    throw error;
  }
  if (!isEvmAddress(payoutAddress)) {
    const error = new Error("Arc payout wallet must be a valid EVM address.");
    error.statusCode = 422;
    error.code = "INVALID_PAYOUT_ADDRESS";
    throw error;
  }

  applyPayoutToManifest(record.manifest, payoutAddress);
  record.updated_at = new Date().toISOString();
  if (record.manifest.provider?.provider_id) {
    store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
  }

  let persisted = false;
  try {
    const config = await readProviderConfig(serviceId);
    applyPayoutToManifest(config.manifest, payoutAddress);
    await writeProviderConfig(config);
    persisted = true;
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
  }

  return {
    ok: true,
    service_id: serviceId,
    payout_address: payoutAddress,
    persisted,
    manifest: record.manifest,
    service: publicServiceRecord(record)
  };
}

export async function registerServiceErc8004Identity(store, serviceId, {
  baseUrl = "",
  metadataUri = "",
  writeEvent = writePersistentServiceEvent
} = {}) {
  const record = store.services.get(serviceId);
  if (!record) {
    const error = new Error(`Service ${serviceId} was not found.`);
    error.statusCode = 404;
    error.code = "SERVICE_NOT_FOUND";
    throw error;
  }
  const providerId = record.manifest.provider.provider_id;
  const existing = store.erc8004VendorIdentities?.get(vendorIdentityStoreKey(providerId));
  if (existing) {
    applyErc8004VendorIdentity(store, providerId, existing);
    return {
      ok: true,
      service_id: serviceId,
      provider_id: providerId,
      reused: true,
      persisted: true,
      erc8004: existing,
      manifest: record.manifest,
      service: publicServiceRecord(record)
    };
  }
  const vendorMetadataUri = metadataUri || `${String(baseUrl).replace(/\/$/, "")}/.well-known/erc8004/vendors/${encodeURIComponent(providerId)}.json`;
  const registration = await registerErc8004AgentIdentity({
    manifest: record.manifest,
    baseUrl,
    metadataUri: vendorMetadataUri
  });
  if (!["registered", "submitted"].includes(registration.status)) {
    const error = new Error(registration.error || "ERC-8004 identity registration failed.");
    error.statusCode = 422;
    error.code = "ERC8004_REGISTRATION_FAILED";
    error.registration = registration;
    throw error;
  }

  const identityEvent = {
    event_version: "agent_router_erc8004_vendor_identity_v1",
    provider_id: providerId,
    ...registration,
    created_at: new Date().toISOString()
  };
  await writeEvent({
    eventType: "erc8004_vendor_identity",
    serviceId: `vendor:${providerId}`,
    requestId: registration.tx_hash || registration.agent_id || null,
    event: identityEvent
  });

  applyErc8004VendorIdentity(store, providerId, identityEvent);
  record.updated_at = new Date().toISOString();
  if (record.manifest.provider?.provider_id) {
    store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
  }

  let persisted = false;
  try {
    const config = await readProviderConfig(serviceId);
    applyErc8004RegistrationToManifest(config.manifest, registration);
    await writeProviderConfig(config);
    persisted = true;
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
  }

  return {
    ok: true,
    service_id: serviceId,
    provider_id: providerId,
    persisted,
    erc8004: registration,
    manifest: record.manifest,
    service: publicServiceRecord(record)
  };
}

function applyPayoutToManifest(manifest, payoutAddress) {
  manifest.provider = manifest.provider || {};
  manifest.provider.payout_address = payoutAddress;
  manifest.pricing = manifest.pricing || {};
  manifest.pricing.pay_to = payoutAddress;
  manifest.pricing.settlement_model = "direct_provider_wallet";
}

export function applyErc8004RegistrationToManifest(manifest, registration = {}) {
  manifest.registration = {
    ...(manifest.registration || {}),
    erc8004: {
      ...(manifest.registration?.erc8004 || {}),
      standard: "ERC-8004",
      network: registration.network || settlementChain().network,
      caip2: registration.caip2 || settlementChain().caip2,
      chain_id: registration.chain_id || settlementChain().id,
      agent_id: registration.agent_id || manifest.registration?.erc8004?.agent_id || null,
      metadata_uri: registration.metadata_uri || manifest.registration?.erc8004?.metadata_uri || null,
      metadata_hash: registration.metadata_hash || manifest.registration?.erc8004?.metadata_hash || null,
      identity_registry: registration.registry_address || manifest.registration?.erc8004?.identity_registry || null,
      reputation_registry: registration.reputation_registry_address || manifest.registration?.erc8004?.reputation_registry || null,
      validation_registry: registration.validation_registry_address || manifest.registration?.erc8004?.validation_registry || null,
      tx_hash: registration.tx_hash || manifest.registration?.erc8004?.tx_hash || null,
      status: registration.status,
      updated_at: new Date().toISOString()
    }
  };
  manifest.provider = manifest.provider || {};
  if (registration.agent_id) manifest.provider.erc8004_agent_id = String(registration.agent_id);
}

export function vendorIdentityStoreKey(providerId, network = settlementChain().network) {
  return `${String(network || "").toLowerCase()}:${String(providerId || "").trim()}`;
}

export function applyErc8004VendorIdentity(store, providerId, registration = {}) {
  if (!providerId || !registration?.agent_id) return null;
  const identity = { ...registration, provider_id: providerId };
  store.erc8004VendorIdentities ||= new Map();
  store.erc8004VendorIdentities.set(vendorIdentityStoreKey(providerId, identity.network), identity);
  for (const record of store.services.values()) {
    if (record.manifest?.provider?.provider_id !== providerId) continue;
    applyErc8004RegistrationToManifest(record.manifest, identity);
    record.updated_at = new Date().toISOString();
  }
  const provider = store.providers.get(providerId);
  if (provider) {
    provider.erc8004_agent_id = String(identity.agent_id);
    store.providers.set(providerId, provider);
  }
  return identity;
}

function normalizeManifestCapabilities(manifest) {
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const inferred = suggestCapabilities([
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    declared.join(" ")
  ].join(" ")).split(",");
  return [...new Set([...declared, ...inferred])];
}

export async function validateService(store, serviceId, transportOptions = {}) {
  const record = store.services.get(serviceId);
  if (!record) return { ok: false, error: "SERVICE_NOT_FOUND" };

  const manifest = record.manifest;
  const requestBody = manifest.sample_request || {};
  const config = transportOptions.providerConfig
    || await readProviderConfig(serviceId).catch(() => null);
  try {
    if (config) {
      const result = await executeProviderConfig(config, requestBody, {
        fetchImpl: requestProviderHttp,
        transportOptions
      });
      const originBinding = await verifyOriginBinding(manifest, transportOptions);
      return storeProviderValidationResult({ record, serviceId, status: result.status, responseBody: result.body, originBinding });
    }

    const validationHeaders = providerValidationHeaders(manifest.endpoint.url, transportOptions);
    const firstResponse = await requestProviderHttp(manifest.endpoint.url, {
      method: manifest.endpoint.method || "POST",
      headers: { "content-type": "application/json", ...validationHeaders },
      body: JSON.stringify(requestBody)
    }, transportOptions);

    if (firstResponse.status !== 402) {
      return storeValidation(record, {
        ok: false,
        service_id: serviceId,
        error: "EXPECTED_402_PAYMENT_REQUIRED",
        status: firstResponse.status,
        created_at: new Date().toISOString()
      });
    }

    const paymentChallenge = await firstResponse.json();
    const proof = await createArcProofForProviderChallenge({
      serviceId,
      manifest,
      payment: paymentChallenge.payment,
      consumerId: "validator"
    });

    const paidResponse = await requestProviderHttp(manifest.endpoint.url, {
      method: manifest.endpoint.method || "POST",
      headers: {
        "content-type": "application/json",
        ...validationHeaders,
        "x-payment": proof
      },
      body: JSON.stringify(requestBody)
    }, transportOptions);
    const responseBody = await paidResponse.json();
    const originBinding = await verifyOriginBinding(manifest, transportOptions);
    return storeProviderValidationResult({ record, serviceId, status: paidResponse.status, responseBody, originBinding });
  } catch (error) {
    if (!String(error?.code || "").startsWith("PROVIDER_HTTP_")) throw error;
    return storeValidation(record, {
      ok: false,
      service_id: serviceId,
      error: error.code,
      message: error.message,
      status: error.statusCode || 502,
      retryable: Boolean(error.retryable),
      created_at: new Date().toISOString()
    });
  }
}

function providerValidationHeaders(value, transportOptions = {}) {
  let endpoint;
  try {
    endpoint = new URL(String(value || ""));
  } catch {
    return {};
  }
  const trusted = (transportOptions.trustedOrigins || []).some((entry) => {
    let origin;
    try {
      origin = new URL(String(entry?.origin || entry)).origin;
    } catch {
      return false;
    }
    if (origin !== endpoint.origin) return false;
    const prefixes = Array.isArray(entry?.pathPrefixes) ? entry.pathPrefixes : [];
    return prefixes.some((prefix) => endpoint.pathname.startsWith(String(prefix || "")));
  });
  return trusted ? internalProviderValidationHeaders() : {};
}

function storeProviderValidationResult({ record, serviceId, status, responseBody, originBinding = null }) {
  const manifest = record.manifest;
  const schemaErrors = validateJsonSchema(responseBody, manifest.output_schema);
  const envelopeErrors = validateEnvelope(responseBody);
  const resultErrors = validateRealResultFeedback(responseBody);
  const ok = status >= 200 && status < 300 && schemaErrors.length === 0 && envelopeErrors.length === 0 && resultErrors.length === 0;

  return storeValidation(record, {
    ok,
    service_id: serviceId,
    status,
    provider_error: responseBody?.error || null,
    schema_errors: schemaErrors,
    envelope_errors: envelopeErrors,
    result_errors: resultErrors,
    result_preview: previewResultData(responseBody?.data),
    origin_binding: originBinding,
    created_at: new Date().toISOString()
  });
}

async function verifyOriginBinding(manifest, transportOptions = {}) {
  const binding = manifest?.origin_binding;
  if (!binding?.well_known_url) return null;
  const result = {
    binding_version: "agentrouter_origin_binding_v1",
    required: Boolean(binding.required),
    well_known_url: binding.well_known_url,
    origin: binding.origin || "",
    status: "not_found",
    ok: false,
    checked_at: new Date().toISOString()
  };
  try {
    const response = await requestProviderHttp(binding.well_known_url, {
      method: "GET",
      headers: { accept: "application/json" }
    }, {
      ...transportOptions,
      trustedOrigins: [],
      timeoutMs: Math.min(Number(transportOptions.timeoutMs) || 1500, 1500),
      maxResponseBytes: Math.min(Number(transportOptions.maxResponseBytes) || 64 * 1024, 64 * 1024)
    });
    result.http_status = response.status;
    if (response.status === 404) return result;
    if (!response.ok) {
      result.status = "unavailable";
      return result;
    }
    const payload = await response.json();
    const serviceId = manifest.service_id;
    const providerId = manifest.provider?.provider_id;
    const services = Array.isArray(payload.services) ? payload.services : [];
    const directMatch = payload.service_id === serviceId || payload.provider_id === providerId;
    const serviceMatch = services.some((service) =>
      service?.service_id === serviceId ||
      service?.manifest_hash === manifest.integrity?.manifest_hash ||
      service?.upstream_url === manifest.source?.upstream_url
    );
    result.payload_hash = payload ? hashPayload(payload) : null;
    result.status = directMatch || serviceMatch ? "verified" : "mismatch";
    result.ok = directMatch || serviceMatch;
    return result;
  } catch (error) {
    result.status = error?.code === "PROVIDER_HTTP_TIMEOUT"
      ? "timeout"
      : error?.code === "PROVIDER_HTTP_UNSAFE_TARGET"
        ? "blocked"
        : "unavailable";
    result.error_code = error?.code || "ORIGIN_BINDING_UNAVAILABLE";
    result.error = error.message;
    return result;
  }
}

function hashPayload(payload) {
  return hashJson(payload);
}

export function searchServices(store, { query = "", capabilities = [], maxPrice, verifiedOnly = false } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const maxValidation = validateBudgetAmount(maxPrice, { field: "max_price" });
  if (!maxValidation.ok) return [];
  const max = maxValidation.present ? maxValidation.amount : null;
  const results = [];

  for (const record of store.services.values()) {
    if (verifiedOnly && record.verification_status !== "verified") continue;
    const manifest = record.manifest;
    if (max != null && Number(manifest.pricing.amount) > max) continue;
    if (capabilities.length && !capabilities.every((capability) => manifest.capabilities.includes(capability))) continue;

    const haystack = [
      manifest.title,
      manifest.description_for_agent,
      ...(manifest.capabilities || []),
      manifest.service_id,
      manifest.agent_contract?.summary,
      manifest.agent_contract?.request_shape_summary,
      manifest.agent_contract?.response_shape_summary,
      JSON.stringify(manifest.routing || {}),
      JSON.stringify(manifest.agent_contract?.request_data || {}),
      JSON.stringify(manifest.agent_contract?.response_data || {}),
      JSON.stringify(manifest.pricing || {}),
      JSON.stringify(manifest.freshness || {}),
      JSON.stringify(manifest.data_source_claim || {}),
      JSON.stringify(manifest.sample_response?.metadata || {}),
      JSON.stringify(manifest.sample_response?.agent_hints || {}),
      JSON.stringify(manifest.sample_request || {}),
      JSON.stringify(manifest.sample_response?.data || {}),
      JSON.stringify(record.validation_runs?.at(-1)?.result_preview || {})
    ].join(" ").toLowerCase();

    const matchCount = terms.filter((term) => haystack.includes(term)).length;
    if (terms.length && matchCount === 0) continue;

    results.push({
      ...publicServiceRecord(record),
      match_score: terms.length ? matchCount / terms.length : 1
    });
  }

  return results.sort((a, b) => b.match_score - a.match_score);
}

export async function invokePaidService(store, serviceId, input, budget = {}, options = {}) {
  const record = store.services.get(serviceId);
  if (!record) return { statusCode: 404, body: { error: { code: "SERVICE_NOT_FOUND" } } };

  if (record.verification_status !== "verified") {
    return {
      statusCode: 409,
      body: {
        error: {
          code: "SERVICE_NOT_VERIFIED",
          message: "Only a service with a currently verified endpoint can be invoked.",
          verification_status: record.verification_status || "unknown",
          retryable: false
        }
      }
    };
  }

  const manifest = record.manifest;
  const rawMaxAmount = budget.max_amount ?? budget.max_price_usdc ?? budget.max_price;
  const budgetValidation = validateBudgetAmount(rawMaxAmount, { field: "budget.max_amount" });
  if (!budgetValidation.ok) {
    return {
      statusCode: 422,
      body: {
        error: {
          code: budgetValidation.code,
          message: budgetValidation.message,
          field: budgetValidation.field,
          retryable: false
        }
      }
    };
  }
  if (budgetValidation.present && Number(manifest.pricing.amount) > budgetValidation.amount) {
    return {
      statusCode: 402,
      body: {
        error: {
          code: "BUDGET_TOO_LOW",
          message: `Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}.`
        }
      }
    };
  }

  const started = Date.now();
  let paidResponse;
  let body;
  let paymentTx = null;
  let settlementReceipt;
  const paymentBackend = currentPaymentBackend();
  if (paymentBackend === "credits") {
    if (!options.consumerApiKey) {
      return {
        statusCode: 401,
        body: agentRouterConnectionRequired()
      };
    }
    if (!isPlatformManagedCreditsEndpoint(manifest.endpoint.url)) {
      return {
        statusCode: 409,
        body: {
          error: {
            code: "CREDITS_ENDPOINT_NOT_PLATFORM_MANAGED",
            message: "Platform credits can only be presented to an AgentRouter-managed provider runtime endpoint.",
            retryable: false
          }
        }
      };
    }
    try {
      paidResponse = await requestProviderHttp(manifest.endpoint.url, {
        method: manifest.endpoint.method || "POST",
        headers: {
          "content-type": "application/json",
          "x-agentrouter-api-key": options.consumerApiKey
        },
        body: JSON.stringify(input),
      }, creditsProviderTransportOptions(manifest.endpoint.url, options.providerTransportOptions));
    } catch (error) {
      if (error?.code === "PROVIDER_HTTP_REDIRECT_LIMIT" || error?.code === "PROVIDER_HTTP_INVALID_REDIRECT") {
        return {
          statusCode: 502,
          body: {
            error: {
              code: "CREDITS_PROVIDER_REDIRECT_BLOCKED",
              message: "The AgentRouter-managed provider runtime redirected the paid call; credentials were not sent to the redirect target.",
              retryable: false,
              cause_code: error.code
            }
          }
        };
      }
      if (error?.code === "PROVIDER_HTTP_RESPONSE_TOO_LARGE") {
        return {
          statusCode: 502,
          body: {
            error: {
              code: "CREDITS_PROVIDER_RESPONSE_TOO_LARGE",
              message: "The AgentRouter-managed provider runtime returned a response larger than the safe limit.",
              retryable: false,
              cause_code: error.code
            }
          }
        };
      }
      return {
        statusCode: 503,
        body: {
          error: {
            code: "CREDITS_PROVIDER_UNAVAILABLE",
            message: "The AgentRouter-managed provider runtime is unavailable before payment.",
            retryable: true,
            cause: error.message,
            cause_code: error?.code || "PROVIDER_HTTP_NETWORK_ERROR"
          }
        }
      };
    }
    if (paidResponse.status >= 300 && paidResponse.status < 400) {
      return {
        statusCode: 502,
        body: {
          error: {
            code: "CREDITS_PROVIDER_REDIRECT_BLOCKED",
            message: "The AgentRouter-managed provider runtime redirected the paid call; credentials were not sent to the redirect target.",
            retryable: false
          }
        }
      };
    }
    body = await paidResponse.json().catch(() => ({}));
    const billing = body?.metadata?.billing || {};
    paymentTx = billing.ledger_entry_id ? `credits:${billing.ledger_entry_id}` : null;
    settlementReceipt = {
      receipt_version: "agent_router_settlement_receipt_v1",
      payment_backend: "credits",
      mode: "credits",
      network: "agentrouter",
      protocol: "platform_credits",
      asset: "credits",
      amount: billing.amount || manifest.pricing.amount,
      payer: options.consumerId || "agentrouter_consumer",
      ledger_entry_id: billing.ledger_entry_id || null,
      balance_after: billing.balance_after || null,
      status: billing.billing_status || (paidResponse.ok ? "charged" : "not_charged"),
      created_at: new Date().toISOString()
    };
  } else {
    const transportOptions = paidProviderTransportOptions(manifest.endpoint.url);
    let firstResponse;
    try {
      firstResponse = await requestProviderHttp(manifest.endpoint.url, {
        method: manifest.endpoint.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      }, transportOptions);
    } catch (error) {
      const feedback = await recordOperationalFailure(store, record, {
        input,
        statusCode: error.statusCode || 502,
        error: {
          code: error.code || "PROVIDER_UNAVAILABLE_BEFORE_PAYMENT",
          message: error.message
        },
        started
      });
      return {
        statusCode: error.statusCode === 422 ? 422 : 503,
        body: {
          error: {
            code: error.code || "PROVIDER_UNAVAILABLE_BEFORE_PAYMENT",
            message: "Provider endpoint failed the safe network boundary before payment.",
            retryable: Boolean(error.retryable)
          },
          feedback
        }
      };
    }
    if (firstResponse.status !== 402) {
      let providerPayload = null;
      try {
        providerPayload = await firstResponse.json();
      } catch {}
      const prepayFailure = providerPayload?.error?.code === "PREPAY_VALIDATION_FAILED";
      const feedback = await recordOperationalFailure(store, record, {
        input,
        statusCode: firstResponse.status,
        error: {
          code: prepayFailure ? "PREPAY_VALIDATION_FAILED" : "EXPECTED_402_PAYMENT_REQUIRED",
          message: prepayFailure
            ? providerPayload.error.message
            : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`,
          provider_payload: providerPayload
        },
        started
      });
      return {
        statusCode: prepayFailure ? 422 : firstResponse.status >= 500 ? 503 : 502,
        body: {
          error: {
            code: prepayFailure
              ? "PROVIDER_PREPAY_VALIDATION_FAILED"
              : firstResponse.status >= 500 ? "PROVIDER_UNAVAILABLE_BEFORE_PAYMENT" : "EXPECTED_402_PAYMENT_REQUIRED",
            message: prepayFailure
              ? "Provider preflight validation failed before payment. No payment was collected."
              : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`,
            upstream_status: firstResponse.status,
            retryable: firstResponse.status >= 500,
            provider_payload: providerPayload
          },
          feedback
        }
      };
    }
    const challenge = await firstResponse.json();
    const proof = await createArcProofForProviderChallenge({
      serviceId,
      manifest,
      payment: challenge.payment,
      consumerId: "agentrouter_consumer"
    });
    try {
      paidResponse = await requestProviderHttp(manifest.endpoint.url, {
        method: manifest.endpoint.method || "POST",
        headers: {
          "content-type": "application/json",
          "x-payment": proof
        },
        body: JSON.stringify(input)
      }, transportOptions);
    } catch (error) {
      return {
        statusCode: 502,
        body: {
          error: {
            code: error.code || "PROVIDER_DELIVERY_FAILED_AFTER_PAYMENT",
            message: "The paid provider response failed the safe network boundary.",
            retryable: Boolean(error.retryable),
            payment_may_have_settled: true
          }
        }
      };
    }
    body = await paidResponse.json();
    paymentTx = decodePaymentTx(proof);
    settlementReceipt = createSettlementReceipt({
      manifest,
      challenge: challenge.payment,
      txHash: paymentTx
    });
  }
  const schemaErrors = validateJsonSchema(body, manifest.output_schema);
  const envelopeErrors = validateEnvelope(body);
  const resultErrors = validateRealResultFeedback(body);
  const schemaValid = schemaErrors.length === 0 && envelopeErrors.length === 0;
  const verification = verifyServiceResult({ result: body, manifest, intent: input, constraints: {} });
  const qualityErrors = verification.sanity_valid === false
    ? [
        ...resultErrors,
        {
          code: "RESULT_DATA_QUALITY_FAILED",
          message: "Provider returned data that failed deterministic quality sanity checks.",
          issues: (verification.data_quality_issues || []).map((issue) => issue.code)
        }
      ]
    : resultErrors;
  const creditBilling = paymentBackend === "credits" ? body?.metadata?.billing || {} : null;
  const paymentCollected = paymentBackend === "credits"
    ? creditBilling?.billing_status === "charged"
    : true;
  const billingStatus = paymentBackend === "credits"
    ? creditBilling?.billing_status || "not_charged"
    : paidResponse.ok && schemaValid && !qualityErrors.length ? "charged_success" : "charged_provider_error";
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: body.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: options.ownerKey || "agentrouter_consumer",
    invocation_actor_key: options.ownerKey || undefined,
    payment_backend: paymentBackend,
    payment_tx: paymentTx,
    payment_collected: paymentCollected,
    billing_status: billingStatus,
    result_delivery_status: paidResponse.ok && schemaValid && !qualityErrors.length ? "delivered" : "failed_after_payment",
    settlement_receipt: settlementReceipt,
    status: paidResponse.ok ? "success" : "error",
    http_status: paidResponse.status,
    schema_valid: schemaValid,
    verification,
    business_error: qualityErrors[0] || null,
    latency_ms: Date.now() - started,
    consumer_rating: paidResponse.ok && schemaValid && !qualityErrors.length ? 1 : 0,
    created_at: new Date().toISOString()
  };
  const qualityEvent = createQualityEvent({
    serviceId,
    providerId: manifest.provider.provider_id,
    requestId: feedback.request_id,
    input,
    result: body,
    feedback,
    verification,
    schemaErrors,
    envelopeErrors,
    resultErrors: qualityErrors
  });
  record.feedback_events.push(feedback);
  record.quality_events = record.quality_events || [];
  record.quality_events.push(qualityEvent);
  store.feedbackEvents = store.feedbackEvents || [];
  store.qualityEvents = store.qualityEvents || [];
  store.invocationLogs = store.invocationLogs || [];
  store.feedbackEvents.push(feedback);
  store.qualityEvents.push(qualityEvent);
  store.invocationLogs.push({ service_id: serviceId, input, feedback });
  await writePersistentServiceEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId: feedback.request_id,
    event: feedback
  });
  await writePersistentServiceEvent({
    eventType: "quality_event",
    serviceId,
    requestId: feedback.request_id,
    event: qualityEvent
  });

  return {
    statusCode: paidResponse.status,
    body: {
      result: body,
      feedback
    }
  };
}

function isPlatformManagedCreditsEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (!endpoint.pathname.startsWith("/provider/")) return false;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname.toLowerCase());
  if (loopback && process.env.NODE_ENV !== "production") return true;
  if (endpoint.protocol !== "https:") return false;

  const trustedOrigins = new Set(["https://agentrouter.network"]);
  for (const configured of [process.env.AGENT_ROUTER_PUBLIC_URL, process.env.ADN_PUBLIC_BASE_URL]) {
    try {
      if (configured) trustedOrigins.add(new URL(configured).origin);
    } catch {}
  }
  const renderHostname = String(process.env.RENDER_EXTERNAL_HOSTNAME || "").trim();
  if (renderHostname) trustedOrigins.add(`https://${renderHostname}`);
  return trustedOrigins.has(endpoint.origin);
}

function paidProviderTransportOptions(value) {
  if (!isPlatformManagedCreditsEndpoint(value)) return {};
  try {
    const endpoint = new URL(String(value));
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname.toLowerCase());
    if (!loopback) return {};
    return {
      trustedOrigins: [{
        origin: endpoint.origin,
        pathPrefixes: ["/provider/"]
      }]
    };
  } catch {
    return {};
  }
}

function creditsProviderTransportOptions(value, overrides = {}) {
  const injectable = {};
  for (const key of [
    "timeoutMs",
    "maxRequestBytes",
    "maxResponseBytes",
    "lookup",
    "requestHop",
    "httpRequest",
    "httpsRequest"
  ]) {
    if (overrides?.[key] !== undefined) injectable[key] = overrides[key];
  }
  return {
    ...injectable,
    ...paidProviderTransportOptions(value),
    maxRedirects: 0
  };
}

async function recordOperationalFailure(store, record, { input, statusCode, error, started }) {
  const serviceId = record.manifest.service_id;
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: `prepay_fail_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    service_id: serviceId,
    provider_id: record.manifest.provider.provider_id,
    consumer_id: "agentrouter_consumer",
    payment_tx: null,
    payment_collected: false,
    billing_status: "not_charged",
    result_delivery_status: "not_delivered",
    status: "error",
    http_status: statusCode,
    schema_valid: false,
    verification: null,
    business_error: error,
    latency_ms: Date.now() - started,
    consumer_rating: 0,
    created_at: new Date().toISOString()
  };
  record.feedback_events = record.feedback_events || [];
  record.feedback_events.push(feedback);
  store.feedbackEvents = store.feedbackEvents || [];
  store.invocationLogs = store.invocationLogs || [];
  store.feedbackEvents.push(feedback);
  store.invocationLogs.push({ service_id: serviceId, input, feedback });
  await writePersistentServiceEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId: feedback.request_id,
    event: feedback
  });
  return feedback;
}

async function createArcProofForProviderChallenge({ serviceId, manifest, payment, consumerId }) {
  const wallet = await readWallet();
  const policyManifest = {
    ...manifest,
    pricing: {
      ...manifest.pricing,
      network: payment.network,
      token_address: payment.token_address,
      pay_to: payment.pay_to,
      settlement_model: payment.settlement_model
    }
  };
  await assertPolicyAllows({
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    providerId: manifest.provider.provider_id,
    manifest: policyManifest,
    challenge: payment
  });
  const balance = await assertArcUsdcBalance({ wallet, payment });
  const tx = await sendArcUsdcTransfer({ wallet, payment });
  const proof = createArcPaymentProof({
    wallet,
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    challenge: payment,
    tx
  });
  await recordPayment({
    event_version: "agent_server_side_arc_payment_event_v1",
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: consumerId,
    payer: wallet.address,
    payment_tx: tx.tx_hash,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    pay_to: payment.pay_to,
    challenge_nonce: payment.nonce,
    balance_before_payment: balance,
    arc_transfer: tx,
    status: "success"
  });
  return proof;
}

export async function runServiceHealthCheck(store, serviceId, transportOptions = {}) {
  const record = store.services.get(serviceId);
  if (!record) return { ok: false, error: "SERVICE_NOT_FOUND" };
  const validation = await validateService(store, serviceId, transportOptions);
  record.health_checks = record.health_checks || [];
  const healthEvent = {
    event_version: "agent_service_health_check_v1",
    service_id: serviceId,
    provider_id: record.manifest.provider.provider_id,
    ok: validation.ok,
    validation,
    created_at: new Date().toISOString()
  };
  record.health_checks.push(healthEvent);
  await writePersistentServiceEvent({
    eventType: "health_check",
    serviceId,
    requestId: healthEvent.created_at,
    event: healthEvent
  });
  return healthEvent;
}

export async function recordConsumerFeedback(store, body = {}, {
  actorKey = "",
  requireKnownInvocation = false,
  writeEvent = writePersistentServiceEvent
} = {}) {
  const serviceId = body.service_id;
  const record = store.services.get(serviceId);
  const requestId = body.request_id || body.feedback?.request_id;
  if (!requestId) {
    const error = new Error("request_id is required");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  // External API sources are callable and rateable but are not registry
  // entries, so their invocations live in the global event list. Without this
  // branch a successful Exa call could never be rated — only registry services
  // could — and reputation would only ever reflect failures.
  if (!record) {
    const external = [...(store.feedbackEvents || [])]
      .reverse()
      .find((event) => event.request_id === requestId && (!serviceId || event.service_id === serviceId));
    if (external) {
      assertFeedbackActor(external, actorKey);
      const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
      const existing = existingConsumerFeedbackResult(external, consumerFeedback, actorKey);
      if (existing) return existing;
      if (external.execution_location === "user_device" && requireKnownInvocation) {
        assertLocalFeedbackGrant(store, {
          requestId,
          serviceId: external.service_id,
          actorKey,
          feedbackToken: body.feedback_token
        });
      }
      const event = consumerFeedbackEvent({ target: external, requestId, actorKey, consumerFeedback });
      await writeEvent({ eventType: "consumer_feedback", serviceId: external.service_id, requestId, event });
      external.consumer_feedback = consumerFeedback;
      external.consumer_rating = consumerFeedback.consumer_score;
      if (actorKey) {
        external.consumer_feedback_actor_key = actorKey;
        external.consumer_id = actorKey;
      }
      external.updated_at = new Date().toISOString();
      if (!store.feedbackEvents.some((item) => sameConsumerEvent(item, event))) store.feedbackEvents.push(event);
      return {
        ok: true,
        status: "consumer_feedback_recorded",
        service_id: external.service_id,
        request_id: requestId,
        consumer_feedback: consumerFeedback,
        recorded_at: external.updated_at
      };
    }
    // Local connector runs execute on the user's device, so the server has no
    // prior event to attach to. Accept the rating and create the record, or
    // free local paths could never build a reputation at all.
    const localMatch = parseLocalFeedbackRequestId(requestId);
    if (localMatch) {
      if (requireKnownInvocation) {
        const error = new Error("A server-issued local feedback grant is required for this request_id.");
        error.statusCode = 404;
        error.code = "LOCAL_FEEDBACK_GRANT_REQUIRED";
        throw error;
      }
      const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
      const localServiceId = serviceId || `local_social_${localMatch.platform}`;
      const event = {
        event_version: "agent_local_connector_feedback_v1",
        request_id: requestId,
        service_id: localServiceId,
        provider_id: "local_browser_connector",
        consumer_id: actorKey || body.consumer_id || "unknown_consumer_agent",
        consumer_feedback_actor_key: actorKey || undefined,
        status: "success",
        schema_valid: true,
        execution_location: "user_device",
        consumer_feedback: consumerFeedback,
        consumer_rating: consumerFeedback.consumer_score,
        created_at: new Date().toISOString()
      };
      await writeEvent({ eventType: "consumer_feedback", serviceId: localServiceId, requestId, event });
      (store.feedbackEvents ||= []).push(event);
      return {
        ok: true,
        status: "consumer_feedback_recorded",
        service_id: localServiceId,
        request_id: requestId,
        consumer_feedback: consumerFeedback,
        recorded_at: event.created_at
      };
    }
    const error = new Error("SERVICE_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  const consumerFeedback = normalizeConsumerFeedback(body.feedback || body);
  const targetEvent = [...(record.feedback_events || [])].reverse().find((event) => event.request_id === requestId);
  if (targetEvent) {
    assertFeedbackActor(targetEvent, actorKey);
    const existing = existingConsumerFeedbackResult(targetEvent, consumerFeedback, actorKey);
    if (existing) return { ...existing, trust: summarizeTrust(record) };
    const event = consumerFeedbackEvent({ target: targetEvent, requestId, actorKey, consumerFeedback });
    await writeEvent({ eventType: "consumer_feedback", serviceId, requestId, event });
    targetEvent.consumer_feedback = consumerFeedback;
    targetEvent.consumer_rating = consumerFeedback.consumer_score;
    if (actorKey) {
      targetEvent.consumer_feedback_actor_key = actorKey;
      targetEvent.consumer_id = actorKey;
    }
    targetEvent.updated_at = new Date().toISOString();
    if (!store.feedbackEvents.some((item) => sameConsumerEvent(item, event))) store.feedbackEvents.push(event);
  } else {
    if (requireKnownInvocation) {
      const error = new Error("INVOCATION_NOT_FOUND");
      error.statusCode = 404;
      error.code = "INVOCATION_NOT_FOUND";
      throw error;
    }
    const target = {
      event_version: "agent_service_feedback_v1",
      request_id: requestId,
      service_id: serviceId,
      provider_id: record.manifest.provider.provider_id,
      consumer_id: actorKey || body.consumer_id || "unknown_consumer_agent",
      consumer_feedback_actor_key: actorKey || undefined,
      status: "consumer_feedback_only",
      schema_valid: null,
      latency_ms: null,
      consumer_rating: consumerFeedback.consumer_score,
      consumer_feedback: consumerFeedback,
      created_at: new Date().toISOString()
    };
    const event = consumerFeedbackEvent({ target, requestId, actorKey, consumerFeedback });
    await writeEvent({ eventType: "consumer_feedback", serviceId, requestId, event });
    record.feedback_events.push(target);
    if (!store.feedbackEvents.some((item) => sameConsumerEvent(item, event))) store.feedbackEvents.push(event);
  }
  return {
    ok: true,
    status: "consumer_feedback_recorded",
    service_id: serviceId,
    request_id: requestId,
    consumer_feedback: consumerFeedback,
    trust: summarizeTrust(record)
  };
}

function consumerFeedbackEvent({ target, requestId, actorKey, consumerFeedback }) {
  return {
    event_version: "agent_consumer_feedback_v1",
    service_id: target.service_id,
    provider_id: target.provider_id,
    request_id: requestId,
    consumer_id: actorKey || target.consumer_id || "unknown_consumer_agent",
    consumer_feedback_actor_key: actorKey || undefined,
    consumer_feedback: consumerFeedback,
    created_at: new Date().toISOString()
  };
}

function existingConsumerFeedbackResult(target, consumerFeedback, actorKey) {
  if (!target.consumer_feedback) return null;
  const same = JSON.stringify(target.consumer_feedback) === JSON.stringify(consumerFeedback);
  if (!same) {
    const error = new Error("Different feedback has already been recorded for this invocation.");
    error.statusCode = 409;
    error.code = "CONSUMER_FEEDBACK_CONFLICT";
    throw error;
  }
  return {
    ok: true,
    status: "consumer_feedback_already_recorded",
    service_id: target.service_id,
    request_id: target.request_id,
    consumer_feedback: target.consumer_feedback,
    recorded_at: target.updated_at || target.created_at,
    consumer_id: actorKey || target.consumer_id,
    trust_anchor: target.consumer_feedback_trust_anchor || target.trust_anchor || null
  };
}

function sameConsumerEvent(left, right) {
  return left.event_version === "agent_consumer_feedback_v1"
    && left.request_id === right.request_id
    && left.service_id === right.service_id
    && left.consumer_id === right.consumer_id;
}

export function parseLocalFeedbackRequestId(requestId) {
  const match = /^local_(search|post|read_user_posts)_([a-z]+)_([A-Za-z0-9_-]{4,160})$/.exec(String(requestId || ""));
  return match ? { operation: match[1], platform: match[2] } : null;
}

const LOCAL_FEEDBACK_PLATFORM_CAPABILITIES = Object.freeze({
  search: Object.freeze({
    x: ["social_search", "social_keyword_search", "social_user_voice_research"],
    reddit: ["social_search", "social_keyword_search", "social_user_voice_research"],
    xiaohongshu: ["social_search", "social_keyword_search", "social_user_voice_research"],
    bilibili: ["social_search", "social_keyword_search", "social_user_voice_research"],
    youtube: ["social_search", "social_keyword_search", "social_user_voice_research"],
    zhihu: ["social_search", "social_keyword_search", "social_user_voice_research"],
    weibo: ["social_search", "social_keyword_search", "social_user_voice_research"]
  }),
  read_user_posts: Object.freeze({
    x: ["social_search", "social_keyword_search", "social_user_voice_research"]
  }),
  post: Object.freeze({
    x: ["social_post_read"],
    tiktok: ["social_post_read"],
    youtube: ["social_post_read"],
    bilibili: ["social_post_read"],
    reddit: ["social_post_read"],
    xiaohongshu: ["social_post_read"],
    zhihu: ["social_post_read"],
    weibo: ["social_post_read"]
  })
});

const LOCAL_FEEDBACK_RESULT_STATUSES = new Set(["completed", "no_results"]);

function invalidLocalFeedbackGrant(message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = "INVALID_LOCAL_FEEDBACK_GRANT";
  return error;
}

function normalizeLocalFeedbackGrantMetadata(body, parsed, existing = null) {
  const operation = String(body.operation || existing?.operation || parsed.operation).trim().toLowerCase();
  const platform = String(body.platform || existing?.platform || parsed.platform).trim().toLowerCase();
  if (operation !== parsed.operation || platform !== parsed.platform) {
    throw invalidLocalFeedbackGrant("Local feedback metadata does not match request_id.");
  }
  const allowedCapabilities = LOCAL_FEEDBACK_PLATFORM_CAPABILITIES[operation]?.[platform];
  if (!allowedCapabilities) {
    throw invalidLocalFeedbackGrant("The local feedback platform and operation are not supported.");
  }
  const defaultCapability = operation === "post" ? "social_post_read" : "social_search";
  const capability = String(body.capability || existing?.capability || defaultCapability).trim().toLowerCase();
  if (!allowedCapabilities.includes(capability)) {
    throw invalidLocalFeedbackGrant("The local feedback capability does not match its platform operation.");
  }
  const resultStatus = String(body.result_status || existing?.result_status || "completed").trim().toLowerCase();
  if (!LOCAL_FEEDBACK_RESULT_STATUSES.has(resultStatus) || (operation === "post" && resultStatus !== "completed")) {
    throw invalidLocalFeedbackGrant("The local feedback result status is not eligible for a grant.");
  }
  return { operation, platform, capability, result_status: resultStatus };
}

export async function issueLocalFeedbackGrant(store, body = {}, options = {}) {
  const actorKey = options.actorKey || "";
  const randomBytes = options.randomBytes || ((size) => crypto.randomBytes(size));
  const writeEvents = typeof options.writeEvents === "function"
    ? options.writeEvents
    : typeof options.writeEvent === "function"
      ? async (entries) => {
          let durable = true;
          for (const entry of entries) {
            const result = await options.writeEvent(entry);
            if (result === false) durable = false;
          }
          return durable;
        }
      : writePersistentServiceEventsAtomically;
  const requestId = String(body.request_id || "").trim();
  const parsed = parseLocalFeedbackRequestId(requestId);
  if (!actorKey || !parsed) {
    const error = new Error("A valid local request_id and authenticated actor are required.");
    error.statusCode = actorKey ? 422 : 401;
    error.code = actorKey ? "INVALID_LOCAL_FEEDBACK_GRANT" : "AUTH_REQUIRED";
    throw error;
  }
  const serviceId = String(body.service_id || `local_social_${parsed.platform}`);
  if (serviceId !== `local_social_${parsed.platform}`) {
    const error = new Error("Local feedback grant metadata does not match request_id.");
    error.statusCode = 422;
    error.code = "LOCAL_FEEDBACK_GRANT_MISMATCH";
    throw error;
  }
  const existing = store.feedbackGrants?.get(requestId);
  const metadata = normalizeLocalFeedbackGrantMetadata(body, parsed, existing);
  if (existing) {
    if (existing.actor_key !== actorKey) {
      const error = new Error("This local invocation belongs to another authenticated account.");
      error.statusCode = 403;
      error.code = "FORBIDDEN_FEEDBACK_ACTOR";
      throw error;
    }
    if (existing.public?.feedback_token) {
      return {
        ...existing.public,
        status: "feedback_grant_already_issued",
        routing_observation_id: existing.routing_observation_id || existing.public.routing_observation_id || null
      };
    }
    const feedbackToken = randomBytes(32).toString("base64url");
    const rotatedAt = new Date().toISOString();
    const rotated = { ...existing, token_hash: hashJson(feedbackToken), rotated_at: rotatedAt };
    await writeEvents([{ eventType: "feedback_grant_rotation", serviceId, requestId, event: rotated }]);
    const publicGrant = {
      ok: true,
      status: "feedback_grant_rotated",
      request_id: requestId,
      service_id: serviceId,
      feedback_token: feedbackToken,
      created_at: existing.created_at,
      rotated_at: rotatedAt,
      routing_observation_id: existing.routing_observation_id || null
    };
    store.feedbackGrants.set(requestId, { ...rotated, public: publicGrant });
    return publicGrant;
  }
  const feedbackToken = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  const localObservation = localRouteObservationFromGrant({
    store,
    body,
    actorKey,
    serviceId,
    requestId,
    createdAt
  });
  const grant = {
    event_version: "agent_local_feedback_grant_v1",
    request_id: requestId,
    service_id: serviceId,
    provider_id: "local_browser_connector",
    actor_key: actorKey,
    operation: metadata.operation,
    platform: metadata.platform,
    capability: metadata.capability,
    result_status: metadata.result_status,
    token_hash: hashJson(feedbackToken),
    created_at: createdAt,
    routing_observation_id: localObservation?.observation_id || null
  };
  const entries = [
    ...(localObservation ? [{ eventType: "route_observation", serviceId, requestId, event: localObservation }] : []),
    { eventType: "feedback_grant", serviceId, requestId, event: grant }
  ];
  const durable = await writeEvents(entries);
  if (localObservation) {
    localObservation.durability_status = durable === false ? "memory_only" : "durable";
    store.routeObservations ||= [];
    if (!store.routeObservations.some((item) => item.observation_id === localObservation.observation_id)) {
      store.routeObservations.push(localObservation);
    }
  }
  const operational = localOperationalEventFromGrant(grant);
  store.feedbackGrants ||= new Map();
  const publicGrant = {
    ok: true,
    status: "feedback_grant_issued",
    request_id: requestId,
    service_id: serviceId,
    feedback_token: feedbackToken,
    created_at: createdAt,
    routing_observation_id: localObservation?.observation_id || null,
    routing_observation_durability: localObservation?.durability_status || null
  };
  store.feedbackGrants.set(requestId, { ...grant, public: publicGrant });
  if (!store.feedbackEvents.some((event) => event.request_id === requestId && event.service_id === serviceId)) {
    store.feedbackEvents.push(operational);
  }
  return publicGrant;
}

export function feedbackGrantActorKey(store, body = {}) {
  const requestId = String(body.request_id || body.feedback?.request_id || "").trim();
  const grant = store.feedbackGrants?.get(requestId);
  const serviceId = String(body.service_id || grant?.service_id || "");
  const tokenHash = hashJson(String(body.feedback_token || ""));
  if (!grant || grant.service_id !== serviceId || grant.token_hash !== tokenHash) return "";
  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) return "";
  return grant.actor_key || "";
}

function assertLocalFeedbackGrant(store, { requestId, serviceId, actorKey, feedbackToken }) {
  const grant = store.feedbackGrants?.get(requestId);
  if (!grant || grant.service_id !== serviceId || grant.actor_key !== actorKey || hashJson(String(feedbackToken || "")) !== grant.token_hash) {
    const error = new Error("A valid server-issued local feedback grant is required for this invocation.");
    error.statusCode = grant && grant.actor_key !== actorKey ? 403 : 404;
    error.code = grant && grant.actor_key !== actorKey ? "FORBIDDEN_FEEDBACK_ACTOR" : "LOCAL_FEEDBACK_GRANT_REQUIRED";
    throw error;
  }
}

function localOperationalEventFromGrant(grant) {
  const success = ["completed", "no_results", "success"].includes(grant.result_status);
  return {
    event_version: "agent_local_connector_feedback_v1",
    request_id: grant.request_id,
    service_id: grant.service_id,
    provider_id: grant.provider_id,
    consumer_id: grant.actor_key,
    invocation_actor_key: grant.actor_key,
    status: success ? "success" : "error",
    schema_valid: success,
    execution_location: "user_device",
    operation: grant.operation,
    capability: grant.capability,
    consumer_feedback_expected: true,
    created_at: grant.created_at
  };
}

function localRouteObservationFromGrant({ store, body, actorKey, serviceId, requestId, createdAt }) {
  const parsed = parseLocalFeedbackRequestId(requestId);
  if (!parsed) return null;
  const metadata = normalizeLocalFeedbackGrantMetadata(body, parsed);
  const existing = (store.routeObservations || []).find((item) => item?.request_id === requestId && item?.actor_key === actorKey);
  if (existing?.observation_version === "agent_router_route_observation_v2") return existing;
  const taskFamily = metadata.capability === "social_post_read"
    ? "social_post_read"
    : metadata.capability === "social_user_voice_research"
      ? "social_research"
      : "social_search";
  return createRouteObservationV2({
    observation_id: existing?.observation_id || `route_obs_local_${hashJson({ actorKey, requestId, serviceId }).slice(2, 18)}`,
    request_id: requestId,
    created_at: createdAt,
    entrypoint: "mcp_request",
    task_family: taskFamily,
    route_family: "local_browser",
    capability: metadata.capability,
    source_family: "social",
    action: "route",
    selected_service_id: serviceId,
    candidates: [{
      service_id: serviceId,
      source_family: "local_browser",
      routing_score: 1,
      price_usdc: "0"
    }],
    confidence: 1,
    fallback: {
      used: false,
      from: null,
      to: null,
      reason: null
    },
    authorization: {
      required: false,
      action: "none",
      source: null
    },
    budget: {
      max_price_usdc: "0",
      selected_price_usdc: "0",
      compliant: true
    },
    actor_key: actorKey,
    routing_policy_version: "agentrouter_route_plan_v1",
    diagnostics: {
      local_feedback_grant: true,
      candidate_count: 1,
      eligible_candidate_count: 1,
      policy_gate: "allowed"
    }
  });
}


function assertFeedbackActor(event, actorKey) {
  if (!actorKey) return;
  const invocationActor = event.invocation_actor_key || "";
  if (invocationActor && invocationActor !== actorKey) {
    const error = new Error("Feedback can only be submitted by the account that made this invocation.");
    error.statusCode = 403;
    error.code = "FORBIDDEN_FEEDBACK_ACTOR";
    throw error;
  }
  const existingActor = event.consumer_feedback_actor_key || "";
  if (!existingActor || existingActor === actorKey) return;
  const error = new Error("Feedback for this invocation was already claimed by another authenticated account.");
  error.statusCode = 403;
  error.code = "FORBIDDEN_FEEDBACK_ACTOR";
  throw error;
}

export async function hydratePersistentServiceEvents(store, {
  enabled = persistenceEnabled,
  listClaims = listPersistentProviderClaims,
  listRegistrations = listPersistentRegisteredServices,
  listServiceClaims = listPersistentServiceRegistrationClaims,
  listEvents = listPersistentServiceEvents,
  claim = claimPersistentProviderId,
  claimRegistration = claimPersistentServiceRegistration,
  finalizeRegistration = finalizePersistentServiceRegistration,
  waitForRegistration = waitForPersistentServiceRegistrationActivation,
  rewriteRegistration = rewritePersistentServiceRegistration,
  readConfig = readProviderConfig,
  prepareConfig = prepareProviderConfigForPersistence,
  writePreparedConfig = writePreparedProviderConfigFile
} = {}) {
  const durableRegistrations = await listRegistrations();
  for (const manifest of durableRegistrations) {
    if (!manifest?.service_id || store.services.has(manifest.service_id)) continue;
    registerTrustedService(store, manifest, "");
  }
  materializeProviderClaimsFromServices(store);
  const durableClaims = await listClaims();
  for (const claim of durableClaims) materializeProviderClaim(store, claim);
  const durableServiceClaims = await listServiceClaims();
  for (const serviceClaim of durableServiceClaims) materializeServiceRegistrationClaim(store, serviceClaim);
  const events = await listEvents();
  const result = await hydrateServiceEventRows(store, events);
  const cursor = serviceEventHighWaterCursor(events);
  if (cursor) store.serviceEventCursor = cursor;
  store.serviceEventSync = {
    ok: true,
    status: "fresh",
    stale: false,
    loaded: events.length,
    cursor: store.serviceEventCursor || null,
    last_success_at: new Date().toISOString()
  };

  // One-time compatibility migration for installations that already have
  // provider_claim audit events/configs but predate the authoritative table.
  const persistenceIsEnabled = Boolean(typeof enabled === "function" ? enabled() : enabled);
  if (persistenceIsEnabled) {
    const providersWithServices = new Set();
    for (const record of store.services?.values?.() || []) {
      const serviceId = String(record.manifest?.service_id || "").trim();
      const providerId = String(record.manifest?.provider?.provider_id || "").trim();
      const ownerKey = String(record.manifest?.registration?.owner?.user_key || "").trim();
      if (!serviceId || !providerId || !ownerKey) continue;
      const documents = await prepareLegacyRegistrationDocuments(record, serviceId, {
        readConfig,
        prepareConfig
      });
      let durable = await claimRegistration({ serviceId, providerId, ownerKey });
      if (!durable || durable.status === "provider_conflict") throw providerAlreadyClaimedError(providerId);
      if (durable.status === "service_conflict") throw serviceAlreadyRegisteredError(serviceId);
      if (durable.claim_state === "pending") {
        if (durable.claim_token) {
          if (typeof finalizeRegistration !== "function") throw providerClaimPersistenceUnavailable();
          try {
            durable = await finalizeRegistration({
              serviceId,
              providerId,
              ownerKey,
              claimToken: durable.claim_token,
              config: documents.config,
              manifest: documents.manifest
            });
            documents.persisted = true;
          } catch (error) {
            if (error?.code !== "REGISTRATION_LEASE_LOST") {
              throw providerClaimPersistenceUnavailable(error);
            }
            durable = await waitForCanonicalRegistration(waitForRegistration, {
              serviceId,
              providerId,
              ownerKey
            });
          }
        } else {
          durable = await waitForCanonicalRegistration(waitForRegistration, {
            serviceId,
            providerId,
            ownerKey
          });
        }
      }
      if (documents.rewrite_required && !documents.persisted) {
        if (typeof rewriteRegistration !== "function") throw providerClaimPersistenceUnavailable();
        try {
          durable = await rewriteRegistration({
            serviceId,
            providerId,
            ownerKey,
            config: documents.config,
            manifest: documents.manifest
          });
          documents.persisted = true;
        } catch (error) {
          throw providerClaimPersistenceUnavailable(error);
        }
      }
      if (!durable || String(durable.claim_state || "active") !== "active") {
        throw providerClaimPersistenceUnavailable();
      }
      if (documents.config && documents.persisted) {
        await writePreparedConfig(documents.config);
      }
      record.manifest = documents.manifest;
      const localProviderClaim = store.providerClaims?.get(providerId);
      if (localProviderClaim?.owner_key === ownerKey) {
        localProviderClaim.owner = { user_key: ownerKey };
      }
      materializeServiceRegistrationClaim(store, durable);
      providersWithServices.add(providerId);
    }
    for (const localClaim of store.providerClaims?.values?.() || []) {
      if (providersWithServices.has(localClaim.provider_id)) continue;
      const durable = await claim({
        providerId: localClaim.provider_id,
        ownerKey: localClaim.owner_key
      });
      if (!durable || durable.status === "conflict" || durable.owner_key !== localClaim.owner_key) {
        throw providerAlreadyClaimedError(localClaim.provider_id);
      }
    }
  }
  return {
    ...result,
    registered_services: durableRegistrations.length,
    provider_claims: store.providerClaims?.size || 0,
    service_claims: store.serviceClaims?.size || 0
  };
}

async function prepareLegacyRegistrationDocuments(record, serviceId, {
  readConfig,
  prepareConfig
} = {}) {
  let config = null;
  try {
    config = typeof readConfig === "function" ? await readConfig(serviceId) : null;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (config && providerConfigRequiresMigration(config)) {
    const prepared = await prepareConfig(structuredClone(config));
    return {
      config: prepared,
      manifest: prepared.manifest,
      rewrite_required: true,
      persisted: false
    };
  }
  const safeConfig = config ? minimalRegistrationPersistenceDocument(config) : null;
  const sourceManifest = safeConfig?.manifest || record.manifest;
  const manifest = minimalRegistrationPersistenceDocument(sourceManifest);
  finalizeManifest(manifest, safeConfig);
  return {
    config: safeConfig,
    manifest,
    rewrite_required: manifestRequiresMigration(sourceManifest, manifest),
    persisted: false
  };
}

function manifestRequiresMigration(sourceManifest, preparedManifest) {
  const owner = sourceManifest?.registration?.owner || null;
  const ownerKeys = owner && typeof owner === "object" ? Object.keys(owner) : [];
  if (ownerKeys.some((key) => key !== "user_key")) return true;
  const manifestHash = createManifestHash(preparedManifest);
  const configHash = preparedManifest?.integrity?.config_hash;
  return sourceManifest?.integrity?.manifest_hash !== manifestHash
    || sourceManifest?.integrity?.config_hash !== configHash
    || sourceManifest?.registration?.manifest_hash !== manifestHash
    || sourceManifest?.registration?.config_hash !== configHash
    || sourceManifest?.erc8257?.metadata_hash !== manifestHash;
}

function providerConfigRequiresMigration(config) {
  const manifest = config?.manifest || {};
  const owner = manifest.registration?.owner || null;
  const ownerKeys = owner && typeof owner === "object" ? Object.keys(owner) : [];
  if (ownerKeys.some((key) => key !== "user_key")) return true;
  if (config?.source?.auth?.secret_value) return true;
  const manifestHash = createManifestHash(manifest);
  const configHash = createConfigHash(config);
  return manifest.integrity?.manifest_hash !== manifestHash
    || manifest.integrity?.config_hash !== configHash
    || manifest.registration?.manifest_hash !== manifestHash
    || manifest.registration?.config_hash !== configHash
    || manifest.erc8257?.metadata_hash !== manifestHash;
}

async function waitForCanonicalRegistration(waitForRegistration, expected) {
  if (typeof waitForRegistration !== "function") throw providerClaimPersistenceUnavailable();
  let canonical;
  try {
    canonical = await waitForRegistration(expected);
  } catch (error) {
    throw providerClaimPersistenceUnavailable(error);
  }
  if (
    !canonical
    || canonical.claim_state !== "active"
    || String(canonical.service_id || "") !== expected.serviceId
    || String(canonical.provider_id || "") !== expected.providerId
    || String(canonical.owner_key || "") !== expected.ownerKey
  ) {
    throw providerClaimPersistenceUnavailable();
  }
  return canonical;
}

/**
 * Incrementally reduce durable events committed since this process's last
 * (created_at,event_id) cursor. Concurrent requests in one process share a
 * single refresh, while separate instances independently converge on the same
 * ordered event stream.
 */
export async function refreshPersistentServiceEvents(store, {
  enabled = persistenceEnabled,
  listEvents = listPersistentServiceEvents
} = {}) {
  const persistenceIsEnabled = Boolean(typeof enabled === "function" ? enabled() : enabled);
  if (!persistenceIsEnabled) {
    const disabled = {
      ok: true,
      status: "disabled",
      stale: false,
      loaded: 0,
      cursor: store.serviceEventCursor || null
    };
    store.serviceEventSync = disabled;
    return disabled;
  }

  const pending = serviceEventRefreshes.get(store);
  if (pending) return pending;

  const refresh = (async () => {
    const previousCursor = store.serviceEventCursor || null;
    try {
      const events = await listEvents({
        afterEventId: previousCursor?.event_id || null
      });
      if (!Array.isArray(events)) {
        const error = new Error("Persistent service-event refresh returned an invalid event page.");
        error.code = "LIVE_STATE_REFRESH_INVALID_RESULT";
        throw error;
      }
      const nextCursor = serviceEventHighWaterCursor(events);
      if (events.length > 0 && !nextCursor) {
        const error = new Error("Persistent service-event refresh did not return a durable keyset cursor.");
        error.code = "LIVE_STATE_REFRESH_CURSOR_MISSING";
        throw error;
      }
      await hydrateServiceEventRows(store, events);
      if (nextCursor) store.serviceEventCursor = nextCursor;
      const success = {
        ok: true,
        status: "fresh",
        stale: false,
        loaded: events.length,
        cursor: store.serviceEventCursor || null,
        last_success_at: new Date().toISOString()
      };
      store.serviceEventSync = success;
      return success;
    } catch (error) {
      const degraded = {
        ok: false,
        status: "degraded",
        stale: true,
        loaded: 0,
        cursor: previousCursor,
        last_success_at: store.serviceEventSync?.last_success_at || null,
        checked_at: new Date().toISOString(),
        error: {
          code: error.code || "LIVE_STATE_REFRESH_FAILED",
          message: error.message || "Persistent live-state refresh failed."
        }
      };
      store.serviceEventSync = degraded;
      return degraded;
    }
  })();
  serviceEventRefreshes.set(store, refresh);
  try {
    return await refresh;
  } finally {
    if (serviceEventRefreshes.get(store) === refresh) serviceEventRefreshes.delete(store);
  }
}

function serviceEventCursorFromRow(row) {
  const createdAt = String(row?.created_at_cursor || row?.created_at || "").trim();
  const eventId = String(row?.event_id || "").trim();
  return createdAt && eventId ? { created_at: createdAt, event_id: eventId } : null;
}

function serviceEventHighWaterCursor(events = []) {
  let highWater = null;
  for (const row of events) {
    const eventId = String(row?.event_id || "").trim();
    if (!/^\d+$/.test(eventId)) continue;
    if (!highWater || BigInt(eventId) > BigInt(highWater.event_id)) highWater = row;
  }
  return serviceEventCursorFromRow(highWater);
}

function materializeProviderClaimsFromServices(store) {
  const providerIds = new Set();
  for (const record of store.services?.values?.() || []) {
    const providerId = String(record.manifest?.provider?.provider_id || "").trim();
    if (providerId) providerIds.add(providerId);
  }
  for (const providerId of providerIds) {
    const claim = providerClaimFromExistingServices(store, providerId);
    if (claim) materializeProviderClaim(store, claim);
  }
}

export async function hydrateServiceEventRows(store, events = []) {
  const hydratedRoutingFeedback = new Set();
  for (const row of events) {
    const event = row.event;
    if (row.event_type === "provider_claim") {
      if (event?.event_version === "agent_router_provider_claim_v1") {
        materializeProviderClaim(store, event);
      }
      continue;
    }
    if (row.event_type === "invocation_feedback_grant" || row.event_type === "invocation_feedback_grant_rotation") {
      store.feedbackGrants ||= new Map();
      store.feedbackGrants.set(row.request_id, event);
      continue;
    }
    if (row.event_type === "feedback_grant" || row.event_type === "feedback_grant_rotation") {
      store.feedbackGrants ||= new Map();
      store.feedbackGrants.set(row.request_id, event);
      const operational = localOperationalEventFromGrant(event);
      if (!store.feedbackEvents.some((item) => item.request_id === row.request_id && item.service_id === row.service_id)) {
        store.feedbackEvents.push(operational);
      }
      continue;
    }
    if (row.event_type === "issued_quote") {
      store.issuedQuotes ||= new Map();
      if (Number(event.expires_at || 0) > Date.now()) store.issuedQuotes.set(event.quote_id, event);
      continue;
    }
    if (row.event_type === "erc8004_hire_invocation") {
      store.feedbackEvents ||= [];
      store.invocationLogs ||= [];
      if (!store.feedbackEvents.some((item) => item.request_id === event.request_id && item.service_id === event.service_id)) {
        store.feedbackEvents.push(event);
      }
      if (!store.invocationLogs.some((item) => item.request_id === event.request_id && item.service_id === event.service_id)) {
        store.invocationLogs.push(event);
      }
      continue;
    }
    if (row.event_type === "operational_feedback") {
      const record = store.services.get(row.service_id);
      if (record && !record.feedback_events.some((item) => item.request_id === event.request_id && item.payment_tx === event.payment_tx)) {
        record.feedback_events.push(event);
      }
      if (!store.feedbackEvents.some((item) => item.request_id === event.request_id && item.payment_tx === event.payment_tx)) {
        store.feedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "consumer_feedback") {
      const record = store.services.get(row.service_id);
      if (record) {
        const existing = [...record.feedback_events].reverse().find((item) => item.request_id === row.request_id);
        if (existing) {
          existing.consumer_feedback = event.consumer_feedback;
          existing.consumer_rating = event.consumer_feedback?.consumer_score ?? existing.consumer_rating;
        } else if (!record.feedback_events.some((item) => item.request_id === row.request_id && item.status === "consumer_feedback_only")) {
          record.feedback_events.push({
            event_version: "agent_service_feedback_v1",
            request_id: row.request_id,
            service_id: row.service_id,
            provider_id: record.manifest.provider.provider_id,
            consumer_id: event.consumer_id,
            status: "consumer_feedback_only",
            schema_valid: null,
            latency_ms: null,
            consumer_rating: event.consumer_feedback?.consumer_score ?? null,
            consumer_feedback: event.consumer_feedback,
            created_at: event.created_at
          });
        }
      }
      const globalOperational = [...store.feedbackEvents].reverse().find((item) =>
        item.request_id === row.request_id &&
        item.service_id === row.service_id &&
        item.event_version !== "agent_consumer_feedback_v1"
      );
      if (globalOperational) {
        globalOperational.consumer_feedback = event.consumer_feedback;
        globalOperational.consumer_rating = event.consumer_feedback?.consumer_score ?? globalOperational.consumer_rating;
        globalOperational.consumer_feedback_actor_key = event.consumer_feedback_actor_key || event.consumer_id;
      }
      if (!store.feedbackEvents.some((item) => item.event_version === event.event_version && item.request_id === event.request_id && item.consumer_id === event.consumer_id)) {
        store.feedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "quote_feedback") {
      store.quoteFeedbackEvents ||= [];
      if (!store.quoteFeedbackEvents.some((item) => item.quote_id === event.quote_id && item.actor_key === event.actor_key)) {
        store.quoteFeedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "consumer_feedback_anchor") {
      const record = store.services.get(row.service_id);
      if (record) {
        const target = [...record.feedback_events].reverse().find((item) => item.request_id === row.request_id);
        if (target) {
          target.consumer_feedback_arc_anchor = event.arc_anchor;
          if (event.erc8004) target.consumer_feedback_erc8004 = event.erc8004;
          if (event.trust_anchor) target.consumer_feedback_trust_anchor = event.trust_anchor;
        }
      }
      const target = [...store.feedbackEvents].reverse().find((item) =>
        item.request_id === row.request_id &&
        item.service_id === row.service_id &&
        item.event_version === "agent_consumer_feedback_v1"
      );
      if (target) {
        target.arc_anchor = event.arc_anchor;
        if (event.erc8004) target.erc8004 = event.erc8004;
        if (event.trust_anchor) target.trust_anchor = event.trust_anchor;
      }
      continue;
    }
    if (row.event_type === "consumer_feedback_erc8004_client") {
      const record = store.services.get(row.service_id);
      const target = [...(record?.feedback_events || [])].reverse().find((item) => item.request_id === row.request_id);
      if (target && event.erc8004) {
        target.consumer_feedback_erc8004 = event.erc8004;
        target.consumer_feedback_trust_anchor = {
          ...(target.consumer_feedback_trust_anchor || {}),
          primary_standard: "ERC-8004",
          state: event.erc8004.status === "submitted" ? "onchain_submitted" : "onchain_failed",
          erc8004: event.erc8004,
          updated_at: event.created_at || new Date().toISOString()
        };
      }
      const globalTarget = [...store.feedbackEvents].reverse().find((item) =>
        item.request_id === row.request_id && item.service_id === row.service_id
      );
      if (globalTarget && event.erc8004) {
        globalTarget.erc8004 = event.erc8004;
        globalTarget.trust_anchor = target?.consumer_feedback_trust_anchor || {
          state: event.erc8004.status === "submitted" ? "onchain_submitted" : "onchain_failed",
          primary_standard: "ERC-8004",
          erc8004: event.erc8004
        };
      }
      continue;
    }
    if (row.event_type === "erc8004_identity") {
      const record = store.services.get(row.service_id);
      if (record && event.erc8004) {
        applyErc8004RegistrationToManifest(record.manifest, event.erc8004);
        if (record.manifest.provider?.provider_id) {
          store.providers.set(record.manifest.provider.provider_id, record.manifest.provider);
        }
      }
      continue;
    }
    if (row.event_type === "erc8004_platform_identity") {
      store.erc8004PlatformIdentities ||= new Map();
      if (event?.network && event?.agent_id) {
        store.erc8004PlatformIdentities.set(event.network, event);
      }
      continue;
    }
    if (row.event_type === "erc8004_vendor_identity") {
      if (event?.provider_id && event?.network && event?.agent_id) {
        applyErc8004VendorIdentity(store, event.provider_id, event);
      }
      continue;
    }
    if (row.event_type === "erc8004_agent_import") {
      if (event?.chain_id && event?.agent_id) {
        store.erc8004Imports ||= new Map();
        store.erc8004Imports.set(`${event.chain_id}:${event.agent_id}`, event);
      }
      continue;
    }
    if (row.event_type === "quality_event") {
      const record = store.services.get(row.service_id);
      if (record) {
        record.quality_events = record.quality_events || [];
        if (!record.quality_events.some((item) => item.quality_event_id === event.quality_event_id)) {
          record.quality_events.push(event);
        }
      }
      if (!store.qualityEvents.some((item) => item.quality_event_id === event.quality_event_id)) {
        store.qualityEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "health_check") {
      const record = store.services.get(row.service_id);
      if (record) {
        record.health_checks = record.health_checks || [];
        if (!record.health_checks.some((item) => item.created_at === event.created_at)) record.health_checks.push(event);
      }
      continue;
    }
    if (row.event_type === "route_observation") {
      if (!store.routeObservations.some((item) => item.observation_id === event.observation_id)) {
        store.routeObservations.push(event);
      }
      continue;
    }
    if (row.event_type === "routing_feedback") {
      store.routingFeedbackEvents ||= [];
      const valid = event?.event_version === "agent_router_routing_feedback_v1"
        && event?.observation_id
        && event?.request_id
        && event?.actor_key;
      const identity = valid ? `${event.observation_id}\u0000${event.actor_key}` : "";
      if (valid && !hydratedRoutingFeedback.has(identity)) {
        hydratedRoutingFeedback.add(identity);
        const existingIndex = store.routingFeedbackEvents.findIndex((item) =>
          item?.observation_id === event.observation_id && item?.actor_key === event.actor_key
        );
        if (existingIndex >= 0) store.routingFeedbackEvents[existingIndex] = event;
        else store.routingFeedbackEvents.push(event);
      }
      continue;
    }
    if (row.event_type === "evidence") {
      if (!store.evidenceEvents.some((item) => item.trace_hash === event.trace_hash)) {
        store.evidenceEvents.push(event);
      }
    }
  }
  return {
    ok: true,
    loaded: events.length
  };
}

function createQualityEvent({
  serviceId,
  providerId,
  requestId,
  input,
  result,
  feedback,
  verification,
  schemaErrors = [],
  envelopeErrors = [],
  resultErrors = []
}) {
  const businessError = resultErrors[0] || null;
  const blockingIssues = [
    ...schemaErrors.map((message) => ({ code: "SCHEMA_ERROR", message })),
    ...envelopeErrors.map((message) => ({ code: "ENVELOPE_ERROR", message })),
    ...resultErrors
  ];
  return {
    quality_event_id: `qe_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    event_version: "agent_service_quality_event_v1",
    service_id: serviceId,
    provider_id: providerId,
    request_id: requestId,
    input,
    status: blockingIssues.length ? "quality_issue" : "passed",
    deterministic_verification: verification,
    business_error: businessError ? { detected: true, ...businessError } : { detected: false },
    http_status: feedback.http_status,
    payment_tx: feedback.payment_tx,
    blocking_issue_count: blockingIssues.length,
    blocking_issues: blockingIssues,
    agent_feedback_expected: true,
    created_at: new Date().toISOString()
  };
}

export async function loadProviderConfigs(store, baseUrl, {
  validate = true,
  force = false,
  listConfigs = null
} = {}) {
  const now = Date.now();
  if (!validate && !force && store.providerConfigsLoadedAt && now - store.providerConfigsLoadedAt < 30_000) {
    return [];
  }
  let configs;
  if (typeof listConfigs === "function") {
    configs = await listConfigs();
  } else {
    const { listProviderConfigs } = await import("./provider-config.js");
    configs = await listProviderConfigs({
      force: force || !store.providerConfigsLoadedAt
    });
  }
  const loaded = [];
  for (const config of configs) {
    const manifest = withCurrentRuntimeEndpoint(config.manifest, baseUrl);
    const publishState = String(manifest?.registration?.publish_state || "legacy_published");
    if (publishState === "validating") {
      loaded.push({
        service_id: manifest.service_id,
        record: null,
        validation: null,
        skipped: true,
        reason: "REGISTRATION_NOT_FINALIZED"
      });
      continue;
    }
    if (store.services.has(manifest.service_id)) {
      const record = store.services.get(manifest.service_id);
      claimProviderOwnership(store, manifest);
      record.manifest = manifest;
      record.updated_at = record.updated_at || new Date().toISOString();
      store.providers.set(manifest.provider.provider_id, manifest.provider);
      loaded.push({ service_id: manifest.service_id, record, validation: record.validation_runs?.at(-1) || null, already_loaded: true });
      continue;
    }
    let record;
    try {
      record = registerTrustedService(store, manifest, baseUrl);
    } catch (error) {
      // A previous successful import can leave an equivalent config behind
      // under a different generated service id. Loading persisted configs must
      // be idempotent; keep the first verified source rather than breaking the
      // entire service catalogue with a 409 on every request.
      if (error.code === "SERVICE_SOURCE_ALREADY_REGISTERED" && error.existingServiceId) {
        const existing = store.services.get(error.existingServiceId);
        loaded.push({
          service_id: manifest.service_id,
          record: existing || null,
          validation: existing?.validation_runs?.at(-1) || null,
          duplicate_source: true,
          existing_service_id: error.existingServiceId
        });
        continue;
      }
      throw error;
    }
    let validation = null;
    if (validate) {
      try {
        validation = await validateService(store, manifest.service_id);
        if (!validation.ok) {
          unregisterService(store, manifest.service_id);
        }
      } catch (error) {
        validation = storeValidation(record, {
          ok: false,
          service_id: manifest.service_id,
          error: "VALIDATION_REQUEST_FAILED",
          message: error.message,
          created_at: new Date().toISOString()
        });
        unregisterService(store, manifest.service_id);
      }
    } else if (publishState === "published" || publishState === "legacy_published") {
      validation = {
        ok: true,
        service_id: manifest.service_id,
        source: "persisted_provider_config",
        message: "Loaded from a provider config that was persisted after successful publish validation.",
        created_at: new Date().toISOString()
      };
      record.validation_runs.push(validation);
      record.verification_status = "verified";
    } else {
      validation = {
        ok: false,
        service_id: manifest.service_id,
        source: "persisted_registration",
        message: "The service registration is durable but still requires provider verification.",
        created_at: new Date().toISOString()
      };
      record.validation_runs.push(validation);
      record.verification_status = "pending";
    }
    loaded.push({ service_id: manifest.service_id, record, validation });
  }
  for (const identity of store.erc8004VendorIdentities?.values?.() || []) {
    if (identity?.provider_id && identity?.network && identity?.agent_id) {
      applyErc8004VendorIdentity(store, identity.provider_id, identity);
    }
  }
  if (!validate) store.providerConfigsLoadedAt = now;
  return loaded;
}

export function withCurrentRuntimeEndpoint(manifest, baseUrl) {
  const endpointUrl = manifest?.endpoint?.url || "";
  if (!baseUrl || !endpointUrl) return manifest;
  let pathname = "";
  try {
    pathname = new URL(endpointUrl).pathname;
  } catch {
    return manifest;
  }
  if (!pathname.startsWith("/provider/custom/")) return manifest;
  return finalizeManifest({
    ...manifest,
    endpoint: {
      ...manifest.endpoint,
      url: `${baseUrl.replace(/\/$/, "")}${pathname}`
    }
  });
}

function validateManifest(manifest) {
  const errors = [];
  for (const key of ["manifest_version", "service_id", "provider", "title", "description_for_agent", "capabilities", "input_schema", "output_schema", "sample_request", "sample_response", "pricing", "endpoint"]) {
    if (!manifest?.[key]) errors.push(`${key} is required`);
  }
  if (!manifest?.provider?.provider_id) errors.push("provider.provider_id is required");
  if (!manifest?.pricing?.amount || !manifest?.pricing?.currency || !manifest?.pricing?.network) errors.push("pricing amount/currency/network are required");
  if (!manifest?.endpoint?.url) errors.push("endpoint.url is required");
  if (manifest?.service_id && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(manifest.service_id)) errors.push("service_id must be 3-64 chars and use lowercase letters, numbers, _ or -");
  if (manifest?.pricing?.amount && !(Number(manifest.pricing.amount) > 0)) errors.push("pricing.amount must be positive");
  if (manifest?.capabilities && (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0)) errors.push("capabilities must be a non-empty array");
  return errors;
}

function storeValidation(record, result) {
  record.validation_runs.push(result);
  record.verification_status = result.ok ? "verified" : "failed";
  record.updated_at = new Date().toISOString();
  return result;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}

function validateRealResultFeedback(envelope) {
  const errors = [];
  if (envelope?.status !== "success") {
    errors.push({ code: "RESULT_STATUS_NOT_SUCCESS", message: "Provider envelope status is not success." });
  }
  const data = envelope?.data;
  if (isEmptyData(data)) {
    errors.push({ code: "RESULT_DATA_EMPTY", message: "Provider returned no usable data." });
    return errors;
  }
  if (looksLikePlaceholderData(data)) {
    errors.push({ code: "RESULT_DATA_PLACEHOLDER", message: "Provider returned placeholder data instead of a real result." });
  }
  const applicationError = detectApplicationErrorData(data);
  if (applicationError) errors.push(applicationError);
  return errors;
}

function isEmptyData(data) {
  if (data === undefined || data === null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") {
    const keys = Object.keys(data);
    if (!keys.length) return true;
    if (Object.prototype.hasOwnProperty.call(data, "data") && data.data === null) return true;
    if (Array.isArray(data.data) && data.data.length === 0) return true;
  }
  return data === "";
}

function looksLikePlaceholderData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && data.ok === true;
}

function detectApplicationErrorData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const message = String(data.message || data.error || data.msg || "").toLowerCase();
  if (/missing api key|api key missing|invalid api key|unauthorized|forbidden|token|auth/.test(message)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "auth_or_permission_error",
      message: data.message || data.error || data.msg || "Upstream API reported an authentication or permission error."
    };
  }
  const status = data.status ?? data.code;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : status;
  const successStatuses = new Set([0, 1, 200, "0", "1", "200", "ok", "success", "succeeded"]);
  if (status !== undefined && !successStatuses.has(normalizedStatus) && (data.message || data.error || data.data === null)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "non_success_status",
      message: data.message || data.error || `Upstream API returned non-success status ${status}.`
    };
  }
  if (data.data === null && (data.message || data.error)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "empty_error_payload",
      message: data.message || data.error || "Upstream API returned null data with an error-like message."
    };
  }
  return null;
}

function previewResultData(data) {
  if (data === undefined) return null;
  return compactPreview(data);
}

function compactPreview(value, { maxArrayItems = 5, maxObjectKeys = 24, maxStringLength = 240 } = {}) {
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems).map((item) => compactPreview(item, { maxArrayItems, maxObjectKeys, maxStringLength }));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const output = {};
    for (const [key, child] of entries.slice(0, maxObjectKeys)) {
      output[key] = compactPreview(child, { maxArrayItems, maxObjectKeys, maxStringLength });
    }
    if (entries.length > maxObjectKeys) {
      output.__preview_truncated_keys = entries.length - maxObjectKeys;
    }
    return output;
  }
  if (typeof value === "string" && value.length > maxStringLength) {
    return `${value.slice(0, maxStringLength)}...`;
  }
  return value;
}
