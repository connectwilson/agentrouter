import assert from "node:assert/strict";
import test from "node:test";

import {
  beginOAuth,
  consumeOAuthState,
  createAuthSession,
  currentUser
} from "../src/auth.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

const SESSION_SECRET = "shared-auth-session-secret-at-least-32-characters";
const USER = {
  provider: "github",
  id: "12345",
  name: "Wilson",
  email: "wilson@example.com",
  avatar_url: "https://avatars.example/wilson.png",
  handle: "connectwilson"
};

function requestFor(cookie) {
  return { headers: { cookie: cookie.split(";")[0] } };
}

test("a browser login remains valid after process restart on another instance", () => {
  const issued = createAuthSession({
    store: createMemoryStore(),
    baseUrl: "https://agentrouter.network",
    user: USER,
    sessionSecret: SESSION_SECRET,
    now: 1_000
  });
  assert.doesNotMatch(issued.cookie, /wilson@example\.com|connectwilson/);
  const restartedStore = createMemoryStore();
  assert.deepEqual(currentUser(requestFor(issued.cookie), restartedStore, {
    sessionSecret: SESSION_SECRET,
    now: 2_000
  }), USER);
  assert.equal(restartedStore.authSessions.size, 0);
});

test("a restarted HTTP instance accepts the sealed login without hydrating session state", async () => {
  const issued = createAuthSession({
    store: createMemoryStore(),
    baseUrl: "https://agentrouter.network",
    user: USER,
    sessionSecret: SESSION_SECRET,
    now: Date.now()
  });
  const previousSecret = process.env.ADN_BROWSER_HANDOFF_SECRET;
  process.env.ADN_BROWSER_HANDOFF_SECRET = SESSION_SECRET;
  const restarted = createServer({ store: createMemoryStore() });
  await new Promise((resolve) => restarted.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.address().port}/account`, {
      headers: { cookie: issued.cookie.split(";")[0] },
      redirect: "manual"
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Wilson|connectwilson/);
  } finally {
    await new Promise((resolve) => restarted.close(resolve));
    if (previousSecret == null) delete process.env.ADN_BROWSER_HANDOFF_SECRET;
    else process.env.ADN_BROWSER_HANDOFF_SECRET = previousSecret;
  }
});

test("signed browser sessions fail closed after tampering or secret rotation", () => {
  const issued = createAuthSession({
    store: createMemoryStore(),
    baseUrl: "https://agentrouter.network",
    user: USER,
    sessionSecret: SESSION_SECRET,
    now: 1_000
  });
  const cookie = issued.cookie.split(";")[0];
  const [cookieName, token] = cookie.split("=");
  const segments = token.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const tag = segments.at(-1);
  const canonicalIndex = alphabet.indexOf(tag.at(-1));
  segments[segments.length - 1] = `${tag.slice(0, -1)}${alphabet[canonicalIndex + 1]}`;
  const tampered = `${cookieName}=${segments.join(".")}`;
  assert.equal(currentUser({ headers: { cookie: tampered } }, createMemoryStore(), {
    sessionSecret: SESSION_SECRET,
    now: 2_000
  }), null);
  assert.equal(currentUser(requestFor(issued.cookie), createMemoryStore(), {
    sessionSecret: "different-shared-auth-session-secret-32-characters",
    now: 2_000
  }), null);
});

test("signed browser sessions expire at the existing fourteen-day boundary", () => {
  const issuedAt = 1_000;
  const issued = createAuthSession({
    store: createMemoryStore(),
    baseUrl: "https://agentrouter.network",
    user: USER,
    sessionSecret: SESSION_SECRET,
    now: issuedAt
  });
  assert.equal(currentUser(requestFor(issued.cookie), createMemoryStore(), {
    sessionSecret: SESSION_SECRET,
    now: issuedAt + 14 * 24 * 60 * 60 * 1000 + 1
  }), null);
});

test("signed browser sessions bound identity claims below browser cookie limits", () => {
  const issued = createAuthSession({
    store: createMemoryStore(),
    baseUrl: "https://agentrouter.network",
    user: { ...USER, name: "n".repeat(10_000), avatar_url: `https://example.com/${"a".repeat(10_000)}` },
    sessionSecret: SESSION_SECRET,
    now: 1_000
  });
  assert.ok(issued.cookie.length < 3800);
  const recovered = currentUser(requestFor(issued.cookie), createMemoryStore(), {
    sessionSecret: SESSION_SECRET,
    now: 2_000
  });
  assert.equal(recovered.name.length, 160);
  assert.equal(recovered.avatar_url.length, 512);
});

test("legacy in-memory sessions remain compatible in local development", () => {
  const store = createMemoryStore();
  store.authSessions.set("legacy-session", { user: USER, expires_at: 10_000 });
  assert.deepEqual(currentUser({ headers: { cookie: "ar_session=legacy-session" } }, store, {
    sessionSecret: "",
    now: 2_000
  }), USER);
});

test("OAuth state survives a rolling deploy and remains single-purpose", () => {
  const oldClientId = process.env.GITHUB_CLIENT_ID;
  const oldClientSecret = process.env.GITHUB_CLIENT_SECRET;
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  try {
    const url = new URL(beginOAuth({
      providerId: "github",
      store: createMemoryStore(),
      baseUrl: "https://agentrouter.network",
      returnTo: "/account",
      sessionSecret: SESSION_SECRET,
      now: 1_000
    }));
    const state = url.searchParams.get("state");
    const recovered = consumeOAuthState({
      providerId: "github",
      state,
      store: createMemoryStore(),
      sessionSecret: SESSION_SECRET,
      now: 2_000
    });
    assert.equal(recovered.return_to, "/account");
    assert.equal(recovered.provider, "github");
    assert.throws(() => consumeOAuthState({
      providerId: "other",
      state,
      store: createMemoryStore(),
      sessionSecret: SESSION_SECRET,
      now: 2_000
    }), (error) => error.code === "INVALID_OAUTH_STATE");
  } finally {
    if (oldClientId == null) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = oldClientId;
    if (oldClientSecret == null) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = oldClientSecret;
  }
});
