# Updating AgentRouter

## What updates automatically

Clients connected directly to `https://agentrouter.network/mcp` receive server-side tools and capability schemas from the deployed AgentRouter version. The public npm bridge and Claude Desktop extension also discover their tool list from that remote MCP instead of shipping a static list.

Restart or reconnect the AI client when it caches an older tool list.

## Migrate an existing local installation

Run the hosted updater:

```bash
curl -fsSL https://agentrouter.network/update.sh | bash
```

The updater:

- downloads the current update manifest and AgentRouter Skill from `agentrouter.network`
- changes existing AgentRouter MCP entries to the public `@agentrouternetwork/mcp@latest` bridge
- preserves `AGENT_ROUTER_API_KEY` and every other custom AgentRouter environment value
- preserves unrelated MCP server entries
- does not delete, recreate, or modify files under `~/.agentrouter/adn`
- writes a timestamped backup beside every changed MCP config
- does not add a client configuration that was not already installed

After it prints `AgentRouter updated. READY`, restart or reload the affected AI client and confirm that `agentrouter_fetch` is available.

## Public update metadata

The stable update channel is machine-readable:

```text
https://agentrouter.network/agent-router/update-manifest.json
```

It declares the current MCP package, command, remote MCP URL, Skill URL, updater URL, minimum Node.js version, and preservation guarantees. It never requires access to the private AgentRouter source repository.

## Pinned package versions

The hosted updater uses `@agentrouternetwork/mcp@latest` by default. To keep a deliberate package pin:

```bash
curl -fsSL https://agentrouter.network/update.sh |
  AGENTROUTER_MCP_PACKAGE=@agentrouternetwork/mcp@0.2.0 bash
```

Pinned clients still receive server-side tool definitions dynamically; the pin only fixes the local bridge implementation.

## Claude Desktop Extension

AgentRouter Desktop Extension v0.2.0 and later discovers tools from the remote MCP. New server-side tools therefore do not require reinstalling the extension. Install a newer `.mcpb` only when the bridge transport, permissions, or extension metadata itself changes.

## Rollback

Before rewriting an existing MCP config, the updater saves a sibling file named like `mcp.json.bak.YYYYMMDDHHMMSS`. To roll back:

1. Stop the AI client.
2. Restore the most recent backup over the active MCP config.
3. Restart the client.

Wallet files are not changed by updates.
