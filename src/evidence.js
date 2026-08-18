import { createHash } from "node:crypto";
import { settlementChain } from "./chains.js";

export function createEvidenceEnvelope({
  request,
  input,
  selectedService,
  manifest,
  quote,
  result,
  feedback,
  verification,
  routeType = "structured_capability_request"
}) {
  const resultHash = hashJson(result);
  const outputHash = resultHash;
  const inputHash = hashJson(input);
  const verificationHash = hashJson(verification);
  const manifestHash = manifest?.integrity?.manifest_hash || manifest?.registration?.manifest_hash || hashJson(stripManifestForEvidenceHash(manifest));
  const configHash = manifest?.integrity?.config_hash || manifest?.registration?.config_hash || null;
  const paymentTx = feedback?.payment_tx || null;
  const requestId = result?.request_id || feedback?.request_id || null;
  const verificationReport = {
    report_version: "agentrouter_verification_report_v1",
    service_id: manifest.service_id,
    request_id: requestId,
    schema_valid: verification?.schema_valid ?? null,
    freshness_valid: verification?.freshness_valid ?? null,
    coverage_valid: verification?.coverage_valid ?? null,
    data_non_empty: verification?.data_non_empty ?? null,
    business_error: verification?.business_error || feedback?.business_error || null,
    deterministic_checks: verification || {},
    report_hash: verificationHash,
    created_at: new Date().toISOString()
  };
  const evidenceProfile = {
    profile_version: "agentrouter_execution_evidence_profile_v1",
    profile_type: "paid_hosted_http_data_api_execution",
    evidence_scope: "service_call",
    required_bindings: [
      "service_id",
      "manifest_hash",
      "input_hash",
      "output_hash",
      "payment_tx",
      "verification_report"
    ],
    manifest_type: manifest?.manifest_type || "hosted_http_data_api",
    erc8004_reputation_compatible: true,
    erc8257_manifest_compatible: Boolean(manifest?.erc8257?.compatible),
    storage_model: "offchain_full_evidence_arc_hash_anchor"
  };
  const tracePayload = {
    route_type: routeType,
    request,
    request_id: requestId,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    service_version: manifest?.version || null,
    manifest_type: manifest?.manifest_type || null,
    manifest_hash: manifestHash,
    config_hash: configHash,
    input_hash: inputHash,
    result_hash: resultHash,
    output_hash: outputHash,
    verification_hash: verificationHash,
    verification_report_hash: verificationHash,
    payment_tx: paymentTx,
    settlement_receipt: feedback?.settlement_receipt || null
  };
  const traceHash = hashJson(tracePayload);
  const createdAt = new Date().toISOString();

  return {
    evidence_version: "agent_router_evidence_v1",
    evidence_profile: evidenceProfile,
    route_type: routeType,
    request_id: requestId,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    service_version: manifest?.version || null,
    manifest_type: manifest?.manifest_type || null,
    manifest_hash: manifestHash,
    config_hash: configHash,
    service_binding: {
      service_id: manifest.service_id,
      provider_id: manifest.provider.provider_id,
      version: manifest?.version || null,
      manifest_type: manifest?.manifest_type || "hosted_http_data_api",
      manifest_hash: manifestHash,
      config_hash: configHash
    },
    selected_service: selectedService,
    request,
    input,
    result_hash: resultHash,
    output_hash: outputHash,
    input_hash: inputHash,
    verification_hash: verificationHash,
    verification_report_hash: verificationHash,
    trace_hash: traceHash,
    trace_payload_hash: traceHash,
    payment: {
      quote,
      settlement_receipt: feedback?.settlement_receipt || null,
      payment_tx: paymentTx
    },
    payment_tx: paymentTx,
    verification,
    verification_report: verificationReport,
    arc_anchor: {
      anchor_version: "agent_router_arc_anchor_v1",
      network: settlementChain().network,
      caip2: settlementChain().caip2,
      chain_id: settlementChain().id,
      status: "not_configured",
      event_type: "AgentRouterEvidence",
      storage_model: "full_evidence_offchain_hashes_on_arc",
      request_id: requestId,
      trace_hash: traceHash,
      result_hash: resultHash,
      output_hash: outputHash,
      verification_hash: verificationHash,
      manifest_hash: manifestHash,
      config_hash: configHash,
      payment_tx: paymentTx,
      created_at: createdAt
    },
    created_at: createdAt
  };
}

export function hashJson(value) {
  return `0x${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function stripManifestForEvidenceHash(manifest) {
  const clone = structuredClone(manifest || {});
  delete clone.integrity;
  if (clone.registration) {
    delete clone.registration.manifest_hash;
    delete clone.registration.config_hash;
    delete clone.registration.version;
    delete clone.registration.manifest_type;
  }
  if (clone.erc8257) delete clone.erc8257.metadata_hash;
  return clone;
}
