# Wallet-confirmed Vendor registration batches

Implemented locally on 2026-09-08. This feature has not been deployed and the tests below did not register real Vendor identities.

## Operator flow

1. Open Account → Connections → Vendor identities.
2. Verify the full owner address. The page prefills the existing platform identity owner returned by the server; it does not create a new wallet. The selected operator wallet is `0x0531bc53d9632E58dd08b54034824E2FdF68f1dB`.
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

The preview prints a loopback URL and displays a LOCAL MOCK ONLY banner. Open Connections, select alpha and beta, and register. Select gamma, choose Unsupported wallet or Cancel signing, and verify a persistent pause. Change back to Success and resume, then reload. All three rows should display IDs and remain disabled. `/__fixture/state` should report three signed, three sent, three verified; failures must not add broadcasts. All IDs, signatures and transaction hashes in this fixture are fake and must not be used as chain evidence.

Verified: 31 controller/UI-contract cases; controller coverage 100% lines, 92.47% branches, 91.67% functions. Full suite: 1,152 passed, zero failed, two PostgreSQL-environment skips. Browser checks covered sequential success, cancellation, unsupported signing, recovery and reload; final mock counters were exactly three/three/three. External fonts/assets are intentionally unavailable in the isolated preview. No real wallet signature or blockchain transaction was requested.
