import test from "node:test";
import assert from "node:assert/strict";

import { createDevSession } from "../src/auth.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { runExternalApiQuery } from "../src/external-api-capability.js";
import {
  hydrateServiceEventRows,
  loadProviderConfigs,
  refreshPersistentServiceEvents,
  registerService,
  registerServiceErc8004Identity
} from "../src/registry.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

const OWNER = "0x5555555555555555555555555555555555555555";
const TX_HASH = `0x${"d".repeat(64)}`;

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function ownedManifest(serviceId = "shared_state_service", providerId = "shared_state_vendor") {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = "Shared state service";
  manifest.provider = { ...manifest.provider, provider_id: providerId };
  manifest.endpoint = { ...manifest.endpoint, url: "http://provider.example/shared-state" };
  manifest.registration = {
    ...(manifest.registration || {}),
    owner: { user_key: "local:local-development-user" }
  };
  return manifest;
}

function createSharedEventLog() {
  const rows = [];
  const calls = [];
  return {
    rows,
    calls,
    async writeEvent({ eventType, serviceId, requestId, event }) {
      const eventId = String(rows.length + 1);
      const createdAt = event.created_at || new Date(1_800_000_000_000 + rows.length * 1000).toISOString();
      const row = {
        event_id: eventId,
        event_type: eventType,
        service_id: serviceId,
        request_id: requestId,
        event: { ...event, created_at: createdAt },
        created_at: createdAt,
        created_at_cursor: createdAt
      };
      rows.push(row);
      return row;
    },
    async listEvents({ afterCreatedAt = null, afterEventId = null } = {}) {
      calls.push({ afterCreatedAt, afterEventId });
      return rows.filter((row) => {
        if (afterEventId !== null) return BigInt(row.event_id) > BigInt(afterEventId);
        if (!afterCreatedAt) return true;
        if (row.created_at_cursor > afterCreatedAt) return true;
        return row.created_at_cursor === afterCreatedAt && BigInt(row.event_id) > BigInt(afterEventId || 0);
      });
    }
  };
}

function operationalFeedback(serviceId, requestId) {
  return {
    event_version: "agent_service_feedback_v1",
    request_id: requestId,
    service_id: serviceId,
    provider_id: "shared_state_vendor",
    consumer_id: "actor:one",
    invocation_actor_key: "actor:one",
    status: "success",
    schema_valid: true,
    payment_tx: `0x${"a".repeat(64)}`,
    verification: { coverage_valid: true, freshness_valid: true, agent_friendly_score: 1 },
    created_at: "2027-01-15T08:00:00.000Z"
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("a second instance incrementally sees feedback, evidence, and Vendor identity without replaying reducers", async () => {
  const serviceId = "shared_state_service";
  const providerId = "shared_state_vendor";
  const shared = createSharedEventLog();
  const storeA = createMemoryStore();
  const storeB = createMemoryStore();
  registerService(storeA, ownedManifest(serviceId, providerId), "http://127.0.0.1");
  registerService(storeB, ownedManifest(serviceId, providerId), "http://127.0.0.1");

  const serverA = createServer({ store: storeA });
  const serverB = createServer({
    store: storeB,
    serviceEventPersistence: {
      refresh: (store) => refreshPersistentServiceEvents(store, {
        enabled: true,
        listEvents: shared.listEvents
      }),
      writeEvent: shared.writeEvent
    }
  });
  await listen(serverA);
  const baseUrlB = await listen(serverB);
  try {
    const requestId = "req_shared_live_state";
    const rows = [];
    rows.push(await shared.writeEvent({
      eventType: "operational_feedback",
      serviceId,
      requestId,
      event: operationalFeedback(serviceId, requestId)
    }));
    rows.push(await shared.writeEvent({
      eventType: "consumer_feedback",
      serviceId,
      requestId,
      event: {
        event_version: "agent_consumer_feedback_v1",
        request_id: requestId,
        service_id: serviceId,
        consumer_id: "actor:one",
        consumer_feedback: { intent_fit: "yes", answer_useful: "yes", reason: "fresh", consumer_score: 1 },
        created_at: "2027-01-15T08:00:01.000Z"
      }
    }));
    rows.push(await shared.writeEvent({
      eventType: "evidence",
      serviceId,
      requestId,
      event: {
        evidence_version: "agent_router_evidence_v1",
        trace_hash: `0x${"b".repeat(64)}`,
        request_id: requestId,
        service_id: serviceId,
        created_at: "2027-01-15T08:00:02.000Z"
      }
    }));
    rows.push(await shared.writeEvent({
      eventType: "erc8004_vendor_identity",
      serviceId: `vendor:${providerId}`,
      requestId: TX_HASH,
      event: {
        event_version: "agent_router_erc8004_vendor_identity_v1",
        provider_id: providerId,
        network: "bsc",
        chain_id: 56,
        agent_id: "99117",
        owner_address: OWNER,
        tx_hash: TX_HASH,
        status: "registered",
        created_at: "2027-01-15T08:00:03.000Z"
      }
    }));
    await hydrateServiceEventRows(storeA, rows);

    const firstResponse = await fetch(`${baseUrlB}/agent-router/service?service_id=${serviceId}`);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("x-agentrouter-state-freshness"), "fresh");
    assert.equal(first.recent_feedback_events.length, 1);
    assert.equal(first.recent_feedback_events[0].consumer_rating, 1);
    assert.equal(first.recent_evidence_events.length, 1);
    assert.equal(first.manifest.registration.erc8004.agent_id, "99117");

    const backdated = await shared.writeEvent({
      eventType: "evidence",
      serviceId,
      requestId: "req_backdated_after_high_water",
      event: {
        evidence_version: "agent_router_evidence_v1",
        trace_hash: `0x${"c".repeat(64)}`,
        request_id: "req_backdated_after_high_water",
        service_id: serviceId,
        created_at: "2020-01-01T00:00:00.000Z"
      }
    });
    await hydrateServiceEventRows(storeA, [backdated]);
    const backdatedResponse = await fetch(`${baseUrlB}/agent-router/service?service_id=${serviceId}`);
    const backdatedDetail = await backdatedResponse.json();
    assert.equal(backdatedDetail.recent_evidence_events.length, 2, "a newly committed event cannot be skipped because its business timestamp is old");

    const eventCounts = {
      feedback: storeB.feedbackEvents.length,
      evidence: storeB.evidenceEvents.length
    };
    const secondResponse = await fetch(`${baseUrlB}/agent-router/service?service_id=${serviceId}`);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual({
      feedback: storeB.feedbackEvents.length,
      evidence: storeB.evidenceEvents.length
    }, eventCounts, "a second refresh must not replay already-reduced rows");
    assert.deepEqual(shared.calls.at(-1), {
      afterCreatedAt: null,
      afterEventId: backdated.event_id
    }, "the next instance read must resume from the durable keyset cursor");
  } finally {
    await close(serverA);
    await close(serverB);
  }
});

test("a second instance loads a newly persisted provider config before reducing that service's live events", async () => {
  const serviceId = "new_cross_instance_service";
  const providerId = "new_cross_instance_vendor";
  const shared = createSharedEventLog();
  const store = createMemoryStore();
  const manifest = ownedManifest(serviceId, providerId);
  await shared.writeEvent({
    eventType: "operational_feedback",
    serviceId,
    requestId: "req_new_service_feedback",
    event: {
      ...operationalFeedback(serviceId, "req_new_service_feedback"),
      provider_id: providerId
    }
  });
  await shared.writeEvent({
    eventType: "erc8004_vendor_identity",
    serviceId: `vendor:${providerId}`,
    requestId: TX_HASH,
    event: {
      event_version: "agent_router_erc8004_vendor_identity_v1",
      provider_id: providerId,
      network: "bsc",
      chain_id: 56,
      agent_id: "99121",
      owner_address: OWNER,
      tx_hash: TX_HASH,
      status: "registered",
      created_at: "2027-01-15T10:00:00.000Z"
    }
  });

  const order = [];
  const server = createServer({
    store,
    serviceEventPersistence: {
      refreshConfigs: async (targetStore, baseUrl) => {
        order.push("configs");
        return loadProviderConfigs(targetStore, baseUrl, {
          validate: false,
          force: true,
          listConfigs: async () => [{ manifest }]
        });
      },
      refresh: async (targetStore) => {
        order.push("events");
        return refreshPersistentServiceEvents(targetStore, {
          enabled: true,
          listEvents: shared.listEvents
        });
      },
      writeEvent: shared.writeEvent
    }
  });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/agent-router/service?service_id=${serviceId}`);
    const detail = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(order, ["configs", "events"]);
    assert.equal(detail.recent_feedback_events.length, 1);
    assert.equal(detail.manifest.registration.erc8004.agent_id, "99121");
  } finally {
    await close(server);
  }
});

test("a refresh failure marks public reads stale and fails paid or trust-changing requests closed", async () => {
  const store = createMemoryStore();
  registerService(store, ownedManifest(), "http://127.0.0.1");
  const server = createServer({
    store,
    serviceEventPersistence: {
      refresh: async () => ({
        ok: false,
        status: "degraded",
        stale: true,
        error: { code: "LIVE_STATE_REFRESH_FAILED", message: "database unavailable" }
      })
    }
  });
  const baseUrl = await listen(server);
  try {
    const publicRead = await fetch(`${baseUrl}/agent-router/evidence`);
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.headers.get("x-agentrouter-state-freshness"), "stale");
    assert.match(publicRead.headers.get("warning") || "", /stale/i);

    const paidRoute = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "find current market data" })
    });
    const payload = await paidRoute.json();
    assert.equal(paidRoute.status, 503);
    assert.equal(payload.error.code, "LIVE_STATE_REFRESH_FAILED");
    assert.equal(payload.durability_status, "degraded");
    assert.equal(payload.state_freshness, "stale");

    const connectorRoute = await fetch(`${baseUrl}/connector/search_services`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "market data" })
    });
    assert.equal(connectorRoute.status, 503, "the connector RPC surface must share the same fail-closed state boundary");
  } finally {
    await close(server);
  }
});

test("identity registration never becomes visible in memory before its durable event succeeds", async () => {
  await withEnv({
    ADN_SETTLEMENT_CHAIN: "bsc",
    ADN_PLATFORM_OPERATOR_OWNER_KEY: "local:local-development-user"
  }, async () => {
    const store = createMemoryStore();
    const session = createDevSession(store, "http://127.0.0.1");
    const server = createServer({
      store,
      serviceEventPersistence: {
        refresh: async () => ({ ok: true, status: "fresh", stale: false, loaded: 0 }),
        writeEvent: async () => {
          const error = new Error("database unavailable");
          error.code = "PERSISTENCE_WRITE_FAILED";
          throw error;
        }
      },
      erc8004RegistrationVerifier: async ({ expected }) => ({
        standard: "ERC-8004",
        registry_type: "identity",
        status: "registered",
        network: "bsc",
        caip2: "eip155:56",
        chain_id: 56,
        registry_address: expected.registryAddress,
        agent_id: "99118",
        owner_address: OWNER,
        metadata_uri: expected.agentUri,
        tx_hash: TX_HASH,
        block_number: "789"
      })
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/agent-router/erc8004/platform-registration`, {
        method: "POST",
        headers: {
          cookie: session.cookie.split(";")[0],
          "content-type": "application/json"
        },
        body: JSON.stringify({ tx_hash: TX_HASH, owner_address: OWNER })
      });
      assert.equal(response.status, 500);
      assert.equal(store.erc8004PlatformIdentities.has("bsc"), false);
    } finally {
      await close(server);
    }
  });
});

test("service-level ERC-8004 registration also persists before changing the shared Vendor identity", async () => {
  await withEnv({ ADN_ERC8004_MODE: "mock", ADN_ERC8004_AGENT_ID: "99119" }, async () => {
    const store = createMemoryStore();
    const manifest = ownedManifest("service_identity_atomic", "service_identity_vendor");
    registerService(store, manifest, "http://127.0.0.1");

    await assert.rejects(
      registerServiceErc8004Identity(store, manifest.service_id, {
        baseUrl: "http://127.0.0.1",
        writeEvent: async () => {
          const error = new Error("database unavailable");
          error.code = "PERSISTENCE_WRITE_FAILED";
          throw error;
        }
      }),
      /database unavailable/
    );
    assert.equal(store.erc8004VendorIdentities.size, 0);
    assert.equal(store.services.get(manifest.service_id).manifest.registration?.erc8004, undefined);
  });
});

test("provider-config refresh cannot erase a Vendor identity learned from the durable event stream", async () => {
  const store = createMemoryStore();
  const manifest = ownedManifest("identity_overlay_service", "identity_overlay_vendor");
  registerService(store, manifest, "http://127.0.0.1");
  await hydrateServiceEventRows(store, [{
    event_id: "1",
    event_type: "erc8004_vendor_identity",
    service_id: "vendor:identity_overlay_vendor",
    request_id: TX_HASH,
    event: {
      event_version: "agent_router_erc8004_vendor_identity_v1",
      provider_id: "identity_overlay_vendor",
      network: "bsc",
      chain_id: 56,
      agent_id: "99120",
      owner_address: OWNER,
      tx_hash: TX_HASH,
      status: "registered",
      created_at: "2027-01-15T09:00:00.000Z"
    },
    created_at: "2027-01-15T09:00:00.000Z",
    created_at_cursor: "2027-01-15T09:00:00.000Z"
  }]);
  assert.equal(store.services.get(manifest.service_id).manifest.registration.erc8004.agent_id, "99120");

  let listed = false;
  const staleConfig = { manifest: ownedManifest(manifest.service_id, "identity_overlay_vendor") };
  await loadProviderConfigs(store, "http://127.0.0.1", {
    validate: false,
    force: true,
    listConfigs: async () => {
      listed = true;
      return [staleConfig];
    }
  });

  assert.equal(listed, true);
  assert.equal(store.services.get(manifest.service_id).manifest.registration.erc8004.agent_id, "99120");
});

test("a successful external API call explicitly reports degraded durability when its feedback artifacts cannot persist", async () => {
  const store = createMemoryStore();
  const result = await runExternalApiQuery(store, "local:test-user", {
    source: "gdelt",
    operation: "search",
    query: "agent payments"
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        articles: [{
          title: "Agent payments",
          url: "https://example.com/news",
          domain: "example.com",
          seendate: "20260830T000000Z"
        }]
      })
    }),
    writeServiceEvent: async () => {
      const error = new Error("database unavailable");
      error.code = "PERSISTENCE_WRITE_FAILED";
      throw error;
    }
  });

  assert.equal(result.ok, true, "data delivery remains available after the upstream call already succeeded");
  assert.equal(result.durability_status, "degraded");
  assert.deepEqual(result.durability_errors.map((item) => item.event_type).sort(), [
    "invocation_feedback_grant",
    "operational_feedback"
  ]);
  assert.ok(result.durability_errors.every((item) => item.code === "PERSISTENCE_WRITE_FAILED"));
});
