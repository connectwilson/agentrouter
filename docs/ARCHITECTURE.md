# Architecture

## Components

- Provider Studio: human-facing service onboarding GUI.
- Execution/Routing/Verification Layer: stores service manifests, provider metadata, validation status, evidence traces, and feedback events, then selects and invokes the best available service for a demand agent.
- Persistent Registry: Postgres-backed provider config and encrypted secret storage, enabled by `DATABASE_URL`. Hosted Provider Studio deployments should require this so registered services survive restarts.
- Connector API: agent-facing primitives for search, manifest, preview, paid invocation, and feedback.
- AgentRouter: higher-level execution endpoint that accepts a structured request or fallback natural-language task and performs search -> selection -> payment -> invocation -> verification -> evidence.
- Route Observations: lightweight offchain records of structured routing decisions, candidate scores, selected service, verification outcome, and feedback hashes for future ranking improvements.
- Provider Runtime: local provider endpoints that return preview or paid agent data envelopes. A provider config declares one `source` type:
  - `static_json` — fixture data held in the config.
  - `hosted_http` — one synchronous call to the provider's own upstream API.
  - `apify_actor` — an Apify Actor run through `run-sync-get-dataset-items`, returning its dataset items as the envelope's `data.items`. Execution is synchronous only; a config asking for `execution_mode: "async"` is rejected at registration with `APIFY_ASYNC_NOT_SUPPORTED`. The Apify token is stored as a provider secret and never reaches the manifest or an agent. Buyer input is filtered to `input_allowlist` and merged over `input_template`, and `dataset.fields` optionally projects items down to the listed keys. Tuned by `ADN_APIFY_API_BASE` and `ADN_APIFY_MAX_WAIT_MS`.
- Wallet/Payment: adapter boundary supporting prepaid platform credits, x402-style payment, and Arc settlement. The credits backend uses Stripe Hosted Checkout plus a PostgreSQL append-only ledger.

## Trust Boundaries

- Demand agents should not choose payment target or amount directly. Invocation derives those from the service manifest and provider challenge.
- Credit top-ups are granted only after a verified Stripe webhook. Client API keys are stored as hashes, and ledger debits use an account row lock so concurrent calls cannot overspend.
- Invalid requests are rejected before debit. A provider failure after debit creates a compensating refund ledger entry instead of mutating history.
- Provider secrets stay server-side in provider config/runtime. They should not be exposed to demand agents or Skill files.
- Hosted provider credentials are encrypted before persistence. `ADN_PROVIDER_SECRET_PASSPHRASE` is the deployment key and must remain stable across restarts.
- Provider-owned upstream API keys must not be hardcoded into hosted deployment environment variables for normal onboarding. Provider Studio collects provider credentials and stores encrypted secret records in the persistent registry.
- AgentRouter returns evidence metadata so the main agent can inspect the service binding, manifest hash, input hash, output hash, payment tx, and verification report.
- Public Skills should call an HTTP endpoint, not a local filesystem path, when used from hosted Claude-like environments.
- AgentRouter should remain compatible with ERC-8257-style tool manifests instead of creating a separate onchain tool registry.

## Manifest Integrity And Evidence

Each service manifest is finalized with:

- `manifest_type: hosted_http_data_api`
- `version`
- structured `routing` metadata
- `manifest_hash`
- `config_hash`
- ERC-8257 compatibility metadata
- optional `origin_binding` pointing at `/.well-known/agentrouter.json`

Each paid call creates evidence that binds `service_id`, `manifest_hash`, `input_hash`, `output_hash`, `payment_tx`, and a deterministic `verification_report`. Full evidence stays offchain; Arc/ERC-8004 integrations anchor and reuse the hashes for verifiability and reputation.

## Agent-Friendly Response Shape

Paid results should return an `agent_data_envelope_v1`-style object:

- `status`
- `service_id`
- `request_id`
- `query`
- `data`
- `metadata`
- `limitations`

The exact provider data can vary by service, but the envelope gives the calling agent stable places to inspect freshness, confidence, limitations, and source metadata.
