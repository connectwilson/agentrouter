# PRD: Routing correctness, refunds for wrong data, and public service reputation

**Status:** Ready for implementation
**Audience:** a coding agent with no context from the conversation that produced this
**Repo:** `/Users/huazhenghao/Downloads/Arc` (AgentRouter)

---

## 0. Why this exists

A buyer agent asked AgentRouter to *find similar job openings for a crypto product
manager*. AgentRouter selected **`get_https_app_nansen_ai_api_points_leaderboard_api`** —
a crypto points leaderboard — returned unrelated data, **charged for it**, and did so
three times in a row. The buyer agent left negative feedback each time; nothing changed.

Every claim in §1 was reproduced against this repo, not inferred. The failure is not a
bad heuristic that needs tuning. It is four independent gaps that happen to line up:

1. two routing paths with **asymmetric guards**;
2. **no minimum relevance** anywhere before payment;
3. refunds fire on **delivery** failure but never on **relevance** failure;
4. negative feedback is recorded but has **no mechanism that acts on it**.

Fixing only the scoring would leave 2, 3 and 4 intact and the same class of bug would
return with a different query.

---

## 1. Reproduction and root cause (verified)

### 1.1 The exact trigger

One shared token was enough. With the real leaderboard manifest registered and verified:

```
"find similar job openings crypto product manager"
  → get_https_app_nansen_ai_api_points_leaderboard_api
  → match_score = 0.14   (1 of 7 query tokens matched)
  → selected → invoked → charged
```

Isolating the tokens shows the whole match rests on **`crypto`**:

| query | result |
|---|---|
| `crypto` | match_score **1.0** |
| `找相似岗位` | no match |
| `senior product manager hiring` | no match |
| `apple pie recipe` | no match |

The word `crypto` pulled a jobs question into a crypto-only registry.

### 1.2 Two routing paths; only one has guards

`src/router.js` → `rankCandidates` → `scoreCandidate` enforces **three** relevance gates:

```js
if (!capabilityHits) return { routing_score: 0 };            // capability must match
if (!serviceCoversCapability(surfaceText, intent.capability)) return { routing_score: 0 };
if (!serviceCoversRequestedAsset(manifest, intent)) return { routing_score: 0 };
```

Verified: `resolveRoute` correctly returns `needs_clarification` for all three jobs
queries. **The main path is not the bug.**

`src/agent-router.js` → `askAgentRouter` falls through to `searchCandidates` →
`selectService` when no capability is inferred. That path has **none** of those gates:

```js
searchServices(store, { query, verifiedOnly: true, maxPrice })   // text search only
```

`agentrouter_fetch` reaches this fallback via
`runRemoteAgentRouterFetch` → `askAgentRouter` (`src/server.js`). So the user-facing
entry point is the one without guards.

### 1.3 No minimum relevance, anywhere

- `rankCandidates` keeps everything with `routing_score > 0`.
- `resolveRoute` takes `candidates[0]` unconditionally.
- `selectService` scores with `match_score` plus a list of `wants_*` bonuses
  (`wants_liquidation`, `wants_netflow`, …). For an off-domain query **no bonus fires**,
  so the ranking is the raw text score — 0.14 still wins if it is the only candidate.

There is no floor below which AgentRouter declines to answer.

### 1.4 Refunds cover the wrong failure

`src/provider-runtime.js` refunds only when delivery fails:

```js
const successful = status >= 200 && status < 300 && body?.status === "success" && !body?.error;
if (!successful) { await refundCredits(...reason: "provider_result_not_delivered") }
```

A service that **successfully returns irrelevant data** is `status: "success"` — so it is
charged and never refunded. That is exactly this incident. Note also: this branch is
`payment.backend === "credits"` only; the x402/Arc path has no equivalent.

### 1.5 Feedback is recorded but inert

`summarizeTrust` (`src/store.js`) already computes `intent_fit_rate`, `usefulness_rate`,
`consumer_feedback_count`, `recent_failure_rate`, and `scoreCandidate` reads them. But:

- feedback only reaches trust **on the main path**, which was not the one that failed;
- there is no threshold at which a service is demoted, quarantined, or flagged;
- nothing notifies the operator that a service is accumulating negative feedback;
- three identical complaints changed nothing, which is the observed behaviour.

`src/home.js` renders one aggregate number — `total_feedback_events` — with no per-service
rating anywhere public.

---

## 2. Goals / Non-goals

**Goals**
- Never charge for a result that was selected on a weak match.
- Make both routing paths enforce the same relevance floor.
- Refund automatically when a paid result is judged irrelevant, not merely undelivered.
- Turn negative feedback into an automatic, visible consequence for the service.
- Publish per-service reputation so buyers and providers can see it.

**Non-goals**
- No ML ranking model. The fix is deterministic gates and thresholds.
- No change to payment rails, wallets, or the credits ledger schema.
- No new capability taxonomy. (Capability coverage is a separate, real problem — see §8.)

---

## 3. Workstream A — a relevance floor before payment

### A1. One shared gate for both paths

Introduce a single exported function used by `rankCandidates` **and** `selectService`:

```js
export function meetsRelevanceFloor(candidate, intent, { floor = 0.35 } = {}) // → boolean
```

It must consider, at minimum: capability match, token overlap ratio, and whether the
query's domain terms appear in the service surface text. A single shared token (the
`crypto` case) must **not** clear the floor.

### A2. Decline instead of guessing

When no candidate clears the floor, return the existing `no_service_found` /
`NO_REGISTERED_SERVICE_MATCHED` shape — never `candidates[0]`. The response must include:

- `best_rejected_candidate`: `{ service_id, score, floor }` so the behaviour is debuggable;
- `next_actions` pointing at free local capabilities where relevant (the pattern added in
  `freeLocalAlternative`, `src/external-api-capability.js`, is the precedent to follow).

### A3. Threshold is configurable, and the default is enforced

`ADN_ROUTING_RELEVANCE_FLOOR` (default `0.35`). A deployment may lower it; it may not be
removed. Log every rejection at info level with query, best candidate and score, so the
floor can be tuned against real traffic rather than guesswork.

### A4. Acceptance criteria

1. The three reproduction queries in §1.1 return "no service found", not a paid call.
2. `crypto` alone does not select the leaderboard service.
3. Genuine crypto queries that worked before still route (regression guard: the existing
   suite covers liquidation, netflow, smart-money and token-price intents — all must stay
   green).
4. Both `resolveRoute` and `askAgentRouter` reject below the floor. A test must assert the
   fallback path specifically, since that is the one that failed.

---

## 4. Workstream B — refunds for irrelevant results

### B1. Relevance is part of "successful"

Extend the success test in `src/provider-runtime.js` so a result that is delivered but
**fails relevance verification** is refunded. `verifyServiceResult` already exists in
`src/router.js` and already computes intent fit; it currently runs *after* the charge.
Move the decision before settlement, or refund immediately on a failing verdict.

New refund reason: `provider_result_not_relevant`, distinct from
`provider_result_not_delivered`, so the two are separable in the ledger.

### B2. Buyer-initiated refund window

An agent that receives a paid result and judges it irrelevant must be able to claim a
refund without a human. Extend the existing feedback tool rather than adding a new one:
`agentrouter_feedback` with `intent_fit: "no"` and a `request_id` should open a refund
claim for that request.

Rules, which the implementation must enforce:
- Refund is per `request_id` and **idempotent** — a repeated claim never double-refunds.
- A claim window (`ADN_REFUND_CLAIM_WINDOW_HOURS`, default 24) bounds the liability.
- Auto-approve when server-side verification **agrees** the result was irrelevant.
- Otherwise mark `disputed` and leave it for an operator. Do not auto-approve on the
  buyer's word alone; that is trivially abusable.

### B3. Parity across payment backends

§1.4 notes the refund branch is credits-only. Either implement the x402/Arc equivalent or
**explicitly document** that relevance refunds are credits-only and have the x402 path
return a clear `refund_unavailable_for_backend` marker. Silent asymmetry is not acceptable.

### B4. Acceptance criteria

1. A service returning a well-formed but irrelevant envelope is refunded automatically,
   with ledger reason `provider_result_not_relevant`.
2. Claiming twice for one `request_id` refunds once (assert ledger entries).
3. A claim outside the window is rejected with a clear code.
4. A claim the server cannot corroborate lands in `disputed`, not `refunded`.

---

## 5. Workstream C — negative feedback must have consequences

### C1. Quarantine on repeated negatives

Reuse the existing circuit-breaker concept in `scoreCandidate`
(`health.circuit_breaker?.active` already excludes services). Add a **relevance** breaker:
N negative `intent_fit` verdicts within a window ⇒ the service is quarantined for that
capability, excluded from routing, and marked in the registry.

Defaults: `ADN_RELEVANCE_BREAKER_THRESHOLD=3`, `ADN_RELEVANCE_BREAKER_WINDOW_HOURS=24`.
Three identical complaints is precisely what happened here and must be enough to stop it.

### C2. Make it visible to the operator

Quarantine writes a `service_quality_alert` record exposed at
`GET /agent-router/quality?service_id=…` (endpoint exists) and surfaced in Provider Studio
for the owning provider, including the offending queries. A provider must be able to see
*why* their service was demoted.

### C3. Recovery path

Quarantine is not permanent. Define how a service returns: operator clears it, or it
expires and re-enters at reduced ranking weight pending fresh positive feedback. Specify
the chosen rule in `docs/ARCHITECTURE.md`.

### C4. Acceptance criteria

1. Three negative `intent_fit` verdicts inside the window quarantine the service.
2. A quarantined service is not selected by either routing path.
3. The alert is retrievable via the quality endpoint and names the queries involved.
4. Recovery works as documented and is covered by a test.

---

## 6. Workstream D — public reputation

### D1. Per-service reputation, not one global counter

`src/home.js` shows only `total_feedback_events`. Replace with per-service reputation
derived from `summarizeTrust`, which already computes everything needed:
`intent_fit_rate`, `usefulness_rate`, `consumer_feedback_count`, `recent_failure_rate`,
`success_rate`.

Public service pages/listings must show:
- an intent-fit and usefulness rate, with **sample size** (a 100% rate from one call must
  not read like a 100% rate from 500);
- recent failure rate and health;
- quarantine status when active;
- last-updated timestamp.

### D2. Honest empty states

A service with no feedback shows "no feedback yet", never a default or implied-good score.
Providers must not be able to look good by being unused.

### D3. Privacy boundary

Reputation is aggregate. Do not expose buyer identity, raw queries, or per-call payloads
on public surfaces. Query text may appear in the **provider-private** alert of §C2 only.

### D4. Acceptance criteria

1. Public listing shows per-service rates with sample sizes.
2. Zero-feedback services render an explicit empty state.
3. No public surface leaks buyer identity or raw query text.
4. Quarantined services are labelled as such publicly.

---

## 7. Suggested order

A → B → C → D. A stops the bleeding and is the smallest change; B needs A's relevance
verdict to exist; C needs B's verdicts accumulated; D presents what C produces.

Land each workstream as its own commit with its own tests. The suite is currently **291
tests passing on a clean checkout** — that is the regression baseline.

---

## 8. Related problem, deliberately out of scope

The registry is crypto-only, so *any* non-crypto question has no correct answer available.
A relevance floor makes AgentRouter **decline honestly** instead of guessing — which is the
right behaviour, but it is not coverage. Deciding what non-crypto capabilities to onboard
(jobs, general web search, social) is a product decision, not part of this document.

Note the free local social capabilities (`social_search` across X, Reddit, Xiaohongshu,
Bilibili, YouTube, Zhihu, Weibo) already exist in the MCP bridge and need no API key. A
jobs question is better served by pointing at those than by any crypto service, and §A2's
`next_actions` should do exactly that.

---

## Appendix — verified facts an implementing agent will need

| Fact | Location |
|---|---|
| Guarded path: capability + coverage + asset gates | `src/router.js`, `scoreCandidate` |
| Unguarded fallback: text search only | `src/agent-router.js`, `searchCandidates` / `selectService` |
| `agentrouter_fetch` reaches the fallback | `src/server.js`, `runRemoteAgentRouterFetch` → `askAgentRouter` |
| Top candidate taken unconditionally | `src/router.js`, `resolveRoute` (`candidates[0]`) |
| Only bar is `routing_score > 0` | `src/router.js`, `rankCandidates` |
| Refund fires on delivery failure only, credits backend only | `src/provider-runtime.js` |
| Refund ledger primitive already exists | `src/credits.js`, `refundCredits` |
| Trust already aggregates intent fit and usefulness | `src/store.js`, `summarizeTrust` |
| Circuit-breaker exclusion precedent | `src/router.js`, `scoreCandidate` |
| Quality events endpoint exists | `GET /agent-router/quality?service_id=…` |
| Public page shows only a total count | `src/home.js` |
| Steering-to-free-alternative precedent | `src/external-api-capability.js`, `freeLocalAlternative` |

Tests use `node:test` + `node:assert/strict`; run with `npm test`. Tests that write
provider configs must clean up in a `finally` block — several existing tests are sensitive
to shared state in `ADN_PROVIDER_DIR`.
