# BNB Judge Mode Runbook

This runbook is the acceptance contract for `/bnb`. It deliberately separates shipped product behavior from evidence that must be produced by a real BSC call.

## 90-second judge path

1. Open `/bnb` without signing in.
2. Confirm four equally weighted jobs are visible: Rebalancing, Grid Trading, Yield Optimisation, and Health Factor Monitoring.
3. Choose one Golden Task and compare the returned agents by Price, Trust Score, Track Record, and BSC Agent ID.
4. Click **Hire / call**. Authentication may be requested here, but never while browsing or comparing.
5. Confirm the result exposes the selected agent, selection reason, BSC/8004scan identity, declared price, Trust Score, latency, actual reported cost, structured result, data sources, evidence trace, and feedback status.
6. If execution fails, confirm the page shows a retryable product message and does not mention MCP, OpenCLI, connectors, or internal service names.

All four tasks must remain read-only or simulation-only. No order, deposit, withdrawal, approval, liquidity movement, or custody action is allowed in Judge Mode.

## Live-agent preflight

Each Golden Task needs at least one independently registered BSC Agent whose public metadata declares:

- chain ID `56` and an Agent ID resolvable on 8004scan;
- one exact allowed capability: `lp_range_rebalancing`, `grid_trading`, `yield_optimization`, or `health_factor_monitoring`;
- a verified public read-only endpoint;
- declared pricing, or an explicit `not_declared` price state;
- source provenance in the structured response;
- an execution policy that rejects side-effecting requests.

An empty marketplace is a failed preflight. Do not replace missing supply with invented cards, prices, trust, or results.

## Public evidence chain

Capture one successful Golden Task as a single evidence bundle:

| Evidence | Required value |
| --- | --- |
| BSC identity | Agent ID and public 8004scan URL |
| Hire | AgentRouter request ID and selected capability |
| Result | Structured response plus source list |
| Execution | Evidence trace hash, start/completion timestamps, and latency |
| Cost | Declared price and actual reported cost |
| Feedback | Consumer feedback request, submitted status, and resulting transaction hash |
| Chain | BscScan transaction URL and 8004scan feedback view |
| Sponsorship | Paymaster/sponsor transaction record showing the vendor did not pay gas |

The proof is complete only when every link is publicly reachable from a clean browser session. A local test count is supporting engineering evidence, not a substitute for this chain.

## Release gates

- `/bnb` and `/agent-router/bnb/golden-tasks` are public and cache-safe.
- Browsing does not require authentication; Hire does.
- Each task resolves to an exact read-only capability.
- The Hire request is idempotent and cannot execute twice after an uncertain response.
- Unknown price, cost, trust, latency, or sources are shown as unknown—not zero.
- A completed call exposes a feedback action/status and evidence trace.
- The full regression suite passes, followed by one production smoke and one real sponsored feedback transaction.
