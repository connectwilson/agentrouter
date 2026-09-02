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

### Routing module boundaries

- `src/routing/planner.js` is the canonical pure decision layer. It owns route family, capability, source constraints, authorization requirements, budget gates, confidence, and abstention.
- `src/routing/metrics.js` owns privacy-minimized runtime observations, authenticated labels, and aggregate production metrics. It must not retain raw prompts.
- `src/routing/runtime.js` adapts catalog/account state into canonical plans, enforces preflight handoffs and budget/source blocks, reconciles terminal results, and records the final observation. HTTP handlers call this module instead of rebuilding routing state locally.
- `src/routing/fetch.js` owns multi-requirement fetch orchestration and fallback sequencing; it returns routing payloads without depending on HTTP request or response objects.
- `src/routing/http-handlers.js` executes the structured request/fetch contracts and returns `{ statusCode, payload }`. `src/routing/http-boundary.js` is the single status/payment mapping boundary. `src/server.js` owns transport, authentication, and dependency wiring only.
- `test/support/routing-evaluation.js` is an offline benchmark evaluator. It is test-only and must not be imported by production modules.
- `src/router.js` remains the registered-service execution and quoting layer during the compatibility migration. New semantic routing rules belong in the canonical planner, not in another entrypoint-specific parser.
- HTTP, MCP, CLI, local-wallet, and browser entrypoints may adapt inputs and execute plans, but they must expose the same canonical plan and terminal observation contract.
- `packages/agentrouter-mcp/server/index.js` is the stdio/remote transport coordinator. Local social planning, observation decoration, and feedback summaries live in `packages/agentrouter-mcp/server/local-routing.js`; new local routing rules must not be added back to the transport entrypoint.

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

## Distribution Channels

AgentRouter reaches agent clients through two complementary channels.

**Installer** (`packages/agentrouter-installer`, one command: `npx @agentrouternetwork/agentrouter`). Hand-writes the Skill and an MCP entry into one detected current-user client and verifies the hosted runtime. It knows nine client config formats (standard `mcpServers` JSON, Codex TOML, OpenClaw `mcp.servers`, opencode argv-array + `environment`, WorkBuddy `.mcp.json` dotfile, and more). The Agent Plugins standard leaves distribution and installation out of scope, and most of AgentRouter's current target clients — Claude Code, Claude Desktop, Hermes, opencode, OpenClaw, WorkBuddy, Windsurf, Gemini CLI — are not yet on the launch support list, so the installer remains the primary path for those.

**Agent Plugins package** (`plugin/`). A spec-conformant Agent Plugins 1.0.0 bundle that any conformant client (ChatGPT, Codex, Cursor, GitHub Copilot, VS Code, Kiro) can install as one artifact. Layout per the spec's fixed locations:

```
plugin/
  plugin.json                     # manifest (metadata only; $schema + name required)
  mcp.json                        # MCP server declarations
  skills/agentrouter/SKILL.md     # Agent Skill
```

- `plugin.json` is metadata only — skills and MCP servers are found at the fixed `skills/` and `mcp.json` locations; the schema is `additionalProperties: false` and declares no `skills`/`mcpServers` fields.
- `mcp.json` declares the **stdio** bridge running `@agentrouternetwork/mcp@latest`. Browser execution is capability-negotiated: Codex/Claude native browsers are preferred when they declare `read_post`, `search`, `read_user_posts`, `read_thread`, or `read_trends`. Results return through `agentrouter_complete_handoff`, preserving signed scope, provenance, and feedback without exposing browser state. OpenCLI is retained only as a portable fallback for older clients that do not expose the required native operation. A remote-only `streamable-http` client can use native-browser handoffs but cannot execute the OpenCLI fallback.
- `plugin/skills/agentrouter/SKILL.md` is synced from the hosted skill (`GET /SKILL.md`); `scripts/sync-plugin-skill.js` (`npm run plugin:skill:sync`) refreshes it, and `test/agent-plugin.test.js` fails on drift.

Keeping the two channels in sync is deliberate: the installer serves clients without plugin support; the plugin serves conformant clients. They should not diverge in the Skill or bridge package they install.

A separate remote-only plugin variant is **not** shipped today. In sandboxes or serverless environments that cannot spawn local processes, the `mcp.json` stdio server can be swapped in place to `streamable-http → https://agentrouter.network/mcp` (see `plugin/README.md` → "Deprovision / downgrade to remote-only"). That one-line swap is the supported path until a concrete client needs its own remote variant; it intentionally trades away the free local-browser reads for portability.
