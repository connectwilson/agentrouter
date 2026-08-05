# PRD: Apify Actor Integration for AgentRouter

**Status:** Draft for implementation
**Owner:** (you)
**Audience:** coding agent implementing the change

---

## 1. Context

AgentRouter is a demand-side router: an agent sends a task, AgentRouter discovers the
best registered service, runs the x402/Arc pay boundary, invokes the provider, verifies
the result, and returns an `agent_data_envelope_v1`. Providers are registered as
**provider configs** with a `source` block. Today `executeProviderConfig()` supports two
source types: `static_json` and `hosted_http` (a single synchronous upstream HTTP call).

**Apify** is a web-scraping / automation execution platform. Each capability is an
**Actor** (a containerized scraper) that you run with an input JSON and that produces a
**dataset** (array of result items). Apify is *supply*: AgentRouter should route buyer
demand **to** Apify Actors, not reimplement scraping.

This PRD adds a third provider source type — **`apify_actor`** — so any Apify Actor can be
onboarded as an AgentRouter service and sold through the existing discover → pay → verify
flow.

## 2. Goal & Non-Goals

**Goal**
- Let a provider register an Apify Actor as an AgentRouter service.
- Let a demand agent invoke it through the normal paid flow and receive a normalized
  `agent_data_envelope_v1`.
- Handle Apify's async execution model (start run → wait → fetch dataset) transparently,
  preferring Apify's synchronous endpoint when the run is fast enough.
- Reuse existing plumbing (secrets, preflight, enveloping, pagination, error mapping).

**Non-Goals (v1)**
- No proxy/anti-bot logic of our own — Apify handles execution.
- No usage-based (variable) pricing pass-through — v1 uses a fixed per-call price
  (see §7).
- **No async execution in v1.** v1 is sync-only: it uses Apify's
  `run-sync-get-dataset-items` endpoint and nothing else. Actors that exceed the ~5 min
  sync window return a clear "too slow for v1" error. Async (start → poll → fetch) is
  explicitly deferred to v2. This removes the polling infra, the wait-budget management,
  and the async-preflight-cost dilemma from v1 entirely.
- No Apify webhooks / push.
- No new payment rails — reuse the existing Arc/x402 boundary unchanged.

## 3. Apify API primer (the only endpoints we need)

Base: `https://api.apify.com/v2`. Auth: `Authorization: Bearer <APIFY_TOKEN>` (preferred)
or `?token=<APIFY_TOKEN>`.

| Purpose | Call |
|---|---|
| **Run sync + get results** (preferred) | `POST /acts/{actorId}/run-sync-get-dataset-items` body = actor input JSON. Returns the dataset items array directly. Blocks up to ~5 min. |
| Start async run | `POST /acts/{actorId}/runs` body = actor input JSON → returns `{ data: { id, defaultDatasetId, status } }` |
| Poll run | `GET /actor-runs/{runId}` → `{ data: { status, defaultDatasetId } }`; terminal statuses: `SUCCEEDED`, `FAILED`, `ABORTED`, `TIMED-OUT` |
| Fetch dataset | `GET /datasets/{datasetId}/items?clean=true&format=json&limit=&offset=` |
| Read actor metadata (import) | `GET /acts/{actorId}` → title, description, `defaultRunOptions`, input schema |

`actorId` is either `<username>~<actor-name>` (e.g. `apify~google-search-scraper`) or the
actor's object id. Note Apify uses `~` in path form, not `/`.

## 4. New provider source: `apify_actor`

Extend the provider config `source` union. Config shape:

```jsonc
{
  "manifest": { /* normal AgentRouter manifest: service_id, provider, pricing, endpoint,
                   capabilities, input_schema, output_schema, sample_request,
                   sample_response, ... */ },
  "source": {
    "type": "apify_actor",
    "actor_id": "apify~google-search-scraper",
    "execution_mode": "sync",              // v1: only "sync" implemented. "async" => v2;
                                            // if set to "async" now, reject at config
                                            // validation with APIFY_ASYNC_NOT_SUPPORTED.
    "run_options": {                        // optional, forwarded to Apify as query params
      "timeout_secs": 120,
      "memory_mbytes": 1024,
      "build": "latest"
    },
    "input_template": {                     // static defaults merged UNDER buyer input
      "resultsPerPage": 10
    },
    "input_allowlist": ["queries", "maxPagesPerQuery", "resultsPerPage"], // buyer-settable keys
    "dataset": {
      "clean": true,
      "max_items": 100,                     // cap items returned in the envelope
      "fields": ["title", "url", "description"] // optional projection; omit = whole items
    },
    "auth": {
      "mode": "apify_token",
      "secret_ref": "apify_google_search:APIFY_TOKEN" // resolved via provider-secrets.js
      // or "secret_value" transiently during import, same as hosted_http
    },
    "summary": "Google SERP via Apify google-search-scraper"
  }
}
```

Rules:
- `actor_id` required. `execution_mode` defaults to `"sync"`.
- Actor input body = `{ ...input_template, ...filteredBuyerInput }` where `filteredBuyerInput`
  is buyer `input` reduced to `input_allowlist` keys (reuse the existing input-filtering
  helper pattern from `filterInputToManifestShape` / `providerInputAllowlist` in
  `router.js`). If `input_allowlist` is absent, pass buyer input through the manifest
  `input_schema` shape.
- The token is a **provider secret** (never in the manifest, never returned to agents).

## 5. Execution logic

Add an `apify_actor` branch in `executeProviderConfig()` (`src/provider-runtime.js`).
Return the same `{ status, body }` contract as the `hosted_http` branch so all downstream
code (envelope validation, quality checks, billing) is unchanged.

**v1 is sync-only** — one call, no polling:

```
executeApifyActor(config, input):
  token   = config.source.auth.secret_value || readProviderSecret(secret_ref)
  actorId = config.source.actor_id
  body    = merge(input_template, filterToAllowlist(input, input_allowlist))
  budgetMs = ADN_APIFY_MAX_WAIT_MS (default 120000)

  items = POST /acts/{actorId}/run-sync-get-dataset-items
          (Bearer token, body, AbortSignal.timeout(budgetMs),
           query: clean, format=json, limit=dataset.max_items, offset=input.offset)
  -> on 2xx: return envelope(project(items, dataset.fields))
  -> on 408 / AbortError / TIMED-OUT: return 504 APIFY_RUN_TIMEOUT (retryable) —
        "actor exceeded the v1 sync window; async support is v2"
  -> on 4xx/5xx: return upstream error (see §8)
```

Async (`start run → poll → fetch dataset`) is **out of scope for v1** — do not build it.
If a config sets `execution_mode: "async"`, reject it at config validation.

Reuse from the existing `hosted_http` path:
- `parseUpstreamPayload()` for JSON/non-JSON handling.
- Prefer Apify's own `limit`/`offset` query params to avoid over-fetching (don't re-page
  in-process).
- `project(items, fields)` = if `dataset.fields` set, map each item to just those keys;
  else return items unchanged.
- `AbortSignal.timeout(budgetMs)` on the fetch.

## 6. Envelope mapping

Wrap Apify dataset output in `agent_data_envelope_v1` via the existing `createEnvelope()`:

```
createEnvelope({
  serviceId,
  input,
  data: { items, item_count, actor_id, run_id, dataset_id },
  sourceType: "apify_actor",
  isEstimated: false,
  confidence: 0.8,
  summary: config.source.summary
})
```

- Empty dataset (`items.length === 0`) must surface as a result the verifier flags:
  keep `status: "success"` only if the actor SUCCEEDED but genuinely returned nothing;
  otherwise map to error. `validateRealResultFeedback()` already flags empty `data`, so an
  empty items array should be represented so that check fires (e.g. `data: []` or
  `data.items: []`). Confirm against `isEmptyData()` in `registry.js`.
- Include `metadata.data_sources: ["apify_actor"]` and `metadata.limitations` noting the
  actor id.

## 7. Pricing

- v1: **fixed per-call price** in `manifest.pricing` (`amount`/`currency`/`network`),
  identical to existing services. The provider sets it to cover expected Apify cost +
  margin and bears run-cost variance.
- The buyer is charged the fixed AgentRouter price via the existing Arc/x402 boundary.
  **No change to payment code.**
- Open question for the human (see §12): variable/metered pass-through pricing is out of
  scope for v1.

## 8. Error handling matrix

Map to the existing error codes so downstream billing/verification behave correctly.

| Situation | HTTP we return | envelope error `code` | Charged? |
|---|---|---|---|
| Missing/invalid Apify token | 502 | `UPSTREAM_APPLICATION_ERROR` (auth) | preflight → not charged |
| Actor not found / 404 | 502 | `UPSTREAM_ERROR` | preflight → not charged |
| Actor run FAILED/ABORTED/TIMED-OUT | 502 | `APIFY_RUN_FAILED` (+ run status) | not charged (caught in preflight) |
| Exceeded v1 sync window | 504 | `APIFY_RUN_TIMEOUT`, `retryable: true` | not charged (caught in preflight) |
| SUCCEEDED but empty dataset | 200 | envelope success + verifier flags `RESULT_DATA_EMPTY` | charged (real run happened) — matches current behavior |
| Non-JSON / malformed items | 502 | `UPSTREAM_NON_JSON_RESPONSE` | not charged (caught in preflight) |

**Preflight is mandatory for `apify_actor`.** Update `shouldPreflightProviderConfig()`
(`provider-runtime.js`) to return true for `apify_actor` as well as `hosted_http`, so a
failing/empty actor is caught **before** the payment challenge and no payment is
collected (reuse `createPrepayValidationFailure()` path). Because v1 is sync-only there is
no async double-charge dilemma: preflight runs the one sync call, and the result is reused
for the paid response via the existing preflight-cache in `handleCustomProvider`
(`payment.preflight?.result`), so the actor runs **once**, not twice.

## 9. Onboarding / import

Two acceptable paths; implement **A**, optionally **B**:

**A. Manual config (required).** Provider supplies `actor_id`, price, `input_allowlist`,
and Apify token through Provider Studio (`src/studio.js`) or the publish API
(`/studio/providers`). Store the token via `writeProviderSecret()`; write the config via
`writeProviderConfig()` (already invalidates the config cache). The service endpoint is a
normal custom provider route `/provider/custom/{service_id}` → `handleCustomProvider` →
`executeProviderConfig`.

**B. Actor-metadata import (nice-to-have).** Given `actor_id` + token, call
`GET /acts/{actorId}`, read title/description/input schema, and auto-draft the manifest
(`input_schema`, `capabilities` via `suggestCapabilities()`, `sample_request`). Mirror the
existing `openapi-import.js` draft flow. If skipped in v1, leave a `TODO`.

## 10. Files to touch

| File | Change |
|---|---|
| `src/provider-runtime.js` | Add `executeApifyActor()`; branch in `executeProviderConfig()`; include `apify_actor` in `shouldPreflightProviderConfig()`; reuse `parseUpstreamPayload`/`classifyUpstreamResponse`. |
| `src/provider-config.js` | Accept/validate `source.type === "apify_actor"` in `finalizeProviderConfig()`/`sanitizeProviderConfig()`; ensure the token is stripped into a secret_ref like `hosted_http`. |
| `src/studio.js` | Add an "Apify Actor" source option in the onboarding form (actor_id, price, allowlist, token). |
| `src/provider-secrets.js` | No change (reuse). |
| `src/registry.js` | No change expected; confirm `validateService` runs the actor once and stores a real `result_preview`. |
| `test/mvp.test.js` | Add coverage (see §11). Add a mock Apify endpoint under `/mock/upstream/apify/*` like the existing `handleMockUpstream*` helpers so tests don't hit api.apify.com. |
| `docs/` | Update `ARCHITECTURE.md` / `MVP_WORKFLOWS.md` to mention the `apify_actor` source. |

Config knobs (env): `ADN_APIFY_API_BASE` (default `https://api.apify.com/v2`, overridable
to the mock in tests), `ADN_APIFY_MAX_WAIT_MS` (default 120000), `ADN_APIFY_POLL_MS`
(default 3000).

## 11. Acceptance criteria

1. A provider config with `source.type: "apify_actor"` registers and validates; the token
   is stored encrypted (never present in `readProviderConfig` output or any agent-facing
   response).
2. Buyer invocation returns an `agent_data_envelope_v1` whose `data.items` equals the
   actor's dataset items (respecting `dataset.max_items` and `input.offset`).
3. `dataset.fields` projection: when set, each returned item contains only those keys;
   when omitted, whole items are returned.
4. Preflight: a failing/empty actor returns `PREPAY_VALIDATION_FAILED` and **no Arc
   payment is collected** (assert via payment log / `payment_collected: false`); the paid
   path reuses the cached preflight result so the actor runs exactly once.
5. Buyer input is filtered to `input_allowlist` before hitting Apify (assert the actor
   never receives disallowed keys).
6. Token errors map to `UPSTREAM_APPLICATION_ERROR` (auth) and do not charge.
7. A config with `execution_mode: "async"` is rejected at registration with
   `APIFY_ASYNC_NOT_SUPPORTED`.
8. Existing `hosted_http` and `static_json` behavior is unchanged (full suite still green,
   currently 100 tests).

## 12. Decisions (locked for v1 — no further input needed)

1. **Pricing: fixed per-call.** Provider sets a fixed USDC price and bears Apify run-cost
   variance. Metered/variable pass-through is deferred (revisit only if a real provider
   asks). No payment-code changes.
2. **Execution: sync-only.** Async is v2 (see §2/§5). This voids the async preflight-cost
   question entirely — sync + preflight cache = the actor runs once.
3. **Auth: Bearer header** (`Authorization: Bearer <token>`), not `?token=`.
4. **Dataset projection: supported, optional.** `dataset.fields` present ⇒ project items to
   those keys (trims agent payloads); absent ⇒ return whole items. Default absent.
5. **First actors (initial catalog + smoke targets):**
   - `apify~google-search-scraper` — Google SERP. Fast, sync-friendly, high demand.
   - `apify~rag-web-browser` — search/read web content for agents, returns markdown.
     Agent-native, fast, covers the "read the web" need.
   Both are fast enough for the sync window. Integration tests use the `/mock/upstream/apify/*`
   mock, **not** the live actors; the two names above are the seed catalog entries and the
   manual smoke-test targets only.

All five are decided — implement directly, do not wait for further product input.

---

### Appendix A — minimal happy-path pseudocode (sync)

```js
async function executeApifyActor(config, input = {}) {
  const s = config.source;
  const serviceId = config.manifest?.service_id || "apify_actor";
  const token = s.auth?.secret_value || await readProviderSecret(s.auth?.secret_ref);
  const body = { ...(s.input_template || {}), ...filterToAllowlist(input, s.input_allowlist) };
  const base = process.env.ADN_APIFY_API_BASE || "https://api.apify.com/v2";
  const limit = boundedInteger(s.dataset?.max_items ?? input.limit, 0, 1000) || undefined;

  const url = new URL(`${base}/acts/${encodeURIComponent(s.actor_id)}/run-sync-get-dataset-items`);
  url.searchParams.set("clean", String(s.dataset?.clean ?? true));
  url.searchParams.set("format", "json");
  if (limit) url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.ADN_APIFY_MAX_WAIT_MS || 120000))
  });
  const payload = await parseUpstreamPayload(res);
  if (!res.ok || payload.non_json) {
    return { status: 502, body: apifyErrorEnvelope(serviceId, input, res.status, payload) };
  }
  const raw = Array.isArray(payload) ? payload : (payload.items || []);
  const items = s.dataset?.fields
    ? raw.map((it) => Object.fromEntries(s.dataset.fields.map((k) => [k, it?.[k]])))
    : raw;
  return { status: 200, body: createEnvelope({
    serviceId, input,
    data: { items, item_count: items.length, actor_id: s.actor_id },
    sourceType: "apify_actor", isEstimated: false, confidence: 0.8, summary: s.summary
  }) };
}
```
