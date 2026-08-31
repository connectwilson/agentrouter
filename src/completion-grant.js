import crypto from "node:crypto";

const TOKEN_PREFIX = "arcg1";
const MAX_GRANT_LIFETIME_MS = 10 * 60 * 1000;
const localDevelopmentSecret = crypto.randomBytes(32);

export function issueCompletionGrant({
  serviceId,
  inputHash,
  challengeNonce,
  expiresAt
} = {}) {
  const expiry = boundedExpiry(expiresAt);
  const payload = {
    version: "agentrouter_completion_grant_v1",
    service_id: requiredString(serviceId, "service_id"),
    input_hash: requiredString(inputHash, "input_hash"),
    challenge_nonce: requiredString(challengeNonce, "challenge_nonce"),
    expires_at: new Date(expiry).toISOString(),
    grant_id: crypto.randomBytes(16).toString("base64url")
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_PREFIX}.${encoded}.${sign(encoded)}`;
}

export function verifyCompletionGrant(token, {
  serviceId,
  inputHash,
  challengeNonce,
  now = Date.now()
} = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return invalid("COMPLETION_GRANT_INVALID");
  const [, encoded, signature] = parts;
  const expectedSignature = sign(encoded);
  if (!safeEqual(signature, expectedSignature)) return invalid("COMPLETION_GRANT_INVALID");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return invalid("COMPLETION_GRANT_INVALID");
  }
  if (payload?.version !== "agentrouter_completion_grant_v1") return invalid("COMPLETION_GRANT_INVALID");
  const expiresAt = Date.parse(String(payload.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return invalid("COMPLETION_GRANT_EXPIRED");
  if (expiresAt - now > MAX_GRANT_LIFETIME_MS) return invalid("COMPLETION_GRANT_INVALID");
  if (payload.service_id !== String(serviceId || "")) return invalid("COMPLETION_GRANT_SERVICE_MISMATCH");
  if (payload.input_hash !== String(inputHash || "")) return invalid("COMPLETION_GRANT_INPUT_MISMATCH");
  if (payload.challenge_nonce !== String(challengeNonce || "")) return invalid("COMPLETION_GRANT_CHALLENGE_MISMATCH");
  return { ok: true, payload };
}

function boundedExpiry(value) {
  const now = Date.now();
  const requested = Date.parse(String(value || ""));
  if (!Number.isFinite(requested) || requested <= now) return now + 5 * 60 * 1000;
  return Math.min(requested, now + MAX_GRANT_LIFETIME_MS);
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${field} is required to issue a completion grant.`);
    error.code = "COMPLETION_GRANT_INPUT_INVALID";
    throw error;
  }
  return normalized;
}

function sign(encoded) {
  return crypto.createHmac("sha256", completionGrantSecret()).update(encoded).digest("base64url");
}

function completionGrantSecret() {
  const configured = String(
    process.env.ADN_COMPLETION_GRANT_SECRET ||
    process.env.ADN_BROWSER_HANDOFF_SECRET ||
    ""
  );
  if (!configured) return localDevelopmentSecret;
  return crypto.createHmac("sha256", configured).update("agentrouter-completion-grant-v1").digest();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function invalid(code) {
  return { ok: false, code };
}
