# BSC identity and sponsored-anchor repair — 2026-09-08

## Release boundary

Implemented and regression-tested locally. Not pushed, not deployed, no Paymaster policy mutation, no identity registration, no real feedback transaction, and no paid data calls in this repair. Production remains the previously verified `f9827ab`. Do not describe this change as successful onchain evidence.

## Changes

- Correct BSC mainnet ReputationRegistry to `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`; correct BSC testnet IdentityRegistry to `0x8004A818BFB912233c491871b3d84c89A494BD9e`. Mainnet identity registry remains `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
- Share registration validation between feedback and marketplace. BSC identity requires an explicit chain and matching identity registry; contradictory chain fields, foreign registries, legacy provider IDs, and global ID fallback cannot establish a Vendor identity. Accept both the verified-receipt `registry_address` and persisted `identity_registry` aliases, rejecting contradictions. This is local provenance validation, not a live owner/URI attestation of arbitrary imported manifests.
- Valid identities applied by the existing receipt-verification registration flow remain available to services and feedback. Unproven BSC identities are shown as `identity_unverified` with no active Agent ID/link. Historical source manifests, feedback hashes and recorded evidence are not rewritten.
- BSC execution anchors use the configured Paymaster exclusively, not ordinary EOA-paid RPC. Before signing: verify RPC chain, simulate the method with zero gas price, estimate gas within 300,000, and obtain sponsorship for the exact sender/target/calldata. Missing/denied/unavailable sponsorship fails closed into the durable retry path. Non-BSC anchoring retains its existing transport.
- Preserve outbox nonce and fixed signing parameters across uncertain-broadcast retries; verify the returned transaction hash. Confirm known transaction hashes instead of rebroadcasting completed jobs. No key or signed raw transaction is stored in the outbox. Paymaster HTTP errors do not expose credential-bearing URLs.
- A receipt must have `status: success` and a block number before the outbox marks the transaction anchored. Missing, incomplete and reverted receipts stay pending with the known hash retained.

## Verification

- TDD reproduced 14 initial registry/identity/transport failures, then three false-success receipt failures, then five storage/card parity failures before their corresponding fixes.
- 37 new executable cases: 31 production-boundary cases, five durable-outbox cases, one HTTP Vendor metadata case. Existing tests that previously treated unscoped IDs as BSC identities now require canonical registry provenance.
- Related suite: 109/109 passing. Sponsored adapter coverage: 100% lines, 100% functions, 97.22% branches. HTTP transport tests cover success, HTTP/JSON-RPC errors, malformed responses and timeout redaction; tests never broadcast to BSC.
- Final full suite: 1,101 total, 1,099 passed, zero failures, two PostgreSQL-environment skips. No CI or production deployment was run in this repair; skipped database checks are not claimed as passed.
- Dependency audit: zero vulnerabilities (successful network-enabled retry after the sandbox DNS failure).
- User regression corpus: AR-BUG-080 and AR-BUG-081, with references to executable tests; original 30 routing questions retained.

## Production rollout prerequisites

1. Approve and deploy the code. If explicit registry environment overrides exist, review them against the canonical table; changing the default does not override operator-set environment variables.
2. Review the MegaFuel policy rather than topping up blindly. Earlier read-only probes allowed the old feedback target and denied the correct mainnet target and AR anchor. Restrict sponsorship by intended sender, target, method, expiry and budget; a probe from the anchor EOA does not establish eligibility for consumer reviewer EOAs.

| Operation | Target | Method selector |
|---|---|---|
| Vendor identity registration | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `register(string)` — `0xf2c298be` |
| Consumer reputation feedback | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `giveFeedback(...)` — `0x3c036a7e` |
| Execution evidence anchor | `0xa1d4ec27a8e5e32808589c60433ec28fb8ae11a3` | `anchorEvidence(...)` — `0x31af4949` |

3. Verify or register the intended AR-managed Nansen integration identity under an explicitly approved owner. Do not bind the legacy ID `22914` or reuse platform ID `319032`. Registering an integration does not imply Nansen endorsement.
4. Keep consumer feedback signed by the consumer reviewer, separate from the provider owner. No server signer environment variable was added. Existing MCP sponsored-feedback functionality consumes the corrected descriptor; this server repair does not require an npm bridge code change or publish a new bridge.
5. Resume an eligible existing job through its durable flow, preserving historical hashes and preventing duplicate feedback. A queued job does not establish that an automatic retry worker exists or has run. Final acceptance needs real successful receipts, correct Vendor ID, public explorer links, and sponsor evidence; no paid lookup is needed solely to verify these boundaries.

Diagnosis and live probe evidence: `docs/BSC_PAYMASTER_DIAGNOSTIC_2026-09-08.md`.
