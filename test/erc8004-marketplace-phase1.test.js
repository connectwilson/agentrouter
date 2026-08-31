import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { baseFundFlowManifest } from "../src/fixtures.js";
import { applyErc8004VendorIdentity, registerService, vendorIdentityStoreKey } from "../src/registry.js";
import { createMemoryStore, publicErc8004, publicServiceRecord, publicServiceSummary } from "../src/store.js";

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

test("Vendor identity application updates only services owned by that Vendor", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const alphaA = registerService(store, serviceManifest("alpha_a", "alpha"), "http://127.0.0.1");
    const alphaB = registerService(store, serviceManifest("alpha_b", "alpha"), "http://127.0.0.1");
    const beta = registerService(store, serviceManifest("beta_a", "beta"), "http://127.0.0.1");
    applyErc8004VendorIdentity(store, "alpha", { network: "bsc", chain_id: 56, agent_id: "101", status: "registered" });
    assert.equal(alphaA.manifest.registration.erc8004.agent_id, "101");
    assert.equal(alphaB.manifest.registration.erc8004.agent_id, "101");
    assert.equal(beta.manifest.registration?.erc8004, undefined);
  });
});

test("a service registered after its Vendor identity inherits the same Agent ID", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    applyErc8004VendorIdentity(store, "alpha", { network: "bsc", chain_id: 56, agent_id: "102", status: "registered" });
    const late = registerService(store, serviceManifest("alpha_late", "alpha"), "http://127.0.0.1");
    assert.equal(late.manifest.registration.erc8004.agent_id, "102");
  });
});

test("a Vendor identity from another network is not inherited on BSC", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    store.erc8004VendorIdentities.set(vendorIdentityStoreKey("alpha", "arc-testnet"), {
      network: "arc-testnet", chain_id: 5042002, agent_id: "22914"
    });
    const record = registerService(store, serviceManifest("alpha_bsc", "alpha"), "http://127.0.0.1");
    assert.equal(record.manifest.registration?.erc8004, undefined);
  });
});

test("an identity without an Agent ID cannot mutate Vendor state", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    registerService(store, serviceManifest("alpha_none", "alpha"), "http://127.0.0.1");
    assert.equal(applyErc8004VendorIdentity(store, "alpha", { network: "bsc", status: "submitted" }), null);
    assert.equal(store.erc8004VendorIdentities.size, 0);
    assert.equal(store.services.get("alpha_none").manifest.registration?.erc8004, undefined);
  });
});

test("service summary and detail expose the same identity contract", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const store = createMemoryStore();
    const record = registerService(store, serviceManifest("alpha_parity", "alpha"), "http://127.0.0.1");
    applyErc8004VendorIdentity(store, "alpha", {
      network: "bsc", chain_id: 56, agent_id: "103", status: "submitted",
      registry_address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    });
    const summary = publicServiceSummary(record);
    const detail = publicServiceRecord(record);
    assert.deepEqual(detail.erc8004, summary.erc8004);
    assert.deepEqual(detail.erc8004_status, summary.erc8004_status);
    assert.equal(detail.erc8004_status.state, "submitted");
  });
});

test("a contradictory BSC network and chain id is hidden instead of linked", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const record = { manifest: { registration: { erc8004: {
      network: "bsc", chain_id: 97, agent_id: "104", status: "registered"
    } } } };
    assert.equal(publicErc8004(record), null);
    assert.equal(publicServiceRecord({
      ...record,
      manifest: {
        service_id: "bad_chain", title: "Bad chain", description_for_agent: "", capabilities: [], pricing: {}, provider: { provider_id: "bad" },
        registration: record.manifest.registration
      },
      verification_status: "pending", validation_runs: [], feedback_events: [], quality_events: [], health_checks: []
    }).erc8004_status.state, "chain_mismatch");
  });
});

test("legacy provider-level Agent IDs remain readable only on the active chain", async () => {
  await withEnv({ ADN_SETTLEMENT_CHAIN: "bsc" }, async () => {
    const identity = publicErc8004({ manifest: { provider: { erc8004_agent_id: "105" } } });
    assert.equal(identity.agent_id, "105");
    assert.equal(identity.chain, "bsc");
    assert.equal(identity.explorer_url, "https://8004scan.io/agents/56/105");
  });
});

test("Vendor identity store keys isolate network while preserving provider identity", () => {
  assert.equal(vendorIdentityStoreKey("provider_alpha", "BSC"), "bsc:provider_alpha");
  assert.equal(vendorIdentityStoreKey("provider_alpha", "arc-testnet"), "arc-testnet:provider_alpha");
  assert.notEqual(vendorIdentityStoreKey("provider_alpha", "bsc"), vendorIdentityStoreKey("provider_beta", "bsc"));
});
