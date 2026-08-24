# @agentrouternetwork/mcp

Public, zero-configuration MCP bridge for AgentRouter.

The bridge owns its MCP control plane locally: `initialize`, `ping`, and
`tools/list` do not depend on DNS or the hosted service. The same canonical tool
catalog is imported by the hosted server, preventing the local fallback list
from drifting away from production. Data calls are forwarded to
`https://agentrouter.network/mcp`.

For a public X status URL, `agentrouter_fetch` and the structured
`social_post_read` capability execute through a fixed read-only connector on
the user's device. OpenCLI is the default connector: its browser extension reads
the public post inside the already signed-in browser without exporting or
decrypting cookies. Browser login state remains local; credentials, cookies, and
raw connector output are not uploaded to AgentRouter.

Entity-scoped X research supports typed `search` and `read_user_posts`
operations. Use an exact `handle` plus `from`/`to` for account history, or
`entity.required_terms` and `entity.excluded_terms` for discovery. The bridge
filters lookalike entities locally and returns machine-readable route ownership,
so another acquisition skill cannot silently replace AgentRouter without an
explicit handoff.

If the browser bridge is offline, AgentRouter returns
`browser_connector_offline` with a reconnect action. It does not ask for a
system password, Keychain access, or cookie values. The legacy `twitter` CLI is
disabled by default and is attempted only when the MCP process is explicitly
configured with `AGENTROUTER_ALLOW_TWITTER_CLI_FALLBACK=1`.

For paid calls, no API key needs to be copied into the MCP configuration. On the first request that needs account credits, call the bridge's `agentrouter_connect` tool. It returns a short browser approval link; after the user approves, the bridge stores the device credential privately and uses the prepaid balance automatically. The credential is never returned to the AI agent.

`AGENT_ROUTER_API_KEY` remains an advanced override for CI and headless servers that cannot open a browser.

The bridge applies bounded remote timeouts and retries only failures that are
known to be safe before a request is processed. It automatically fails over
from the canonical domain to the Singapore Render origin when DNS, Fake-IP,
TUN, or connect failures occur. A paid-capable MCP tool call is never replayed
after an ambiguous failure unless AgentRouter explicitly returns
`x-agentrouter-retry-safe: true`. Circuit state is isolated per origin: the
healthy origin stays in the hot path during cooldown, then the primary is
probed again automatically. Exhaustion returns a structured
`temporarily_unavailable` result with attempted-origin diagnostics so the AI
client does not wait repeatedly or silently switch to an untracked data source.

The defaults work for normal clients. Operators can tune them with
`AGENT_ROUTER_REMOTE_ATTEMPTS` (default `3`),
`AGENT_ROUTER_REMOTE_RETRY_MS` (default `250`),
`AGENT_ROUTER_REMOTE_TIMEOUT_MS` (default `15000`), and
`AGENT_ROUTER_REMOTE_COOLDOWN_MS` (default `30000`). Remote tool discovery has
its own short `AGENT_ROUTER_DISCOVERY_TIMEOUT_MS` (default `1500`), then falls
back to the bundled stable catalog instead of blocking client startup. The optional
`AGENT_ROUTER_FALLBACK_URLS` accepts a comma-separated list of trusted origins;
the production bridge already includes
`https://agentrouter-markets-sg.onrender.com`. Values are bounded by the
bridge to prevent accidental retry storms or unbounded hangs.

## Usage

Run with npx:

```bash
npx -y --package @agentrouternetwork/mcp@latest agentrouter-mcp
```

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

## Updates

Capability schemas returned by `agentrouter_capabilities` update server-side.
Stable MCP tool envelopes ship with the bridge; restart or reconnect the AI
client after a bridge release if it caches the MCP tool list.

To refresh the Skill and migrate an older GitHub-based MCP config:

```bash
curl -fsSL https://agentrouter.network/update.sh | bash
```

The updater preserves optional developer API keys, device credentials, custom environment settings, unrelated MCP servers, and existing wallet files.

## Protocol Boundary

The main agent should parse user language into a structured capability request whenever possible. AgentRouter handles routing, quote, provider invocation, verification, payment metadata, and evidence. If a quote returns `auto_invoke_allowed: true`, the agent should invoke without asking the user again because the call is within the configured max-price policy. After a successful call, the main agent should submit `agentrouter_feedback` automatically. If it quotes but does not invoke, it should submit `agentrouter_quote_feedback`.

On BNB Chain, `agentrouter_feedback` also completes the ERC-8004 reputation write automatically when the AgentRouter server has `ADN_BSC_PAYMASTER_URL` configured. The bridge creates or reuses an encrypted local reviewer wallet, signs a zero-gas-price `giveFeedback` transaction, and sends it through AgentRouter's authenticated BNB EOA Paymaster proxy. If sponsorship is unavailable, the feedback remains offchain and the bridge never spends the user's BNB as a fallback.

Local connector results are registered with the server before they are returned. The bridge keeps the server-issued one-time feedback grant and supplies it automatically when `agentrouter_feedback` is called; callers must reuse the returned `request_id` instead of fabricating one. Feedback is idempotent per invocation: an identical retry is acknowledged, while conflicting feedback is rejected. The returned trust anchor exposes one explicit lifecycle state: `offchain_recorded`, `onchain_pending`, `onchain_submitted`, or `onchain_failed`.
