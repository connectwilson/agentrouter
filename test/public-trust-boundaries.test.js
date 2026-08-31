import assert from "node:assert/strict";
import test from "node:test";

import { baseFundFlowManifest } from "../src/fixtures.js";
import { createServer } from "../src/server.js";

const OWNER_COOKIE = "ar_session=public-trust-owner-session";
const STRANGER_COOKIE = "ar_session=public-trust-stranger-session";
const PRIVATE_OWNER_EMAIL = "private-owner-email-sentinel@example.test";
const RAW_REQUEST_SENTINEL = "raw-request-sentinel-do-not-publish";
const RAW_INPUT_SENTINEL = "raw-input-sentinel-do-not-publish";
const ACTOR_SENTINEL = "github:private-actor-sentinel";

const owner = {
  provider: "github",
  id: "public-trust-owner",
  name: "Public Trust Owner",
  handle: "public-trust-owner",
  email: PRIVATE_OWNER_EMAIL
};

const stranger = {
  provider: "github",
  id: "public-trust-stranger",
  name: "Public Trust Stranger",
  handle: "public-trust-stranger"
};

async function withTrustServer(run) {
  const server = createServer();
  server.store.authSessions.set("public-trust-owner-session", {
    user: owner,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  server.store.authSessions.set("public-trust-stranger-session", {
    user: stranger,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ server, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function manifest(serviceId) {
  const value = structuredClone(baseFundFlowManifest);
  value.service_id = serviceId;
  value.title = `Public trust boundary ${serviceId}`;
  value.provider = {
    ...value.provider,
    provider_id: `provider_${serviceId}`
  };
  value.sample_response.service_id = serviceId;
  return value;
}

async function postJson(url, body, cookie = "") {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

async function registerOwnedService(server, baseUrl, serviceId) {
  const response = await postJson(`${baseUrl}/services/register`, manifest(serviceId), OWNER_COOKIE);
  assert.equal(response.status, 201);
  return server.store.services.get(serviceId);
}

function mutationCounts(server, record) {
  return {
    record_feedback: record.feedback_events.length,
    global_feedback: server.store.feedbackEvents.length,
    quality: server.store.qualityEvents.length,
    evidence: server.store.evidenceEvents.length
  };
}

async function responseTextAtPublicBoundary(response) {
  assert.ok(
    [200, 401, 403].includes(response.status),
    `public boundary must return a projection or an auth denial, received HTTP ${response.status}`
  );
  return response.text();
}

function assertNoPrivateSentinels(text, label) {
  for (const sentinel of [RAW_REQUEST_SENTINEL, RAW_INPUT_SENTINEL, ACTOR_SENTINEL, PRIVATE_OWNER_EMAIL]) {
    assert.equal(text.includes(sentinel), false, `${label} exposed ${sentinel}`);
  }
}

test("anonymous completed-call ingestion cannot create trust-affecting events", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    const serviceId = "anonymous_completed_call_boundary";
    const record = await registerOwnedService(server, baseUrl, serviceId);
    const before = mutationCounts(server, record);
    const previousAnchorMode = process.env.ADN_EVIDENCE_ANCHOR_MODE;
    process.env.ADN_EVIDENCE_ANCHOR_MODE = "mock";

    let response;
    try {
      const result = structuredClone(record.manifest.sample_response);
      delete result.sample_type;
      result.service_id = serviceId;
      result.request_id = "req_anonymous_completed_call_boundary";
      result.metadata.generated_at = new Date().toISOString();
      result.metadata.is_estimated = false;
      response = await postJson(`${baseUrl}/agent-router/calls/complete`, {
        service_id: serviceId,
        request: {
          capability: "fund_flow",
          params: { chain: "base", days: 7, confidential: RAW_REQUEST_SENTINEL }
        },
        input: { chain: "base", days: 7, confidential: RAW_INPUT_SENTINEL },
        result,
        local_payment: {
          network: "attacker-controlled-non-settlement-network",
          status: "success"
        },
        feedback: {
          status: "success",
          consumer_id: ACTOR_SENTINEL,
          consumer_rating: 1,
          latency_ms: 1
        }
      });
    } finally {
      if (previousAnchorMode == null) delete process.env.ADN_EVIDENCE_ANCHOR_MODE;
      else process.env.ADN_EVIDENCE_ANCHOR_MODE = previousAnchorMode;
    }

    assert.deepEqual({
      http_status: response.status,
      mutations: mutationCounts(server, record)
    }, {
      http_status: 401,
      mutations: before
    });
  });
});

test("anonymous ERC-8004 attachment cannot consume a pending feedback state", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    const serviceId = "anonymous_erc8004_boundary";
    const requestId = "req_anonymous_erc8004_boundary";
    const record = await registerOwnedService(server, baseUrl, serviceId);
    const pending = {
      standard: "ERC-8004",
      registry_type: "reputation",
      status: "consumer_submission_required",
      chain_id: 56,
      registry_address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      agent_id: "42",
      feedback_hash: `0x${"c".repeat(64)}`,
      value: "10000",
      value_decimals: 2,
      tag1: "intent_fit",
      tag2: "answer_useful",
      endpoint: "https://agentrouter.network/agent-router/feedback",
      feedback_uri: `https://agentrouter.network/agent-router/feedback?request_id=${requestId}`
    };
    const event = {
      event_version: "agent_service_feedback_v1",
      request_id: requestId,
      service_id: serviceId,
      provider_id: record.manifest.provider.provider_id,
      invocation_actor_key: "github:public-trust-owner",
      status: "success",
      schema_valid: true,
      consumer_feedback_erc8004: pending,
      consumer_feedback_trust_anchor: { state: "onchain_pending", erc8004: pending },
      created_at: new Date().toISOString()
    };
    record.feedback_events.push(event);
    server.store.feedbackEvents.push(event);

    const body = {
      service_id: serviceId,
      request_id: requestId,
      erc8004: {
        ...pending,
        status: "sponsorship_failed",
        error: "anonymous attacker consumed the pending state"
      }
    };
    const anonymousResponse = await postJson(`${baseUrl}/agent-router/feedback/erc8004`, body);
    const strangerResponse = await postJson(`${baseUrl}/agent-router/feedback/erc8004`, body, STRANGER_COOKIE);

    assert.deepEqual({
      anonymous_http_status: anonymousResponse.status,
      stranger_http_status: strangerResponse.status,
      erc8004_status: event.consumer_feedback_erc8004.status,
      trust_state: event.consumer_feedback_trust_anchor.state
    }, {
      anonymous_http_status: 401,
      stranger_http_status: 403,
      erc8004_status: "consumer_submission_required",
      trust_state: "onchain_pending"
    });
  });
});

test("public evidence responses never expose raw request or input values", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    server.store.evidenceEvents.push({
      evidence_version: "agent_router_evidence_v1",
      request_id: "req_public_evidence_boundary",
      service_id: "public_evidence_boundary",
      provider_id: "provider_public_evidence_boundary",
      request: { task: RAW_REQUEST_SENTINEL },
      input: { confidential: RAW_INPUT_SENTINEL },
      invocation_actor_key: ACTOR_SENTINEL,
      created_at: new Date().toISOString()
    });

    const response = await fetch(`${baseUrl}/agent-router/evidence?request_id=req_public_evidence_boundary`);
    const text = await responseTextAtPublicBoundary(response);
    assertNoPrivateSentinels(text, "public evidence response");
  });
});

test("public observation responses never expose raw routing context", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    server.store.routeObservations.push({
      observation_version: "agent_router_route_observation_v1",
      observation_id: "route_obs_public_boundary",
      status: "routed",
      request: {
        capability: "fund_flow",
        task: RAW_REQUEST_SENTINEL,
        params: { confidential: RAW_INPUT_SENTINEL }
      },
      invocation_actor_key: ACTOR_SENTINEL,
      created_at: new Date().toISOString()
    });

    const response = await fetch(`${baseUrl}/agent-router/observations?status=routed`);
    const text = await responseTextAtPublicBoundary(response);
    assertNoPrivateSentinels(text, "public observation response");
  });
});

test("public feedback responses never expose invocation actors or raw call inputs", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    const serviceId = "public_feedback_boundary";
    const requestId = "req_public_feedback_boundary";
    const record = await registerOwnedService(server, baseUrl, serviceId);
    const event = {
      event_version: "agent_service_feedback_v1",
      request_id: requestId,
      service_id: serviceId,
      provider_id: record.manifest.provider.provider_id,
      consumer_id: ACTOR_SENTINEL,
      invocation_actor_key: ACTOR_SENTINEL,
      request: { task: RAW_REQUEST_SENTINEL },
      input: { confidential: RAW_INPUT_SENTINEL },
      status: "success",
      schema_valid: true,
      created_at: new Date().toISOString()
    };
    record.feedback_events.push(event);
    server.store.feedbackEvents.push(event);

    const responses = await Promise.all([
      fetch(`${baseUrl}/agent-router/feedback?request_id=${requestId}`),
      fetch(`${baseUrl}/services/${serviceId}/feedback`),
      postJson(`${baseUrl}/connector/get_feedback`, { service_id: serviceId })
    ]);
    const texts = await Promise.all(responses.map(responseTextAtPublicBoundary));
    texts.forEach((text, index) => assertNoPrivateSentinels(text, `public feedback response ${index + 1}`));
  });
});

test("public manifest projections omit private registration owner metadata", async () => {
  await withTrustServer(async ({ server, baseUrl }) => {
    const serviceId = "public_manifest_owner_boundary";
    const record = await registerOwnedService(server, baseUrl, serviceId);
    record.verification_status = "verified";

    const httpResponse = await fetch(`${baseUrl}/services/${serviceId}/manifest`);
    const connectorResponse = await postJson(`${baseUrl}/connector/get_manifest`, { service_id: serviceId });
    assert.equal(httpResponse.status, 200);
    assert.equal(connectorResponse.status, 200);
    const httpManifest = await httpResponse.json();
    const connectorManifest = await connectorResponse.json();

    assert.deepEqual({
      http_owner: httpManifest.registration?.owner,
      connector_owner: connectorManifest.registration?.owner
    }, {
      http_owner: undefined,
      connector_owner: undefined
    });
    assert.equal(
      record.manifest.registration.owner.email,
      PRIVATE_OWNER_EMAIL,
      "public projection must not mutate the stored manifest"
    );
    assertNoPrivateSentinels(JSON.stringify([httpManifest, connectorManifest]), "public manifest projection");
  });
});
