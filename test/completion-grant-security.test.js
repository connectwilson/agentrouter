import assert from "node:assert/strict";
import test from "node:test";

const previousSecret = process.env.ADN_COMPLETION_GRANT_SECRET;
process.env.ADN_COMPLETION_GRANT_SECRET = "completion-grant-regression-secret";

const { issueCompletionGrant, verifyCompletionGrant } = await import("../src/completion-grant.js");

test.after(() => {
  if (previousSecret === undefined) delete process.env.ADN_COMPLETION_GRANT_SECRET;
  else process.env.ADN_COMPLETION_GRANT_SECRET = previousSecret;
});

test("completion grants are bound to service, input, challenge, signature, and expiry", () => {
  const issuedAt = Date.now();
  const expected = {
    serviceId: "verified_service",
    inputHash: "input-hash",
    challengeNonce: "challenge-nonce"
  };
  const token = issueCompletionGrant({
    ...expected,
    expiresAt: new Date(issuedAt + 60_000).toISOString()
  });

  assert.equal(verifyCompletionGrant(token, { ...expected, now: issuedAt }).ok, true);
  assert.equal(verifyCompletionGrant(token, { ...expected, serviceId: "other_service", now: issuedAt }).code, "COMPLETION_GRANT_SERVICE_MISMATCH");
  assert.equal(verifyCompletionGrant(token, { ...expected, inputHash: "other-input", now: issuedAt }).code, "COMPLETION_GRANT_INPUT_MISMATCH");
  assert.equal(verifyCompletionGrant(token, { ...expected, challengeNonce: "other-challenge", now: issuedAt }).code, "COMPLETION_GRANT_CHALLENGE_MISMATCH");
  assert.equal(verifyCompletionGrant(`${token.slice(0, -1)}x`, { ...expected, now: issuedAt }).code, "COMPLETION_GRANT_INVALID");
  assert.equal(verifyCompletionGrant(token, { ...expected, now: issuedAt + 60_001 }).code, "COMPLETION_GRANT_EXPIRED");
});

test("completion grant issuance rejects incomplete authorization context", () => {
  assert.throws(
    () => issueCompletionGrant({ serviceId: "verified_service", inputHash: "input-hash" }),
    (error) => error?.code === "COMPLETION_GRANT_INPUT_INVALID"
  );
});
