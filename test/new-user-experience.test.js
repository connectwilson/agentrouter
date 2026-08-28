import test from "node:test";
import assert from "node:assert/strict";

import { createPaymentQuote } from "../src/payment-adapter.js";
import { inferIntent } from "../src/agent-router.js";
import { buildInput, quoteCapabilityRequest, normalizeTaskIntent, summarizeCandidates } from "../src/router.js";
import { createMemoryStore } from "../src/store.js";

test("perpetual-futures requests preserve the base asset from a USDT trading pair", () => {
  const result = normalizeTaskIntent({ task: "HFTUSDT 币安永续最大爆仓痛点" });

  assert.equal(result.status, "route_with_assumption");
  assert.equal(result.intent.asset, "HFT");
  assert.equal(result.intent.quote_asset, "USDT");
  assert.equal(result.intent.trading_pair, "HFTUSDT");
});

test("core and compatibility parsers agree on an arbitrary uppercase liquidation asset", () => {
  const task = "查XLM当前最大爆仓痛点";
  const normalized = normalizeTaskIntent({ task });
  const compatibility = inferIntent(task);

  assert.equal(normalized.status, "route_with_assumption");
  assert.equal(normalized.intent.capability, "perp_liquidation_max_pain");
  assert.equal(normalized.intent.asset, "XLM");
  assert.equal(normalized.intent.market_type, "perpetual_futures");
  assert.equal(normalized.intent.time_sensitivity, "realtime");
  assert.equal(compatibility.input.asset, normalized.intent.asset);
});

test("natural-language fetch intent preserves a compact perpetual trading pair", () => {
  const intent = inferIntent("HFTUSDT 币安永续最大爆仓痛点");

  assert.equal(intent.input.asset, "HFT");
  assert.equal(intent.input.trading_pair, "HFTUSDT");
  assert.equal(intent.input.quote_asset, "USDT");
});

test("a quote distinguishes budget authorization from an available payment executor", () => {
  const quote = createPaymentQuote({
    manifest: {
      service_id: "test_liquidation",
      provider: { provider_id: "test_provider" },
      capabilities: ["perp_liquidation"],
      pricing: { amount: "0.01", currency: "USDC", network: "base", protocol: "x402" }
    },
    constraints: { max_price_usdc: "0.05" },
    selectedService: { health_status: "healthy", selection_badges: ["verified_live_endpoint"] }
  });

  assert.equal(quote.agent_decision.payment_authorized_by_budget, true);
  assert.equal(quote.agent_decision.payment_executor_available, false);
  assert.equal(quote.agent_decision.execution_available, false);
  assert.equal(quote.agent_decision.auto_invoke_allowed, false);
  assert.equal(quote.agent_decision.main_agent_next_action, "connect_credits_or_configure_local_payment");
  assert.equal(quote.settlement.network, "agentrouter");
  assert.equal(quote.pricing.network, quote.settlement.network);
});

test("an unsupported small-cap asset produces no match instead of an invalid parameter", () => {
  const quote = quoteCapabilityRequest(createMemoryStore(), {
    capability: "perp_liquidation_max_pain",
    params: { asset: "HFT", market_type: "perpetual_futures", window: "current" },
    constraints: { max_price_usdc: "0.05" }
  });

  assert.equal(quote.status, "no_match");
  assert.notEqual(quote.error, "INVALID_PARAM_VALUE");
});

test("perpetual-futures provider input replaces sample BTC with the requested trading pair", () => {
  const input = buildInput({
    sample_request: { exchange_list: "Binance", symbol: "BTC", interval: "1d" },
    input_schema: { properties: { exchange_list: {}, symbol: {}, interval: {} } }
  }, {
    capability: "perp_liquidation_max_pain",
    asset: "HFT",
    trading_pair: "HFTUSDT",
    market_type: "perpetual_futures",
    window: "current"
  });

  assert.equal(input.symbol, "HFTUSDT");
  assert.equal("asset" in input, false);
});

test("equivalent provider candidates are folded into one user-facing option", () => {
  const candidates = summarizeCandidates([
    {
      service_id: "liquidation_heatmap",
      title: "Liquidation Heatmap",
      provider_id: "coinglass",
      candidate_group: "crypto_liquidation",
      pricing: { amount: "0.01", currency: "USDC", network: "arc-testnet" },
      routing_score: 0.9
    },
    {
      service_id: "liquidation_heatmap_model_2",
      title: "Liquidation Heatmap Model 2",
      provider_id: "coinglass",
      candidate_group: "crypto_liquidation",
      pricing: { amount: "0.01", currency: "USDC", network: "arc-testnet" },
      routing_score: 0.88
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].equivalent_service_count, 2);
  assert.deepEqual(candidates[0].equivalent_service_ids, ["liquidation_heatmap_model_2"]);
});
