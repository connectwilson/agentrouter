# Architecture (client side)

What runs where, and why the split is drawn here.

```
AI client (Claude Code, Cursor, Codex, …)
   │  MCP stdio
   ▼
AgentRouter bridge          ← this repository
   ├── local reads ────────► your browser, via the OpenCLI connector
   └── everything else ───► hosted AgentRouter (routing, quotes, invocation)
```

## The bridge

`packages/agentrouter-mcp` is an MCP server over stdio. It is deliberately thin:
it exposes the tools, forwards requests to the hosted service, and intercepts the
calls that must not leave the machine.

Transport is newline-delimited JSON, as MCP specifies — not LSP-style
`Content-Length` framing. Clients that assume the latter will hang.

## Why stdio, and not remote-only

A remote-only HTTP connector would be simpler to ship, and would lose the reads
that run on your own machine. Those need a local process next to your browser, so
the bridge runs locally and reaches out, rather than the reverse.

## Local reads

`server/local-social-post.js` and `server/local-social-search.js` intercept
social-platform requests before they reach the network and run them through the
OpenCLI browser connector against your existing signed-in session.

Consequences, by construction:

- Credentials never leave the machine; the bridge never sees them.
- Access is read-only. There is no write path — no posting, no messaging.
- No platform API key is needed for these sources.
- AgentRouter never asks for your system password. A prompt asking to decrypt
  browser cookies did not come from AgentRouter; granting it would expose every
  site you are signed in to.

These calls are free, and they still return a `request_id` so a good result can
be rated. Otherwise reputation would only ever record the paid paths that failed.

## The installer

`packages/agentrouter-installer` detects installed AI clients, writes each one's
MCP configuration, and installs the Skill into the directories those clients read.
It is a one-time step; it does not stay resident.

Client detection reads environment markers, which is why its tests scrub ambient
client variables — a test running inside one of these clients would otherwise
detect the harness rather than the fixture.

## Credentials

`server/credential-store.js` holds references, not secrets: connections are made
against your AgentRouter account, and the bridge forwards an account token. If a
client cannot do the browser approval flow, `AGENT_ROUTER_API_KEY` is the
headless fallback.

You should never be asked to paste a provider API key into a chat.

## What is on the other side

Routing, the service registry, quotes and settlement, trust scoring, and provider
credentials all live in the hosted service and are not in this repository. The
bridge holds no routing logic of its own, which is why routing improvements reach
you without an upgrade.

## On-chain

`contracts/AgentRouterEvidenceAnchor.sol` anchors a hash of each feedback record.
The record itself stays off chain; only the hash is written, so evidence is
verifiable without publishing what was asked or returned.

Agent identity follows ERC-8004: registered services carry an identity in the
chain's agent registry, and their agent cards are served under
`/.well-known/erc8004/agents/{service_id}.json` in the EIP's own schema.
