import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

const PUBLIC_BASE_URL = "https://agentrouter.network";
const SESSION_SECRET = "oauth-browser-binding-secret-at-least-32-characters";

async function withOAuthServers(count, run, { browserHandoffClaim } = {}) {
  const previousEnvironment = {
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    ADN_AUTH_SESSION_SECRET: process.env.ADN_AUTH_SESSION_SECRET
  };
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_CLIENT_ID = "oauth-security-client";
  process.env.GITHUB_CLIENT_SECRET = "oauth-security-secret";
  process.env.ADN_AUTH_SESSION_SECRET = SESSION_SECRET;
  const servers = Array.from({ length: count }, () => createServer({
    baseUrl: PUBLIC_BASE_URL,
    store: createMemoryStore(),
    ...(browserHandoffClaim ? { browserHandoffClaim } : {})
  }));
  try {
    for (const server of servers) {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    }
    const origins = servers.map((server) => `http://127.0.0.1:${server.address().port}`);
    await run({ servers, origins, rawFetch: previousFetch });
  } finally {
    globalThis.fetch = previousFetch;
    for (const server of servers) {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function startOAuth(rawFetch, origin, returnTo = "/account") {
  const response = await rawFetch(
    `${origin}/auth/github/start?return_to=${encodeURIComponent(returnTo)}`,
    { redirect: "manual" }
  );
  assert.equal(response.status, 302);
  const authorizationUrl = new URL(response.headers.get("location"));
  return {
    response,
    state: authorizationUrl.searchParams.get("state"),
    cookie: response.headers.get("set-cookie") || ""
  };
}

function requestCookie(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

function installGitHubMock() {
  const calls = { token: 0, user: 0 };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      calls.token += 1;
      return Response.json({ access_token: `access-token-${calls.token}` });
    }
    if (url === "https://api.github.com/user") {
      calls.user += 1;
      return Response.json({
        id: 42,
        login: "oauth-security-user",
        name: "OAuth Security User",
        email: "oauth-security@example.test",
        avatar_url: "https://avatars.example/oauth-security-user.png"
      });
    }
    throw new Error(`Unexpected OAuth fetch ${url}`);
  };
  return calls;
}

function createSharedStateClaim() {
  const claimed = new Set();
  return async (claimId) => {
    if (claimed.has(claimId)) return false;
    claimed.add(claimId);
    return true;
  };
}

test("OAuth start binds signed state to a short-lived secure HttpOnly browser cookie", async () => {
  await withOAuthServers(1, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    assert.ok(started.state);
    assert.match(started.cookie, /^ar_oauth_state_[A-Za-z0-9_-]{20}=/);
    assert.match(started.cookie, /HttpOnly/i);
    assert.match(started.cookie, /SameSite=Lax/i);
    assert.match(started.cookie, /Secure/i);
    assert.match(started.cookie, /Max-Age=600/i);
    assert.match(started.cookie, /Path=\/auth\/github\/callback/i);
  });
});

test("a copied signed state cannot be exchanged by a browser without its binding cookie", async () => {
  await withOAuthServers(1, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    const calls = installGitHubMock();
    const response = await rawFetch(
      `${origins[0]}/auth/github/callback?code=stolen-code&state=${encodeURIComponent(started.state)}`,
      { redirect: "manual" }
    );
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /^\/auth\/login\?error=/);
    assert.equal(calls.token, 0);
    assert.match(response.headers.get("set-cookie") || "", /ar_oauth_state_[A-Za-z0-9_-]{20}=;/);
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /ar_session=;/);
  });
});

test("browser-bound signed state survives a rolling deploy and is consumed after success", async () => {
  await withOAuthServers(2, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    const calls = installGitHubMock();
    const callbackUrl = `${origins[1]}/auth/github/callback?code=valid-code&state=${encodeURIComponent(started.state)}`;
    const first = await rawFetch(callbackUrl, {
      headers: { cookie: requestCookie(started.cookie) },
      redirect: "manual"
    });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "/account");
    assert.match(first.headers.get("set-cookie") || "", /ar_session=/);
    assert.match(first.headers.get("set-cookie") || "", /ar_oauth_state_[A-Za-z0-9_-]{20}=;/);
    assert.equal(calls.token, 1);

    const replay = await rawFetch(callbackUrl, {
      headers: { cookie: requestCookie(started.cookie) },
      redirect: "manual"
    });
    assert.equal(replay.status, 302);
    assert.match(replay.headers.get("location"), /^\/auth\/login\?error=/);
    assert.equal(calls.token, 1, "a replay must be rejected before a second token exchange");
  });
});

test("a shared OAuth state claim rejects replay on a different server instance", async () => {
  const browserHandoffClaim = createSharedStateClaim();
  await withOAuthServers(2, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    const calls = installGitHubMock();
    const query = `code=valid-code&state=${encodeURIComponent(started.state)}`;
    const options = {
      headers: { cookie: requestCookie(started.cookie) },
      redirect: "manual"
    };

    const first = await rawFetch(`${origins[0]}/auth/github/callback?${query}`, options);
    assert.equal(first.headers.get("location"), "/account");
    assert.equal(calls.token, 1);

    const replay = await rawFetch(`${origins[1]}/auth/github/callback?${query}`, options);
    assert.match(replay.headers.get("location"), /^\/auth\/login\?error=/);
    assert.equal(calls.token, 1, "the shared claim must reject replay before token exchange");
  }, { browserHandoffClaim });
});

test("a failed callback consumes its shared state across server instances", async () => {
  const browserHandoffClaim = createSharedStateClaim();
  await withOAuthServers(2, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    const calls = installGitHubMock();
    const cookie = { cookie: requestCookie(started.cookie) };
    const state = encodeURIComponent(started.state);

    const failed = await rawFetch(`${origins[0]}/auth/github/callback?state=${state}`, {
      headers: cookie,
      redirect: "manual"
    });
    assert.match(failed.headers.get("location"), /^\/auth\/login\?error=/);

    const replay = await rawFetch(`${origins[1]}/auth/github/callback?code=late-code&state=${state}`, {
      headers: cookie,
      redirect: "manual"
    });
    assert.match(replay.headers.get("location"), /^\/auth\/login\?error=/);
    assert.equal(calls.token, 0, "failed callbacks must consume shared state before code exchange");
  }, { browserHandoffClaim });
});

test("a browser-bound state is consumed when its callback fails", async () => {
  await withOAuthServers(1, async ({ origins, rawFetch }) => {
    const started = await startOAuth(rawFetch, origins[0]);
    const calls = installGitHubMock();
    const headers = { cookie: requestCookie(started.cookie) };
    const failed = await rawFetch(
      `${origins[0]}/auth/github/callback?state=${encodeURIComponent(started.state)}`,
      { headers, redirect: "manual" }
    );
    assert.equal(failed.status, 302);
    assert.match(failed.headers.get("location"), /^\/auth\/login\?error=/);
    assert.match(failed.headers.get("set-cookie") || "", /ar_oauth_state_[A-Za-z0-9_-]{20}=;/);
    assert.equal(calls.token, 0);

    const replay = await rawFetch(
      `${origins[0]}/auth/github/callback?code=late-code&state=${encodeURIComponent(started.state)}`,
      { headers, redirect: "manual" }
    );
    assert.equal(replay.status, 302);
    assert.match(replay.headers.get("location"), /^\/auth\/login\?error=/);
    assert.equal(calls.token, 0, "a failed callback must consume its state");
  });
});

test("concurrent OAuth tabs keep independent browser bindings", async () => {
  await withOAuthServers(1, async ({ origins, rawFetch }) => {
    const firstStarted = await startOAuth(rawFetch, origins[0], "/studio");
    const secondStarted = await startOAuth(rawFetch, origins[0], "/account");
    assert.notEqual(requestCookie(firstStarted.cookie).split("=")[0], requestCookie(secondStarted.cookie).split("=")[0]);
    const calls = installGitHubMock();
    const cookies = `${requestCookie(firstStarted.cookie)}; ${requestCookie(secondStarted.cookie)}`;

    const first = await rawFetch(
      `${origins[0]}/auth/github/callback?code=first-code&state=${encodeURIComponent(firstStarted.state)}`,
      { headers: { cookie: cookies }, redirect: "manual" }
    );
    assert.equal(first.headers.get("location"), "/studio");

    const second = await rawFetch(
      `${origins[0]}/auth/github/callback?code=second-code&state=${encodeURIComponent(secondStarted.state)}`,
      { headers: { cookie: cookies }, redirect: "manual" }
    );
    assert.equal(second.headers.get("location"), "/account");
    assert.equal(calls.token, 2);
  });
});
