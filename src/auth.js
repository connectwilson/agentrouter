import crypto from "node:crypto";

const SESSION_COOKIE = "ar_session";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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

export function createDevSession(store, baseUrl) {
  const sessionId = randomToken();
  const user = normalizeUser({
    provider: "local",
    id: "local-development-user",
    name: "Local Developer",
    email: "developer@localhost",
    handle: "local-developer"
  });
  store.authSessions.set(sessionId, {
    user,
    created_at: Date.now(),
    expires_at: Date.now() + SESSION_TTL_MS
  });
  return {
    user,
    cookie: serializeCookie(SESSION_COOKIE, sessionId, {
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: isHttps(baseUrl)
    })
  };
}

export function currentUser(req, store) {
  const sessionId = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = store.authSessions?.get(sessionId);
  if (!session || Number(session.expires_at || 0) < Date.now()) {
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

export function beginOAuth({ providerId, store, baseUrl, returnTo = "/" }) {
  const provider = configuredProvider(providerId);
  sweepExpiredOAuthStates(store);
  const state = randomToken();
  const redirectUri = callbackUrl(baseUrl, provider.id);
  store.oauthStates.set(state, {
    provider: provider.id,
    redirect_uri: redirectUri,
    return_to: safeReturnTo(returnTo),
    created_at: Date.now(),
    expires_at: Date.now() + OAUTH_STATE_TTL_MS
  });
  const url = new URL(provider.authUrl);
  url.searchParams.set("client_id", process.env[provider.clientIdEnv]);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export async function completeOAuth({ providerId, code, state, store, baseUrl }) {
  const provider = configuredProvider(providerId);
  const savedState = store.oauthStates.get(state);
  store.oauthStates.delete(state);
  if (!savedState || savedState.provider !== provider.id || Number(savedState.expires_at || 0) < Date.now()) {
    const error = new Error("OAuth state is invalid or expired. Please try logging in again.");
    error.statusCode = 400;
    error.code = "INVALID_OAUTH_STATE";
    throw error;
  }
  if (!code) {
    const error = new Error("OAuth provider did not return an authorization code.");
    error.statusCode = 400;
    error.code = "MISSING_OAUTH_CODE";
    throw error;
  }
  const redirectUri = savedState.redirect_uri || callbackUrl(baseUrl, provider.id);
  const token = await exchangeCode({ provider, code, redirectUri });
  const user = await fetchUser({ provider, accessToken: token.access_token });
  const sessionId = randomToken();
  store.authSessions.set(sessionId, {
    user,
    created_at: Date.now(),
    expires_at: Date.now() + SESSION_TTL_MS
  });
  return {
    user,
    returnTo: savedState.return_to || "/",
    cookie: serializeCookie(SESSION_COOKIE, sessionId, {
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: isHttps(baseUrl)
    })
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
    provider: user.provider,
    id: String(user.id || ""),
    name: user.name || user.email || user.handle || "Signed in user",
    email: user.email || "",
    avatar_url: user.avatar_url || "",
    handle: user.handle || ""
  };
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
