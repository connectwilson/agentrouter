# Status

Last updated: 2026-07-31

## Current MVP

- Fixed the MCP stdio bridges so clients actually connect. All three bridges (`@agentrouternetwork/mcp`, the legacy `bin/agent-router-mcp.js`, and the mcpb desktop extension) were replying with LSP-style `Content-Length` framing, which MCP clients cannot parse — `initialize` never completed and the server hung in "connecting" forever. They now reply with newline-delimited JSON per the MCP stdio transport (input stays liberal). The npm bridge startup moved into an exported `start()` so importing it in tests cannot hijack stdin/exit, with a framing regression test. Published `@agentrouternetwork/mcp@0.5.1`. Existing users do not need a manual version bump: `@latest`-configured clients resolve 0.5.1 on the next client restart, and local-bridge configs already use the fixed file — only users still on the deprecated github bridge must re-run the installer once. The installer (`@agentrouternetwork/agentrouter@0.4.0`) also best-effort installs the `@jackwener/opencli` browser connector for free local X/social reads and always returns the extension/sign-in next steps.
- Added a durable `public-apis/public-apis` conversion pipeline and public `/public-apis` inventory backed by `/api/public-apis`. Every catalog row receives an explicit state, progress survives PostgreSQL-backed restarts, removed upstream rows remain auditable, and bounded conversion batches discover and live-test every read-only endpoint before marking an API usable. The pipeline now serializes local checkpoints, prioritizes untouched work over ordinary retries, prioritizes explicit operator retries, accepts direct JSON catalog URLs, scans ordinary documentation homepages in catalog mode, enforces per-request timeouts, and supports an explicit synthetic-DNS compatibility mode without allowing real private targets. Bulk sync/conversion requires `ADN_ADMIN_API_TOKEN`; automated fetches reject private/local/reserved targets and unsafe redirects. The current resumable local audit has tested 116 of 1,611 entries: 3 usable, 11 credential-required, 98 retryable failures, 4 manual review, 1,374 queued, and 121 HTTP-only blocked.
- X local reads now use a no-password browser-connector policy. OpenCLI is the only default adapter for single-post reads and creator research; the legacy Twitter CLI is explicit opt-in. The public MCP bridge discovers OpenCLI in user-level npm/local bin directories, reads a status with OpenCLI's supported `twitter thread <url> --limit 1` command, keeps secrets out of child-process environments, and returns `browser_connector_offline` with a browser-extension reconnect action instead of prompting for Keychain access or cookie values.
- The public setup path is now one short agent-native command: `npx @agentrouternetwork/agentrouter`. Installer v0.3.0 installs the Skill, prioritizes the invoking client, migrates an existing stale AgentRouter entry when needed, changes exactly one configuration, preserves unrelated servers and AgentRouter environment settings, verifies the hosted MCP tool list, and explicitly requires one client reload before claiming the local bridge is ready. `--client` handles environments that cannot expose their host identity; `--http-only` is the non-mutating alternative.
- Replaced the private-GitHub client dependency with a repository-independent update channel. `GET /agent-router/update-manifest.json` declares the stable public MCP package, Skill URL, Remote MCP URL, and updater URL; `GET /update.sh` migrates existing Claude Desktop/Cursor entries while preserving API keys, custom environment values, unrelated MCP servers, config backups, and local wallet files.
- `@agentrouternetwork/mcp` v0.5.0 is the thin hosted/local bridge release containing the corrected OpenCLI X reader. Hosted tool definitions still come from `/mcp`, while local connector implementation changes require a bridge package release; configurations use `@latest`, so reconnecting the client resolves the new bridge.
- The private source repository is no longer referenced by public install, update, MCP config, package metadata, or user-facing Skill instructions. The public npm bridge, installer, hosted Skill, and update manifest are repository-independent.
- Expanded `external_api_query` into a read-only high-frequency provider layer. Public providers now include GitHub, GDELT, SEC EDGAR, and Open-Meteo; user-connected providers now include YouTube Data API, VirusTotal, Google Places, Amadeus, EasyPost, and OpenAlex. Public sources can run without login, while credential-backed sources remain owner-scoped and never expose credentials in results.
- Remote MCP `agentrouter_request` now dispatches built-in external API and social-user-voice capabilities consistently with the HTTP request endpoint. A valid AgentRouter credit API key resolves its owning user for private Provider connections; anonymous MCP calls remain limited to public/local sources. Provider-specific validation, unsupported operations, and zero-result responses now return machine-readable diagnostics.
- Provider Studio now accepts `public-apis/public-apis` as an API discovery source. Catalog entries retain category/auth/HTTPS/CORS/documentation provenance, remain non-publishable candidates, and must continue through official-doc endpoint discovery plus live validation before entering the AgentRouter registry.
- Added `social_user_voice_research` as a first-class AgentRouter capability for X, Reddit, Xiaohongshu, Bilibili, YouTube, and Facebook. It uses read-only local/browser connectors or user-owned official API connections, preserves source URLs and provenance, and keeps local credentials and raw browser results on the user's device by default.
- Complaint research now retries an entity-only query when a strict complaint query has no relevant rows, then applies the same negative-experience relevance filter to the broader result set.
- Creator Research now exposes sign-out controls for local sessions. YouTube execution plans match the runtime's OpenCLI-first/yt-dlp-fallback order.
- Bilibili OpenCLI now has a 90-second browser-search timeout instead of the generic 20-second process timeout. A live KIMI K3 probe has returned real videos, but Bilibili's page-context request can still intermittently return `TypeError: Failed to fetch`; attempts are retained as provider diagnostics and `bili-cli` remains the preferred optional backend when installed.
- Existing local users now have an explicit `agentrouter update` / `agentrouter upgrade` path. It refreshes installed Skill files and existing MCP package commands without recreating wallets, adding unused client configs, or overwriting API keys, custom AgentRouter environment values, unrelated MCP servers, and timestamped config backups.
- Added a centralized prepaid credits backend for broader adoption beyond Arc Testnet. OAuth users can top up through Stripe Hosted Checkout, create client API keys, inspect balances and ledger activity, and pay for MCP/HTTP service calls from one persistent balance.
- Credit keys are stored as SHA-256 hashes, Stripe webhooks are signature-verified and idempotent, debits are atomic, insufficient balances are rejected without charge, and failed provider delivery creates an automatic refund event.

- Provider Studio supports manual service creation and OpenAPI import.
- OpenAPI import can discover multiple endpoints, preview generated cards, select many drafts, and publish them.
- Registered services expose manifests, preview data, paid invocation, and feedback events.
- AgentRouter can search registered services, select a likely service, construct simple input, invoke through the connector, and summarize the result.
- AgentRouter is available as:
  - CLI: `node bin/agent-router.js ask "<task>"`
  - HTTP: `POST /agent-router/ask`
- AgentRouter currently recognizes address lookup, BTC/perp liquidation max-pain, generic netflow, Nansen-style smart-money netflow, and smart-money holdings intents.
- Local provider configs using `/provider/custom/...` are rebound to the current server port at startup, so old generated JSON does not pin the app to a stale local port.
- Wallet/payment defaults to dev-mode x402-style proof. `circle_arc` mode now supports local-wallet Arc Testnet USDC transfers to provider payout wallets with provider-side tx verification.
- Agora hackathon positioning is captured in `docs/PRD_AGORA_HACKATHON.md`: AgentRouter Markets, a paid market-intelligence routing layer for trading agents.
- The PRD now treats `agentrouter_fetch` / `/agent-router/request` as the agent-facing execution path: main agents can pass either a natural-language task or structured data requirements, while discovery, routing, payment, invocation, verification, evidence, and feedback stay internal to AgentRouter.
- Implemented `GET /capabilities` for a machine-readable capability catalog.
- Implemented `POST /agent-router/request` for deterministic structured routing.
- Implemented `/agent-router/demo` as the demand-side hackathon console.
- Paid invocation feedback now includes an `agent_router_settlement_receipt_v1` settlement receipt with USDC amount, mode, network, payee, and tx hash.
- Local `circle_arc` calls now include Arc Testnet chain metadata, direct-provider-wallet settlement model, payment event hash, and feedback hash.
- Search results now expose `trust_score`; structured routing returns provider selection reasons.
- Verified the full provider-to-demand flow: Provider Studio OpenAPI import publishes `get_liquidation_max_pain`; AgentRouter `/ask` compiles natural language into a structured `perp_liquidation_max_pain` request, selects the uploaded service, pays, validates, and returns data.
- OpenAPI capability inference now enriches imported liquidation services with the standard `perp_liquidation`, `liquidation_heatmap`, and `perp_liquidation_max_pain` capabilities.
- Deployed AgentRouter Markets to Render at `https://agentrouter.network`.
- Claude/Codex Skill and MCP defaults now point to the Render endpoint instead of the temporary Cloudflare/Railway endpoints.
- Added payment backend abstraction: `dev`, `x402`, `omniagentpay`, and `circle_arc`.
- Added `POST /agent-router/quote` so agents can inspect selected service, input, price, and guard result before paying.
- Product positioning updated: AgentRouter is not a payment SDK; OmniAgentPay/Circle/x402 can be payment execution backends.
- Added `bin/agent-router-mcp.js`, a zero-dependency MCP stdio server for Claude/Desktop-style clients. This is now the preferred Claude integration because hosted Claude may block outbound access to `trycloudflare.com` and `railway.app`.
- Updated the AgentRouter skill into a GitHub-distributable bootstrap skill: it checks for existing AgentRouter MCP tools, chooses the best client-specific install path, and falls back to HTTP only when appropriate.
- Tightened protocol boundaries: MCP `agentrouter_fetch` is the preferred one-call user-facing path; `agentrouter_request`, `agentrouter_quote`, and `agentrouter_capabilities` are advanced/debug integration tools.
- Structured requests now return `agent_router_evidence_v1`, including `manifest_hash`, `config_hash`, `input_hash`, `output_hash`, `payment_tx`, `verification_report`, `trace_hash`, and Arc anchor metadata.
- Added `GET /agent-router/evidence` and `GET /agent-router/trust` so the MVP shows where offchain trust state lives and what can later be anchored on Arc.
- Added lightweight `agent_router_route_observation_v1` records and `GET /agent-router/observations` so structured routing accumulates candidate, score, selection, verification, and feedback data for future learned routing without adding a heavy training system.
- Added Claude Desktop Extension package source in `mcpb/agentrouter` and generated `/Users/huazhenghao/Downloads/Arc/agentrouter.mcpb` for no-command local installation.
- `mcpb validate mcpb/agentrouter` passes and `mcpb pack mcpb/agentrouter` succeeds.
- Added publish-ready npm/npx MCP package source in `packages/agentrouter-mcp` with target package name `@agentrouternetwork/mcp`.
- Added `npm run mcp:npm:check` and `npm run mcp:npm:pack` to validate the npm package before publication.
- Provider Studio now treats validation as a registration gate: services are only published when the endpoint can be invoked and returns a valid AgentRouter envelope. Failed API calls are reported with validation details and are not persisted into the registry.
- Imported provider manifests now include inferred input schemas and an `agent_data_service_contract_v1` block with example questions, shape summaries, and quality expectations.
- Data quality verification now records deterministic checks for schema, envelope, freshness, coverage, empty result, confidence, data shape, and an overall quality score. Trust snapshots include freshness, coverage, and agent-friendliness signals.
- Route failures now return `failure_explanation` so clients can distinguish "no service found" from "service found and invoked, but upstream rejected the request."
- Added service provenance, health, badges, recent failure rate, and quality-event feeds to the registry view. Agents can now inspect `GET /agent-router/services`, `GET /agent-router/service?service_id=...`, and `GET /agent-router/quality?service_id=...`.
- Paid service calls now create `agent_service_quality_event_v1` records with deterministic verification, HTTP status, business-error detection, blocking issues, and a post-call feedback expectation for the caller agent.
- Local-wallet paid calls now report completed invocations back to the registry through `POST /agent-router/calls/complete`, where the server verifies the Arc USDC payment tx, records an evidence trace keyed by `request_id`, attaches deterministic verification, and returns a consumer-feedback request for the main agent.
- `GET /agent-router/evidence` and `GET /agent-router/feedback` can now filter by `request_id`, and `POST /agent-router/feedback` can accept a unique `request_id` without exposing service IDs to the user-visible agent response.
- The MCP server now exposes `agentrouter_feedback`, so the main agent can submit intent fit, answer usefulness, missing fields, and confidence after it decides whether the paid result answered the user.
- Evidence and consumer feedback now support Arc Testnet hash anchoring. Full evidence stays offchain; `trace_hash`, `result_hash`, `verification_hash`, payment tx hash, and feedback hash are anchored through `contracts/AgentRouterEvidenceAnchor.sol` when `ADN_ARC_ANCHOR_CONTRACT` and `ADN_ARC_ANCHOR_PRIVATE_KEY` are configured. Local tests use `ADN_ARC_ANCHOR_MODE=mock`.
- Consumer feedback is always recorded offchain and uses ERC-8004 as its single public onchain record. On BNB Chain, the local consumer/reviewer wallet signs a zero-gas-price `giveFeedback` transaction and the server-side BNB EOA Paymaster proxy sponsors and submits it. A declined sponsorship never falls back to spending consumer BNB. The old custom consumer-feedback anchor is no longer written; evidence anchoring remains separate.
- Published services can expose ERC-8004 Agent Registration Files at `/.well-known/erc8004/agents/:service_id.json` and register an ERC-8004 Identity Registry token through `POST /services/:service_id/erc8004/register`. The returned `agent_id` is written back into the manifest and becomes the target for later Reputation Registry feedback.
- Published services now include `manifest_type: hosted_http_data_api`, `version`, structured routing metadata, `manifest_hash`, `config_hash`, optional `/.well-known/agentrouter.json` origin-binding metadata, and ERC-8257-compatible tool manifest metadata at `/.well-known/erc8257/tools/:service_id.json`.
- Router scoring now considers consumer feedback, recent failure rate, service health, and source provenance instead of ranking only by capability/text match and price.
- Added `POST /agent-router/health-check` for registry-driven live health checks; service details expose recent validation, health, quality, and feedback events.
- Deployed a real AgentRouter evidence anchor contract on Arc Testnet and verified a live paid data request end-to-end:
  - Local demand wallet paid Arc Testnet USDC to the provider payout wallet.
  - Server verified the payment tx before returning data.
  - Server anchored the evidence trace on Arc Testnet (the historical run also used the now-retired custom feedback anchor).
  - Consumer wallet submitted ERC-8004 Reputation feedback for the provider agent.
  - New runs keep feedback offchain plus one ERC-8004 reputation transaction; evidence anchoring remains independent.

## Known Useful Local Flow

```bash
PORT=8800 npm start
curl -fsSL -X POST http://127.0.0.1:8800/agent-router/ask \
  -H "content-type: application/json" \
  -d '{"task":"BTC当前最大爆仓痛点是多少","max_price":"0.05"}'
```

For any MCP-capable AI agent client, add the AgentRouter MCP server:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
      "env": {
        "AGENT_ROUTER_URL": "https://agentrouter.network"
      }
    }
  }
}
```

Temporary tunnels and some hosted domains may be blocked by Claude's remote network policy.

The Matrixport address demo depends on the upstream Lookonchain-style API at `127.0.0.1:3456`. If that upstream is not running, the service can remain registered but fail validation/invocation.

## Next Decisions

- Keep heuristic natural-language handling only as `/agent-router/ask` demo/fallback logic.
- Use route observations as the first lightweight dataset for improving provider ranking before considering graph models or learned rankers.
- Productize the Arc operator key path so server deployments use secure secret storage instead of manual shell env injection.
- Deploy the updated consumer-wallet ERC-8004 feedback flow to the hosted Render service.
- Decide whether to keep `dev` payment mode available only for tests, and keep public hosted endpoints on real payment enforcement.
- Add a one-command provider onboarding path after the GUI stabilizes.
- For the hackathon build, polish the demo around the verified path: provider identity, x402-style Arc payment, evidence anchor, ERC-8004 feedback, and trust score update.
