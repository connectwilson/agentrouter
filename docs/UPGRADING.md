# Updating AgentRouter

## Local MCP installation

If AgentRouter was installed with the GitHub `npx` command, update it with:

```bash
npx -y github:connectwilson/agentrouter-markets#main update
```

When the npm package is available, use:

```bash
npx -y agentrouter@latest update
```

The command updates the AgentRouter Skill and the package command in MCP clients that already contain an AgentRouter entry. It does not create a new wallet or add configurations for clients that were not previously configured.

The updater preserves:

- `~/.agentrouter/adn`, including the wallet and local session secret
- `AGENT_ROUTER_API_KEY` and other custom AgentRouter environment values
- unrelated MCP server entries
- the currently configured AgentRouter URL, maximum price, Arc RPC URL, and wallet directory
- a timestamped backup beside every changed MCP config file

An explicit update option overrides its stored value. For example:

```bash
npx -y github:connectwilson/agentrouter-markets#main update --max-price 0.10
```

To add or repair a client while updating, select it explicitly:

```bash
npx -y github:connectwilson/agentrouter-markets#main update --client cursor
npx -y github:connectwilson/agentrouter-markets#main update --client claude-desktop
```

After the updater prints `AgentRouter updated. READY`:

1. Restart or reload the affected AI client.
2. Run `npx -y github:connectwilson/agentrouter-markets#main doctor`.
3. Confirm the client exposes `agentrouter_fetch` and the other expected AgentRouter tools.

If the update reports `NOT_READY`, follow its repair message. The existing wallet should not be deleted or recreated as a general repair step.

## Remote MCP

Clients connected to `https://agentrouter.network/mcp` receive server-side tool updates automatically. Reconnect or reload the client if its cached tool list does not show a new tool.

## Claude Desktop Extension

For an `.mcpb` installation, install the newest AgentRouter extension package over the existing extension, then restart Claude Desktop. Keep the same AgentRouter URL and wallet settings during the replacement.

## Pinned package versions

The updater normally changes the local MCP command to the current GitHub `main` package. To keep a deliberate package pin, set `AGENTROUTER_MCP_PACKAGE` while updating:

```bash
AGENTROUTER_MCP_PACKAGE=@agentrouter/mcp@0.2.0 npx -y agentrouter@latest update
```

## Rollback

Before rewriting an existing MCP config, the updater saves a sibling file named like `mcp.json.bak.YYYYMMDDHHMMSS`. To roll back, stop the AI client, restore the most recent backup, and restart the client. Wallet files are not changed by updates.
