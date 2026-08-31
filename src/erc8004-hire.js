import crypto from "node:crypto";

import { hashJson } from "./evidence.js";

const POLICY_VERSION = "agent_router_erc8004_execution_policy_v1";
const MAX_LOCAL_HIRE_REQUESTS = 1000;

export function normalizeErc8004ExecutionPolicy(metadata = {}) {
  const candidate = metadata?.agentrouter?.execution_policy
    || metadata?.execution_policy
    || null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const capabilities = Array.isArray(candidate.allowed_capabilities)
    ? candidate.allowed_capabilities.map(normalizeCapability).filter(Boolean)
    : [];
  return {
    policy_version: String(candidate.policy_version || ""),
    access: String(candidate.access || "").toLowerCase(),
    allowed_capabilities: [...new Set(capabilities)]
  };
}

export function requireReadOnlyErc8004ExecutionPolicy(agent = {}, capabilityValue = "") {
  const policy = agent.execution_policy
    || normalizeErc8004ExecutionPolicy(agent.metadata)
    || null;
  if (!policy || policy.policy_version !== POLICY_VERSION) {
    throw hireError(
      "ERC8004_EXECUTION_POLICY_REQUIRED",
      "Direct execution requires a verified AgentRouter execution policy from the Agent's on-chain metadata."
    );
  }
  if (String(policy.access || "").toLowerCase() !== "read_only") {
    throw hireError(
      "ERC8004_EXECUTION_NOT_READ_ONLY",
      "AgentRouter only directly executes ERC-8004 capabilities whose verified policy is read-only."
    );
  }
  const capability = normalizeCapability(capabilityValue);
  if (!capability) {
    throw hireError(
      "ERC8004_CAPABILITY_REQUIRED",
      "A named capability is required before AgentRouter can evaluate the execution policy."
    );
  }
  const allowed = Array.isArray(policy.allowed_capabilities)
    ? policy.allowed_capabilities.map(normalizeCapability).filter(Boolean)
    : [];
  if (!allowed.includes(capability)) {
    throw hireError(
      "ERC8004_CAPABILITY_NOT_ALLOWED",
      "The requested capability is not allowlisted by the Agent's verified read-only execution policy."
    );
  }
  return {
    policy_version: POLICY_VERSION,
    access: "read_only",
    capability,
    allowed_capabilities: [...new Set(allowed)]
  };
}

export function createErc8004HireArtifacts({
  requestId,
  actorKey,
  agent,
  endpoint,
  input,
  result,
  policy,
  startedAt,
  completedAt = new Date().toISOString()
}) {
  const serviceId = erc8004HireServiceId(agent);
  const providerId = serviceId;
  const inputHash = hashJson(input);
  const resultHash = hashJson(result);
  const endpointHash = hashJson(endpoint);
  const policyHash = hashJson(policy);
  const verificationSnapshot = {
    verification_state: agent.verification_state,
    verified_at: agent.verified_at,
    adapter: agent.preferred_adapter,
    endpoint_status: agent.protocols?.[agent.preferred_adapter]?.status || null
  };
  const agentIdentity = {
    standard: "ERC-8004",
    chain_id: Number(agent.chain_id),
    agent_id: String(agent.agent_id),
    registry: agent.registry || null,
    explorer_url: agent.explorer_url || null
  };
  const evidenceCore = {
    evidence_version: "agent_router_erc8004_hire_evidence_v1",
    route_type: "erc8004_direct_hire",
    request_id: requestId,
    service_id: serviceId,
    provider_id: providerId,
    agent_identity: agentIdentity,
    consumer_hash: hashJson(actorKey),
    capability: policy.capability,
    access: policy.access,
    endpoint_hash: endpointHash,
    input_hash: inputHash,
    result_hash: resultHash,
    policy_hash: policyHash,
    verification: verificationSnapshot,
    verification_hash: hashJson(verificationSnapshot),
    execution_started_at: startedAt,
    execution_completed_at: completedAt
  };
  const evidence = {
    ...evidenceCore,
    trace_hash: hashJson(evidenceCore),
    created_at: completedAt
  };
  const invocation = {
    event_version: "agent_external_api_feedback_v1",
    invocation_type: "erc8004_direct_hire",
    request_id: requestId,
    service_id: serviceId,
    provider_id: providerId,
    invocation_actor_key: actorKey,
    agent_identity: agentIdentity,
    capability: policy.capability,
    access: policy.access,
    status: "success",
    schema_valid: null,
    data_non_empty: result !== null && result !== undefined,
    execution_location: "agentrouter_server",
    endpoint_hash: endpointHash,
    input_hash: inputHash,
    result_hash: resultHash,
    trace_hash: evidence.trace_hash,
    consumer_feedback_expected: true,
    created_at: completedAt
  };
  return { serviceId, providerId, invocation, evidence };
}

export function erc8004HireServiceId(agent = {}) {
  return `erc8004:${Number(agent.chain_id || 56)}:${String(agent.agent_id || "")}`;
}

export function erc8004HireClaim({ actorKey, idempotencyKey, agent, endpoint, capability, input, policy }) {
  const requestHash = hashJson({
    chain_id: Number(agent.chain_id),
    agent_id: String(agent.agent_id),
    registry: agent.registry || null,
    endpoint,
    capability,
    input,
    execution_policy: policy
  });
  return {
    claimKey: hashJson({ scope: "erc8004_direct_hire", actor_key: actorKey, idempotency_key: idempotencyKey }),
    requestHash
  };
}

export async function executeErc8004HireOnce({
  store,
  claimKey,
  requestHash,
  requestId = `erc8004_${crypto.randomUUID()}`,
  serviceId,
  persistence = {},
  execute,
  persistentResponse = (value) => value
}) {
  store.erc8004HireRequests ||= new Map();
  const existing = store.erc8004HireRequests.get(claimKey);
  if (existing) {
    assertMatchingRequest(existing.request_hash, requestHash);
    if (existing.status === "completed") {
      return { value: existing.value, replayed: true, localCompletedReplay: true };
    }
    if (existing.status === "failed") throw uncertainExecutionError(existing.error);
    if (existing.status !== "reconcile") {
      const joined = await existing.promise;
      return { ...joined, replayed: true, joinedInProgress: true };
    }
    // The remote response and trust artifacts are durable, but finalizing the
    // idempotency row failed. Re-enter only the persistent claim path; its
    // completion marker reconciliation must decide the outcome before execute.
    store.erc8004HireRequests.delete(claimKey);
  }

  const pending = executeClaimedHire({
    claimKey,
    requestHash,
    requestId,
    serviceId,
    persistence,
    execute,
    persistentResponse
  });
  const state = { request_hash: requestHash, request_id: requestId, status: "in_progress", promise: pending };
  store.erc8004HireRequests.set(claimKey, state);
  trimLocalHireRequests(store.erc8004HireRequests);

  try {
    const outcome = await pending;
    Object.assign(state, { status: "completed", value: outcome.value, promise: null });
    return outcome;
  } catch (error) {
    Object.assign(state, {
      status: error?.code === "ERC8004_HIRE_PERSISTENCE_FAILED" ? "reconcile" : "failed",
      error,
      promise: null
    });
    throw error;
  }
}

async function executeClaimedHire({
  claimKey,
  requestHash,
  requestId,
  serviceId,
  persistence,
  execute,
  persistentResponse
}) {
  const claim = typeof persistence.claim === "function"
    ? await persistence.claim({
      claim_key: claimKey,
      request_hash: requestHash,
      request_id: requestId,
      service_id: serviceId
    })
    : null;
  if (claim && claim.claimed === false) {
    const record = claim.record || {};
    assertMatchingRequest(record.request_hash, requestHash);
    if (record.status === "completed" && record.response) {
      return { value: record.response, replayed: true, persistentReplay: true };
    }
    if (record.status === "failed") throw uncertainExecutionError(record.error);
    throw hireError(
      "ERC8004_HIRE_IN_PROGRESS",
      "This idempotent hire is already executing on another AgentRouter instance.",
      409
    );
  }

  let executionCompleted = false;
  try {
    const value = await execute({ requestId });
    executionCompleted = true;
    if (typeof persistence.complete === "function") {
      let completed;
      try {
        completed = await persistence.complete({
          claim_key: claimKey,
          request_hash: requestHash,
          request_id: requestId,
          service_id: serviceId,
          response: persistentResponse(value)
        });
      } catch (cause) {
        throw persistenceFinalizationError(cause);
      }
      if (claim && !completed) {
        throw persistenceFinalizationError();
      }
    }
    return { value, replayed: false, persistentReplay: false };
  } catch (error) {
    if (!executionCompleted && typeof persistence.fail === "function") {
      await persistence.fail({
        claim_key: claimKey,
        request_hash: requestHash,
        request_id: requestId,
        service_id: serviceId,
        error: String(error?.message || error)
      }).catch(() => {});
    }
    throw error;
  }
}

function persistenceFinalizationError(cause) {
  const error = hireError(
    "ERC8004_HIRE_PERSISTENCE_FAILED",
    "The remote Agent completed, but AgentRouter could not durably finalize its idempotency record.",
    503
  );
  if (cause) error.cause = cause;
  return error;
}

function assertMatchingRequest(existingHash, requestHash) {
  if (existingHash === requestHash) return;
  throw hireError(
    "ERC8004_HIRE_IDEMPOTENCY_CONFLICT",
    "This Idempotency-Key was already used for a different ERC-8004 hire request.",
    409
  );
}

function uncertainExecutionError(reason) {
  return hireError(
    "ERC8004_HIRE_EXECUTION_UNCERTAIN",
    `A previous execution attempt failed or could not be durably reconciled${reason?.message || reason ? `: ${String(reason?.message || reason)}` : "."}`,
    503
  );
}

function trimLocalHireRequests(requests) {
  while (requests.size > MAX_LOCAL_HIRE_REQUESTS) {
    const key = [...requests.entries()].find(([, value]) => value.status !== "in_progress")?.[0];
    if (!key) return;
    requests.delete(key);
  }
}

function normalizeCapability(value) {
  const capability = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(capability) ? capability : "";
}

function hireError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
