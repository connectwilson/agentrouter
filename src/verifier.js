import { validateEnvelope, validateJsonSchema } from "./schema.js";

export function verifyServiceResult({ result, manifest, intent = {}, constraints = {} }) {
  const schemaErrors = validateJsonSchema(result, manifest.output_schema);
  const envelopeErrors = validateEnvelope(result);
  const issues = [];

  if (schemaErrors.length) issues.push(...schemaErrors.map((message) => ({ code: "SCHEMA_ERROR", message })));
  if (envelopeErrors.length) issues.push(...envelopeErrors.map((message) => ({ code: "ENVELOPE_ERROR", message })));
  if (result?.status !== "success") issues.push({ code: "STATUS_NOT_SUCCESS", message: "Result status is not success." });
  if (result?.sample_type) issues.push({ code: "SAMPLE_RETURNED", message: "Provider returned a sample response instead of paid live data." });

  const freshnessSeconds = Number(result?.metadata?.freshness_seconds);
  const freshnessLimit = Number(constraints.freshness_seconds ?? manifest.freshness?.max_data_lag_seconds ?? 0);
  const freshness = verifyFreshness({
    generatedAt: result?.metadata?.generated_at,
    claimedLagSeconds: freshnessSeconds,
    freshnessLimit
  });
  const freshnessValid = freshness.ok;
  if (!freshnessValid) {
    issues.push({
      code: "FRESHNESS_NOT_VERIFIABLE",
      message: "Result freshness is missing or above the requested limit."
    });
  }

  const coverageIssues = checkCoverage(result, intent);
  issues.push(...coverageIssues);
  const dataShape = inspectDataShape(result?.data);
  if (dataShape.empty) {
    issues.push({
      code: "EMPTY_RESULT",
      message: "Provider returned a structurally valid response, but the data payload is empty."
    });
  }
  const dataQuality = assessDataQuality(result?.data);
  if (!dataQuality.sanity_valid) {
    issues.push({
      code: "DATA_QUALITY_SANITY_FAILED",
      message: "Provider result passed envelope checks but failed deterministic data-quality sanity checks."
    });
  }
  const confidence = Number(result?.metadata?.confidence);
  if (Number.isFinite(confidence) && constraints.min_confidence && confidence < Number(constraints.min_confidence)) {
    issues.push({
      code: "CONFIDENCE_BELOW_REQUEST",
      message: `Result confidence ${confidence} is below requested minimum ${constraints.min_confidence}.`
    });
  }

  const agentFriendlyScore = computeAgentFriendlyScore(result, issues);
  const deterministicScore = computeDeterministicScore({
    schemaValid: schemaErrors.length === 0 && envelopeErrors.length === 0,
    statusSuccess: result?.status === "success",
    freshnessValid,
    coverageValid: coverageIssues.length === 0,
    dataNonEmpty: !dataShape.empty,
    sanityValid: dataQuality.sanity_valid
  });
  const overallScore = Number((deterministicScore * 0.8 + agentFriendlyScore * 0.2).toFixed(2));
  return {
    schema_valid: schemaErrors.length === 0 && envelopeErrors.length === 0,
    freshness_valid: freshnessValid,
    coverage_valid: coverageIssues.length === 0,
    data_non_empty: !dataShape.empty,
    sanity_valid: dataQuality.sanity_valid,
    data_quality_issues: dataQuality.issues,
    agent_friendly_score: agentFriendlyScore,
    deterministic_score: deterministicScore,
    overall_quality_score: overallScore,
    data_shape: dataShape,
    quality_model: {
      name: "deterministic_first_data_quality_v1",
      weights: {
        deterministic: 0.8,
        agent_friendly: 0.2
      }
    },
    issues
  };
}

export function createConsumerFeedbackRequest({
  request = {},
  selectedService = {},
  result = {},
  verification = {}
} = {}) {
  return {
    feedback_request_version: "agent_consumer_feedback_request_v1",
    endpoint: "/agent-router/feedback",
    method: "POST",
    timing: "after_final_answer_or_after_deciding_result_usability",
    must_submit: true,
    service_id: selectedService.service_id || result.service_id,
    request_id: result.request_id,
    instructions: [
      "Submit this after the main agent has inspected whether the returned data helped answer the user's task.",
      "Do not infer domain truth beyond the returned data. Judge intent fit, usefulness, and parseability for this call.",
      "Use unknown when the main agent cannot reasonably judge a field.",
      "If the answer required another source, set answer_useful to partial or no and list missing_fields.",
      "This feedback is part of the service reputation loop; do not skip it for successful calls."
    ],
    submit_to: {
      local_path: "/agent-router/feedback",
      body_template: {
        service_id: selectedService.service_id || result.service_id,
        request_id: result.request_id,
        consumer_id: "<main_agent_or_client_id>",
        feedback: "<fill_from_schema>"
      }
    },
    schema: {
      type: "object",
      required: ["request_id", "feedback"],
      properties: {
        service_id: { type: "string", description: "Optional when request_id uniquely identifies the completed call." },
        request_id: { type: "string" },
        consumer_id: { type: "string" },
        feedback: {
          type: "object",
          required: ["intent_fit", "answer_useful", "reason"],
          properties: {
            intent_fit: { enum: ["yes", "partial", "no", "unknown"] },
            answer_useful: { enum: ["yes", "partial", "no", "unknown"] },
            data_quality_score: { type: "number", minimum: 0, maximum: 1 },
            used_in_final_answer: { type: "boolean" },
            reason: { type: "string" },
            missing_fields: { type: "array", items: { type: "string" } },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    },
    rubric: {
      intent_fit: "yes if the data directly matches the requested capability and parameters; partial if it is related but incomplete; no if it is the wrong data; unknown if the agent cannot judge.",
      answer_useful: "yes if the data can support a final answer; partial if it needs another source or transformation; no if it cannot be used; unknown if unclear.",
      data_quality_score: "0..1 score for non-empty, fresh, parseable, complete, and relevant data.",
      missing_fields: "Fields, dimensions, filters, or evidence that were needed but absent from the returned result.",
      confidence: "Confidence in this feedback judgment, not confidence in the market or domain claim.",
      reason: "One short sentence grounded in the returned data, not provider reputation."
    },
    suggested_feedback: suggestConsumerFeedback({ request, result, verification })
  };
}

export function normalizeConsumerFeedback(input = {}) {
  const feedback = input.feedback && typeof input.feedback === "object" ? input.feedback : input;
  const normalized = {
    intent_fit: normalizeAssessment(feedback.intent_fit),
    answer_useful: normalizeAssessment(feedback.answer_useful),
    data_quality_score: normalizeScore(feedback.data_quality_score),
    used_in_final_answer: typeof feedback.used_in_final_answer === "boolean" ? feedback.used_in_final_answer : null,
    reason: String(feedback.reason || "").trim().slice(0, 500),
    missing_fields: Array.isArray(feedback.missing_fields)
      ? feedback.missing_fields.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    confidence: normalizeScore(feedback.confidence)
  };
  const componentScores = [
    assessmentScore(normalized.intent_fit),
    assessmentScore(normalized.answer_useful),
    normalized.data_quality_score,
    normalized.used_in_final_answer === null ? null : Number(normalized.used_in_final_answer)
  ].filter((score) => typeof score === "number");
  if (!componentScores.length) {
    const error = new Error("feedback must include at least one judgeable signal");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  if (!normalized.reason) {
    const error = new Error("feedback.reason is required");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  normalized.consumer_score = Number((componentScores.reduce((sum, score) => sum + score, 0) / componentScores.length).toFixed(4));
  return normalized;
}

function suggestConsumerFeedback({ result = {}, verification = {} }) {
  const score = typeof verification.overall_quality_score === "number" ? verification.overall_quality_score : null;
  const hasBlockingIssues = (verification.issues || []).some((issue) => ["EMPTY_RESULT", "STATUS_NOT_SUCCESS", "SCHEMA_ERROR", "ENVELOPE_ERROR"].includes(issue.code));
  return {
    intent_fit: verification.coverage_valid === false ? "partial" : "unknown",
    answer_useful: hasBlockingIssues ? "no" : "unknown",
    data_quality_score: score,
    used_in_final_answer: null,
    reason: result?.summary || (hasBlockingIssues ? "Deterministic checks found blocking quality issues." : "Main agent should judge usefulness against the user task."),
    missing_fields: (verification.issues || []).map((issue) => issue.code).slice(0, 8),
    confidence: 0.5
  };
}

function normalizeAssessment(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  const normalized = String(value || "unknown").trim().toLowerCase();
  return ["yes", "partial", "no", "unknown"].includes(normalized) ? normalized : "unknown";
}

function assessmentScore(value) {
  if (value === "yes") return 1;
  if (value === "partial") return 0.5;
  if (value === "no") return 0;
  return null;
}

function normalizeScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function checkCoverage(result, intent) {
  const issues = [];
  const queryText = JSON.stringify(result?.query || {}).toLowerCase();
  const dataText = JSON.stringify(result?.data || {}).toLowerCase();
  if (intent.asset && !assetCovered(intent.asset, `${queryText} ${dataText}`)) {
    issues.push({ code: "ASSET_NOT_COVERED", message: `Result does not clearly cover ${intent.asset}.` });
  }
  if (intent.capability === "perp_liquidation_max_pain") {
    const hasLiquidationSignal = /liquidation|max_pain|cluster|notional/.test(dataText);
    if (!hasLiquidationSignal) {
      issues.push({ code: "LIQUIDATION_FIELDS_MISSING", message: "Result does not include liquidation max-pain fields." });
    }
  }
  if (intent.capability === "onchain_fund_flow") {
    const hasFundFlowSignal = /inflow|outflow|net_flow/.test(dataText);
    if (!hasFundFlowSignal) {
      issues.push({ code: "FUND_FLOW_FIELDS_MISSING", message: "Result does not include fund-flow fields." });
    }
  }
  if (intent.capability === "smart_money_netflow") {
    const hasNetflowSignal = /netflow|net_flow|inflow|outflow|net.*usd|flow/.test(dataText);
    if (!hasNetflowSignal) {
      issues.push({ code: "SMART_MONEY_NETFLOW_FIELDS_MISSING", message: "Result does not include recognizable smart-money netflow fields." });
    }
  }
  if (intent.capability === "smart_money_holdings") {
    const hasHoldingsSignal = /holding|holdings|balance|token|symbol|value_usd|amount/.test(dataText);
    if (!hasHoldingsSignal) {
      issues.push({ code: "SMART_MONEY_HOLDINGS_FIELDS_MISSING", message: "Result does not include recognizable smart-money holdings fields." });
    }
  }
  return issues;
}

function assetCovered(asset, text) {
  const normalized = String(asset || "").toUpperCase();
  const aliases = {
    BTC: ["btc", "bitcoin", "xbt"],
    ETH: ["eth", "ethereum"],
    SOL: ["sol", "solana"],
    BNB: ["bnb", "binancecoin", "binance coin"],
    XRP: ["xrp", "ripple"],
    DOGE: ["doge", "dogecoin"]
  };
  return (aliases[normalized] || [String(asset || "").toLowerCase()])
    .some((alias) => assetAliasCovered(alias, text));
}

function assetAliasCovered(alias, text) {
  const normalizedAlias = String(alias || "").toLowerCase().trim();
  if (!normalizedAlias) return false;
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const boundary = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  if (boundary.test(text)) return true;
  if (!/^[a-z0-9]{2,6}$/.test(normalizedAlias)) return false;
  return new RegExp(`(^|[^a-z0-9])${escaped}(?:usd|usdt|usdc|busd|btc|eth|perp)([^a-z0-9]|$)`, "i").test(text);
}

function verifyFreshness({ generatedAt, claimedLagSeconds, freshnessLimit, now = Date.now() }) {
  const generatedAtMs = Date.parse(String(generatedAt || ""));
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(claimedLagSeconds) || claimedLagSeconds < 0) {
    return { ok: false, effective_lag_seconds: null };
  }
  const observedLagSeconds = (now - generatedAtMs) / 1000;
  const maxFutureClockSkewSeconds = 300;
  if (observedLagSeconds < -maxFutureClockSkewSeconds) {
    return { ok: false, effective_lag_seconds: observedLagSeconds };
  }
  const effectiveLagSeconds = Math.max(claimedLagSeconds, Math.max(0, observedLagSeconds));
  const limit = Number(freshnessLimit);
  return {
    ok: Number.isFinite(limit) && limit >= 0 && (!limit || effectiveLagSeconds <= limit),
    effective_lag_seconds: effectiveLagSeconds
  };
}

function computeAgentFriendlyScore(result, issues) {
  let score = 1;
  if (!result?.summary) score -= 0.15;
  if (!result?.metadata?.data_sources?.length) score -= 0.15;
  if (!result?.metadata?.generated_at) score -= 0.1;
  if (!result?.agent_hints) score -= 0.1;
  score -= Math.min(0.4, issues.length * 0.08);
  return Math.max(0, Number(score.toFixed(2)));
}

function inspectDataShape(data) {
  if (data === undefined || data === null) return { type: data === null ? "null" : "undefined", empty: true, top_level_keys: [] };
  if (Array.isArray(data)) return { type: "array", empty: data.length === 0, item_count: data.length, top_level_keys: [] };
  if (typeof data === "object") {
    const keys = Object.keys(data);
    const nestedArrays = Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => ({ key, item_count: value.length }));
    const hasRows = nestedArrays.some((item) => item.item_count > 0);
    return {
      type: "object",
      empty: keys.length === 0 || (nestedArrays.length > 0 && !hasRows && keys.length <= 2),
      top_level_keys: keys.slice(0, 20),
      nested_arrays: nestedArrays.slice(0, 10)
    };
  }
  return { type: typeof data, empty: data === "", top_level_keys: [] };
}

function assessDataQuality(data) {
  const issues = [];
  const objects = flattenDataObjects(data);
  const abnormalTimestamp = objects.find((object) =>
    Object.entries(object).some(([key, value]) => isTimestampKey(key) && isAbnormalTimestamp(value))
  );
  if (abnormalTimestamp) {
    issues.push({
      code: "ABNORMAL_TIMESTAMP",
      message: "Data contains a timestamp/date field with an impossible or suspicious value."
    });
  }

  const numericMetrics = [];
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (isMetricKey(key) && typeof value === "number" && Number.isFinite(value)) {
        numericMetrics.push(value);
      }
    }
  }
  if (numericMetrics.length >= 2 && numericMetrics.every((value) => value === 0)) {
    issues.push({
      code: "ALL_ZERO_NUMERIC_METRICS",
      message: "All numeric metric fields are zero, which is suspicious for a paid market/data result."
    });
  }

  return {
    sanity_valid: issues.length === 0,
    issues
  };
}

function flattenDataObjects(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenDataObjects(item, out);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) flattenDataObjects(child, out);
  return out;
}

function isTimestampKey(key) {
  return /(^|_)(timestamp|time|date|created_at|updated_at|generated_at)$/i.test(String(key));
}

function isAbnormalTimestamp(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    if (value < 0) return true;
    if (value > 0 && value < 946684800) return true;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed < Date.UTC(2000, 0, 1);
  }
  return false;
}

function isMetricKey(key) {
  const normalized = String(key).toLowerCase();
  if (/id$|rank|page|limit|timestamp|time|date|decimals|chain_id/.test(normalized)) return false;
  return /amount|value|price|volume|flow|inflow|outflow|net|balance|count|ratio|pct|percent|rate|usd|notional|open_interest|oi|pain|liquidation/.test(normalized);
}

function computeDeterministicScore({ schemaValid, statusSuccess, freshnessValid, coverageValid, dataNonEmpty, sanityValid = true }) {
  const score =
    Number(schemaValid) * 0.25 +
    Number(statusSuccess) * 0.2 +
    Number(freshnessValid) * 0.2 +
    Number(coverageValid) * 0.2 +
    Number(dataNonEmpty) * 0.1 +
    Number(sanityValid) * 0.05;
  return Number(score.toFixed(2));
}
