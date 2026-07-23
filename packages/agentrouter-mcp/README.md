# @agentrouter/mcp

Universal MCP server for AgentRouter.

AgentRouter routes AI agents to paid API/data services, supports quote-before-pay, invokes providers, verifies returned data, and returns an evidence envelope with trace hashes.

Create `AGENT_ROUTER_API_KEY` from the signed-in AgentRouter account page. When present, the MCP server uses the prepaid credits balance and does not require a local Arc wallet.

## Usage

Run with npx:

```bash
npx -y @agentrouter/mcp
```

Before the npm package is published, use the GitHub package form:

```bash
npx -y --package github:connectwilson/agentrouter-markets#main agent-router-mcp
```

Most AI clients configure MCP like this:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "@agentrouter/mcp"],
      "env": {
        "AGENT_ROUTER_URL": "https://agentrouter.network",
        "AGENT_ROUTER_MAX_PRICE": "0.05",
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
      "args": ["-y", "@agentrouter/mcp"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800",
        "AGENT_ROUTER_MAX_PRICE": "0.05"
      }
    }
  }
}
```

## Tools

- `agentrouter_request`: preferred structured capability request path for specialized, real-time, paid, or verifiable external data/API needs. Use this first whenever the main agent can parse the user request. Successful calls record verification/evidence and return a feedback request.
- `agentrouter_quote`: route and quote without invoking a provider. Quotes include `agent_decision.auto_invoke_allowed`, expected data, budget status, and why paid data is justified.
- `agentrouter_quote_feedback`: submit this when a main agent receives a quote but chooses not to invoke, so AgentRouter can learn skipped-call reasons.
- `agentrouter_capabilities`: list capability schemas when the main agent has a data/API need and needs to discover what AgentRouter can route.
- `agentrouter_feedback`: submit post-call usefulness/intent-fit feedback after answering.
- `agentrouter_ask`: natural-language routing helper when a structured capability request cannot be produced.

## Protocol Boundary

The main agent should parse user language into a structured capability request whenever possible. AgentRouter handles routing, quote, provider invocation, verification, payment metadata, and evidence. If a quote returns `auto_invoke_allowed: true`, the agent should invoke without asking the user again because the call is within the configured max-price policy. After a successful call, the main agent should submit `agentrouter_feedback` automatically. If it quotes but does not invoke, it should submit `agentrouter_quote_feedback`.
