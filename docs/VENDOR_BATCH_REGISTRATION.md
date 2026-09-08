# Wallet-confirmed Vendor registration batches

Batch registration was deployed as `3766cbc` on 2026-09-08. A real attempt stopped at wallet signing; no Vendor identity was created. The Rabby preflight/provider-selection follow-up below is local only and has not been deployed.

## Rabby follow-up (local)

- Explicit EIP-6963 wallet selection replaces reliance on the first `window.ethereum` injection. Discovery does not connect, sign, fetch provider icons, or prove that a provider is trustworthy. A batch pins the selected provider; later announcements cannot replace it.
- Rabby is blocked before starting a new raw-signing registration. Its unsupported path is not probed with a transaction. Existing transaction hashes can still be verified. Other wallet brands remain unverified until a real supported signing flow succeeds; a mock success is not wallet compatibility evidence.
- Signing errors retain a numeric diagnostic code and distinguish cancellation, authorization, pending requests, unsupported methods and unknown failures. Raw provider error payloads are not exposed in UI or persisted.
- Official Rabby source inspected at `f12cbb05eb7eed48ddb1c02dee887deff193ec55`: `src/background/controller/provider/controller.ts` implements `ethSendTransaction`, not `ethSignTransaction`; `rpcFlow.ts` forwards unhandled `eth_` methods to RPC. This explains why our current raw-signature acquisition assumption cannot be relied upon for Rabby.
- This follow-up does NOT implement a new Rabby sponsorship transport. Do not describe it as a completed gas-free registration fix.

### Explicit platform-paid path (approved, implemented locally)

The operator approved the existing platform `0x0531…f1dB` wallet paying BNB gas. The separate `platform_paid` mode uses `eth_sendTransaction`, not an automatic fallback. The server exposes an available payer only to the configured operator and pins it to the registered platform identity owner on the canonical chain/registry. The user operates Rabby and confirms each real transaction.

Each fee review shows Vendor, full payer, BSC, gas plus 20% buffer, maximum fee in BNB, and a non-Paymaster label. Guards: 500,000 gas, 0.001 BNB per-transaction safety ceiling, sufficient balance, 60-second quote expiry, account/network recheck after consent. Do not increase limits in the wallet. Actual cost comes from the mined receipt. Unknown sends block repeat registration; returned hashes resume verification. These local guards do not guarantee cross-device exactly-once execution.

If the operator requires zero BNB paid by this wallet as well, use a separately reviewed sponsored-registration design (for example a typed-authorization relay with atomic registry registration and identity transfer). That requires a separate decision about contract deployment, signer custody, fees and receipt verification; do not silently add a relay or repurpose the evidence-anchor signer.

## Operator flow

1. Open Account → Connections → Vendor identities.
2. Select the intended registration wallet and verify the full owner address. The page prefills the existing platform identity owner returned by the server; it does not create a new wallet. The selected operator wallet is `0x0531bc53d9632E58dd08b54034824E2FdF68f1dB`.
3. For Rabby, explicitly choose **Platform wallet pays BNB**. Select one to five canonical Vendors and click Register selected. Similar imported names are not automatically merged; do not register duplicate imports as separate identities without reviewing them.
4. Review each fee and confirm in Rabby yourself. The original Paymaster mode remains separate for compatible raw-signing wallets. This is batch preparation, not one-signature or unattended registration.
5. Successful receipt verification displays the returned Agent ID and transaction link. Cancellation or errors pause the batch with a persistent explanation. Already registered Vendors are skipped.

The signing wallet owns these identities. Platform-managed integrations are not endorsements by the named third-party Vendors. Provider authentication, ownership checks and receipt verification remain server-side.

## Safety and recovery

- BSC mainnet only; canonical IdentityRegistry; zero BNB value; fixed register method; maximum 500,000 gas; connected owner and network checked around signing.
- No private key export, new server signer, or BNB-paid fallback. Actual sponsorship eligibility and daily limits remain enforced by the existing Paymaster policy. Five selected Vendors is a batch limit, not a promise that five transactions remain in the daily allowance.
- Sponsored mode uses `eth_signTransaction`; platform-paid mode uses `eth_sendTransaction` after explicit fee consent. Compatibility with the user's real wallet still needs verification after deployment.
- Same-origin browser locks prevent concurrent batches in supported browsers. This is not a cross-device or server-wide registration lock.
- The local recovery journal stores status and public transaction hashes, never signed transactions or wallet secrets. A known submitted hash resumes receipt verification rather than signing again. An uncertain broadcast without a returned hash blocks another submission; recover with its BscScan transaction hash.
- Preserve browser storage while a transaction is unresolved. Clearing it or switching devices removes this local guard; this implementation does not claim global exactly-once execution.
- Pause cannot undo a transaction already submitted. Never interpret a paused UI as a chain rollback.

## Reproduce tests

Platform-paid preview: choose Rabby fixture and alpha. Sponsored mode stays disabled. Explicitly select Platform wallet pays BNB and register: the fee dialog shows 0.000012 BNB and full payer. Expiry sends nothing; confirming a fresh quote produces fake Agent ID 900001 without raw signing. All fixture IDs/hashes are fake. Tests cover wrong operator/payer, fee bounds, insufficient balance, missing or declined consent, expiry, account/network changes, stop, cancellation, storage failures, uncertain send and receipt recovery.

2026-09-08 platform-paid verification: browser fixture counters were raw signed=0, ordinary sent=1, verified=1. This proves the local ordinary-send branch, not real Rabby execution. Full suite and scoped regression results are recorded in `docs/STATUS.md`. Fresh production-dependency npm audit reported zero vulnerabilities. No database migration or dependency change is needed.

```sh
node --test test/vendor-registration-batch.test.js
node --test --experimental-test-coverage --test-coverage-include=src/vendor-registration-batch.js test/vendor-registration-batch.test.js
npm test
node test-support/vendor-batch-preview.js
```

The preview prints a loopback URL and displays a LOCAL MOCK ONLY banner. Open Connections. Before selecting a wallet, registration is disabled. Select Rabby fixture: new registration remains disabled with a compatibility explanation. Select Mock raw-signing wallet, then alpha and beta, and register. Select gamma, choose Unsupported wallet or Cancel signing, and verify a persistent pause. Change back to Success and resume, then reload. All three rows should display IDs and remain disabled. `/__fixture/state` should report three signed, three sent, three verified; failures must not add broadcasts. All IDs, signatures and transaction hashes in this fixture are fake and must not be used as chain evidence.

Verified: 31 controller/UI-contract cases; controller coverage 100% lines, 92.47% branches, 91.67% functions. Full suite: 1,152 passed, zero failed, two PostgreSQL-environment skips. Browser checks covered sequential success, cancellation, unsupported signing, recovery and reload; final mock counters were exactly three/three/three. External fonts/assets are intentionally unavailable in the isolated preview. No real wallet signature or blockchain transaction was requested.

Rabby follow-up verification: 47 focused tests pass. Combined controller/discovery coverage: 100% lines, 90.98% branches, 90.91% functions. Full suite: 1,168 passed, zero failed, two database-environment skips. Isolated browser checks confirmed explicit wallet choice, Rabby blocking before signing, and one successful mock registration after choosing the compatible mock wallet. One browser action needed a retry after an approval-review timeout. These checks do not establish a working real Rabby sponsorship flow.
