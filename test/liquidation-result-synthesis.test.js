import test from "node:test";
import assert from "node:assert/strict";

import {
  compactAgentFacingResult,
  createCompactResult,
  deriveLiquidationHeatmapInsight
} from "../src/compact-result.js";
import { summarize } from "../src/agent-router.js";

function heatmapResult() {
  return {
    status: "success",
    request_id: "req_xlm_heatmap",
    data: {
      code: "0",
      msg: "success",
      data: {
        y_axis: [0.09, 0.1, 0.11],
        liquidation_leverage_data: [
          [4, 0, 999],
          [5, 0, 10],
          [5, 1, 20],
          [5, 2, 80],
          [5, 99, 10000],
          ["invalid", 2, 10000]
        ],
        price_candlesticks: [
          [1787900000, "0.099", "0.102", "0.098", "0.1", "100000"],
          [1787910000, "0.1", "0.103", "0.099", "0.101", "120000"]
        ]
      }
    },
    summary: "Liquidation heatmap data."
  };
}

test("current liquidation max pain uses the strongest valid level in the latest heatmap slice", () => {
  const insight = deriveLiquidationHeatmapInsight(heatmapResult(), {
    capability: "perp_liquidation_max_pain",
    params: { asset: "XLM" }
  });

  assert.equal(insight.asset, "XLM");
  assert.equal(insight.max_liquidation_pain_price, 0.11);
  assert.equal(insight.current_price, 0.101);
  assert.equal(insight.liquidation_side, "short");
  assert.equal(insight.price_distance_percent, 8.91);
  assert.equal(insight.liquidation_intensity, 80);
  assert.equal(insight.latest_heatmap_x_index, 5);
  assert.equal(insight.method, "strongest_level_in_latest_heatmap_slice");
});

test("compact results synthesize heatmaps without copying their large plotting arrays", () => {
  const result = heatmapResult();
  const compact = createCompactResult({
    result,
    request: { capability: "perp_liquidation_max_pain", params: { asset: "XLM" } },
    verification: { schema_valid: true, data_non_empty: true, sanity_valid: true }
  });

  assert.equal(compact.data.max_liquidation_pain_price, 0.11);
  assert.equal(compact.data.liquidation_side, "short");
  assert.match(compact.summary, /XLM/);
  assert.match(compact.summary, /0\.11/);
  assert.equal("y_axis" in compact.data, false);
  assert.equal("liquidation_leverage_data" in compact.data, false);
  assert.equal(compact.source_data.raw_points, 6);
  assert.equal(compact.source_data.raw_data_omitted, true);
});

test("agent-facing responses replace recognized raw heatmaps with the synthesized result", () => {
  const raw = heatmapResult();
  const compactResult = createCompactResult({
    result: raw,
    request: { capability: "perp_liquidation_max_pain", params: { asset: "XLM" } },
    verification: { schema_valid: true, data_non_empty: true, sanity_valid: true }
  });
  const response = compactAgentFacingResult({
    result: raw,
    compact_result: compactResult,
    evidence: { trace_hash: "0xabc" }
  });

  assert.deepEqual(response.result.data, compactResult.data);
  assert.equal(response.result.raw_data_omitted, true);
  assert.equal(response.result.request_id, raw.request_id);
  assert.equal(JSON.stringify(response).includes("liquidation_leverage_data"), false);
  assert.equal(response.evidence.trace_hash, "0xabc");
});

test("natural-language summaries name the requested asset instead of hard-coding BTC", () => {
  const answer = summarize("查XLM当前最大爆仓痛点", heatmapResult());

  assert.match(answer, /^XLM perpetual liquidation max-pain is 0\.11\./);
  assert.match(answer, /Short liquidations/);
  assert.match(answer, /current price 0\.101/);
});
