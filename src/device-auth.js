import crypto from "node:crypto";

const DEVICE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function beginDeviceAuthorization(store, { baseUrl, clientName = "AI agent", now = Date.now() }) {
  const deviceCode = `ard_${crypto.randomBytes(32).toString("base64url")}`;
  const userCode = createUserCode(store);
  const origin = String(baseUrl || "https://agentrouter.network").replace(/\/$/, "");
  const record = {
    device_code_hash: hash(deviceCode),
    user_code: userCode,
    client_name: cleanClientName(clientName),
    status: "pending",
    account: null,
    created_at: now,
    expires_at: now + DEVICE_TTL_MS,
    approved_at: null,
    consumed_at: null,
    last_poll_at: 0,
    poll_interval_ms: POLL_INTERVAL_MS
  };
  deviceStore(store).set(record.device_code_hash, record);
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/connect`,
    verification_uri_complete: `${origin}/connect?user_code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(DEVICE_TTL_MS / 1000),
    interval: Math.floor(POLL_INTERVAL_MS / 1000)
  };
}

export function getDeviceAuthorizationByUserCode(store, userCode, { now = Date.now() } = {}) {
  const normalized = normalizeUserCode(userCode);
  const record = [...deviceStore(store).values()].find((entry) => entry.user_code === normalized) || null;
  if (!record || record.expires_at <= now || record.status === "consumed") return null;
  return publicAuthorization(record);
}

export function approveDeviceAuthorization(store, { userCode, account, now = Date.now() }) {
  if (!account?.account_id) throw deviceError("A signed-in credit account is required.", "ACCOUNT_REQUIRED", 401);
  const normalized = normalizeUserCode(userCode);
  const record = [...deviceStore(store).values()].find((entry) => entry.user_code === normalized);
  if (!record || record.expires_at <= now || record.status === "consumed") {
    throw deviceError("The connection code is invalid or expired.", "INVALID_USER_CODE", 400);
  }
  if (record.status === "pending") {
    record.status = "approved";
    record.account = account;
    record.approved_at = now;
  }
  return publicAuthorization(record);
}

export async function pollDeviceAuthorization(store, { deviceCode, issueCredential, now = Date.now() }) {
  const record = deviceStore(store).get(hash(String(deviceCode || "")));
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
      account: record.account,
      clientName: record.client_name
    });
    if (!credential?.api_key) throw new Error("Credential issuer returned no access token.");
    record.status = "consumed";
    record.consumed_at = now;
    return {
      access_token: credential.api_key,
      token_type: "Bearer",
      key_id: credential.key_id || null,
      account_id: record.account.account_id
    };
  } catch (error) {
    record.status = "approved";
    throw error;
  }
}

function publicAuthorization(record) {
  return {
    user_code: record.user_code,
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

function createUserCode(store) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let raw = "";
    for (let index = 0; index < 8; index += 1) {
      raw += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
    }
    const code = `AR-${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (![...deviceStore(store).values()].some((entry) => entry.user_code === code)) return code;
  }
  throw deviceError("Unable to allocate a connection code.", "DEVICE_CODE_UNAVAILABLE", 503);
}

function normalizeUserCode(value) {
  return String(value || "").trim().toUpperCase();
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
