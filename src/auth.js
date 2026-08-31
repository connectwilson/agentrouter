import crypto from "node:crypto";

const SESSION_COOKIE = "ar_session";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_PREFIX = "ars1";
const OAUTH_STATE_TOKEN_PREFIX = "aro1";

const PROVIDERS = {
  github: {
    id: "github",
    label: "GitHub",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email"
  }
};

export function authProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: Boolean(process.env[provider.clientIdEnv] && process.env[provider.clientSecretEnv]),
    client_id_env: provider.clientIdEnv,
    client_secret_env: provider.clientSecretEnv
  }));
}

export function devLoginAvailable(req, baseUrl) {
  if (process.env.ADN_AUTH_ALLOW_DEV_LOGIN !== "true" || process.env.NODE_ENV === "production") return false;
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return false;
  const remoteAddress = String(req?.socket?.remoteAddress || "").toLowerCase();
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress);
}

export function createDevSession(store, baseUrl, options = {}) {
  const user = normalizeUser({
    provider: "local",
    id: "local-development-user",
    name: "Local Developer",
    email: "developer@localhost",
    handle: "local-developer"
  });
  return createAuthSession({ store, baseUrl, user, ...options });
}

export function createAuthSession({
  store,
  baseUrl,
  user,
  sessionSecret = configuredSessionSecret(),
  now = Date.now()
}) {
  const normalizedUser = normalizeUser(user);
  const expiresAt = now + SESSION_TTL_MS;
  const sealed = sealPayload(SESSION_TOKEN_PREFIX, {
    user: normalizedUser,
    created_at: now,
    expires_at: expiresAt
  }, sessionSecret);
  const sessionId = sealed || randomToken();
  if (!sealed) {
    store.authSessions.set(sessionId, {
      user: normalizedUser,
      created_at: now,
      expires_at: expiresAt
    });
  }
  return {
    user: normalizedUser,
    cookie: serializeCookie(SESSION_COOKIE, sessionId, {
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: isHttps(baseUrl)
    })
  };
}

export function currentUser(req, store, {
  sessionSecret = configuredSessionSecret(),
  now = Date.now()
} = {}) {
  const sessionId = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!sessionId) return null;
  if (sessionId.startsWith(`${SESSION_TOKEN_PREFIX}.`)) {
    const payload = openPayload(SESSION_TOKEN_PREFIX, sessionId, sessionSecret);
    if (!payload || Number(payload.expires_at || 0) < now || Number(payload.created_at || 0) > now) return null;
    return normalizeUser(payload.user || {});
  }
  const session = store.authSessions?.get(sessionId);
  if (!session || Number(session.expires_at || 0) < now) {
    if (session) store.authSessions.delete(sessionId);
    return null;
  }
  return session.user;
}

export function authUserKey(user) {
  if (!user) return "";
  if (user.provider && user.id) return `${user.provider}:${user.id}`;
  if (user.email) return `email:${String(user.email).toLowerCase()}`;
  if (user.handle) return `handle:${String(user.handle).toLowerCase()}`;
  return "";
}

export function beginOAuth({
  providerId,
  store,
  baseUrl,
  returnTo = "/",
  sessionSecret = configuredSessionSecret(),
  now = Date.now()
}) {
  const provider = configuredProvider(providerId);
  sweepExpiredOAuthStates(store);
  const redirectUri = callbackUrl(baseUrl, provider.id);
  const stateRecord = {
    provider: provider.id,
    redirect_uri: redirectUri,
    return_to: safeReturnTo(returnTo),
    created_at: now,
    expires_at: now + OAUTH_STATE_TTL_MS,
    nonce: randomToken()
  };
  const sealedState = sealPayload(OAUTH_STATE_TOKEN_PREFIX, stateRecord, sessionSecret);
  const state = sealedState || randomToken();
  if (!sealedState) store.oauthStates.set(state, stateRecord);
  const url = new URL(provider.authUrl);
  url.searchParams.set("client_id", process.env[provider.clientIdEnv]);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export function consumeOAuthState({
  providerId,
  state,
  store,
  sessionSecret = configuredSessionSecret(),
  now = Date.now()
}) {
  const signedState = String(state || "").startsWith(`${OAUTH_STATE_TOKEN_PREFIX}.`)
    ? openPayload(OAUTH_STATE_TOKEN_PREFIX, state, sessionSecret)
    : null;
  const savedState = signedState || store.oauthStates.get(state);
  if (!signedState) store.oauthStates.delete(state);
  if (!savedState || savedState.provider !== providerId || Number(savedState.expires_at || 0) < now || Number(savedState.created_at || 0) > now) {
    throw invalidOAuthStateError();
  }
  return savedState;
}

export async function completeOAuth({
  providerId,
  code,
  state,
  store,
  baseUrl,
  sessionSecret = configuredSessionSecret()
}) {
  const provider = configuredProvider(providerId);
  const savedState = consumeOAuthState({ providerId: provider.id, state, store, sessionSecret });
  if (!code) {
    const error = new Error("OAuth provider did not return an authorization code.");
    error.statusCode = 400;
    error.code = "MISSING_OAUTH_CODE";
    throw error;
  }
  const redirectUri = savedState.redirect_uri || callbackUrl(baseUrl, provider.id);
  const token = await exchangeCode({ provider, code, redirectUri });
  const user = await fetchUser({ provider, accessToken: token.access_token });
  const session = createAuthSession({ store, baseUrl, user, sessionSecret });
  return {
    user,
    returnTo: savedState.return_to || "/",
    cookie: session.cookie
  };
}

export function clearSessionCookie(baseUrl) {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: isHttps(baseUrl) });
}

export function logout(req, store, baseUrl) {
  const sessionId = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (sessionId) store.authSessions.delete(sessionId);
  return clearSessionCookie(baseUrl);
}

function sweepExpiredOAuthStates(store) {
  const now = Date.now();
  for (const [state, entry] of store.oauthStates) {
    if (Number(entry?.expires_at || 0) < now) store.oauthStates.delete(state);
  }
}

function configuredProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    const error = new Error("Unknown auth provider.");
    error.statusCode = 404;
    error.code = "UNKNOWN_AUTH_PROVIDER";
    throw error;
  }
  if (!process.env[provider.clientIdEnv] || !process.env[provider.clientSecretEnv]) {
    const error = new Error(`${provider.label} auth is not configured. Set ${provider.clientIdEnv} and ${provider.clientSecretEnv}.`);
    error.statusCode = 503;
    error.code = "AUTH_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  return provider;
}

async function exchangeCode({ provider, code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: process.env[provider.clientIdEnv],
    client_secret: process.env[provider.clientSecretEnv],
    code,
    redirect_uri: redirectUri
  });
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error(payload.error_description || payload.error || "OAuth token exchange failed.");
    error.statusCode = 502;
    error.code = "OAUTH_TOKEN_EXCHANGE_FAILED";
    throw error;
  }
  return payload;
}

async function fetchUser({ provider, accessToken }) {
  return fetchGitHubUser(accessToken);
}

async function fetchGitHubUser(accessToken) {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "AgentRouter"
    }
  });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok) throwOAuthProfileError(user);
  let email = user.email || "";
  if (!email) {
    const emailResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "AgentRouter"
      }
    });
    const emails = await emailResponse.json().catch(() => []);
    email = Array.isArray(emails)
      ? emails.find((item) => item.primary && item.verified)?.email || emails.find((item) => item.verified)?.email || ""
      : "";
  }
  return normalizeUser({
    provider: "github",
    id: user.id,
    name: user.name || user.login,
    email,
    avatar_url: user.avatar_url,
    handle: user.login
  });
}

function normalizeUser(user) {
  return {
    provider: cleanClaim(user.provider, 40),
    id: cleanClaim(user.id, 128),
    name: cleanClaim(user.name || user.email || user.handle || "Signed in user", 160),
    email: cleanClaim(user.email, 254),
    avatar_url: cleanClaim(user.avatar_url, 512),
    handle: cleanClaim(user.handle, 100)
  };
}

function cleanClaim(value, limit) {
  return String(value || "").slice(0, limit);
}

function throwOAuthProfileError(payload) {
  const error = new Error(payload.message || payload.error || "OAuth profile fetch failed.");
  error.statusCode = 502;
  error.code = "OAUTH_PROFILE_FAILED";
  throw error;
}

function callbackUrl(baseUrl, providerId) {
  return new URL(`/auth/${providerId}/callback`, baseUrl).toString();
}

function safeReturnTo(value) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function configuredSessionSecret(environment = process.env) {
  return String(environment.ADN_AUTH_SESSION_SECRET || environment.ADN_BROWSER_HANDOFF_SECRET || "");
}

function sealPayload(prefix, payload, secret) {
  if (String(secret || "").length < 32) return "";
  const key = tokenKey(prefix, secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [prefix, iv.toString("base64url"), encrypted.toString("base64url"), tag.toString("base64url")].join(".");
}

function openPayload(prefix, token, secret) {
  if (String(secret || "").length < 32 || String(token || "").length > 4096) return null;
  const [actualPrefix, ivValue, encryptedValue, tagValue, extra] = String(token || "").split(".");
  if (actualPrefix !== prefix || !ivValue || !encryptedValue || !tagValue || extra) return null;
  try {
    const iv = canonicalBase64url(ivValue);
    const encrypted = canonicalBase64url(encryptedValue);
    const tag = canonicalBase64url(tagValue);
    if (!iv || !encrypted || !tag) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(prefix, secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString("utf8");
    const payload = JSON.parse(plaintext);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function canonicalBase64url(value) {
  const decoded = Buffer.from(String(value || ""), "base64url");
  return decoded.length && decoded.toString("base64url") === value ? decoded : null;
}

function tokenKey(prefix, secret) {
  return crypto.createHash("sha256").update(`AgentRouter:${prefix}\0${secret}`).digest();
}

function invalidOAuthStateError() {
  const error = new Error("OAuth state is invalid or expired. Please try logging in again.");
  error.statusCode = 400;
  error.code = "INVALID_OAUTH_STATE";
  return error;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("=") || "")];
  }).filter(([key]) => key));
}

function serializeCookie(name, value, { maxAge, secure = false } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    typeof maxAge === "number" ? `Max-Age=${maxAge}` : "",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function isHttps(baseUrl) {
  try {
    return new URL(baseUrl).protocol === "https:";
  } catch {
    return false;
  }
}
