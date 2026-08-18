# AgentRouter — Agent Plugins 1.0.0 package

This directory is an [Agent Plugins 1.0.0](https://github.com/agentplugins/agent-plugins-spec)
bundle of the AgentRouter Skill plus its MCP bridge. Any conformant client
(ChatGPT, Codex, Cursor, GitHub Copilot, VS Code, Kiro) can install it as one
artifact.

```
plugin/
  plugin.json                     # manifest (metadata only; $schema + name required)
  mcp.json                        # MCP server declarations
  skills/agentrouter/SKILL.md     # Agent Skill
```

`plugin.json` is metadata only. Skills and MCP servers live at the spec's fixed
locations (`skills/`, `mcp.json`) and are auto-discovered; nothing in the
manifest points at them.

## Transport: stdio (default)

`mcp.json` declares a **stdio** server named `AgentRouter` running the published
bridge:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "AgentRouter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
      "env": { "AGENT_ROUTER_URL": "https://agentrouter.network" }
    }
  }
}
```

**stdio is the default deliberately.** The local bridge is what provides the
free local-browser reads (X, YouTube, Bilibili, Reddit, Xiaohongshu, Zhihu,
Weibo, TikTok via OpenCLI against the user's own logged-in browser). Those reads
are the product's main differentiator against resold-scraping competitors, so a
remote-only declaration would silently drop them.

## Deprovision / downgrade to remote-only

In a sandbox, serverless, or other environment that **cannot spawn local
processes**, replace the stdio server with the remote MCP endpoint:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "AgentRouter": {
      "type": "streamable-http",
      "url": "https://agentrouter.network/mcp"
    }
  }
}
```

Trade-offs of doing this:

- You lose the free local-browser social reads — only the hosted tools remain.
- Hosted paid calls need a prepaid-credit `AGENT_ROUTER_API_KEY`; without one
  the remote endpoint returns a quote/auth requirement instead of paid data.
- Nothing else changes: skills, payment, and verification behave the same.

If the plugin is shipped with stdio and you need remote-only, edit `mcp.json`
in place (swap the server object as above) and reinstall the plugin. We do not
ship a separate remote-only artifact today; the one-line swap above is the
supported path until a concrete client needs its own remote variant.

## Keeping the skill in sync

`skills/agentrouter/SKILL.md` is copied from the hosted
`https://agentrouter.network/SKILL.md`. Source of truth is the hosted URL.

Refresh:

```bash
npm run plugin:skill:sync
```

`test/agent-plugin.test.js` fails if the committed copy drifts from the hosted
skill, so run the sync after any hosted-SKILL change.

## Distribution

This artifact is a distribution channel alongside
`packages/agentrouter-installer`. Distribution/installation mechanics are out of
scope of the Agent Plugins spec, so which path a client uses depends on the
client: plugin-based clients use this bundle; clients without plugin support use
the installer. See `docs/ARCHITECTURE.md` → "Distribution Channels".
