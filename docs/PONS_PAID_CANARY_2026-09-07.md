# PONS paid canary — 2026-09-07

## Production follow-up — released and retested

Production revision `f9827abb13f084e904ac6ad6aa686bb1b91fb1ba` is Live on Render. The final native MCP call returned ten PONS holder addresses, charged **0.01 credits**, and automatically recorded consumer feedback. BSC anchoring did **not** succeed. This final call reused the previously resolved contract; it is not a claim that the original symbol-only task passed in one uninterrupted production call.

### Production failure caught and repaired

The first release (`16ec93d`) resolved PONS correctly, but the full production catalog selected `nansen_prediction_market_top_holders`: its shared holder tags and higher trust outweighed domain incompatibility. Nansen rejected the input with HTTP 422. The earlier three-service fixture had omitted this competitor. The new gate excludes incompatible domain/input contracts **before** trust/price ranking and before paid token resolution. Six collision variants and the HTTP/MCP integration now cover that blind spot (AR-BUG-079).

- Production resolver: `req_1788794038162`, charged 0.01 credits, ledger `cle_9857eb81-975d-4785-8970-06798bf3c9d8`.
- Failed prediction-market request: `req_1788794042973`. Its billing/refund metadata was not exposed in the routing failure envelope; the refund was not independently verified. Failed-delivery refund behavior exists in provider runtime, but is not sufficient evidence of this specific ledger outcome.
- Final holder request: `req_1788794834931`, charged 0.01 credits, ledger `cle_eab80df8-ad02-48ef-a1d8-00b705944c45`.
- Final client-observed MCP duration, including automatic feedback: **21,692 ms**. The earlier failed production workflow took 18,740 ms; deployment and checks are excluded.
- This deployment turn has 0.02 credits in confirmed successful charges; across the earlier hybrid test and this turn, confirmed successful charges total 0.04. The unverified failed-step ledger outcome was conservatively reserved within the agreed 0.05 ceiling. No further paid calls were made.

### Final production result and feedback

Chain `robinhood`, contract `0x39dbed3a2bd333467115de45665cc57f813c4571`; page 1, ten rows, all holders, no entity aggregation, token amount descending. Checked ten unique valid addresses and descending balances. Addresses match the historical table below; balances changed with the newer response timestamp `2026-09-07T15:27:14.931Z`. Rank 1 is the burn address, not an active trader. Data is Nansen-reported, not independently RPC-verified.

- Native MCP automatic feedback: `consumer_feedback_recorded`; no extra manual rating submitted.
- [Public holder feedback](https://agentrouter.network/agent-router/feedback?request_id=req_1788794834931): HTTP 200, two events (one operational, one consumer; not two consumer ratings).
- Resolver feedback was also read back after the second deploy: HTTP 200, two events. The earlier hybrid `SERVICE_NOT_FOUND` boundary does not affect these actual production invocations.
- Consumer feedback ERC-8004: `not_configured`, missing Vendor Agent ID on BSC. No feedback transaction hash.
- Separate execution-evidence anchor: `anchor_pending_retry`, durable outbox, error that gas cost exceeds account balance; no transaction hash. This does not establish successful Paymaster sponsorship.
- Remaining response inconsistency: the successful envelope still contains pre-execution quote advice `connect_credits_or_configure_local_payment` / `execution_available: false`. Actual result and charged receipt establish execution, but this stale advice should be reconciled to prevent misleading agents.

### Release checks

Scoped tests 83/83; full local suite 1,064 total, 1,062 passed, zero failed, two PostgreSQL-dependent skips. CI run `34137789188` passed both verification and real PostgreSQL persistence (3/3); regression corpus 14/14. Token-holder module coverage: 100% lines/functions, 80.61% branches. npm audit: zero vulnerabilities. Free production quote selects TGM holders; the paid resumed call confirms real execution. Server release does not publish a new npm bridge version.

## Historical hybrid canary — before deployment

The following sections preserve the earlier test and its limitations; they are not the latest release status.

### Historical verdict

Real Nansen data acquisition and production AgentRouter credit billing passed. Full production routing/feedback/on-chain acceptance did **not** pass: the repaired router is local and has not been deployed. Do not describe this as an end-to-end production success.

The user authorized a paid test. The run was bounded to 0.05 USDC-equivalent pricing; actual receipts show **0.02 credits**, in two charges of 0.01. No additional paid calls were made after success.

## Execution boundary

- Original task: `查robinhood链上PONS代币的前10大 token holder的地址`.
- Local router revision: `3de5e53`.
- Production MCP's free quote still selected TGM Transfers and copied a sample contract. That quoted call was **not** executed.
- Local repaired routing used current public production manifests for `nansen_tgm_holders`, `nansen_search_general`, and the confusing `nansen_tgm_transfers` candidate. This is a focused canary, not a full production-catalog routing benchmark.
- Calls went through AgentRouter's authenticated production provider runtime and real credit ledger, not directly to Nansen. Existing browser-approved AR credentials were used without exposing or changing them.
- The initial local attempt was blocked before payment: system DNS resolved `agentrouter.network` to reserved Fake-IP `198.18.0.194`. A subsequent attempt used Google's public DNS answer (`216.24.57.1` at the time), while retaining public-address validation, DNS pinning, and original-host TLS verification. No SSRF bypass or security configuration change was made.

## Successful paid steps

| Step | Service | Request ID | Charge | Client-observed latency |
|---|---|---|---|---|
| Resolve exact PONS symbol on Robinhood | `nansen_search_general` | `req_1788789898292` | 0.01 credits | 4,920 ms |
| Top ten holders by token balance | `nansen_tgm_holders` | `req_1788789904567` | 0.01 credits | 6,418 ms |

Total execution time: **11,345 ms**, excluding manifest downloads, the prior DNS-blocked attempt, and subsequent feedback checks.

Receipts:

- Resolver ledger entry: `cle_317a6952-f525-4bbe-a6fc-3b6bdc3f6ad4`, `charged`.
- Holder ledger entry: `cle_7322193c-e714-4da6-83b4-3a18c23bbf88`, `charged`.

Resolved contract: **`0x39dbed3a2bd333467115de45665cc57f813c4571`**, chain **`robinhood`**.

Holder request: page 1, per_page 10, all_holders, aggregate_by_entity false, token_amount descending. Result timestamp: `2026-09-07T14:05:04.567Z`; provider-wrapper declared lag: 60 seconds. This timestamp is not an independently checked block timestamp.

## Returned holder addresses

Balances below are rounded to two decimal places. Rank 1 is the conventional burn address and must not be represented as an active trader or whale. These are provider-reported holdings, not independently RPC-verified balances.

| Rank | Address | PONS balance |
|---|---|---:|
| 1 | `0x000000000000000000000000000000000000dead` | 299,000,471.69 |
| 2 | `0x035ae7d933dcbfe617ffba194a88af0c2867b90c` | 11,795,883.53 |
| 3 | `0x2dbaf98620ac5bbe3441f756feff82702d095b1a` | 11,413,123.44 |
| 4 | `0x1bcc5f67cd17e13770f199fa03bc043b0cde1143` | 10,958,126.04 |
| 5 | `0x0a6ebed0155edb4b21d92ad02897a626cd90119e` | 10,957,901.42 |
| 6 | `0x6455327f820edd69c4cd665b995e0fec679d7f9e` | 9,882,450.70 |
| 7 | `0xde52c75041371b5e08d8a50b82c63734850628c1` | 8,999,999.98 |
| 8 | `0x33d35d84372a97da6bbd32d101bdcc48074cc102` | 7,980,058.22 |
| 9 | `0x88d25c861938a91af4ad57ad964a8fcc6c6351d3` | 7,918,257.90 |
| 10 | `0x7e3ba68c49561aae7c23c1d20fef0f1d7615a3ad` | 7,800,000.00 |

Local verification passed exact chain/contract provenance, ten unique valid addresses, nonnegative numeric balances, descending order, schema, and requested count. A verifier pass is not a guarantee of upstream ground truth.

## Feedback gap

Both MCP feedback submissions returned `SERVICE_NOT_FOUND`. Read-only production checks returned HTTP 200 with `count: 0` for both request IDs. The local router has invocation/verification records; the production credit provider delivered and billed data, but production feedback lookup has no corresponding invocation record for this hybrid path.

- [Resolver feedback lookup](https://agentrouter.network/agent-router/feedback?request_id=req_1788789898292)
- [Holders feedback lookup](https://agentrouter.network/agent-router/feedback?request_id=req_1788789904567)

No invocation records or consumer feedback were fabricated to overcome this boundary. No successful BSC feedback transaction was observed or claimed.

Next acceptance step: deploy the reviewed router changes with user authorization, then repeat through the actual production fetch/MCP entry point. Verify persisted invocation records, successful feedback ownership/lookup, and the returned BSC anchoring status separately. Do not add charges beyond the remaining agreed budget without approval.
