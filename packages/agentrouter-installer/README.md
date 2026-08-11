# AgentRouter installer

Install the AgentRouter Skill, configure one detected current AI client with
the local MCP bridge, and verify the hosted runtime:

```bash
npx @agentrouternetwork/agentrouter
```

The installer:

- installs the AgentRouter Skill into standard AI-agent Skill directories;
- prioritizes the invoking AI client and migrates an older AgentRouter entry;
- changes exactly one client configuration and preserves unrelated MCP servers;
- creates a timestamped backup before changing an existing configuration;
- verifies `https://agentrouter.network/agent-router/health`;
- verifies the hosted MCP tool list;
- does not create a wallet.

AgentRouter providers, capabilities, routing logic, and hosted tools update server-side without reinstalling this package.

Reload the AI client once after installation so it starts the local bridge. If
the invoking client cannot be detected from its environment, keep the setup as
one command and identify it explicitly:

```bash
npx @agentrouternetwork/agentrouter --client claude-code
```

Supported values are `claude-code`, `cursor`, and `claude-desktop`.

For Skill installation plus HTTP verification without changing an MCP
configuration:

```bash
npx @agentrouternetwork/agentrouter --http-only
```

Hosted paid calls use AgentRouter account credits. On the first paid call, the
local bridge provides a browser approval link and securely remembers the
connection; users do not copy an API key into the MCP configuration. Manual
API keys remain available only for CI and headless servers.
