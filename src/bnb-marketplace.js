function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function declaredPrice(agent) {
  const metadata = record(agent?.metadata);
  const pricing = record(agent?.pricing);
  const metadataPricing = record(metadata.pricing);
  const agentRouterPricing = record(record(metadata.agentrouter).pricing);
  const source = [pricing, metadataPricing, agentRouterPricing]
    .find((candidate) => candidate.amount !== undefined && candidate.amount !== null && candidate.amount !== "");
  if (!source) return { amount: null, currency: "USDC", status: "not_declared" };
  return {
    amount: String(source.amount),
    currency: String(source.currency || "USDC").toUpperCase(),
    status: "declared"
  };
}

function executionLatency(evidence) {
  const started = Date.parse(String(evidence?.execution_started_at || ""));
  const completed = Date.parse(String(evidence?.execution_completed_at || ""));
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

function resultSources(result) {
  const payload = record(result);
  const values = payload.data_sources || payload.sources || payload.citations || [];
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string" || (value && typeof value === "object"));
}

function actualCost(dispatch) {
  const amount = dispatch?.actual_cost_usdc ?? dispatch?.cost_usdc;
  if (amount !== undefined && amount !== null && amount !== "") {
    return { amount: String(amount), currency: "USDC", status: "reported" };
  }
  if (dispatch?.payment === "none_declared") {
    return { amount: "0", currency: "USDC", status: "no_payment_declared" };
  }
  return { amount: null, currency: "USDC", status: "not_reported" };
}

export function createBnbHireSummary({
  agent = {},
  capability = "",
  dispatch = {},
  result = null,
  evidence = {},
  feedbackRequest = null
} = {}) {
  const trust = record(agent.trust);
  const price = declaredPrice(agent);
  const cost = actualCost(dispatch);
  const agentIdentity = {
    chain_id: Number(agent.chain_id || 56),
    agent_id: agent.agent_id == null ? null : String(agent.agent_id),
    explorer_url: agent.explorer_url || null
  };
  const feedbackStatus = feedbackRequest ? "consumer_feedback_requested" : "not_requested";
  return {
    summary_version: "agent_router_bnb_hire_summary_v1",
    selected_agent: {
      name: agent.name || `ERC-8004 Agent #${agent.agent_id || "unknown"}`,
      ...agentIdentity
    },
    agent_identity: agentIdentity,
    selection_reason: "Verified BSC identity, verified endpoint, and read-only capability match.",
    capability: String(capability || ""),
    price,
    price_usdc: price.currency === "USDC" ? price.amount : null,
    trust_score: {
      score: finiteNumber(trust.average_score),
      total_feedbacks: finiteNumber(trust.total_feedbacks) ?? 0,
      total_validations: finiteNumber(trust.total_validations) ?? 0,
      verification_state: agent.verification_state || null,
      verified_at: agent.verified_at || null
    },
    latency_ms: executionLatency(evidence),
    actual_cost: cost,
    actual_cost_usdc: cost.currency === "USDC" ? cost.amount : null,
    structured_result: result,
    data_sources: resultSources(result),
    evidence: {
      trace_hash: evidence?.trace_hash || null,
      execution_started_at: evidence?.execution_started_at || null,
      execution_completed_at: evidence?.execution_completed_at || null
    },
    feedback: {
      status: feedbackStatus,
      endpoint: feedbackRequest?.endpoint || null,
      must_submit: Boolean(feedbackRequest?.must_submit)
    },
    feedback_status: feedbackStatus
  };
}
