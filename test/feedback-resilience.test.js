import test from "node:test";
import assert from "node:assert/strict";

import { baseFundFlowManifest } from "../src/fixtures.js";
import {
  hydrateServiceEventRows,
  issueLocalFeedbackGrant,
  recordConsumerFeedback,
  registerService
} from "../src/registry.js";
import {
  createMemoryStore,
  summarizeRegistryStats,
  summarizeTrust
} from "../src/store.js";

function feedback(intentFit = "yes") {
  return {
    intent_fit: intentFit,
    answer_useful: intentFit,
    reason: `${intentFit} result`,
    consumer_score: intentFit === "yes" ? 1 : 0
  };
}

function operational({ requestId, serviceId, actor = "actor:owner" }) {
  return {
    event_version: "agent_service_feedback_v1",
    request_id: requestId,
    service_id: serviceId,
    provider_id: `provider_${serviceId}`,
    consumer_id: actor,
    invocation_actor_key: actor,
    status: "success",
    schema_valid: true,
    verification: { coverage_valid: true, freshness_valid: true, agent_friendly_score: 1 },
    created_at: "2026-08-24T00:00:00.000Z"
  };
}

test("a hydrated feedback grant rotates its opaque token after restart", async () => {
  const store = createMemoryStore();
  const requestId = "local_post_x_restart";
  await hydrateServiceEventRows(store, [{
    event_type: "feedback_grant",
    service_id: "local_social_x",
    request_id: requestId,
    event: {
      event_version: "agent_local_feedback_grant_v1",
      request_id: requestId,
      service_id: "local_social_x",
      actor_key: "actor:owner",
      operation: "post",
      platform: "x",
      token_hash: "old-hash",
      created_at: "2026-08-28T00:00:00.000Z"
    }
  }]);
  const writes = [];
  const result = await issueLocalFeedbackGrant(store, {
    request_id: requestId,
    service_id: "local_social_x",
    operation: "post"
  }, {
    actorKey: "actor:owner",
    writeEvent: async (entry) => writes.push(entry),
    randomBytes: () => Buffer.alloc(32, 7)
  });
  assert.equal(result.status, "feedback_grant_rotated");
  assert.match(result.feedback_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(writes[0].eventType, "feedback_grant_rotation");
  assert.notEqual(store.feedbackGrants.get(requestId).token_hash, "old-hash");
});

test("persistent hydration restores external feedback, quote feedback, and submitted ERC-8004 state", async () => {
  const store = createMemoryStore();
  const record = registerService(store, {
    ...structuredClone(baseFundFlowManifest),
    service_id: "hydrated_service",
    provider: { ...baseFundFlowManifest.provider, provider_id: "provider_hydrated_service" }
  }, "http://127.0.0.1:8800");
  const registryOperational = operational({ requestId: "req_registry", serviceId: "hydrated_service" });
  const externalOperational = operational({ requestId: "req_external", serviceId: "external_api_exa" });
  const submitted = {
    standard: "ERC-8004",
    registry_type: "reputation",
    status: "submitted",
    chain_id: 56,
    agent_id: "42",
    tx_hash: `0x${"a".repeat(64)}`
  };
  const rows = [
    {
      event_type: "issued_quote",
      service_id: "hydrated_service",
      request_id: "quote_1",
      event: { quote_id: "quote_1", service_id: "hydrated_service", actor_key: "actor:owner", created_at: "2026-08-24T00:00:30.000Z", expires_at: Date.now() + 60_000 }
    },
    { event_type: "operational_feedback", service_id: "hydrated_service", request_id: "req_registry", event: registryOperational },
    { event_type: "operational_feedback", service_id: "external_api_exa", request_id: "req_external", event: externalOperational },
    {
      event_type: "consumer_feedback",
      service_id: "external_api_exa",
      request_id: "req_external",
      event: {
        event_version: "agent_consumer_feedback_v1",
        service_id: "external_api_exa",
        request_id: "req_external",
        consumer_id: "actor:owner",
        consumer_feedback: feedback("no"),
        created_at: "2026-08-24T00:01:00.000Z"
      }
    },
    {
      event_type: "quote_feedback",
      service_id: "hydrated_service",
      request_id: "quote_1",
      event: { event_version: "agentrouter_quote_feedback_v1", quote_id: "quote_1", service_id: "hydrated_service", decision: "not_invoked", reason_code: "price_too_high", reason: "too expensive", created_at: "2026-08-24T00:02:00.000Z" }
    },
    {
      event_type: "consumer_feedback_anchor",
      service_id: "hydrated_service",
      request_id: "req_registry",
      event: {
        arc_anchor: { status: "not_used" },
        erc8004: { status: "consumer_submission_required", chain_id: 56, agent_id: "42" },
        trust_anchor: { state: "onchain_pending", primary_standard: "ERC-8004" }
      }
    },
    {
      event_type: "consumer_feedback_erc8004_client",
      service_id: "hydrated_service",
      request_id: "req_registry",
      event: { erc8004: submitted, created_at: "2026-08-24T00:03:00.000Z" }
    }
  ];

  await hydrateServiceEventRows(store, rows);

  const external = store.feedbackEvents.find((event) => event.request_id === "req_external" && event.event_version === "agent_service_feedback_v1");
  assert.equal(external.consumer_feedback.intent_fit, "no");
  assert.equal(store.quoteFeedbackEvents.length, 1);
  assert.equal(store.issuedQuotes.get("quote_1").service_id, "hydrated_service");
  const registry = record.feedback_events.find((event) => event.request_id === "req_registry");
  assert.equal(registry.consumer_feedback_erc8004.status, "submitted");
  assert.equal(registry.consumer_feedback_trust_anchor.state, "onchain_submitted");
});

test("consumer feedback persistence failure is returned and never mutates reputation", async () => {
  const store = createMemoryStore();
  const event = operational({ requestId: "req_write_failure", serviceId: "external_api_exa" });
  store.feedbackEvents.push(event);

  await assert.rejects(
    () => recordConsumerFeedback(store, {
      request_id: "req_write_failure",
      feedback: { intent_fit: "yes", answer_useful: "yes", reason: "would be useful" }
    }, {
      actorKey: "actor:owner",
      requireKnownInvocation: true,
      writeEvent: async () => { throw new Error("database unavailable"); }
    }),
    /database unavailable/
  );
  assert.equal(event.consumer_feedback, undefined);
});

test("trust exposes sample confidence and shrinks small samples for routing", () => {
  const trust = (events) => summarizeTrust({
    manifest: { provider: { provider_id: "provider" } },
    verification_status: "verified",
    feedback_events: events
  });
  const none = trust([]);
  const one = trust([{ ...operational({ requestId: "one", serviceId: "s" }), consumer_feedback: feedback("no") }]);
  const many = trust(Array.from({ length: 20 }, (_, index) => ({
    ...operational({ requestId: `many_${index}`, serviceId: "s" }),
    consumer_feedback: feedback("no")
  })));

  assert.equal(none.feedback_state, "no_feedback_yet");
  assert.equal(none.trust_score_confidence, 0);
  assert.ok(one.trust_score_confidence > 0 && one.trust_score_confidence < many.trust_score_confidence);
  assert.ok(
    Math.abs(one.routing_trust_score - one.trust_score_prior) < Math.abs(one.trust_score - one.trust_score_prior),
    "one rating is shrunk toward the verified-service prior"
  );
  assert.ok(Math.abs(many.routing_trust_score - many.trust_score) < Math.abs(one.routing_trust_score - one.trust_score));
});

test("registry stats report feedback completion and explicit on-chain states", () => {
  const store = createMemoryStore();
  store.feedbackEvents.push(
    { ...operational({ requestId: "completed", serviceId: "external_api_exa" }), consumer_feedback: feedback("yes"), consumer_feedback_trust_anchor: { state: "onchain_submitted" } },
    { ...operational({ requestId: "pending", serviceId: "local_social_x" }), consumer_feedback_trust_anchor: { state: "onchain_pending" } },
    { ...operational({ requestId: "offchain", serviceId: "external_api_gdelt" }), consumer_feedback: feedback("no"), consumer_feedback_trust_anchor: { state: "offchain_recorded" } }
  );

  const metrics = summarizeRegistryStats(store).feedback_delivery;
  assert.deepEqual(metrics, {
    expected: 3,
    received: 2,
    completion_rate: 0.67,
    onchain_submitted: 1,
    onchain_pending: 1,
    onchain_failed: 0,
    offchain_recorded: 1
  });
});

test("home stats count the canonical call ledger and expose newest calls across service types", async () => {
  const { summarizeHomeStats } = await import("../src/store.js");
  const store = createMemoryStore();
  const record = registerService(store, {
    ...structuredClone(baseFundFlowManifest),
    service_id: "registered_recent_service",
    title: "Registered recent service",
    provider: { ...baseFundFlowManifest.provider, provider_id: "registered_provider" }
  }, "http://127.0.0.1:8800");
  record.feedback_events.push(operational({ requestId: "registered_req", serviceId: "registered_recent_service" }));
  store.feedbackEvents.push(
    operational({ requestId: "registered_req", serviceId: "registered_recent_service" }),
    {
      event_version: "agent_external_api_feedback_v1",
      request_id: "external_req",
      service_id: "external_api_exa",
      provider_id: "exa",
      status: "success",
      schema_valid: true,
      created_at: "2026-08-24T00:02:00.000Z"
    },
    {
      event_version: "agent_local_connector_feedback_v1",
      request_id: "local_req",
      service_id: "local_social_x",
      provider_id: "local_browser_connector",
      status: "success",
      schema_valid: true,
      created_at: "2026-08-24T00:03:00.000Z"
    },
    {
      event_version: "agent_service_feedback_v1",
      request_id: "rating_without_call",
      service_id: "registered_recent_service",
      status: "consumer_feedback_only",
      created_at: "2026-08-24T00:04:00.000Z"
    }
  );

  const stats = summarizeHomeStats(store);

  assert.equal(stats.total_calls, 3, "duplicate ledger rows and rating-only events are not counted as calls");
  assert.deepEqual(stats.recent_calls.map((call) => call.service_id), [
    "local_social_x",
    "external_api_exa",
    "registered_recent_service"
  ]);
  assert.equal(stats.recent_calls[2].title, "Registered recent service");
  assert.equal(stats.generated_at.endsWith("Z"), true);
  assert.equal("recent_services" in stats, false, "registration load order is not a call activity feed");
});
