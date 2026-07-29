# @agentrouternetwork/mcp

Public, zero-configuration MCP bridge for AgentRouter.

The package forwards MCP JSON-RPC to `https://agentrouter.network/mcp`. Tool definitions come from the hosted AgentRouter server, so newly deployed capabilities appear after the AI client reconnects without requiring a new package release.

For a public X status URL, `agentrouter_fetch` and the structured
`social_post_read` capability execute through a fixed read-only connector on
the user's device. The bridge tries OpenCLI and then the `twitter` CLI. Browser
login state remains local; credentials, cookies, and raw connector output are
not uploaded to AgentRouter.

Create `AGENT_ROUTER_API_KEY` from the signed-in AgentRouter account page. When present, the MCP server uses the prepaid credits balance and does not require a local Arc wallet.

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
        "AGENT_ROUTER_URL": "https://agentrouter.network",
        "AGENT_ROUTER_API_KEY": "ar_live_..."
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

The updater preserves AgentRouter API keys, custom environment settings, unrelated MCP servers, and existing wallet files.

## Protocol Boundary

The main agent should parse user language into a structured capability request whenever possible. AgentRouter handles routing, quote, provider invocation, verification, payment metadata, and evidence. If a quote returns `auto_invoke_allowed: true`, the agent should invoke without asking the user again because the call is within the configured max-price policy. After a successful call, the main agent should submit `agentrouter_feedback` automatically. If it quotes but does not invoke, it should submit `agentrouter_quote_feedback`.
