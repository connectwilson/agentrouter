# PONS routing regression — 2026-09-07

Production reproducer: `查robinhood链上PONS代币的前10大 token holder的地址`

Request: `external_geckoterminal_1788774955717_a7trjrtj`; zero budget; MCP round trip 18.844 seconds. Returned BSC trending pools, not PONS holders. The automatic consumer assessment incorrectly recorded `yes/yes`. BSC feedback remained `not_configured` because the external Vendor has no active Agent ID. This is not successful BSC transaction evidence.

## Fix boundaries

- Token-holder queries now map to the registered `token_holders` contract, including Nansen TGM Holders. An absent/unverified endpoint still fails before payment or login. Robinhood is supported by the adapter; this does not assert that PONS is indexed or that any particular contract has been verified live.
- The planner, HTTP ask, HTTP fetch, and MCP fetch preserve chain, token identity, and requested count. Quotes distinguish an attempt from a confirmed answer. Missing chain/token is clarified without authorization. Current holdings are not a historical snapshot or a profitable-trader leaderboard.
- A supplied contract skips symbol search. A symbol uses the selected provider's registered token resolver, requiring an exact symbol, exact chain, valid address, and unique contract. Wrapped tokens, other chains, samples, and truncated/ambiguous search results cannot silently substitute. No provider credentials are added to environment variables.
- The workflow quotes token resolution plus holders together (currently the public Nansen manifests price each at 0.01). All known holder parameters are preflighted before paying for resolution. Each step receives only its reserved price ceiling; USDC totals use exact six-decimal units. A second-step failure preserves the resolver receipt. Quotes do not count as successful executions or feedback.
- Holder input is constructed from the task, not copied from sample requests: page one, requested count, `aggregate_by_entity: false`, `label_type: all_holders`, and descending `token_amount`. No stale `date`, sample contract, or premium-label flag is forwarded. Verification checks chain/contract, unique valid holder addresses, numeric nonnegative descending balances, and page completeness.
- Pool connectors check operation and chain compatibility at planning and invocation. Unknown or conflicting explicit chains cannot default to BSC. BSC remains the default only where no chain is declared.
- Nonempty results prove transport success, not usefulness. Automatic positive ratings require explicit `intent_fit_valid: true` and `coverage_valid: true`. Missing relevance evidence yields `assessment_unavailable`, without a consumer rating or an extra user prompt. The existing invocation record remains available. Negative and partial verification results remain distinct.
- Vendor identity isolation is unchanged. Missing Vendor registration must not reuse Platform Agent ID 319032. No identity was registered and no transaction broadcast during this repair.

## Remaining release/operational work

The fix changes server routing and the npm MCP bridge. Both need releasing; already-running older clients will not acquire the bridge fix merely from a server deployment. This local repair does not alter the already-recorded incorrect production rating. Correcting historical ratings is a separate scoped operation.

Live release verification remains separate: authorize a bounded paid request, confirm the resolved PONS contract with the user/source evidence, and inspect actual holder results, both receipts, and feedback. Neither mocked success nor official chain coverage is proof of PONS data availability. No paid Nansen call, production deployment, or BSC transaction was performed during this implementation.

Official contract references checked on 2026-09-07:

- [Nansen chain coverage](https://docs.nansen.ai/reference/chains.md)
- [TGM Holders](https://docs.nansen.ai/api/token-god-mode/holders.md)
- [Search / token resolution](https://docs.nansen.ai/api/search.md)

`src/token-holders.js` centralizes the adapter's chain scope, parsing, exact token matching, input contract, and result verification. Its scoped regression suite has 53 cases, with 100% line/function and 80.61% branch coverage. HTTP/MCP integration tests now isolate their provider directory so developer-installed providers cannot turn an intended no-provider case into a supported route.

Regression IDs: AR-BUG-076, AR-BUG-077, AR-BUG-078. Runtime tests cover both registered-service quotes and no-service refusals through HTTP/MCP, free and nonzero budgets, no-match telemetry, and absence of bogus feedback.

## Production catalog collision (AR-BUG-079)

The first deployed canary on `16ec93d` resolved PONS correctly but selected `nansen_prediction_market_top_holders`. That manifest carried the same holder tags as TGM while its input schema declared `market_id` rather than `chain` and `token_address`. The earlier three-service canary omitted this competitor and therefore was insufficient evidence of full-catalog routing accuracy.

Revision `f9827ab` makes explicit string-typed chain/contract fields and a compatible domain mandatory before trust/price ranking or paid symbol resolution. A mislabeled prediction-market service, missing chain, missing contract, opaque schema, numeric chain, and conflicting domain are now regression cases. Ranking, quotes, execution, absent-compatible-service refusal, and HTTP/MCP entrypoints are covered. The scoped suites pass 83/83; full regression passes 1,062 with zero failures and two DB-dependent skips, while CI separately passes all three real Postgres checks. An offline check loading 234 existing provider manifests admits only `nansen_tgm_holders` for the PONS request.

See the paid canary report for production release evidence, costs, and the separate missing Vendor ERC-8004 identity limitation. Passing these checks does not establish correctness for every possible future imported manifest.
