import assert from "node:assert/strict";
import test from "node:test";

import { btcLiquidationMaxPainManifest } from "../src/fixtures.js";
import { verifyServiceResult } from "../src/verifier.js";

function result({ generatedAt = new Date().toISOString(), freshnessSeconds = 0, data = {} } = {}) {
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: btcLiquidationMaxPainManifest.service_id,
    request_id: "verifier-integrity",
    status: "success",
    query: {},
    data,
    metadata: {
      generated_at: generatedAt,
      freshness_seconds: freshnessSeconds,
      data_sources: ["test"]
    },
    summary: "Integrity regression",
    agent_hints: {}
  };
}

test("freshness is derived from generated_at instead of trusting provider-claimed lag", () => {
  const stale = verifyServiceResult({
    result: result({ generatedAt: "2010-01-01T00:00:00Z", freshnessSeconds: 0, data: { asset: "BTC", liquidation_cluster: 1 } }),
    manifest: btcLiquidationMaxPainManifest,
    intent: { asset: "BTC", capability: "perp_liquidation_max_pain" },
    constraints: { freshness_seconds: 300 }
  });
  const future = verifyServiceResult({
    result: result({ generatedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), freshnessSeconds: 0, data: { asset: "BTC", liquidation_cluster: 1 } }),
    manifest: btcLiquidationMaxPainManifest,
    intent: { asset: "BTC", capability: "perp_liquidation_max_pain" },
    constraints: { freshness_seconds: 300 }
  });
  const recent = verifyServiceResult({
    result: result({ data: { asset: "BTC", liquidation_cluster: 1 } }),
    manifest: btcLiquidationMaxPainManifest,
    intent: { asset: "BTC", capability: "perp_liquidation_max_pain" },
    constraints: { freshness_seconds: 300 }
  });

  assert.equal(stale.freshness_valid, false);
  assert.equal(future.freshness_valid, false);
  assert.equal(recent.freshness_valid, true);
});

test("asset coverage uses token boundaries rather than substrings in unrelated words", () => {
  for (const [asset, data] of [
    ["ETH", { method: "cluster model", liquidation_cluster: 1 }],
    ["SOL", { resolution: "hourly", liquidation_cluster: 1 }]
  ]) {
    const verification = verifyServiceResult({
      result: result({ data }),
      manifest: btcLiquidationMaxPainManifest,
      intent: { asset, capability: "perp_liquidation_max_pain" },
      constraints: { freshness_seconds: 300 }
    });
    assert.equal(verification.coverage_valid, false, asset);
    assert.ok(verification.issues.some((issue) => issue.code === "ASSET_NOT_COVERED"), asset);
  }

  const correct = verifyServiceResult({
    result: result({ data: { trading_pair: "ETH/USDT", liquidation_cluster: 1 } }),
    manifest: btcLiquidationMaxPainManifest,
    intent: { asset: "ETH", capability: "perp_liquidation_max_pain" },
    constraints: { freshness_seconds: 300 }
  });
  assert.equal(correct.coverage_valid, true);
});
