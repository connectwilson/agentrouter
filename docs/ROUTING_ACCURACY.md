# Routing accuracy

AgentRouter measures routing as a decision system, not as a list of keyword
matches. A route is only correct when the task family, capability, source
family, authorization action, and budget decision are all correct.

## Decision pipeline

1. The canonical planner converts natural language or a structured request into
   `agentrouter_route_plan_v1`.
2. Hard constraints are applied first: explicit source/provider, unsupported
   source, authorization state, and maximum price.
3. Candidates inside the permitted source family are ranked by semantic fit,
   routing trust, recent failure rate, connection availability, and price.
4. Low-information, unsupported, unknown-price, and over-budget requests abstain
   or request clarification/authorization instead of guessing or making a paid
   call.
5. Every terminal decision emits a privacy-minimized
   `agent_router_route_observation_v2`. It never stores the raw prompt.

Explicit source requests are hard constraints. Trust may reorder equivalent
sources inside the same family, but it may not replace OpenAlex with a social
provider, turn an X variable into Twitter, or route a parcel tracking request to
a generic web source.

Authorization is represented as three different actions:

- `connect_account`: sign in to AgentRouter.
- `connect_source`: authorize a specific upstream API/data source.
- `browser_handoff`: continue through the user's already signed-in browser.

These states must not be collapsed into a generic “connect API” response.

## Offline benchmark

`test/fixtures/routing-benchmark-v1.json` is a versioned, labeled corpus. Version
1.2.0 contains 94 cases: the original 30 reported prompts plus paraphrases,
contrasts, Chinese/English variants, ambiguous requests, explicit-source
conflicts, authorization states, browser routes, budget boundaries, no-match
cases, unavailable partner sources, structured batches, and legacy registered
service intents.

Every production routing bug must add at least:

- the original prompt;
- one paraphrase;
- one contrast case that must *not* match the same source;
- the expected route family, capability, source candidates, auth action, and
  budget behavior.

Run the routing gate with:

```bash
npm run test:routing
```

Release gates are evaluated separately so a high overall score cannot hide a
dangerous slice:

- route-family accuracy;
- capability accuracy;
- source precision@1 and recall@3;
- abstention precision and recall;
- authorization-action accuracy;
- budget and forbidden-source violation rates;
- high-confidence misroute rate;
- expected calibration error (ECE);
- real ask/fetch/request/remote MCP/local-wallet/packaged-MCP outcome parity.

## Online observations and labels

The operator-only `GET /agent-router/metrics/routing` endpoint requires an
AgentRouter admin token and returns aggregate metrics with
`Cache-Control: no-store`. It never returns prompts, actors, observations, or
labels. Production labels are explicitly marked as self-reported diagnostics;
they are not suitable for a public accuracy claim. Public accuracy claims must
come from the versioned offline benchmark. Legacy V1 observations are counted
separately and excluded from V2 accuracy denominators.

Authenticated callers may label their own decision through
`POST /agent-router/routing-feedback`. Labels are tied to both `request_id` and
`observation_id`, persisted before memory is updated, idempotent across retries,
and cannot be submitted by another actor. Anonymous decisions do not advertise
the feedback endpoint.

Per-call V2 observations are visible only to their authenticated owner. Public
clients can use the aggregate metrics endpoint.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Labeled coverage | Labeled V2 observations / all V2 observations |
| Decision accuracy | Exact correctness of the terminal routing action |
| Route-family accuracy | Correct external API, local browser, registered service, or abstention family |
| Capability accuracy | Correct capability independent of the chosen Vendor |
| Precision@1 | Top selected service/source matches the label |
| Recall@3 | An acceptable service/source appears in the first three candidates |
| Abstention precision/recall | Whether clarify/no-match/abstain happens only when needed and is not missed |
| Auth-action accuracy | Correct account, source, or browser authorization action, including false negatives |
| Budget violation rate | Actually routed calls with known selected/max prices whose selected price exceeds the limit |
| Budget guard accuracy | Labeled route-vs-blocked budget decisions that match the expected outcome |
| Unknown-price guard rate | Unknown-price cases that correctly stop for a quote instead of executing |
| High-confidence misroute rate | Incorrect routes with confidence at or above the configured threshold |
| ECE | Difference between predicted confidence and observed correctness across confidence bins |

Metrics with no valid denominator are `null`, never a misleading zero or 100%.
All metrics are sliced by entrypoint, task family, route family, capability, and
source family so regressions cannot hide inside a global average.

## Operating loop

1. Monitor accuracy, high-confidence errors, budget violations, ECE, and labeled
   coverage by slice.
2. Review high-confidence errors first; they indicate the router is both wrong
   and insufficiently uncertain.
3. Add the failure and its contrast/paraphrase cases to the benchmark.
4. Fix the taxonomy, capability handbook, ranking signal, or guardrail rather
   than adding a prompt-specific keyword patch.
5. Require the offline gate, actual entrypoint parity tests, and a clean packed
   MCP installation smoke test before release.
