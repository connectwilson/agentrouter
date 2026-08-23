import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/store.js";
import { createDevSession } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { searchLocalSocialPlatform } from "../src/research-social-providers.js";
import {
  createSocialConnection,
  deleteSocialConnection,
  listSocialConnections,
  socialProvidersForUser
} from "../src/social-connections.js";

function memorySecretStore() {
  const values = new Map();
  return {
    values,
    writeSecret: async ({ serviceId, secretName, secretValue }) => {
      const ref = `${serviceId}:${secretName}`;
      values.set(ref, secretValue);
      return ref;
    },
    readSecret: async (ref) => values.get(ref) || "",
    deleteSecret: async (ref) => values.delete(ref)
  };
}

test("social connections are owner-scoped and never return credentials", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  const created = await createSocialConnection(store, "github:user-a", {
    platform: "x",
    provider_type: "x_api",
    label: "My X API",
    credentials: { bearer_token: "x-secret-token" }
  }, secrets);

  assert.equal(created.platform, "x");
  assert.equal(created.has_credentials, true);
  assert.equal(JSON.stringify(created).includes("x-secret-token"), false);
  assert.equal(listSocialConnections(store, "github:user-a").length, 1);
  assert.equal(listSocialConnections(store, "github:user-b").length, 0);
  assert.equal(JSON.stringify(store.socialConnections).includes("x-secret-token"), false);
  assert.equal(secrets.values.size, 1);
});

test("XPOZ and SocialDataX credentials can be saved through AgentRouter without leaking them", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();

  for (const [platform, providerType] of [["xpoz", "xpoz_api"], ["socialdatax", "socialdatax_api"]]) {
    const token = `${platform}-secret`;
    const created = await createSocialConnection(store, "github:user-a", {
      platform,
      provider_type: providerType,
      credentials: { api_key: token }
    }, secrets);
    assert.equal(created.platform, platform);
    assert.equal(created.has_credentials, true);
    assert.equal(JSON.stringify(created).includes(token), false);
  }

  assert.equal(secrets.values.size, 2);
});

test("one user cannot delete another user's social connection", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  const created = await createSocialConnection(store, "github:user-a", {
    platform: "reddit",
    provider_type: "reddit_api",
    credentials: { access_token: "reddit-secret" }
  }, secrets);

  await assert.rejects(
    deleteSocialConnection(store, "github:user-b", created.connection_id, secrets),
    (error) => error.code === "SOCIAL_CONNECTION_NOT_FOUND" && error.statusCode === 404
  );
  assert.equal(listSocialConnections(store, "github:user-a").length, 1);
});

test("X API provider searches with the secret internally and returns normalized public rows", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  await createSocialConnection(store, "github:user-a", {
    platform: "x",
    provider_type: "x_api",
    credentials: { bearer_token: "x-secret-token" }
  }, secrets);
  const requests = [];
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "123", text: "Kimi K3 is painfully slow", author_id: "u1", created_at: "2026-07-20T00:00:00Z", public_metrics: { like_count: 7 } }],
          includes: { users: [{ id: "u1", username: "creator" }] }
        })
      };
    }
  });
  const result = await providers.x[0].search("Kimi K3 slow", 10);

  assert.equal(requests[0].options.headers.authorization, "Bearer x-secret-token");
  assert.match(requests[0].url, /api\.x\.com\/2\/tweets\/search\/recent/);
  assert.equal(result.status, "completed");
  assert.equal(result.rows[0].url, "https://x.com/creator/status/123");
  assert.equal(result.rows[0].author, "creator");
  assert.equal(JSON.stringify(result).includes("x-secret-token"), false);
});

test("X API provider reads one public status URL without exposing its credential", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  await createSocialConnection(store, "github:user-a", {
    platform: "x",
    provider_type: "x_api",
    credentials: { bearer_token: "x-read-secret" }
  }, secrets);
  const requests = [];
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => ({
          data: {
            id: "2081890388298874880",
            text: "One public X post",
            author_id: "u1",
            created_at: "2026-07-29T00:00:00Z",
            public_metrics: { like_count: 8, reply_count: 2, retweet_count: 1, impression_count: 100 }
          },
          includes: { users: [{ id: "u1", username: "marclou" }] }
        })
      };
    }
  });

  const result = await providers.x[0].readPost("https://x.com/marclou/status/2081890388298874880");
  assert.match(requests[0].url, /api\.x\.com\/2\/tweets\/2081890388298874880/);
  assert.equal(requests[0].options.headers.authorization, "Bearer x-read-secret");
  assert.equal(result.rows[0].url, "https://x.com/marclou/status/2081890388298874880");
  assert.deepEqual(result.rows[0].engagement, { likes: 8, comments: 2, shares: 1, views: 100 });
  assert.equal(JSON.stringify(result).includes("x-read-secret"), false);
});

test("Reddit API provider uses the user's OAuth token and normalizes permalink results", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  await createSocialConnection(store, "github:user-a", {
    platform: "reddit",
    provider_type: "reddit_api",
    credentials: { access_token: "reddit-token" }
  }, secrets);
  const requests = [];
  const providers = await socialProvidersForUser(store, "github:user-a", {
    ...secrets,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => ({ data: { children: [{ data: { id: "abc", title: "Kimi K3 is slow", selftext: "It burns tokens", author: "redditor", created_utc: 1784500000, permalink: "/r/kimi/comments/abc/kimi_k3/", score: 9, num_comments: 3 } }] } })
      };
    }
  });
  const result = await providers.reddit[0].search("Kimi K3 slow", 10);
  assert.equal(requests[0].options.headers.authorization, "Bearer reddit-token");
  assert.match(requests[0].options.headers["user-agent"], /AgentRouter/);
  assert.equal(result.rows[0].url, "https://www.reddit.com/r/kimi/comments/abc/kimi_k3/");
  assert.deepEqual(result.rows[0].engagement, { likes: 9, comments: 3 });
});

test("local browser connections do not store credentials", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  const created = await createSocialConnection(store, "github:user-a", {
    platform: "xiaohongshu",
    provider_type: "local_browser",
    label: "Dedicated Chrome"
  }, secrets);
  assert.equal(created.has_credentials, false);
  assert.equal(secrets.values.size, 0);
});

test("all suitable local research platforms can be registered without sending credentials", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  for (const platform of ["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook"]) {
    const created = await createSocialConnection(store, "github:user-a", {
      platform,
      provider_type: "local_browser",
      label: `${platform} local`
    }, secrets);
    assert.equal(created.has_credentials, false);
  }
  assert.equal(secrets.values.size, 0);
  assert.equal(listSocialConnections(store, "github:user-a").length, 6);
});

test("local execution plan API requires a signed-in user and never returns a command", async () => {
  const store = createMemoryStore();
  const session = createDevSession(store, "http://127.0.0.1");
  const cookie = session.cookie.split(";")[0];
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthorized = await fetch(`${baseUrl}/research/api/local-plan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${baseUrl}/research/api/local-plan`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ platform: "x", operation: "search", query: "Kimi K3", limit: 10 })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.execution_location, "user_device");
    assert.equal("command" in payload, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("user API providers are tried before machine-local browser backends", async () => {
  let commandCalls = 0;
  const result = await searchLocalSocialPlatform("x", "Kimi K3 slow", 10, {
    providers: {
      x: [{
        id: "x-api:user-connection",
        search: async () => ({ status: "completed", rows: [{ url: "https://x.com/user/status/1", text: "Kimi K3 is slow" }] })
      }]
    },
    runCommand: async () => {
      commandCalls += 1;
      return { status: "provider_error", error: "should not run" };
    }
  });
  assert.equal(result.backend_id, "x-api:user-connection");
  assert.equal(result.rows.length, 1);
  assert.equal(commandCalls, 0);
});

test("social connection HTTP API requires login, isolates the owner, and redacts secrets", async () => {
  const store = createMemoryStore();
  const secrets = memorySecretStore();
  const session = createDevSession(store, "http://127.0.0.1");
  const cookie = session.cookie.split(";")[0];
  const server = createServer({ store, socialConnectionOptions: secrets });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthorized = await fetch(`${baseUrl}/research/api/connections`);
    assert.equal(unauthorized.status, 401);

    const createdResponse = await fetch(`${baseUrl}/research/api/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ platform: "x", provider_type: "x_api", credentials: { bearer_token: "http-secret" } })
    });
    assert.equal(createdResponse.status, 201);
    const createdText = await createdResponse.text();
    assert.equal(createdText.includes("http-secret"), false);
    const created = JSON.parse(createdText);

    const listResponse = await fetch(`${baseUrl}/research/api/connections`, { headers: { cookie } });
    const listText = await listResponse.text();
    assert.equal(listResponse.status, 200);
    assert.equal(listText.includes("http-secret"), false);
    assert.equal(JSON.parse(listText).connections.length, 1);

    const deleteResponse = await fetch(`${baseUrl}/research/api/connections/${created.connection_id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(deleteResponse.status, 200);
    assert.equal(secrets.values.size, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
