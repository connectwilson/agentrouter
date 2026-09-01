import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

const OWNER = { provider: "github", id: "route-owner", handle: "route-owner" };
const STRANGER = { provider: "github", id: "route-stranger", handle: "route-stranger" };

function observation(id, actorKey) {
  return {
    observation_version: "agent_router_route_observation_v2",
    observation_id: id,
    request_id: `request-${id}`,
    created_at: new Date().toISOString(),
    entrypoint: "request",
    task_family: "research",
    route_family: "external_api",
    capability: "external_api_query",
    source_family: "web_search",
    action: "route",
    actor_key: actorKey
  };
}

async function withServer(run) {
  const store = createMemoryStore();
  store.authSessions.set("owner-session", {
    user: OWNER,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  store.authSessions.set("stranger-session", {
    user: STRANGER,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  store.routeObservations.push(
    observation("owner", "github:route-owner"),
    observation("stranger", "github:route-stranger"),
    {
      observation_version: "agent_router_route_observation_v1",
      observation_id: "legacy-public",
      request_id: "legacy-request",
      created_at: new Date().toISOString(),
      status: "routed"
    }
  );
  const server = createServer({
    store,
    serviceEventPersistence: {
      enabled: () => false,
      refreshConfigs: async () => [],
      refresh: async () => ({ ok: true, status: "fresh", loaded: 0 }),
      writeEvent: async () => true
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readFeed(baseUrl, session = "") {
  const response = await fetch(`${baseUrl}/agent-router/observations`, {
    headers: session ? { cookie: `ar_session=${session}` } : {}
  });
  assert.equal(response.status, 200);
  return { response, payload: await response.json() };
}

test("per-call v2 routing observations are private to their authenticated actor", async () => {
  await withServer(async (baseUrl) => {
    const { payload: anonymous } = await readFeed(baseUrl);
    assert.deepEqual(anonymous.observations.map((item) => item.observation_id), ["legacy-public"]);

    const { payload: owner } = await readFeed(baseUrl, "owner-session");
    assert.deepEqual(owner.observations.map((item) => item.observation_id).sort(), ["legacy-public", "owner"]);

    const { payload: stranger } = await readFeed(baseUrl, "stranger-session");
    assert.deepEqual(stranger.observations.map((item) => item.observation_id).sort(), ["legacy-public", "stranger"]);
  });
});

test("actor-scoped observation feeds are private, uncacheable, and retain feedback identifiers", async () => {
  await withServer(async (baseUrl) => {
    const { response, payload } = await readFeed(baseUrl, "owner-session");

    assert.match(response.headers.get("cache-control") || "", /private/i);
    assert.match(response.headers.get("cache-control") || "", /no-store/i);
    const vary = (response.headers.get("vary") || "").toLowerCase();
    for (const header of ["cookie", "authorization", "x-api-key", "x-agentrouter-api-key", "x-agentrouter-publish-token"]) {
      assert.match(vary, new RegExp(`(^|,\\s*)${header.replaceAll("-", "\\-")}($|,\\s*)`));
    }

    const projected = payload.observations.find((item) => item.observation_id === "owner");
    assert.deepEqual({
      observation_id: projected.observation_id,
      request_id: projected.request_id,
      route_family: projected.route_family,
      capability: projected.capability
    }, {
      observation_id: "owner",
      request_id: "request-owner",
      route_family: "external_api",
      capability: "external_api_query"
    });
    assert.equal(projected.actor_key, undefined);
    assert.equal(projected.prompt, undefined);
    assert.equal(projected.request?.task, undefined);
  });
});
