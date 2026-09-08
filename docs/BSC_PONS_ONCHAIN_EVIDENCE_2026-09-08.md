# Confirmed BSC execution evidence — PONS

## Public transaction

[View the successful transaction on BscScan](https://bscscan.com/tx/0xa9785ff572b9e53d09bc67483606eeb5ad03fdabc20843213fd5145bf8d8291b).

| Field | Verified value |
|---|---|
| Network | BNB Smart Chain mainnet, chain 56 |
| Block | 120623869 |
| Timestamp | 2026-09-08 04:39:54 UTC |
| Request | req_1788794834931 |
| Sender | 0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb |
| Evidence contract | 0xa1d4ec27a8e5e32808589c60433ec28fb8ae11a3 |
| Method | anchorEvidence, selector 0x31af4949 |
| Receipt | success |
| Actual Gas used | 31,590 |
| Transaction Gas limit | 300,000 configured by the sponsored adapter |
| Gas price / effective Gas price | 0 / 0 |
| Native value transferred | 0 |
| Nonce | 0 |

## What was verified

- Resumed the existing durable evidence job after explicit user approval. Did not repeat the paid PONS lookup.
- Independent RPC receipt/event verification found exactly one `EvidenceAnchored` event from the expected contract. All eight event arguments matched the original stored request and evidence hashes.
- Independent database read confirmed `anchored`, the same transaction hash, and two attempts: the historical failure and this successful resume.
- Paymaster preflight returned sponsor `AgentRouter`; wrong sender, target and method probes were rejected. MegaFuel balance display subsequently changed from 0.001 to 0.000998 BNB. Exact sponsor charge is not yet verified because the displayed balance is rounded and aggregate sponsorship metrics had not synchronized.
- BscScan displayed Success and 215 confirmations when inspected.

## Boundaries and remaining work

This proves a real execution-evidence hash anchor on BSC, not a new Vendor registration or an ERC-8004 ReputationRegistry `giveFeedback` transaction. It does not independently establish the accuracy of the underlying holder data.

The public evidence endpoint still returns its historical `arc_anchor.status=anchor_pending_retry` and null transaction hash. The durable job and chain receipt are successful, but the GET endpoint currently projects the stored evidence snapshot without reconciling later outbox completion. Fix that reconciliation and add a regression test before claiming the entire user-visible evidence flow is complete. Do not create a second chain transaction merely to refresh the displayed status.

### Follow-up implementation (local, not deployed yet)

The read-model reconciliation is implemented and covered by HTTP regression tests. A read-only production database check confirmed that the historical PONS event contains its outbox ID, anchor account and contract, and that recomputing all original arguments yields the exact persisted job ID. No production data rewrite or second broadcast is required for this event.

Two related registration/feedback blockers are also fixed locally: imported Vendors appear in the configured operator's identity list, and feedback created before a Vendor identity can refresh its unsigned descriptor after registration without recording another rating or replacing a submitted transaction.

Regression corpus entries: AR-BUG-082, AR-BUG-083 and AR-BUG-084. Production rollout and browser-wallet registration remain pending; these local fixes are not evidence that a Vendor Agent ID or ReputationRegistry feedback has already been created.
