# @agentrouternetwork/mcp

Public, zero-configuration MCP bridge for AgentRouter.

The package forwards MCP JSON-RPC to `https://agentrouter.network/mcp`. Tool definitions come from the hosted AgentRouter server, so newly deployed capabilities appear after the AI client reconnects without requiring a new package release.

For a public X status URL, `agentrouter_fetch` and the structured
`social_post_read` capability execute through a fixed read-only connector on
the user's device. OpenCLI is the default connector: its browser extension reads
the public post inside the already signed-in browser without exporting or
decrypting cookies. Browser login state remains local; credentials, cookies, and
raw connector output are not uploaded to AgentRouter.

If the browser bridge is offline, AgentRouter returns
`browser_connector_offline` with a reconnect action. It does not ask for a
system password, Keychain access, or cookie values. The legacy `twitter` CLI is
disabled by default and is attempted only when the MCP process is explicitly
configured with `AGENTROUTER_ALLOW_TWITTER_CLI_FALLBACK=1`.

For paid calls, no API key needs to be copied into the MCP configuration. On the first request that needs account credits, call the bridge's `agentrouter_connect` tool. It returns a short browser approval link; after the user approves, the bridge stores the device credential privately and uses the prepaid balance automatically. The credential is never returned to the AI agent.

`AGENT_ROUTER_API_KEY` remains an advanced override for CI and headless servers that cannot open a browser.

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

Server-side tools and capability schemas update automatically. Restart or reconnect the AI client if it caches the MCP tool list.

To refresh the Skill and migrate an older GitHub-based MCP config:

```bash
curl -fsSL https://agentrouter.network/update.sh | bash
```

The updater preserves optional developer API keys, device credentials, custom environment settings, unrelated MCP servers, and existing wallet files.

## Protocol Boundary

The main agent should parse user language into a structured capability request whenever possible. AgentRouter handles routing, quote, provider invocation, verification, payment metadata, and evidence. If a quote returns `auto_invoke_allowed: true`, the agent should invoke without asking the user again because the call is within the configured max-price policy. After a successful call, the main agent should submit `agentrouter_feedback` automatically. If it quotes but does not invoke, it should submit `agentrouter_quote_feedback`.
