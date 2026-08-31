import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { applyErc8004VendorIdentity, registerService } from "../src/registry.js";
import { createMemoryStore, publicServiceRecord, publicServiceSummary } from "../src/store.js";

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

function serviceManifest(serviceId, providerId) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = serviceId;
  manifest.provider = { ...manifest.provider, provider_id: providerId };
  manifest.endpoint = { ...manifest.endpoint, url: `http://provider.example/${serviceId}` };
  return manifest;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("BSC marketplace hides a stale Arc identity and reports why it is not active", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const record = registerService(store, serviceManifest("legacy_arc_service", "legacy_vendor"), "http://127.0.0.1");
    record.manifest.registration = {
      ...(record.manifest.registration || {}),
      erc8004: { agent_id: "22914", network: "arc-testnet", chain_id: 5042002 }
    };

    const summary = publicServiceSummary(record);
    assert.equal(summary.erc8004, null);
    assert.deepEqual(summary.erc8004_status, {
      state: "legacy_other_chain",
      active_chain: "bsc",
      registered_chain: "arc-testnet",
      agent_id: "22914"
    });
  });
});

test("service detail exposes the shared BSC Vendor Agent ID and 8004scan link", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const record = registerService(store, serviceManifest("vendor_prices", "vendor_alpha"), "http://127.0.0.1");
    applyErc8004VendorIdentity(store, "vendor_alpha", {
      standard: "ERC-8004",
      status: "registered",
      network: "bsc",
      chain_id: 56,
      agent_id: "81001",
      registry_address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    });

    const detail = publicServiceRecord(record);
    assert.equal(detail.erc8004.agent_id, "81001");
    assert.equal(detail.erc8004.explorer_url, "https://8004scan.io/agents/56/81001");
    assert.equal(detail.erc8004_status.state, "registered");

    const server = createServer({ store });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/agent-router/service?service_id=vendor_prices`);
      const payload = await response.json();
      assert.equal(payload.service.erc8004.agent_id, "81001");
      assert.equal(payload.service.erc8004.explorer_url, "https://8004scan.io/agents/56/81001");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("unregistered Vendor services have an explicit registration state", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const record = registerService(store, serviceManifest("vendor_news", "vendor_beta"), "http://127.0.0.1");
    assert.deepEqual(publicServiceRecord(record).erc8004_status, {
      state: "not_registered",
      active_chain: "bsc",
      registered_chain: null,
      agent_id: null
    });
  });
});
