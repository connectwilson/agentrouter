# AgentRouter

Agent-native API routing. Your agent asks a question in plain language; AgentRouter
finds a source that can answer it, handles the paywall, and returns verified data
with a way to rate the result.

No subscriptions, no per-source API keys to collect, no vendor SDKs to learn.

This repository holds the **client side**: everything that runs on your machine or
inside your AI client. The hosted registry, routing and trust services, provider
credentials, and payment settlement are not part of it.

## Install

One command, any supported client:

```bash
npx @agentrouternetwork/agentrouter
```

It detects installed AI clients, registers the MCP bridge with each, and installs
the AgentRouter Skill. Reload the client afterwards so it starts the bridge.

Supported: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI,
opencode, OpenClaw, WorkBuddy.

Target one client instead of all of them:

```bash
npx @agentrouternetwork/agentrouter --client claude-code
```

### Manual MCP configuration

If your client is not on that list, point it at the bridge directly:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
      "env": {
        "AGENT_ROUTER_URL": "https://agentrouter.network",
        "AGENT_ROUTER_MAX_PRICE": "0.05"
      }
    }
  }
}
```

## Using it

Ask for data the way you would ask a person. The agent calls one tool:

```
agentrouter_fetch({ task: "latest funding rounds in AI infrastructure" })
```

AgentRouter decides where that should go. Free sources answer for free; paid ones
return a quote first, and the call only proceeds within the budget you set.

Every result carries a `request_id` and a request to rate it. Submitting that
rating is what keeps routing honest — see [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Local reads run on your machine

Some sources are read through your own signed-in browser rather than a paid API:
X, Reddit, YouTube, Bilibili, Xiaohongshu, Zhihu, Weibo, TikTok.

These run locally through the OpenCLI browser connector. Nothing is uploaded, no
credentials leave the machine, and access is read-only — AgentRouter never posts,
messages, or writes on your behalf. It also never asks for your system password:
a prompt asking to decrypt browser cookies is not from AgentRouter, and granting
it would expose every site you are signed in to.

## What is in here

| Path | What it is |
|---|---|
| `packages/agentrouter-mcp` | The MCP bridge. Published as `@agentrouternetwork/mcp`. |
| `packages/agentrouter-installer` | The one-command installer. Published as `@agentrouternetwork/agentrouter`. |
| `plugin/` | Claude Code plugin (stdio bridge + skill). |
| `mcpb/agentrouter/` | Desktop Extension bundle scaffold. |
| `skills/` | AgentRouter Skill for Claude and Codex. |
| `contracts/` | The evidence anchor contract, with a script to compile and deploy your own. |
| `docs/` | Protocol contract, architecture, upgrade notes. |

## What is not in here

The hosted registry and Provider Studio, the routing, trust and reputation
services, provider credentials and payout configuration, settlement and payment
backends, and internal planning documents.

## The evidence anchor

`contracts/` holds the contract AgentRouter writes evidence and feedback hashes
to, and a script that compiles and deploys it. It is events only — no storage,
no owner, nothing upgradeable — so a deployment is disposable and you are meant
to deploy your own rather than trust an address someone else published.

```bash
npm install
RPC_URL=<your rpc> node contracts/deploy.js --dry-run
```

See [contracts/README.md](contracts/README.md) for deploying and for checking a
deployed address against this source.

## Updating

The bridge resolves `@latest` at launch and the hosted side updates independently,
so most changes reach you without reinstalling. See [docs/UPGRADING.md](docs/UPGRADING.md).

## License

MIT — see [LICENSE](LICENSE).
