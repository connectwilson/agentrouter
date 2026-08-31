import test from "node:test";
import assert from "node:assert/strict";

import { serviceEventIdempotencyKey } from "../src/persistence.js";

test("re-verifying an imported ERC-8004 agent creates a new durable event", () => {
  const first = serviceEventIdempotencyKey({
    eventType: "erc8004_agent_import",
    serviceId: "erc8004:56:42",
    requestId: "56:42",
    event: { chain_id: 56, agent_id: "42", verified_at: "2026-08-31T00:00:00.000Z" }
  });
  const second = serviceEventIdempotencyKey({
    eventType: "erc8004_agent_import",
    serviceId: "erc8004:56:42",
    requestId: "56:42",
    event: { chain_id: 56, agent_id: "42", verified_at: "2026-08-31T00:15:00.000Z" }
  });
  assert.notEqual(first, second);
});
