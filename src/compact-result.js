export function createCompactResult({
  result = {},
  verification = {},
  quote = null,
  feedback = null,
  evidence = null,
  request = null,
  input = null
} = {}) {
  const issues = Array.isArray(verification.issues) ? verification.issues : [];
  const dataQualityIssues = Array.isArray(verification.data_quality_issues)
    ? verification.data_quality_issues
    : [];
  const blockingIssueCodes = new Set([
    "SCHEMA_ERROR",
    "ENVELOPE_ERROR",
    "STATUS_NOT_SUCCESS",
    "SAMPLE_RETURNED",
    "EMPTY_RESULT",
    "DATA_QUALITY_SANITY_FAILED"
  ]);
  const answerReady = result?.status === "success" &&
    verification.schema_valid !== false &&
    verification.data_non_empty !== false &&
    verification.sanity_valid !== false &&
    !issues.some((issue) => blockingIssueCodes.has(issue.code));
  const liquidationInsight = deriveLiquidationHeatmapInsight(result, request || input || result?.query || {});

  return {
    result_version: "agent_router_compact_result_v1",
    answer_ready: answerReady,
    status: result?.status || null,
    request_id: result?.request_id || feedback?.request_id || null,
    data: liquidationInsight ?? result?.data ?? null,
    summary: liquidationInsight ? liquidationInsightSummary(liquidationInsight) : result?.summary || null,
    query: result?.query || null,
    ...(liquidationInsight ? {
      source_data: {
        type: "liquidation_heatmap",
        raw_points: liquidationHeatmapPayload(result)?.liquidation_leverage_data?.length || 0,
        price_levels: liquidationHeatmapPayload(result)?.y_axis?.length || 0,
        raw_data_omitted: true
      }
    } : {}),
    quality: {
      schema_valid: verification.schema_valid ?? null,
      freshness_valid: verification.freshness_valid ?? null,
      coverage_valid: verification.coverage_valid ?? null,
      data_non_empty: verification.data_non_empty ?? null,
      sanity_valid: verification.sanity_valid ?? null,
      overall_quality_score: verification.overall_quality_score ?? null,
      issues: issues.map((issue) => issue.code).filter(Boolean),
      data_quality_issues: dataQualityIssues.map((issue) => issue.code).filter(Boolean)
    },
    payment: {
      price: quote?.price || feedback?.settlement_receipt?.amount
        ? {
            amount: quote?.price?.amount || feedback?.settlement_receipt?.amount,
            currency: quote?.price?.currency || feedback?.settlement_receipt?.asset || "USDC"
          }
        : null,
      status: feedback?.billing_status || null,
      tx_present: Boolean(feedback?.payment_tx || evidence?.payment_tx)
    },
    evidence: evidence?.trace_hash
      ? {
          trace_hash: evidence.trace_hash,
          anchored: evidence.arc_anchor?.status || null
        }
      : null
  };
}

export function deriveLiquidationHeatmapInsight(result = {}, context = {}) {
  const heatmap = liquidationHeatmapPayload(result);
  if (!heatmap) return null;
  const yAxis = heatmap.y_axis;
  const rows = heatmap.liquidation_leverage_data;
  const validRows = rows.map((row) => {
    if (!Array.isArray(row) || row.length < 3) return null;
    const xIndex = Number(row[0]);
    const yIndex = Number(row[1]);
    const intensity = Number(row[2]);
    const price = Number(yAxis[yIndex]);
    if (![xIndex, yIndex, intensity, price].every(Number.isFinite)) return null;
    if (!Number.isInteger(yIndex) || yIndex < 0 || yIndex >= yAxis.length || intensity < 0) return null;
    return { x_index: xIndex, y_index: yIndex, price, intensity };
  }).filter(Boolean);
  if (!validRows.length) return null;

  const latestXIndex = Math.max(...validRows.map((row) => row.x_index));
  const latestRows = validRows
    .filter((row) => row.x_index === latestXIndex)
    .sort((left, right) => right.intensity - left.intensity);
  const strongest = latestRows[0];
  if (!strongest) return null;
  const currentPrice = latestCandleClose(heatmap.price_candlesticks);
  const priceDistancePercent = currentPrice && currentPrice > 0
    ? round(((strongest.price - currentPrice) / currentPrice) * 100, 2)
    : null;
  const liquidationSide = priceDistancePercent === null || priceDistancePercent === 0
    ? "balanced"
    : priceDistancePercent > 0 ? "short" : "long";

  return {
    insight_version: "agent_router_liquidation_insight_v1",
    asset: assetFromContext(context, result),
    max_liquidation_pain_price: strongest.price,
    liquidation_side: liquidationSide,
    current_price: currentPrice,
    price_distance_percent: priceDistancePercent === null ? null : Math.abs(priceDistancePercent),
    price_position: priceDistancePercent === null ? "unknown" : priceDistancePercent > 0 ? "above_current" : priceDistancePercent < 0 ? "below_current" : "at_current",
    liquidation_intensity: strongest.intensity,
    latest_heatmap_x_index: latestXIndex,
    top_current_levels: latestRows.slice(0, 3).map((row) => ({
      price: row.price,
      liquidation_side: currentPrice && row.price !== currentPrice ? (row.price > currentPrice ? "short" : "long") : "balanced",
      price_distance_percent: currentPrice && currentPrice > 0 ? Math.abs(round(((row.price - currentPrice) / currentPrice) * 100, 2)) : null,
      intensity: row.intensity
    })),
    method: "strongest_level_in_latest_heatmap_slice"
  };
}

export function compactAgentFacingResult(payload) {
  if (Array.isArray(payload)) return payload.map((item) => compactAgentFacingResult(item));
  if (!payload || typeof payload !== "object") return payload;
  const output = { ...payload };
  if (Array.isArray(output.results)) {
    output.results = output.results.map((item) => compactAgentFacingResult(item));
  }
  const compact = output.compact_result;
  if (compact?.source_data?.raw_data_omitted && output.result && typeof output.result === "object") {
    output.result = {
      ...output.result,
      data: compact.data,
      summary: compact.summary || output.result.summary || null,
      raw_data_omitted: true,
      source_data: compact.source_data
    };
  }
  return output;
}

export function liquidationInsightSummary(insight = {}) {
  const asset = insight.asset || "Asset";
  const side = insight.liquidation_side === "short"
    ? "Short liquidations are at risk"
    : insight.liquidation_side === "long"
      ? "Long liquidations are at risk"
      : "The level is near the current price";
  const comparison = insight.current_price !== null && insight.current_price !== undefined
    ? ` versus current price ${insight.current_price}${insight.price_distance_percent !== null ? ` (${insight.price_distance_percent}% away)` : ""}.`
    : "";
  return `${asset} perpetual liquidation max-pain is ${insight.max_liquidation_pain_price}. ${side}${comparison}`.trim();
}

function liquidationHeatmapPayload(result) {
  const candidates = [
    result?.data,
    result?.data?.data,
    result?.data?.result,
    result?.result?.data,
    result?.result?.data?.data
  ];
  return candidates.find((value) => value &&
    Array.isArray(value.y_axis) &&
    Array.isArray(value.liquidation_leverage_data)) || null;
}

function latestCandleClose(candles) {
  if (!Array.isArray(candles)) return null;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const close = Number(Array.isArray(candles[index]) ? candles[index][4] : candles[index]?.close);
    if (Number.isFinite(close) && close > 0) return close;
  }
  return null;
}

function assetFromContext(context = {}, result = {}) {
  const candidate = context?.params?.asset || context?.asset || context?.params?.symbol || context?.symbol ||
    result?.query?.asset || result?.query?.symbol || "Asset";
  return String(candidate).trim().toUpperCase().replace(/(?:USDT|USDC|USD)$/i, "") || "Asset";
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
