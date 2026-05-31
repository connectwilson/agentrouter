export function createCompactResult({
  result = {},
  verification = {},
  quote = null,
  feedback = null,
  evidence = null
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

  return {
    result_version: "agent_router_compact_result_v1",
    answer_ready: answerReady,
    status: result?.status || null,
    request_id: result?.request_id || feedback?.request_id || null,
    data: result?.data ?? null,
    summary: result?.summary || null,
    query: result?.query || null,
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
