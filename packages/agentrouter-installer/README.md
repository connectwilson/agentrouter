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

For a one-command full setup, including the current supported AI client's
MCP configuration and a real `initialize` + `tools/list` verification:

```bash
npx @agentrouternetwork/agentrouter --full
```

`--full` changes exactly one detected client configuration, preserves unrelated
MCP servers, and writes a timestamped backup before editing. It does not create
a local crypto wallet. Hosted paid calls use AgentRouter account credits and an
optional API key created outside the installer.
