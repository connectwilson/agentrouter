# AgentRouter installer

Install AgentRouter and verify its hosted HTTP runtime:

```bash
npx @agentrouternetwork/agentrouter
```

The installer:

- installs the AgentRouter Skill into standard AI-agent Skill directories;
- verifies `https://agentrouter.network/agent-router/health`;
- reports `READY (HTTP mode)`;
- does not edit MCP configuration or create a wallet.

AgentRouter providers, capabilities, routing logic, and hosted tools update server-side without reinstalling this package.

Remote MCP remains an optional enhancement:

```text
https://agentrouter.network/mcp
```
