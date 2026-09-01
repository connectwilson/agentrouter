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

test("issuing a local feedback grant can durably materialize a privacy-minimized v2 routing observation", async () => {
  const store = createMemoryStore();
  const writes = [];
  const result = await issueLocalFeedbackGrant(store, {
    request_id: "local_search_x_routeobs",
    service_id: "local_social_x",
    operation: "search",
    capability: "social_user_voice_research",
    result_status: "completed",
    routing_summary: {
      task_family: "social_research",
      route_family: "local_browser",
      capability: "social_user_voice_research",
      source_family: "social",
      action: "route",
      source: "x",
      selected_service_id: "local_social_x",
      candidate_sources: ["x"],
      budget: {
        max_price_usdc: "0.05",
        selected_price_usdc: "0",
        compliant: true
      },
      authorization: {
        required: false,
        action: "none",
        source: null
      }
    }
  }, {
    actorKey: "actor:owner",
    writeEvent: async (entry) => writes.push(entry),
    randomBytes: () => Buffer.alloc(32, 3)
  });

  assert.equal(result.status, "feedback_grant_issued");
  assert.equal(result.routing_observation_id, store.routeObservations[0].observation_id);
  assert.equal(writes[0].eventType, "route_observation");
  assert.equal(writes[1].eventType, "feedback_grant");
  assert.equal(store.routeObservations.length, 1);
  assert.equal(store.routeObservations[0].observation_version, "agent_router_route_observation_v2");
  assert.equal(store.routeObservations[0].action, "route");
  assert.deepEqual(store.routeObservations[0].authorization, {
    required: false,
    action: "none",
    source: null
  });
});

test("local feedback grant persistence is one atomic idempotent bundle", async () => {
  const store = createMemoryStore();
  const committed = [];
  let batchCalls = 0;
  const body = {
    request_id: "local_search_reddit_atomic_retry",
    service_id: "local_social_reddit",
    operation: "search",
    capability: "social_search",
    result_status: "completed",
    routing_summary: { route_family: "local_browser" }
  };

  await assert.rejects(
    issueLocalFeedbackGrant(store, body, {
      actorKey: "actor:owner",
      writeEvents: async (entries) => {
        batchCalls += 1;
        assert.deepEqual(entries.map((entry) => entry.eventType), ["route_observation", "feedback_grant"]);
        throw new Error("feedback grant insert failed");
      },
      randomBytes: () => Buffer.alloc(32, 4)
    }),
    /feedback grant insert failed/
  );
  assert.equal(batchCalls, 1, "the two rows must be offered to one transaction boundary");
  assert.deepEqual(committed, [], "a failed bundle must not leave a durable orphan");
  assert.equal(store.routeObservations.length, 0, "memory must not claim an uncommitted observation");
  assert.equal(store.feedbackGrants.size, 0, "memory must not claim an uncommitted grant");

  const first = await issueLocalFeedbackGrant(store, body, {
    actorKey: "actor:owner",
    writeEvents: async (entries) => {
      for (const entry of entries) {
        const identity = `${entry.eventType}:${entry.event.observation_id || entry.event.request_id}`;
        if (!committed.some((item) => item.identity === identity)) committed.push({ identity, entry });
      }
      return true;
    },
    randomBytes: () => Buffer.alloc(32, 4)
  });
  const replay = await issueLocalFeedbackGrant(store, body, {
    actorKey: "actor:owner",
    writeEvents: async () => assert.fail("an in-process replay must not write a second bundle"),
    randomBytes: () => Buffer.alloc(32, 4)
  });

  assert.equal(committed.length, 2);
  assert.equal(first.routing_observation_id, committed[0].entry.event.observation_id);
  assert.equal(replay.routing_observation_id, first.routing_observation_id);
  assert.equal(replay.status, "feedback_grant_already_issued");
});

test("local feedback observations are derived from validated server fields, not client routing claims", async () => {
  const store = createMemoryStore();
  const writes = [];
  const result = await issueLocalFeedbackGrant(store, {
    request_id: "local_search_x_poisoned_summary",
    service_id: "local_social_x",
    operation: "search",
    capability: "social_user_voice_research",
    result_status: "no_results",
    routing_summary: {
      task_family: "financial_market_data",
      route_family: "external_api",
      capability: "stock_quote",
      source_family: "market",
      action: "fallback",
      selected_service_id: "evil_paid_service",
      candidate_sources: ["evil_paid_service"],
      budget: {
        max_price_usdc: "0",
        selected_price_usdc: "999",
        compliant: false
      },
      authorization: { required: true, action: "connect_source", source: "evil" }
    }
  }, {
    actorKey: "actor:owner",
    writeEvents: async (entries) => writes.push(...entries),
    randomBytes: () => Buffer.alloc(32, 5)
  });

  const observation = writes.find((entry) => entry.eventType === "route_observation").event;
  assert.equal(result.routing_observation_id, observation.observation_id);
  assert.equal(observation.task_family, "social_research");
  assert.equal(observation.route_family, "local_browser");
  assert.equal(observation.capability, "social_user_voice_research");
  assert.equal(observation.source_family, "social");
  assert.equal(observation.action, "route");
  assert.equal(observation.selected_service_id, "local_social_x");
  assert.deepEqual(observation.candidates.map((candidate) => candidate.service_id), ["local_social_x"]);
  assert.deepEqual(observation.budget, {
    max_price_usdc: "0",
    selected_price_usdc: "0",
    compliant: true
  });
  assert.deepEqual(observation.authorization, { required: false, action: "none", source: null });
});

test("local feedback grants reject invalid platform, capability, operation, and result status enums", async () => {
  const cases = [
    {
      request_id: "local_search_telegram_invalid",
      service_id: "local_social_telegram",
      operation: "search",
      capability: "social_search",
      result_status: "completed"
    },
    {
      request_id: "local_search_x_badcap",
      service_id: "local_social_x",
      operation: "search",
      capability: "stock_quote",
      result_status: "completed"
    },
    {
      request_id: "local_post_x_badop",
      service_id: "local_social_x",
      operation: "search",
      capability: "social_post_read",
      result_status: "completed"
    },
    {
      request_id: "local_search_reddit_badstatus",
      service_id: "local_social_reddit",
      operation: "search",
      capability: "social_search",
      result_status: "budget_violation"
    }
  ];

  for (const body of cases) {
    const store = createMemoryStore();
    await assert.rejects(
      issueLocalFeedbackGrant(store, body, {
        actorKey: "actor:owner",
        writeEvents: async () => assert.fail("invalid metadata must not be persisted")
      }),
      (error) => error?.statusCode === 422 && error?.code === "INVALID_LOCAL_FEEDBACK_GRANT"
    );
    assert.equal(store.routeObservations.length, 0);
    assert.equal(store.feedbackGrants.size, 0);
  }
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
