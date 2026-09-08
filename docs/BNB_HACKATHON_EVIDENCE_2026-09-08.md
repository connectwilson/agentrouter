# BNB hackathon evidence pack — 2026-09-08

This is the reviewer-facing evidence inventory. It separates confirmed public
transactions from locally recorded events and from work that is still pending.
It must not be read as a claim that every feedback event is already on-chain.

## 1. Confirmed ERC-8004 Vendor identity

| Item | Confirmed value |
|---|---|
| Network | BNB Smart Chain mainnet (`chainId: 56`) |
| Identity Registry | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://bscscan.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| Vendor integration | `provider_nansen_api` (AgentRouter-managed integration; not an endorsement by Nansen) |
| ERC-8004 Agent ID | [`340924`](https://8004scan.io/agents/56/340924) |
| On-chain owner | `0x0531bc53d9632E58dd08b54034824E2FdF68f1dB` |
| Registration transaction | [`0xce780499…135fc365`](https://bscscan.com/tx/0xce780499022ade2028085acc000218a8e5d1cebddf4df912bd9dd779135fc365) |
| Receipt | Success; block `120657225`; `183,720` gas; `0.0000119418 BNB` paid |
| Token URI | [Vendor identity metadata](https://agentrouter.network/.well-known/erc8004/vendors/provider_nansen_api.json) |

The registry generated Agent ID `340924`. It is a Vendor-scoped identity shared
by that Vendor's AgentRouter services; it is not the AgentRouter platform Agent
ID and it is not a manually assigned number.

## 2. Confirmed paid call and BSC execution evidence

| Item | Confirmed value |
|---|---|
| Request | `req_1788794834931` |
| Task | PONS top-token-holders lookup on Robinhood Chain |
| Paid result | 10 holder records; `0.01` credits charged |
| Provider execution time | `4,090 ms` |
| End-to-end client time | `21,692 ms` (includes routing and automatic feedback handling) |
| Evidence transaction | [`0xa9785ff…f8d8291b`](https://bscscan.com/tx/0xa9785ff572b9e53d09bc67483606eeb5ad03fdabc20843213fd5145bf8d8291b) |
| Evidence contract | [`0xa1d4ec27a8e5e32808589c60433ec28fb8ae11a3`](https://bscscan.com/address/0xa1d4ec27a8e5e32808589c60433ec28fb8ae11a3) |
| Method | `anchorEvidence(...)` (`0x31af4949`) |
| Receipt | Success; block `120623869`; `31,590` gas; native value `0` |
| Sponsorship indication | effective gas price `0`; this is the Paymaster-backed execution-evidence anchor |

The anchor proves that AgentRouter recorded a successful call's evidence hash on
BSC. It does **not** prove that the returned token-holder data is independently
chain-verified, and it is not an ERC-8004 reputation feedback transaction.

## 3. Feedback validation: current, honest status

| Check | Status |
|---|---|
| Operational + consumer feedback record for the call | Recorded in AgentRouter's public feedback projection |
| Public readback | [Feedback record](https://agentrouter.network/agent-router/feedback?request_id=req_1788794834931) |
| Consumer assessment | intent fit/useful/data quality were recorded as positive in the event record |
| Canonical BSC Reputation Registry | [`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`](https://bscscan.com/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |
| On-chain `giveFeedback(...)` receipt for this request | **Not yet available** |
| Paymaster receipt for feedback | **Not yet available** |

Why this is pending: the historic feedback record was created before the Vendor
identity existed. A retry must reuse its exact signed canonical payload (including
the non-public idempotency fields) and then have the independent consumer wallet
sign the sponsored `giveFeedback(...)` transaction. A previous retry correctly
stopped before signing because it could not safely reconstruct that payload. No
feedback transaction hash or on-chain rating is being claimed.

## 4. Evidence chain a judge can verify now

```text
Vendor metadata → ERC-8004 Agent ID 340924 → registration receipt on BSC
                                   ↓
paid AgentRouter request → successful result → BSC EvidenceAnchored receipt
                                   ↓
public off-chain feedback projection (on-chain reputation feedback pending)
```

## 5. Submission-safe wording

Use this wording in the hackathon submission:

> AgentRouter has a live BSC ERC-8004 Vendor identity and a separate successful
> BSC execution-evidence anchor for a paid data call. Consumer feedback is
> recorded and publicly readable; the final ERC-8004 `giveFeedback` receipt is
> pending canonical-payload reconciliation and must not be presented as complete.

## 6. Remaining acceptance criterion

To complete the full target chain, perform exactly one idempotent feedback resume
for this existing request, obtain the consumer wallet's explicit signature, then
verify the BscScan receipt, emitted reputation event, Agent ID `340924`, feedback
hash and Paymaster sponsorship. This should create no new paid data call and must
never submit a changed rating or a duplicate feedback event.
