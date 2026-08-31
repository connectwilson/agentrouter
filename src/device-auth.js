import crypto from "node:crypto";

import {
  approvePersistentDeviceAuthorization,
  claimPersistentDeviceAuthorization,
  completePersistentDeviceAuthorization,
  createPersistentDeviceAuthorization,
  persistenceEnabled,
  readPersistentDeviceAuthorizationByDeviceHash,
  readPersistentDeviceAuthorizationByUserHash,
  releasePersistentDeviceAuthorization,
  updatePersistentDeviceAuthorizationPoll
} from "./persistence.js";

const DEVICE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function beginDeviceAuthorization(store, { baseUrl, clientName = "AI agent", now = Date.now() }) {
  const persistence = deviceStatePersistence(store);
  if (persistence.enabled) {
    return beginPersistentDeviceAuthorization(store, persistence, { baseUrl, clientName, now });
  }
  const deviceCode = `ard_${crypto.randomBytes(32).toString("base64url")}`;
  const userCode = createUserCode(store);
  const record = createRecord({ deviceCode, userCode, clientName, now });
  deviceStore(store).set(record.device_code_hash, record);
  return authorizationStart(record, { deviceCode, userCode, baseUrl });
}

export function getDeviceAuthorizationByUserCode(store, userCode, { now = Date.now() } = {}) {
  const normalized = normalizeUserCode(userCode);
  const persistence = deviceStatePersistence(store);
  if (persistence.enabled) {
    return persistence.readByUserCodeHash(hash(normalized)).then((record) => {
      cacheRecord(store, record);
      if (!record || record.expires_at <= now || record.status === "consumed") return null;
      return publicAuthorization(record, normalized);
    });
  }
  const record = [...deviceStore(store).values()].find((entry) => entry.user_code_hash === hash(normalized)) || null;
  if (!record || record.expires_at <= now || record.status === "consumed") return null;
  return publicAuthorization(record, normalized);
}

export function approveDeviceAuthorization(store, { userCode, account, now = Date.now() }) {
  if (!account?.account_id) throw deviceError("A signed-in credit account is required.", "ACCOUNT_REQUIRED", 401);
  const normalized = normalizeUserCode(userCode);
  const persistence = deviceStatePersistence(store);
  if (persistence.enabled) {
    return persistence.approve(hash(normalized), {
      accountId: account.account_id,
      ownerKey: account.owner_key || "",
      now
    }).then((record) => {
      if (!record) throw deviceError("The connection code is invalid or expired.", "INVALID_USER_CODE", 400);
      cacheRecord(store, record);
      return publicAuthorization(record, normalized);
    });
  }
  const record = [...deviceStore(store).values()].find((entry) => entry.user_code_hash === hash(normalized));
  if (!record || record.expires_at <= now || record.status === "consumed") {
    throw deviceError("The connection code is invalid or expired.", "INVALID_USER_CODE", 400);
  }
  if (record.status === "pending") {
    record.status = "approved";
    record.account_id = account.account_id;
    record.owner_key = account.owner_key || "";
    record.approved_at = now;
  }
  return publicAuthorization(record, normalized);
}

export async function pollDeviceAuthorization(store, {
  deviceCode,
  deviceCodeHash = "",
  issueCredential,
  now = Date.now()
}) {
  const recordKey = normalizedDeviceCodeHash(deviceCodeHash) || hash(String(deviceCode || ""));
  const persistence = deviceStatePersistence(store);
  if (persistence.enabled) {
    return pollPersistentDeviceAuthorization(store, persistence, { recordKey, issueCredential, now });
  }
  const record = deviceStore(store).get(recordKey);
  if (!record || record.expires_at <= now || record.status === "consumed") {
    return oauthError("expired_token", "The device authorization is invalid, expired, or already used.");
  }
  if (record.status !== "approved" && record.last_poll_at && now - record.last_poll_at < record.poll_interval_ms) {
    record.poll_interval_ms += 1_000;
    return oauthError("slow_down", "Polling too quickly. Wait before trying again.", {
      interval: Math.ceil(record.poll_interval_ms / 1000)
    });
  }
  record.last_poll_at = now;
  if (record.status !== "approved") {
    return oauthError("authorization_pending", "Waiting for the user to approve this agent connection.");
  }
  if (typeof issueCredential !== "function") {
    throw deviceError("Credential issuer is unavailable.", "CREDENTIAL_ISSUER_UNAVAILABLE", 503);
  }
  record.status = "issuing";
  try {
    const credential = await issueCredential({
      account: approvedAccount(record),
      clientName: record.client_name
    });
    if (!credential?.api_key) throw new Error("Credential issuer returned no access token.");
    record.status = "consumed";
    record.consumed_at = now;
    return credentialResponse(credential, record);
  } catch (error) {
    record.status = "approved";
    throw error;
  }
}

export function hashDeviceCode(deviceCode) {
  return hash(String(deviceCode || ""));
}

async function beginPersistentDeviceAuthorization(store, persistence, { baseUrl, clientName, now }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const deviceCode = `ard_${crypto.randomBytes(32).toString("base64url")}`;
    const userCode = randomUserCode();
    const record = createRecord({ deviceCode, userCode, clientName, now });
    const saved = await persistence.create(record);
    if (!saved) continue;
    cacheRecord(store, saved);
    return authorizationStart(saved, { deviceCode, userCode, baseUrl });
  }
  throw deviceError("Unable to allocate a connection code.", "DEVICE_CODE_UNAVAILABLE", 503);
}

async function pollPersistentDeviceAuthorization(store, persistence, { recordKey, issueCredential, now }) {
  let record = await persistence.readByDeviceCodeHash(recordKey);
  cacheRecord(store, record);
  if (!record || record.expires_at <= now || record.status === "consumed") {
    return oauthError("expired_token", "The device authorization is invalid, expired, or already used.");
  }
  if (record.status !== "approved" && record.last_poll_at && now - record.last_poll_at < record.poll_interval_ms) {
    const interval = record.poll_interval_ms + 1_000;
    record = await persistence.updatePoll(recordKey, { lastPollAt: now, pollIntervalMs: interval }) || record;
    cacheRecord(store, record);
    return oauthError("slow_down", "Polling too quickly. Wait before trying again.", {
      interval: Math.ceil(interval / 1000)
    });
  }
  if (record.status !== "approved") {
    record = await persistence.updatePoll(recordKey, {
      lastPollAt: now,
      pollIntervalMs: record.poll_interval_ms
    }) || record;
    cacheRecord(store, record);
    return oauthError("authorization_pending", "Waiting for the user to approve this agent connection.");
  }
  if (typeof issueCredential !== "function") {
    throw deviceError("Credential issuer is unavailable.", "CREDENTIAL_ISSUER_UNAVAILABLE", 503);
  }
  const claimed = await persistence.claimApproved(recordKey, now);
  if (!claimed) {
    const latest = await persistence.readByDeviceCodeHash(recordKey);
    cacheRecord(store, latest);
    if (!latest || latest.status === "consumed" || latest.expires_at <= now) {
      return oauthError("expired_token", "The device authorization is invalid, expired, or already used.");
    }
    return oauthError("authorization_pending", "Another request is completing this agent connection.");
  }
  cacheRecord(store, claimed);
  let credentialIssued = false;
  try {
    const credential = await issueCredential({
      account: approvedAccount(claimed),
      clientName: claimed.client_name
    });
    if (!credential?.api_key) throw new Error("Credential issuer returned no access token.");
    credentialIssued = true;
    const completed = await persistence.complete(recordKey, now);
    cacheRecord(store, completed);
    return credentialResponse(credential, claimed);
  } catch (error) {
    // Once a bearer has been minted, an uncertain completion write must never
    // reopen the same approval for a second bearer. Leaving it in `issuing`
    // fails closed until expiry; the first key remains visible for revocation
    // in the account dashboard without ever being persisted in this record.
    if (!credentialIssued) {
      const released = await persistence.release(recordKey);
      cacheRecord(store, released);
    }
    throw error;
  }
}

function credentialResponse(credential, record) {
  return {
    access_token: credential.api_key,
    token_type: "Bearer",
    key_id: credential.key_id || null,
    account_id: record.account_id
  };
}

function approvedAccount(record) {
  return {
    account_id: record.account_id,
    owner_key: record.owner_key || null,
    user_profile: {}
  };
}

function authorizationStart(record, { deviceCode, userCode, baseUrl }) {
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/connect`,
    verification_uri_complete: `${origin}/connect?user_code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor((record.expires_at - record.created_at) / 1000),
    interval: Math.floor(record.poll_interval_ms / 1000)
  };
}

function createRecord({ deviceCode, userCode, clientName, now }) {
  return {
    device_code_hash: hash(deviceCode),
    user_code_hash: hash(normalizeUserCode(userCode)),
    client_name: cleanClientName(clientName),
    status: "pending",
    account_id: null,
    owner_key: null,
    created_at: now,
    expires_at: now + DEVICE_TTL_MS,
    approved_at: null,
    consumed_at: null,
    last_poll_at: 0,
    poll_interval_ms: POLL_INTERVAL_MS
  };
}

function publicAuthorization(record, userCode = "") {
  return {
    user_code: normalizeUserCode(userCode),
    client_name: record.client_name,
    status: record.status,
    expires_at: new Date(record.expires_at).toISOString(),
    approved_at: record.approved_at ? new Date(record.approved_at).toISOString() : null
  };
}

function deviceStore(store) {
  if (!store.deviceAuthorizations) store.deviceAuthorizations = new Map();
  return store.deviceAuthorizations;
}

function cacheRecord(store, record) {
  if (record?.device_code_hash) deviceStore(store).set(record.device_code_hash, record);
}

function createUserCode(store) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomUserCode();
    if (![...deviceStore(store).values()].some((entry) => entry.user_code_hash === hash(code))) return code;
  }
  throw deviceError("Unable to allocate a connection code.", "DEVICE_CODE_UNAVAILABLE", 503);
}

function randomUserCode() {
  let raw = "";
  for (let index = 0; index < 8; index += 1) {
    raw += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  }
  return `AR-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeUserCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizedDeviceCodeHash(value) {
  const normalized = String(value || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : "";
}

function cleanClientName(value) {
  return String(value || "AI agent").trim().slice(0, 120) || "AI agent";
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function oauthError(error, errorDescription, extra = {}) {
  return { error, error_description: errorDescription, ...extra };
}

function deviceError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function deviceStatePersistence(store) {
  if (store?.deviceAuthPersistence) {
    return {
      enabled: store.deviceAuthPersistence.enabled !== false,
      create: store.deviceAuthPersistence.create.bind(store.deviceAuthPersistence),
      readByDeviceCodeHash: store.deviceAuthPersistence.readByDeviceCodeHash.bind(store.deviceAuthPersistence),
      readByUserCodeHash: store.deviceAuthPersistence.readByUserCodeHash.bind(store.deviceAuthPersistence),
      approve: store.deviceAuthPersistence.approve.bind(store.deviceAuthPersistence),
      updatePoll: store.deviceAuthPersistence.updatePoll.bind(store.deviceAuthPersistence),
      claimApproved: store.deviceAuthPersistence.claimApproved.bind(store.deviceAuthPersistence),
      complete: store.deviceAuthPersistence.complete.bind(store.deviceAuthPersistence),
      release: store.deviceAuthPersistence.release.bind(store.deviceAuthPersistence)
    };
  }
  return {
    enabled: persistenceEnabled(),
    create: createPersistentDeviceAuthorization,
    readByDeviceCodeHash: readPersistentDeviceAuthorizationByDeviceHash,
    readByUserCodeHash: readPersistentDeviceAuthorizationByUserHash,
    approve: approvePersistentDeviceAuthorization,
    updatePoll: updatePersistentDeviceAuthorizationPoll,
    claimApproved: claimPersistentDeviceAuthorization,
    complete: completePersistentDeviceAuthorization,
    release: releasePersistentDeviceAuthorization
  };
}
