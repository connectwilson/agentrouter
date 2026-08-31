import test from "node:test";
import assert from "node:assert/strict";

import { serviceEventIdempotencyKey } from "../src/persistence.js";
import { hydrateServiceEventRows } from "../src/registry.js";
import { createMemoryStore } from "../src/store.js";

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
  assert.equal(first, serviceEventIdempotencyKey({
    eventType: "erc8004_agent_import",
    serviceId: "erc8004:56:42",
    requestId: "56:42",
    event: { chain_id: 56, agent_id: "42", verified_at: "2026-08-31T00:00:00.000Z" }
  }), "an exact event retry must remain idempotent");
});

test("hydration keeps the newest verification event for an imported Agent", async () => {
  const store = createMemoryStore();
  await hydrateServiceEventRows(store, [
    {
      event_type: "erc8004_agent_import",
      event: { chain_id: 56, agent_id: "42", callable: false, verified_at: "2026-08-31T00:00:00.000Z" }
    },
    {
      event_type: "erc8004_agent_import",
      event: { chain_id: 56, agent_id: "42", callable: true, verified_at: "2026-08-31T00:15:00.000Z" }
    }
  ]);
  assert.equal(store.erc8004Imports.get("56:42").callable, true);
  assert.equal(store.erc8004Imports.get("56:42").verified_at, "2026-08-31T00:15:00.000Z");
});
