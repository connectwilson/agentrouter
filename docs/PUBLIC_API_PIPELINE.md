# Public API conversion pipeline

AgentRouter tracks every entry from `public-apis/public-apis`, but does not treat a directory row as a callable service. Catalog coverage and executable service coverage are separate.

## State model

- `queued`: HTTPS catalog entry awaiting documentation discovery.
- `blocked_insecure_transport`: the catalog entry or documentation URL is HTTP-only.
- `credential_required`: read-only endpoints were discovered, but the provider requires its own credential.
- `validated_ready`: a read-only endpoint was discovered and passed a live public probe.
- `manual_review`: automation found no safe read-only endpoint or rejected the network target.
- `retryable_failure`: discovery or validation failed and can be retried.

Removed upstream entries remain stored with `catalog_presence: "removed"` so coverage history is auditable.

## Operations

Set `DATABASE_URL` in hosted environments. Without PostgreSQL, the CLI stores its resumable state in the gitignored `.adn/public-api-pipeline.json` file; override it with `ADN_PUBLIC_API_PIPELINE_STATE_PATH`.

```bash
npm run catalog:sync
npm run catalog:run -- --limit 25 --concurrency 3
npm run catalog:retry -- --status manual_review --reason unsafe_network_target
npm run catalog:coverage
```

Some managed local development environments resolve every public hostname into
the synthetic `198.18.0.0/15` benchmarking range before proxying HTTPS. That
range remains blocked by default. For an explicit local audit in such an
environment, add `--allow-synthetic-dns` to `catalog:run`, or set
`ADN_PUBLIC_API_ALLOW_SYNTHETIC_DNS=1`. Real loopback, private, link-local, and
metadata targets remain blocked. Do not enable this compatibility mode in the
hosted service unless its network layer is known to use the same synthetic
proxy mapping.

The HTTP management API provides the same workflow:

```bash
curl -H "Authorization: Bearer $ADN_ADMIN_API_TOKEN" \
  -X POST https://agentrouter.network/studio/public-api-pipeline/sync

curl -H "Authorization: Bearer $ADN_ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":25,"concurrency":3}' \
  -X POST https://agentrouter.network/studio/public-api-pipeline/start

curl -H "Authorization: Bearer $ADN_ADMIN_API_TOKEN" \
  "https://agentrouter.network/studio/public-api-pipeline/status?limit=100"
```

Only `ADN_ADMIN_API_TOKEN` can start sync or conversion jobs. A normal Provider Studio token cannot trigger bulk outbound requests.

Validated results are public and read-only:

```bash
curl "https://agentrouter.network/api/public-apis?availability=usable"
curl "https://agentrouter.network/api/public-apis?availability=unavailable"
```

The website renders the same inventory at `/public-apis`, including totals,
search, availability filters, tested endpoints, documentation links, and
machine-readable failure reasons. These public routes cannot start jobs or
change pipeline state.

The repository includes `.github/workflows/public-api-pipeline.yml`. It syncs the catalog daily and requests a bounded background conversion batch every ten minutes. Before enabling it, add the repository Actions secret `AGENTROUTER_ADMIN_TOKEN` with the same value as the hosted service's `ADN_ADMIN_API_TOKEN`. Duplicate triggers return `accepted: false` and do not overlap.

Generate this value as a random secret (for example, `openssl rand -hex 32`). Store it only in Render as `ADN_ADMIN_API_TOKEN` and in the private GitHub repository as the Actions secret `AGENTROUTER_ADMIN_TOKEN`; do not commit the value.

## Safety and registration boundary

Automated fetching rejects local, loopback, link-local, private, metadata, and reserved network targets, including redirect destinations. Conversion keeps only `GET` drafts. Provider credentials are never inferred or copied from documentation.

`validated_ready` means the candidate is ready for registry review; it is not automatically published as a paid AgentRouter service. Registration remains an explicit operation so pricing, ownership, payout, provider terms, rate limits, and credential custody can be confirmed.

## Current full-catalog audit

The upstream README fetched on 2026-07-29 contained 1,611 parseable API rows in 51 categories. The pipeline assigned a state to all 1,611 rows:

- 1,490 HTTPS candidates: `queued`
- 121 HTTP-only candidates: `blocked_insecure_transport`

This is 100% catalog-state coverage. Callable coverage grows as bounded conversion batches move candidates through documentation discovery and live validation.

### Partial live audit after pipeline hardening

The resumable local audit has tested 116 catalog entries so far:

- 3 `validated_ready`: Crossref Metadata Search, PoetryDB, and Quran Cloud.
- 11 `credential_required`.
- 98 `retryable_failure`.
- 4 `manual_review`.
- 1,374 remain queued.
- 121 remain blocked because the catalog source is HTTP-only.

This is explicitly a partial execution report, not a claim that the remaining
queued entries work or fail. The detailed tested endpoint and failure inventory
is exposed by `/api/public-apis`; the scheduled hosted batches continue from the
durable database checkpoint.
