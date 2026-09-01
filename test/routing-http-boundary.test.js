import assert from "node:assert/strict";
import test from "node:test";

import {
  externalApiStatusCode,
  paymentBoundaryStatusCode,
  requestPaymentRequired
} from "../src/routing/http-boundary.js";
import {
  requirementToCapabilityRequest,
  resultReturnedUsableData
} from "../src/routing/fetch.js";

test("routing HTTP boundary preserves agent-facing status codes", () => {
  assert.equal(externalApiStatusCode({ ok: false, status: "connection_required" }), 401);
  assert.equal(externalApiStatusCode({ ok: false, status: "quote_required" }), 402);
  assert.equal(externalApiStatusCode({ ok: false, status: "unsupported_operation" }), 422);
  assert.equal(externalApiStatusCode({ ok: false, status: "rate_limited" }), 429);
  assert.equal(externalApiStatusCode({ ok: false, status: "provider_error" }), 502);
  assert.equal(externalApiStatusCode({ ok: false, status: "local_browser_handoff_required" }), 200);

  assert.equal(paymentBoundaryStatusCode({ status: "connection_required" }), 401);
  assert.equal(paymentBoundaryStatusCode({ status: "payment_required" }), 402);
  assert.equal(paymentBoundaryStatusCode({
    status: "no_data_returned",
    results: [{ status: "provider_error" }]
  }), 502);
});

test("request boundary converts an invokable quote into payment-required", () => {
  const result = requestPaymentRequired({
    ok: true,
    status: "quoted",
    selected_service: { service_id: "test-service" }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "payment_required");
  assert.equal(result.protocol.protocol_version, "agent_router_request_v1");
  assert.match(result.next_step, /payment-capable backend|payment proof/i);
});

test("fetch requirement normalization keeps explicit request constraints", () => {
  const request = requirementToCapabilityRequest({
    type: "external_api_query",
    source: "exa",
    operation: "search",
    constraints: { max_price_usdc: "0.01" },
    budget: { currency: "USDC" },
    consumer_context: { source: "test-suite" }
  }, {
    constraints: { freshness: "7d" },
    budget: { max_amount: "0.05" }
  }, { maxPrice: "0.05", currency: "USDC" });

  assert.equal(request.capability, "external_api_query");
  assert.deepEqual(request.params, { source: "exa", operation: "search" });
  assert.equal(request.constraints.max_price_usdc, "0.01");
  assert.equal(request.constraints.freshness, "7d");
  assert.equal(request.budget.max_amount, "0.05");
  assert.equal(request.consumer_context.source, "test-suite");
});

test("fetch usability rejects empty envelopes and accepts populated data", () => {
  assert.equal(resultReturnedUsableData(null), false);
  assert.equal(resultReturnedUsableData({ ok: false, result: [1] }), false);
  assert.equal(resultReturnedUsableData({ ok: true, result: [] }), false);
  assert.equal(resultReturnedUsableData({ ok: true, result: { items: [] } }), false);
  assert.equal(resultReturnedUsableData({ ok: true, result: { data: [{ id: 1 }] } }), true);
  assert.equal(resultReturnedUsableData({ ok: true, result: "evidence" }), true);
});
