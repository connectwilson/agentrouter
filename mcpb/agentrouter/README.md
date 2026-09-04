# AgentRouter Claude Desktop Extension

AgentRouter connects Claude Desktop to the Agent Native Data Network through MCP.

## Tools

- `agentrouter_request`: preferred structured capability request path for specialized, real-time, paid, or verifiable external data/API needs. Use this first whenever the main agent can parse the user request. Successful calls record verification/evidence and return a feedback request.
- `agentrouter_quote`: route and quote without invoking a provider.
- `agentrouter_capabilities`: list capability schemas when the main agent has a data/API need and needs to discover what AgentRouter can route.
- `agentrouter_feedback`: advanced/manual correction path; the current bridge submits default feedback inside the original data call.
- `agentrouter_ask`: natural-language routing helper when a structured capability request cannot be produced.

## Configuration

- `AgentRouter URL`: defaults to `https://agentrouter.network`.
- `Default Max Price`: defaults to `0.05` USDC.

The main agent should parse user language into structured requests whenever possible. AgentRouter handles routing, quote, invocation, verification, evidence, and default feedback within the original data call; the user should only need to ask the data question.
