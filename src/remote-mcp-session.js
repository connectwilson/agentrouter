import crypto from "node:crypto";

import {
  deletePersistentRemoteMcpSession,
  persistenceEnabled,
  readPersistentRemoteMcpSession,
  writePersistentRemoteMcpSession
} from "./persistence.js";

const SESSION_TOKEN_PREFIX = "remote-mcp-session-v1";

export async function loadRemoteMcpSession(store, requestedId = "", {
  now = Date.now(),
  ttlMs,
  secret = configuredSessionSecret()
} = {}) {
  if (!store.remoteMcpSessions) store.remoteMcpSessions = new Map();
  for (const [id, record] of store.remoteMcpSessions) {
    if (Number(record.expires_at || 0) <= now) store.remoteMcpSessions.delete(id);
  }
  const persistence = remoteSessionPersistence(store);
  const requested = cleanSessionId(requestedId);
  let session = null;

  if (requested && persistence.enabled) {
    const persisted = await persistence.read(hashSessionId(requested));
    if (persisted && Number(persisted.expires_at || 0) > now) {
      session = openSessionState(persisted.state_opaque, requested, secret);
    } else if (persisted) {
      await persistence.delete(hashSessionId(requested));
    }
  } else if (requested) {
    session = store.remoteMcpSessions.get(requested) || null;
  }

  if (session && Number(session.expires_at || 0) > now) {
    session.id = requested;
    session.expires_at = now + ttlMs;
  } else {
    session = createSession({ now, ttlMs });
    if (requested) session.reconnect_reason = "session_not_found";
  }
  session.persistence_required = persistence.enabled;
  session.persistence_ready = !persistence.enabled || validSecret(secret);
  store.remoteMcpSessions.set(session.id, session);
  await persistRemoteMcpSession(store, session, { secret });
  return session;
}

export async function persistRemoteMcpSession(store, session, {
  secret = configuredSessionSecret()
} = {}) {
  if (!session?.id) return false;
  if (!store.remoteMcpSessions) store.remoteMcpSessions = new Map();
  store.remoteMcpSessions.set(session.id, session);
  const persistence = remoteSessionPersistence(store);
  if (!persistence.enabled) return true;
  if (!validSecret(secret)) {
    session.persistence_ready = false;
    return false;
  }
  const stateOpaque = sealSessionState(session, secret);
  await persistence.write({
    session_id_hash: hashSessionId(session.id),
    state_opaque: stateOpaque,
    expires_at: Number(session.expires_at)
  });
  session.persistence_ready = true;
  return true;
}

export function hashSessionId(sessionId) {
  return crypto.createHash("sha256").update(String(sessionId || "")).digest("hex");
}

function createSession({ now, ttlMs }) {
  return {
    id: `armcp_${crypto.randomBytes(24).toString("base64url")}`,
    device_authorization: null,
    consumer_api_key: "",
    credential_key_id: null,
    reconnect_reason: null,
    created_at: now,
    expires_at: now + ttlMs
  };
}

function sealSessionState(session, secret) {
  const payload = JSON.stringify({
    device_authorization: session.device_authorization || null,
    consumer_api_key: String(session.consumer_api_key || ""),
    credential_key_id: session.credential_key_id || null,
    reconnect_reason: session.reconnect_reason || null,
    created_at: Number(session.created_at),
    expires_at: Number(session.expires_at)
  });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(sessionAad(session.id));
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return {
    version: SESSION_TOKEN_PREFIX,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

function openSessionState(envelope, sessionId, secret) {
  if (!validSecret(secret) || !envelope || envelope.version !== SESSION_TOKEN_PREFIX || envelope.cipher !== "aes-256-gcm") {
    return null;
  }
  try {
    const iv = canonicalBase64url(envelope.iv);
    const ciphertext = canonicalBase64url(envelope.ciphertext);
    const tag = canonicalBase64url(envelope.tag);
    if (!iv || !ciphertext || !tag) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(sessionAad(sessionId));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return {
      id: sessionId,
      device_authorization: safeDeviceAuthorization(payload.device_authorization),
      consumer_api_key: cleanBearer(payload.consumer_api_key),
      credential_key_id: cleanText(payload.credential_key_id, 160) || null,
      reconnect_reason: cleanText(payload.reconnect_reason, 80) || null,
      created_at: Number(payload.created_at || 0),
      expires_at: Number(payload.expires_at || 0)
    };
  } catch {
    return null;
  }
}

function safeDeviceAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deviceCodeHash = String(value.device_code_hash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deviceCodeHash)) return null;
  return {
    device_code_hash: deviceCodeHash,
    user_code: cleanText(value.user_code, 32),
    verification_uri: cleanText(value.verification_uri, 1024),
    verification_uri_complete: cleanText(value.verification_uri_complete, 1200),
    expires_in: Number(value.expires_in || 0),
    interval: Number(value.interval || 0)
  };
}

function cleanSessionId(value) {
  const sessionId = String(value || "").trim();
  return /^armcp_[A-Za-z0-9_-]{20,128}$/.test(sessionId) ? sessionId : "";
}

function cleanBearer(value) {
  const bearer = String(value || "");
  return bearer.length <= 512 ? bearer : "";
}

function cleanText(value, limit) {
  return String(value || "").slice(0, limit);
}

function canonicalBase64url(value) {
  const text = String(value || "");
  const decoded = Buffer.from(text, "base64url");
  return decoded.length && decoded.toString("base64url") === text ? decoded : null;
}

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(`${SESSION_TOKEN_PREFIX}\0${secret}`).digest();
}

function sessionAad(sessionId) {
  return Buffer.from(`${SESSION_TOKEN_PREFIX}:${hashSessionId(sessionId)}`);
}

function validSecret(secret) {
  return String(secret || "").length >= 32;
}

function configuredSessionSecret(environment = process.env) {
  return String(environment.ADN_AUTH_SESSION_SECRET || environment.ADN_BROWSER_HANDOFF_SECRET || "");
}

function remoteSessionPersistence(store) {
  if (store?.remoteMcpPersistence) {
    return {
      enabled: store.remoteMcpPersistence.enabled !== false,
      read: store.remoteMcpPersistence.read.bind(store.remoteMcpPersistence),
      write: store.remoteMcpPersistence.write.bind(store.remoteMcpPersistence),
      delete: store.remoteMcpPersistence.delete.bind(store.remoteMcpPersistence)
    };
  }
  return {
    enabled: persistenceEnabled(),
    read: readPersistentRemoteMcpSession,
    write: writePersistentRemoteMcpSession,
    delete: deletePersistentRemoteMcpSession
  };
}
