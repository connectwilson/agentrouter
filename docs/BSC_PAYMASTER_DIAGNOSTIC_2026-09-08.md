# BSC / Paymaster diagnostic — 2026-09-08

## Scope and outcome

Read-only production inspection. No credentials changed or revealed, no private keys exported, no signatures produced, no transactions broadcast, no paid data calls, no deployment. Production remains `f9827ab`. All Paymaster probes use `pm_isSponsorable`, not `eth_sendRawTransaction`; positive eligibility is not a settlement receipt or a guarantee for a different sender.

## Confirmed findings

1. Render runtime is BSC and has `ADN_BSC_PAYMASTER_URL` pointing to host `bsc-megafuel.nodereal.io`. Public health also reports configured. The owner and feedback signing-key environment variables are absent; this is not itself a defect because the production feedback path expects a consumer-local signer, not a provider/server self-rating.
2. Current BSC reputation address in `src/chains.js`, metadata and prior feedback is `0x8004B663056A597Dffe9eCcC1965A193B7388713`. On BSC, `getIdentityRegistry`, `getLastIndex` and a non-owner `giveFeedback` eth_call reverted. Bytecode existence alone did not establish a usable registry. Earlier advice presenting this as the correct BSC mainnet reputation contract was wrong.
3. The official contract repository lists BSC mainnet ReputationRegistry as `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Direct BSC reads return the expected identity registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; the same diagnostic `giveFeedback` eth_call succeeds there. No feedback was actually submitted.
4. Production vendor metadata for `provider_nansen_api` advertises ID `22914`. On the canonical BSC identity registry this ID has owner `0x416bF085DF428076F2F10a68541dE7013Ceef4E8` and an inline tokenURI whose name is `34611`, not the AgentRouter Nansen metadata URI. Therefore this metadata claim cannot establish Nansen ownership. The feedback descriptor for the real PONS invocation correctly did not blindly accept it. Code permits provider-level legacy ID fallback when generating the aggregate vendor card, while service feedback rejects explicit cross-chain registration; this is an inconsistent identity-provenance boundary to repair before registering or binding anything.
5. Platform ID `319032` is distinct and valid: canonical BSC tokenURI is `https://agentrouter.network/.well-known/erc8004/platform.json`, owner `0x0531bc53d9632E58dd08b54034824E2FdF68f1dB`. It must not replace Vendor IDs.
6. Execution-anchor account `0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb` currently has zero BNB. `src/arc-anchor.js:createAnchorClients` uses the settlement RPC, not the configured Paymaster. The stored PONS execution anchor remains `anchor_pending_retry`, without transaction hash. A durable retry record does not prove a retry worker has successfully retried it.

## Actual production Paymaster eligibility probes

Sender in all probes: the public execution-anchor account above. Gas limit 300,000; value zero. Registration calldata names the exact Nansen vendor metadata URI; feedback/anchor probes use explicitly diagnostic calldata and are never broadcast. Consumer-local reviewer addresses may have different eligibility and must be checked separately before real feedback.

| Probe | Target | HTTP | Sponsorable | Sponsor reported |
|---|---|---:|---|---|
| Vendor register | canonical BSC identity registry | 200 | true | ERC8004 |
| giveFeedback, currently configured address | `0x8004B663…88713` | 200 | true | AgentRouter |
| giveFeedback, correct mainnet address | `0x8004BAa1…9b63` | 200 | false | none |
| anchorEvidence | `0xa1d4ec27a8e5e32808589c60433ec28fb8ae11a3` | 200 | false | none |

This proves that the existing policy result for the old feedback target does not carry over to the correct mainnet registry. It does not expose the complete policy configuration, balance, expiry, or the exact rejection reason. Do not claim an empty Paymaster balance; no top-up is justified solely by these checks.

## Recommended repair sequence (not executed)

1. Correct chain-specific canonical registry defaults, validate registry-to-identity linkage and method simulation, and fix public metadata to reject legacy/unproven cross-chain Vendor IDs. Preserve historical feedback payloads and hashes rather than rewriting signed evidence.
2. Update the narrowly scoped sponsorship policy for the correct mainnet reputation contract and intended reviewer senders/method. Decide explicitly whether the separate evidence anchor is needed; if retained, add a bounded sponsored transport and policy for it. Do not silently fall back to user-paid BNB.
3. Verify whether a valid Nansen-specific identity already exists under the intended AR-managed integration owner. If not, obtain explicit approval for a sponsored registration with the owner address and transaction scope stated. Do not claim registration implies Nansen endorsed this integration, and do not reuse the platform ID.
4. Safely resume one existing real feedback through the consumer reviewer path, with fresh canonical identity validation and idempotent receipt attachment. Registration and feedback submitters must respect the contract's self-feedback restrictions. Only actual successful receipts count as transaction evidence.
5. Regression coverage should include: bytecode but wrong interface; mainnet/testnet identity mismatch; unproven legacy Vendor ID; policy allows wrong target but rejects canonical target; sponsored path with zero EOA balance; no gas fallback on denial; duplicate retry; immutable historical evidence; reviewer/owner separation.

## Sources

- Official deployment table: https://github.com/erc-8004/erc-8004-contracts (BSC Mainnet and BSC Testnet sections).
- NodeReal eligibility API: https://docs.nodereal.io/reference/pm-issponsorable .
- Production metadata: https://agentrouter.network/.well-known/erc8004/vendors/provider_nansen_api.json .
- PONS evidence: https://agentrouter.network/agent-router/evidence?request_id=req_1788794834931 .
- Authenticated Render environment + web-shell read-only probes, and direct BSC JSON-RPC reads/eth_call on this date.
