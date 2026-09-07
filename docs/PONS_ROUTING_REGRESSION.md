# PONS routing regression — 2026-09-07

Production reproducer: `查robinhood链上PONS代币的前10大 token holder的地址`

Request: `external_geckoterminal_1788774955717_a7trjrtj`; zero budget; MCP round trip 18.844 seconds. Returned BSC trending pools, not PONS holders. The automatic consumer assessment incorrectly recorded `yes/yes`. BSC feedback remained `not_configured` because the external Vendor has no active Agent ID. This is not successful BSC transaction evidence.

## Fix boundaries

- Token-holder queries have a separate capability boundary. The current implementation does not implement a holder contract: it returns `capability_not_available` before payment, login, or provider invocation. This fix does not add Robinhood/PONS coverage.
- Pool connectors check operation and chain compatibility at planning and invocation. Unknown or conflicting explicit chains cannot default to BSC. BSC remains the default only where no chain is declared.
- Nonempty results prove transport success, not usefulness. Automatic positive ratings require explicit `intent_fit_valid: true` and `coverage_valid: true`. Missing relevance evidence yields `assessment_unavailable`, without a consumer rating or an extra user prompt. The existing invocation record remains available. Negative and partial verification results remain distinct.
- Vendor identity isolation is unchanged. Missing Vendor registration must not reuse Platform Agent ID 319032. No identity was registered and no transaction broadcast during this repair.

## Remaining release/operational work

The fix changes server routing and the npm MCP bridge. Both need releasing; already-running older clients will not acquire the bridge fix merely from a server deployment. This local repair does not alter the already-recorded incorrect production rating. Correcting historical ratings is a separate scoped operation.

Future holder support needs a real provider contract with chain/token resolution, balance ordering, owner addresses and block/time provenance. Do not simply remove the capability guard when a generic API appears in the catalog.

Regression IDs: AR-BUG-076 and AR-BUG-077. Runtime tests cover free and nonzero budgets through HTTP and MCP, zero provider invocations, no-match telemetry, and absence of bogus feedback.
