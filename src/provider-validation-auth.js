import crypto from "node:crypto";

const INTERNAL_VALIDATION_HEADER = "x-agentrouter-provider-validation";
const internalValidationToken = crypto.randomBytes(32).toString("base64url");

export function internalProviderValidationHeaders() {
  return { [INTERNAL_VALIDATION_HEADER]: internalValidationToken };
}

export function isInternalProviderValidationRequest(req) {
  const supplied = String(req?.headers?.[INTERNAL_VALIDATION_HEADER] || "");
  const actual = Buffer.from(internalValidationToken);
  const candidate = Buffer.from(supplied);
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}
