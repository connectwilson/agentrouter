# Agent Native Data Network MVP

Local MVP for an Agent-native paid data service network.

It demonstrates:

- Discovery Connector bootstrap entry for Codex / Claude / Cursor-style agents
- Service Registry
- Provider service manifest
- Sample response preview
- Provider onboarding validation
- Hosted HTTP Provider Runtime with private Provider Secret
- Optional Postgres-backed persistent registry and encrypted provider secret vault
- x402-style HTTP 402 payment challenge and retry flow
- Local Alice Agent Wallet with budget policy
- Agent-friendly `agent_data_envelope_v1` response
- ERC-8004-compatible identity metadata fields
- Feedback event generation after paid invocation

## Run Tests

```bash
npm test
```

The test suite starts local HTTP servers, uses temporary runtime directories for wallet/provider state, validates services, performs discovery, previews sample responses, completes paid invocations, checks feedback, and verifies provider configs can be reloaded after restart.

## Project Structure

```text
bin/adn.js                 CLI entrypoint
src/server.js              HTTP routing shell and bootstrap
src/registry.js            service registry, search, validation, invocation
src/provider-runtime.js    built-in and configurable provider endpoints
src/provider-config.js     provider config generation/loading
src/openapi-import.js      OpenAPI/Swagger discovery and batch service drafts
src/studio.js              Provider Studio GUI and form handler
src/router.js              task intent normalization and service routing
src/verifier.js            post-call result verification
src/wallet.js              local Alice Agent Wallet and policy
src/payment.js             dev x402-compatible payment proof
src/local-invoke.js        CLI paid invocation through local wallet
src/local-route.js         CLI route flow through local wallet
src/id-utils.js            ID and capability suggestion helpers
src/schema.js              JSON schema and envelope validation
src/http-utils.js          shared HTTP helpers
bin/agent-router-mcp.js    MCP stdio server for Claude/Desktop-style clients
test/mvp.test.js           end-to-end MVP coverage
```

## Run Demo

```bash
npm run demo
```

Expected flow:

```text
Discovery Connector -> Registry search -> Manifest -> Preview -> 402 challenge -> dev x402 payment proof -> paid result -> feedback event -> final analysis
```

## Start Server

```bash
npm start
```

The server binds to `127.0.0.1:8787` by default and seeds the demo service.

Open the Provider Studio GUI:

```text
http://127.0.0.1:8787/studio
```

### Public API catalog discovery

Provider Studio accepts `https://github.com/public-apis/public-apis` as a discovery source. Its README entries are imported as non-executable `catalog_candidate` cards with category, authentication, HTTPS, CORS, documentation URL, and source provenance.

Catalog candidates are deliberately not selectable for publishing. Choose **Inspect API docs** on a candidate to run its official documentation through the existing OpenAPI/API-doc discovery flow. Only a concrete HTTP endpoint that passes AgentRouter's live validation can become registered and routable; appearing in the public catalog is never treated as provider verification or permission to resell an API.

### Read-only external providers

`external_api_query` routes a common request envelope to public or user-connected data providers. GitHub, GDELT, SEC EDGAR, and Open-Meteo are public sources and do not require an AgentRouter account connection. YouTube Data API, VirusTotal, Google Places, Amadeus, EasyPost, and OpenAlex use owner-scoped credentials configured from the connection manager. Existing Brave, Tavily, Serper, Exa, Firecrawl, and Jina connectors remain available.

All of these connectors are read-only from AgentRouter's perspective. Responses are normalized into source-linked items with timestamps and provider-specific metadata; credentials remain server-side and are never included in the result.

The same capability works through HTTP and remote MCP `agentrouter_request`. For credential-backed sources, the MCP client must send the AgentRouter API key created by the same user who connected the Provider. Public sources remain callable without a user connection. Empty results return `no_results` with diagnostics instead of being presented as a successful evidence hit.

## Multi-user social research

Creator Research is available at `http://127.0.0.1:8787/research`. Signed-in users can connect their own X Bearer Token, Reddit OAuth Access Token, or a device-local browser session. Connections are owner-scoped; API responses never return credentials.

Hosted deployments that store credentials must configure:

```text
DATABASE_URL=postgres://...
ADN_PROVIDER_SECRET_PASSPHRASE=<random platform encryption secret>
```

Use HTTPS in production. For local-browser research, use a dedicated Chrome profile without email, financial, exchange, or wallet accounts. Detailed requirements and security boundaries are in [`docs/PRD_MULTI_USER_SOCIAL_RESEARCH.md`](docs/PRD_MULTI_USER_SOCIAL_RESEARCH.md).

## Persistent Registry

By default, the MVP uses in-memory registry state plus local provider files. That is fine for local development, but hosted instances can restart and lose runtime files.

For production-style deployments, set:

```text
DATABASE_URL=postgres://...
ADN_PROVIDER_SECRET_PASSPHRASE=<stable-32+-char-secret>
```

When `DATABASE_URL` is present, Provider Studio writes provider configs to Postgres and stores provider credentials as encrypted secret records. On every restart, AgentRouter reloads registered providers from the database, so a provider only needs to publish once.

`ADN_PROVIDER_SECRET_PASSPHRASE` is a platform encryption key, not a provider API key. It must stay stable across deploys. Rotating it without re-encrypting secrets will make existing provider credentials unreadable.

Do not add provider-owned API keys such as BlockBeats, Nansen, or other upstream keys to hosted deployment environment variables as the normal onboarding path. Providers enter their credentials in Provider Studio; the platform stores encrypted secret records in the persistent registry. Hosted deployments that require persistence, such as Render, reject Provider Studio publish requests unless `DATABASE_URL` and a stable `ADN_PROVIDER_SECRET_PASSPHRASE` are configured.

Environment-variable provider bootstrap is disabled by default and exists only for temporary local tests:

```text
ADN_ENABLE_ENV_PROVIDER_BOOTSTRAP=true
```

## CLI Connector

With the server running:

```bash
node bin/adn.js wallet init
node bin/adn.js search "Base 7d fund flow"
node bin/adn.js manifest chain_fund_flow_7d_base
node bin/adn.js preview chain_fund_flow_7d_base
node bin/adn.js invoke chain_fund_flow_7d_base '{"chain":"base","days":7}'
node bin/adn.js route "What is BTC liquidation max pain right now?" --max-price 0.05 --freshness 300
node bin/adn.js feedback chain_fund_flow_7d_base
```

Set a custom registry URL:

```bash
ADN_REGISTRY_URL=http://127.0.0.1:8787 node bin/adn.js search "Base 7d fund flow"
```

## Agent Router

The router is the MVP version of the Agent capability routing layer. The formal protocol is structured: the main agent parses the user's request, asks `/capabilities` for supported schemas when needed, then sends a capability request to `/agent-router/request`. AgentRouter validates the schema, selects a matching service, quotes the payment, performs a paid invocation, verifies the result, and returns an evidence envelope.

`/agent-router/ask` remains a demo fallback for natural-language testing. It is not the core protocol and should not be treated as the semantic parser in production.

Example:

```bash
ADN_REGISTRY_URL=http://127.0.0.1:8787 \
node bin/adn.js route "What is BTC liquidation max pain right now?" --max-price 0.05 --freshness 300
```

For this ambiguous crypto query, the router returns `route_with_assumption` and explicitly states that it interpreted "liquidation max pain" as perpetual futures liquidation max-pain, not options max pain. If the task only says "What is BTC max pain?", the router returns `needs_clarification` instead of guessing.

Router response fields include:

- `protocol`
- `request`
- `normalized_intent`
- `intent_confidence`
- `assumptions`
- `ambiguities`
- `selected_service`
- `candidates_considered`
- `verification`
- `evidence`
- `result`

Structured request example:

```bash
curl -fsSL -X POST http://127.0.0.1:8787/agent-router/request \
  -H "content-type: application/json" \
  -d '{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05","freshness_seconds":300}}'
```

The returned `evidence` object includes `trace_hash`, `result_hash`, `verification_hash`, payment receipt metadata, and an Arc hash anchor. Full evidence remains offchain; Arc stores the integrity/timestamp trail through `contracts/AgentRouterEvidenceAnchor.sol` when `ADN_ARC_ANCHOR_CONTRACT` and `ADN_ARC_ANCHOR_PRIVATE_KEY` are configured.

## Alice Wallet

The MVP supports scheme A from the product discussion: Alice gets a local Agent Wallet controlled by the CLI.

Initialize it once:

```bash
export ADN_WALLET_PASSPHRASE="choose-a-local-demo-passphrase"
node bin/adn.js wallet init
node bin/adn.js wallet address
node bin/adn.js wallet status
```

Set local spend limits:

```bash
node bin/adn.js wallet policy set --per-call 0.05 --daily 2
```

View local payment history:

```bash
node bin/adn.js wallet log
node bin/adn.js payment plan
```

When Claude / Codex calls `adn invoke`, the CLI:

1. Fetches the service manifest
2. Requests the provider endpoint
3. Receives HTTP 402 payment requirements
4. Checks Alice's local policy
5. Signs a dev x402 payment proof, or sends an Arc Testnet USDC transfer in `circle_arc` mode
6. Retries the provider request
7. Records the payment in `.adn/payments.log`

No manual signature is required for payments inside policy limits. Payments above policy limits are rejected instead of prompting, which keeps CLI use safe inside Agent workflows.

### Wallet Safety Guardrails

The MVP treats Alice's wallet as a local Agent hot wallet with policy checks. The AI never chooses `pay_to` or `amount`; `adn invoke` derives those from the service manifest and the provider's HTTP 402 challenge.

Implemented guardrails:

- `.adn/` is gitignored
- wallet private key is encrypted at rest with `ADN_WALLET_PASSPHRASE`
- payments require a complete HTTP 402 challenge
- payment proof binds `service_id`, `amount`, `network`, `asset`, `pay_to`, `nonce`, expiry, resource hash, and Arc tx hash when using Arc settlement
- `circle_arc` mode verifies the Arc ERC-20 USDC transfer before returning provider data
- provider rejects replayed challenge nonces
- wallet policy enforces per-call and daily limits
- wallet policy can restrict services, providers, and payment targets
- `adn wallet lock` disables automatic signing
- wallet payment log records challenge nonce and payment target

### Arc Evidence and ERC-8004 Trust

After a paid call, AgentRouter records:

- evidence trace hash, result hash, verification hash, and payment tx hash
- deterministic verification metadata
- consumer-agent feedback
- ERC-8004 Reputation Registry feedback when configured

The custom evidence anchor keeps the paid-call trace auditable without putting raw API data onchain. Consumer feedback uses ERC-8004 as its one public onchain record; AgentRouter does not also create a custom feedback-anchor transaction.

Feedback uses a persistent, idempotent event lifecycle. Registered, external-API, and local-browser calls share the same consumer-feedback contract; local calls require a server-issued one-time grant. Trust anchors report `offchain_recorded`, `onchain_pending`, `onchain_submitted`, or `onchain_failed`, and registry stats expose feedback completion plus each onchain state. Trust scoring also reports sample confidence and shrinks small samples toward the verified-service prior before using them for routing.

Each published service can expose an ERC-8004 Agent Registration File and register an onchain identity:

```bash
curl -fsSL -X POST http://127.0.0.1:8800/services/chain_fund_flow_7d_base/erc8004/register \
  -H "content-type: application/json" \
  -d '{}'
```

Agent metadata is served at:

```text
/.well-known/erc8004/agents/:service_id.json
```

Useful server config:

```bash
ADN_ARC_ANCHOR_CONTRACT=0x...
ADN_ARC_ANCHOR_PRIVATE_KEY=0x...
ADN_SETTLEMENT_CHAIN=bsc
ADN_BSC_PAYMASTER_URL=https://your-bnb-eoa-paymaster-rpc
ADN_ERC8004_OWNER_PRIVATE_KEY=0x...
ADN_ERC8004_AGENT_ID=1001
ADN_ERC8004_METADATA_BASE_URL=https://agentrouter.network
ADN_ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
ADN_ERC8004_REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
```

Useful commands:

```bash
node bin/adn.js wallet lock
node bin/adn.js wallet unlock
node bin/adn.js wallet policy set --service-allowlist chain_fund_flow_7d_base
node bin/adn.js wallet policy set --provider-allowlist provider_bob
node bin/adn.js wallet policy set --pay-to-allowlist 0xProviderDemoWallet000000000000000000000000
```

Still TODO for production hardening:

- OS keychain integration
- separate signer daemon
- session wallet / spending-cap smart account
- escrow/claim contract for batching, refunds, platform fees, and dispute windows

## Payment Modes

For general users, AgentRouter can run a prepaid platform balance backed by PostgreSQL and Stripe Hosted Checkout:

```bash
ADN_PAYMENT_BACKEND=credits
DATABASE_URL=postgresql://...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Configure Stripe to send `checkout.session.completed` events to:

```text
https://your-agentrouter-host/webhooks/stripe/credits
```

After OAuth login, `/account` lets a user purchase credits and create a client API key. Raw client keys are shown once and only their SHA-256 hashes are stored. Each provider invocation atomically debits the persistent append-only ledger; invalid requests are rejected before charging, and failed provider delivery is automatically refunded. `ADN_CREDITS_ALLOW_MANUAL_TOPUP=true` is only for local tests and must not be enabled on a public deployment.

For localhost-only account testing without GitHub OAuth, set `ADN_AUTH_ALLOW_DEV_LOGIN=true`. The development login is rejected in production, for non-local hostnames, and for non-loopback clients.

The MVP defaults to:

```bash
ADN_PAYMENT_BACKEND=dev
```

To demo real Arc settlement from Alice's local wallet to the provider payout wallet:

```bash
ADN_PAYMENT_BACKEND=circle_arc
ADN_ARC_RPC_URL=https://rpc.testnet.arc.network
ADN_PROVIDER_RECEIVE_ADDRESS=0xProviderPayoutWallet
```

Provider Studio also has an optional `Arc payout wallet` field. In `circle_arc` mode the provider endpoint returns an x402-style HTTP 402 challenge, Alice's local MCP/CLI wallet sends an Arc Testnet USDC transfer to that payout address, and the provider verifies the transaction hash before returning data.

In dev mode, the provider still returns an x402-style HTTP 402 challenge, but the CLI signs a local development payment proof instead of settling real USDC.

AgentRouter treats payment as an adapter boundary. It is not intended to compete with full payment SDKs such as OmniAgentPay; those can become execution backends while AgentRouter remains responsible for capability discovery, provider selection, result verification, and trust feedback.

Supported backend names:

```bash
ADN_PAYMENT_BACKEND=credits
ADN_PAYMENT_BACKEND=dev
ADN_PAYMENT_BACKEND=x402
ADN_PAYMENT_BACKEND=omniagentpay
ADN_PAYMENT_BACKEND=circle_arc
```

Quote a route before paying:

```bash
node bin/agent-router.js quote '{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}'
```

## Login / OAuth

The website header includes a `Login` entry. This MVP supports GitHub OAuth when the matching environment variables are present:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Register these callback URLs with GitHub:

```text
http://127.0.0.1:8800/auth/github/callback
https://agentrouter.network/auth/github/callback
```

OAuth is for user identity only. Provider-owned API credentials still belong in Provider Studio/provider secret storage, not OAuth environment variables.

## Skill Install

The default installation path is agent-native. Give this one line to the AI agent that should use AgentRouter:

```text
Set up https://agentrouter.network/SKILL.md
```

That request authorizes the agent to add only AgentRouter to its current client. The Skill tells it to prefer the hosted Remote MCP, preserve unrelated configuration, avoid wallet/payment setup, and verify `initialize` plus `tools/list`. If the client cannot hot-reload MCP configuration, reload it once after setup.

Create an AgentRouter API key from `/account` only when paid hosted calls are needed. The key stays in the local MCP configuration and the bridge forwards it only to the configured AgentRouter origin.

### Update an existing installation

Existing users can refresh the installed Skill and local MCP bridge with one command:

```bash
curl -fsSL https://agentrouter.network/update.sh | bash
```

The updater only changes AgentRouter entries that are already installed. It preserves existing wallet files, `AGENT_ROUTER_API_KEY`, custom AgentRouter environment settings, unrelated MCP servers, and timestamped backups of changed client config files. Restart or reload the updated AI client afterward. See [docs/UPGRADING.md](docs/UPGRADING.md) for rollback and pinned-package guidance.

Manual compatibility fallback:

```bash
curl -fsSL https://agentrouter.network/install.sh | bash
```

This fallback installs the Skill only by default. Set exactly one explicit client flag when a desktop config must also be written:

```bash
curl -fsSL https://agentrouter.network/install.sh | AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP=1 bash
```

## Remote MCP Connector

For Claude web, Claude Managed Agents, and any product that supports URL-based Remote MCP, add this connector URL:

```text
https://agentrouter.network/mcp
```

Claude custom connectors can connect to any third-party remote MCP server URL. Managed Agents declare URL MCP servers in `mcp_servers` and require servers to support the streamable HTTP transport.

## Universal MCP Integration

The runtime integration is a thin universal MCP bridge. It forwards JSON-RPC to the configured AgentRouter Remote MCP, so server-side tools and capability schemas update without republishing the client package.

Run the MCP server with npx:

```bash
npx -y --package @agentrouternetwork/mcp@latest agentrouter-mcp
```

Run this MCP command in a terminal or put the command/args into an MCP client config. For Claude Code chat-style installation, use the Skill install command above.

Most AI clients configure MCP like this:

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

For a local AgentRouter server:

```bash
PORT=8800 npm start
```

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800"
      }
    }
  }
}
```

### Optional Claude Desktop Extension

Claude Desktop users can also install the packaged extension:

```text
/Users/huazhenghao/Downloads/Arc/agentrouter.mcpb
```

In Claude Desktop:

```text
Settings -> Extensions -> Install Extension -> choose agentrouter.mcpb
```

When prompted, keep:

```text
AgentRouter URL = https://agentrouter.network
Default Max Price = 0.05
```

Build or rebuild the package:

```bash
npm run mcpb:pack
```

Validate the extension manifest:

```bash
mcpb validate mcpb/agentrouter
```

The MCP server exposes:

- `agentrouter_request`: preferred structured request -> route -> invoke -> verify -> evidence
- `agentrouter_ask`: last-resort natural-language fallback -> route -> invoke -> verify
- `agentrouter_quote`: structured request -> quote and budget guard only
- `agentrouter_capabilities`: capability catalog and schemas

## Universal npm / npx MCP Install

For Cursor, Windsurf, Cline, Continue, VS Code, and other MCP-capable clients, the portable install path is npm/npx.

Package source:

```text
packages/agentrouter-mcp
```

Target package name:

```text
@agentrouternetwork/mcp
```

MCP config:

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

Local development config before publishing:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "node",
      "args": ["/Users/huazhenghao/Downloads/Arc/packages/agentrouter-mcp/bin/agentrouter-mcp.js"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800"
      }
    }
  }
}
```

Validate the npm package:

```bash
npm run mcp:npm:check
npm run mcp:npm:pack
```

## GitHub Skill Bootstrap

The installable skill in `claude-skills/agent-router/SKILL.md` is intentionally written as a universal bootstrap:

1. It first checks whether AgentRouter MCP tools are already available.
2. If not, it detects the current AI client where possible.
3. It picks the best install path for that client: Remote MCP, local MCP bridge, Desktop Extension, or HTTP fallback.
4. Once connected, it uses AgentRouter generically for any registered API/data service.

After publishing the skill folder to GitHub, users can ask their AI client:

```text
Install the AgentRouter Skill from this GitHub link, then use AgentRouter to answer my data request:
<YOUR_GITHUB_SKILL_URL>
```

For best results, the GitHub URL should point directly to the `agent-router` skill folder or a repo whose root contains `SKILL.md`.

Inspect the production migration checklist:

```bash
node bin/adn.js payment plan
```

Production x402 integration should replace:

- buyer-side `createWalletPaymentProof` with an official x402 exact EVM client payment authorization where a facilitator supports the target chain
- seller-side `verifyDevPaymentProof` with facilitator `/verify` and `/settle`
- demo payment requirements with official x402 payment requirements
- local evidence mocks with real `EvidenceAnchored` transactions on the configured settlement chain; consumer feedback is a separate, consumer-signed ERC-8004 transaction and can be gas-sponsored by BNB EOA Paymaster

Relevant runtime configuration:

```bash
ADN_PAYMENT_BACKEND=dev
ADN_PAYMENT_BACKEND=circle_arc
ADN_ARC_RPC_URL=https://rpc.testnet.arc.network
ADN_PROVIDER_RECEIVE_ADDRESS=0x...
ADN_ARC_ANCHOR_CONTRACT=0x...
ADN_ARC_ANCHOR_PRIVATE_KEY=0x...
ADN_X402_FACILITATOR_URL=https://x402.org/facilitator
```

## Provider Onboarding

Start the server first:

```bash
npm start
```

### GUI

Open:

```text
http://127.0.0.1:8787/studio
```

The form supports:

- `static-json`
- `hosted-http`
- OpenAPI / Swagger import

Provider Studio generates service IDs, provider IDs, and default capability tags from the service title, provider name, and agent-facing description. These fields remain editable under advanced settings for stable integrations.

Click **Create, Register, Validate** to generate provider config, register the service, run validation, and get next-step CLI commands.

Use **Fill Hosted Demo** to populate a working hosted HTTP example that calls the local mock upstream endpoint.

Use **Import API Collection** when one provider API has many data endpoints. Paste one API base URL and Studio will try the direct URL plus `/openapi.json`, `/swagger.json`, and `/.well-known/openapi.json`.

The importer generates one service draft per data endpoint, skips operational endpoints such as `/auth`, `/health`, `/metrics`, and `/debug`, then lets Bob review or edit the drafts before publishing. The local demo API is:

```text
http://127.0.0.1:8787/mock/api
```

This creates separate services, such as funding-rate and liquidation max-pain, instead of hiding many endpoints behind one large service.

### CLI

In another terminal, run the guided onboarding flow:

```bash
node bin/adn.js provider onboard
```

Default mode is `static-json`. The CLI asks for:

- title
- provider name
- agent-facing description
- capability tags, suggested automatically from the title and description
- price
- example request JSON
- preview data JSON
- paid result data JSON
- paid response summary

Then it automatically:

1. Generates `providers/<service_id>.json`
2. Builds a service manifest
3. Registers the service with the local Registry
4. Runs Validator against the generated endpoint
5. Returns next-step commands for search, preview, and invoke

For a non-interactive smoke test:

```bash
node bin/adn.js provider onboard --yes
node bin/adn.js search "sentiment demo"
node bin/adn.js preview community_sentiment_demo
node bin/adn.js wallet init
node bin/adn.js invoke community_sentiment_demo '{"asset":"ETH","window":"7d"}'
```

### Hosted HTTP Mode

Hosted HTTP mode lets Bob publish a paid service without running his own public endpoint. The platform-hosted Provider Runtime calls Bob's configured upstream endpoint after payment.

Smoke test:

```bash
node bin/adn.js provider onboard --mode hosted-http --yes
node bin/adn.js search "hosted http sentiment"
node bin/adn.js preview hosted_http_sentiment_demo
node bin/adn.js wallet init
node bin/adn.js invoke hosted_http_sentiment_demo '{"asset":"ETH","window":"7d"}'
```

In hosted HTTP mode, the submitted Provider Secret is moved into the local encrypted Provider Secret store:

```text
.adn/provider-secrets.json
```

It is encrypted with `ADN_PROVIDER_SECRET_PASSPHRASE`, falling back to `ADN_WALLET_PASSPHRASE` for local MVP demos.

When `DATABASE_URL` is enabled, `ADN_PROVIDER_SECRET_PASSPHRASE` is required. Local fallback keys are intentionally not used for persistent hosted credentials because they can disappear across deploys and make stored provider secrets unreadable.

The generated provider config only includes a secret reference:

```json
{
  "source": {
    "type": "hosted_http",
    "auth": {
      "secret_name": "PROVIDER_SECRET",
      "secret_ref": "hosted_http_sentiment_demo:PROVIDER_SECRET"
    }
  }
}
```

That secret is runtime config only. It is not copied into the public manifest:

```json
{
  "runtime_secrets": {
    "required": true,
    "custody": "hosted_runtime_config",
    "public": false
  }
}
```

This keeps the product framing as “publish a paid data capability service” rather than “publish an API key.” The current MVP uses a local encrypted secret store as a stand-in for a production vault.

The current configurable provider runtime supports `static_json` and `hosted_http`. The next source adapters should be `cli_command`, `mcp_tool`, and production vault-backed `hosted_http`.

## Important MVP Note

The default payment implementation is a local development x402-compatible handshake: the Provider returns HTTP 402, the CLI creates a wallet-signed dev payment proof, then retries the request. For Agora/Arc demos, `ADN_PAYMENT_BACKEND=circle_arc` switches local MCP/CLI calls to direct Arc Testnet USDC transfer settlement: Alice pays the provider payout wallet, the provider verifies the tx, and the response includes settlement, payment event, and feedback hashes.
