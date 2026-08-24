import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";

const owner = {
  provider: "github",
  id: "security-owner",
  name: "Security Owner",
  handle: "security-owner"
};

const stranger = {
  provider: "github",
  id: "security-stranger",
  name: "Security Stranger",
  handle: "security-stranger"
};

async function withSecurityServer(fn, serverOptions = {}) {
  const server = createServer(serverOptions);
  server.store.authSessions.set("owner-session", {
    user: owner,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  server.store.authSessions.set("stranger-session", {
    user: stranger,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ server, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function manifest(serviceId = "security_owned_service") {
  return structuredClone({
    ...baseFundFlowManifest,
    service_id: serviceId,
    title: "Security boundary service",
    provider: {
      ...baseFundFlowManifest.provider,
      provider_id: `provider_${serviceId}`
    }
  });
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

test("security-sensitive service writes require authentication and ownership", async () => {
  await withSecurityServer(async ({ server, baseUrl }) => {
    const anonymous = await postJson(`${baseUrl}/services/register`, manifest());
    assert.equal(anonymous.status, 401);
    assert.equal(server.store.services.has("security_owned_service"), false);

    const registered = await postJson(
      `${baseUrl}/services/register`,
      manifest(),
      "ar_session=owner-session"
    );
    assert.equal(registered.status, 201);
    assert.equal(
      server.store.services.get("security_owned_service").manifest.registration.owner.user_key,
      "github:security-owner"
    );

    const anonymousValidation = await postJson(
      `${baseUrl}/services/security_owned_service/validate`,
      {}
    );
    assert.equal(anonymousValidation.status, 401);

    const strangerValidation = await postJson(
      `${baseUrl}/services/security_owned_service/validate`,
      {},
      "ar_session=stranger-session"
    );
    assert.equal(strangerValidation.status, 403);

    const strangerHealthCheck = await postJson(
      `${baseUrl}/agent-router/health-check`,
      { service_id: "security_owned_service" },
      "ar_session=stranger-session"
    );
    assert.equal(strangerHealthCheck.status, 403);
    assert.equal(server.store.services.get("security_owned_service").health_checks.length, 0);

    const strangerErc8004 = await postJson(
      `${baseUrl}/services/security_owned_service/erc8004/register`,
      {},
      "ar_session=stranger-session"
    );
    assert.equal(strangerErc8004.status, 403);
  });
});

test("feedback requires an authenticated caller and a real invocation handle", async () => {
  await withSecurityServer(async ({ server, baseUrl }) => {
    const registration = await postJson(
      `${baseUrl}/services/register`,
      manifest("feedback_security_service"),
      "ar_session=owner-session"
    );
    assert.equal(registration.status, 201);

    const body = {
      service_id: "feedback_security_service",
      request_id: "invented_request_id",
      consumer_id: "spoofed-client-value",
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        reason: "attempted trust inflation"
      }
    };
    const anonymous = await postJson(`${baseUrl}/agent-router/feedback`, body);
    assert.equal(anonymous.status, 401);

    const invented = await postJson(
      `${baseUrl}/agent-router/feedback`,
      body,
      "ar_session=owner-session"
    );
    assert.equal(invented.status, 404);
    assert.equal(server.store.services.get("feedback_security_service").feedback_events.length, 0);

    const claimedInvocation = {
      event_version: "agent_service_feedback_v1",
      request_id: "real_but_foreign_request",
      service_id: "feedback_security_service",
      provider_id: "provider_feedback_security_service",
      consumer_id: "github:security-stranger",
      invocation_actor_key: "github:security-stranger",
      status: "success",
      schema_valid: true,
      created_at: new Date().toISOString()
    };
    server.store.services.get("feedback_security_service").feedback_events.push(claimedInvocation);
    server.store.feedbackEvents.push(claimedInvocation);
    const foreignInvocation = await postJson(
      `${baseUrl}/agent-router/feedback`,
      { ...body, request_id: "real_but_foreign_request" },
      "ar_session=owner-session"
    );
    assert.equal(foreignInvocation.status, 403);

    const localBody = {
      request_id: "local_search_reddit_1786955108056_secure1",
      consumer_id: "spoofed-client-value",
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        reason: "used in the answer"
      }
    };
    const local = await postJson(
      `${baseUrl}/agent-router/feedback`,
      localBody,
      "ar_session=owner-session"
    );
    assert.equal(local.status, 200);
    const localEvent = server.store.feedbackEvents.find((event) => event.request_id === localBody.request_id);
    assert.equal(localEvent.consumer_id, "github:security-owner");

    const hijack = await postJson(
      `${baseUrl}/agent-router/feedback`,
      localBody,
      "ar_session=stranger-session"
    );
    assert.equal(hijack.status, 403);
  });
});

test("sensitive writes are rate limited per authenticated actor", async () => {
  await withSecurityServer(async ({ baseUrl }) => {
    const first = await postJson(
      `${baseUrl}/services/register`,
      manifest("rate_limit_1"),
      "ar_session=owner-session"
    );
    const second = await postJson(
      `${baseUrl}/services/register`,
      manifest("rate_limit_2"),
      "ar_session=owner-session"
    );
    const blocked = await postJson(
      `${baseUrl}/services/register`,
      manifest("rate_limit_3"),
      "ar_session=owner-session"
    );

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal((await blocked.json()).error.code, "RATE_LIMITED");
  }, {
    writeRateLimit: { max: 2, windowMs: 60_000 }
  });
});
