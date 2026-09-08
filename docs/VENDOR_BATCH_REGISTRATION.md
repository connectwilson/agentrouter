# Wallet-confirmed Vendor registration batches

Batch registration was deployed as `3766cbc` on 2026-09-08. A real attempt stopped at wallet signing; no Vendor identity was created. The Rabby preflight/provider-selection follow-up below is local only and has not been deployed.

## Rabby follow-up (local)

- Explicit EIP-6963 wallet selection replaces reliance on the first `window.ethereum` injection. Discovery does not connect, sign, fetch provider icons, or prove that a provider is trustworthy. A batch pins the selected provider; later announcements cannot replace it.
- Rabby is blocked before starting a new raw-signing registration. Its unsupported path is not probed with a transaction. Existing transaction hashes can still be verified. Other wallet brands remain unverified until a real supported signing flow succeeds; a mock success is not wallet compatibility evidence.
- Signing errors retain a numeric diagnostic code and distinguish cancellation, authorization, pending requests, unsupported methods and unknown failures. Raw provider error payloads are not exposed in UI or persisted.
- Official Rabby source inspected at `f12cbb05eb7eed48ddb1c02dee887deff193ec55`: `src/background/controller/provider/controller.ts` implements `ethSendTransaction`, not `ethSignTransaction`; `rpcFlow.ts` forwards unhandled `eth_` methods to RPC. This explains why our current raw-signature acquisition assumption cannot be relied upon for Rabby.
- This follow-up does NOT implement a new Rabby sponsorship transport. Do not describe it as a completed gas-free registration fix.

### Decision needed before a new execution path

The existing owner is the platform's `0x0531…f1dB` wallet. If the operator authorizes this platform wallet to pay BNB gas, an explicitly labeled ordinary wallet-send path can keep Vendor cost zero without a new contract. It must not be an automatic fallback from failed sponsorship. Before any actual send, show the estimated cost and let the operator confirm in Rabby. No such permission, code path or transaction is included here.

If the operator requires zero BNB paid by this wallet as well, use a separately reviewed sponsored-registration design (for example a typed-authorization relay with atomic registry registration and identity transfer). That requires a separate decision about contract deployment, signer custody, fees and receipt verification; do not silently add a relay or repurpose the evidence-anchor signer.

## Operator flow

1. Open Account → Connections → Vendor identities.
2. Select the intended registration wallet and verify the full owner address. The page prefills the existing platform identity owner returned by the server; it does not create a new wallet. The selected operator wallet is `0x0531bc53d9632E58dd08b54034824E2FdF68f1dB`.
3. Select one to five canonical Vendors and click Register selected. Similar imported names are not automatically merged; do not register duplicate imports as separate identities without reviewing them.
4. Confirm each registration in the browser wallet. Registrations run sequentially and only through approved platform sponsorship. This is batch preparation, not one-signature or unattended registration.
5. Successful receipt verification displays the returned Agent ID and transaction link. Cancellation or errors pause the batch with a persistent explanation. Already registered Vendors are skipped.

The signing wallet owns these identities. Platform-managed integrations are not endorsements by the named third-party Vendors. Provider authentication, ownership checks and receipt verification remain server-side.

## Safety and recovery

- BSC mainnet only; canonical IdentityRegistry; zero BNB value; fixed register method; maximum 500,000 gas; connected owner and network checked around signing.
- No private key export, new server signer, or BNB-paid fallback. Actual sponsorship eligibility and daily limits remain enforced by the existing Paymaster policy. Five selected Vendors is a batch limit, not a promise that five transactions remain in the daily allowance.
- Uses `eth_signTransaction`. A wallet that does not support this method pauses without sending a paid fallback. Compatibility with the user's real wallet still needs verification after deployment.
- Same-origin browser locks prevent concurrent batches in supported browsers. This is not a cross-device or server-wide registration lock.
- The local recovery journal stores status and public transaction hashes, never signed transactions or wallet secrets. A known submitted hash resumes receipt verification rather than signing again. An uncertain broadcast without a returned hash blocks another submission; recover with its BscScan transaction hash.
- Preserve browser storage while a transaction is unresolved. Clearing it or switching devices removes this local guard; this implementation does not claim global exactly-once execution.
- Pause cannot undo a transaction already submitted. Never interpret a paused UI as a chain rollback.

## Reproduce tests

```sh
node --test test/vendor-registration-batch.test.js
node --test --experimental-test-coverage --test-coverage-include=src/vendor-registration-batch.js test/vendor-registration-batch.test.js
npm test
node test-support/vendor-batch-preview.js
```

The preview prints a loopback URL and displays a LOCAL MOCK ONLY banner. Open Connections. Before selecting a wallet, registration is disabled. Select Rabby fixture: new registration remains disabled with a compatibility explanation. Select Mock raw-signing wallet, then alpha and beta, and register. Select gamma, choose Unsupported wallet or Cancel signing, and verify a persistent pause. Change back to Success and resume, then reload. All three rows should display IDs and remain disabled. `/__fixture/state` should report three signed, three sent, three verified; failures must not add broadcasts. All IDs, signatures and transaction hashes in this fixture are fake and must not be used as chain evidence.

Verified: 31 controller/UI-contract cases; controller coverage 100% lines, 92.47% branches, 91.67% functions. Full suite: 1,152 passed, zero failed, two PostgreSQL-environment skips. Browser checks covered sequential success, cancellation, unsupported signing, recovery and reload; final mock counters were exactly three/three/three. External fonts/assets are intentionally unavailable in the isolated preview. No real wallet signature or blockchain transaction was requested.

Rabby follow-up verification: 47 focused tests pass. Combined controller/discovery coverage: 100% lines, 90.98% branches, 90.91% functions. Full suite: 1,168 passed, zero failed, two database-environment skips. Isolated browser checks confirmed explicit wallet choice, Rabby blocking before signing, and one successful mock registration after choosing the compatible mock wallet. One browser action needed a retry after an approval-review timeout. These checks do not establish a working real Rabby sponsorship flow.
