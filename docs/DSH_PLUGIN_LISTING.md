# Listing AgentRouter in the DSH Plugin Market (searchable distribution)

**Goal:** a DSH (DeepSeek Harness) user opens the plugin market, **searches** for data/API/crypto capabilities, **finds "AgentRouter"**, and one-click installs it — turning DSH into a free distribution/acquisition channel for AR.

## How discovery actually works (confirmed)

- The community markets (`dshplugin.store`, `AwesomeHou/dsh-plugin-marketplace`) **live-sync the GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)** into a searchable, paginated in-app tab (7000+ repos indexed as of 2026-08-18).
- To be **listed + searchable + one-click installable**, a repo needs:
  1. the GitHub **topic `dsh-plugin`**,
  2. a root **`package.json`** declaring DSH integration (`dsh.bundle` and/or `dsh.client`),
  3. (optional, recommended) **published to npm** — the market prioritizes npm installs over git clone.
- **Search matches repo name + description** (GitHub `q` across the topic). So name/description must carry the words users search.
- **No manual submission/PR** — auto-discovered on the next sync cycle.

## Deliverable: a dedicated plugin repo

Create a small public repo, e.g. **`agentrouter-dsh-plugin`** (separate from the main AR repo). It just mounts AR's already-live remote MCP endpoint (`https://<ar-host>/mcp`) as a DSH tool plugin — no AR code changes.

### Reality check: DSH plugins are **Cordis** npm packages, not URL manifests

Confirmed from the first-party plugin `dsh-plugin-desktop/package.json`, the real `dsh` field looks like:

```jsonc
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-theme"],
    "platform": "web"
  },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

So a DSH plugin is a **[Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) framework plugin** (an npm package that exports `name` + `inject` + an `apply` that registers capabilities into the harness). "Install" in the market = installing this Cordis plugin, **not** pointing at an MCP URL. The unified capability/MCP manifest (`dsh-community-fabric`) is still **RFC Draft — "not yet a publishing target"** per the repo, so there is no stable declarative "mcp: {url}" field to rely on.

### Confirmed working template: `bobleer/deepseek-harness-plugin-mcp`

This is a real, minimal MCP DSH plugin. Copy its shape. Its actual `package.json`:

```jsonc
{
  "name": "deepseek-harness-plugin-mcp",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "dsh-plugin-mcp": "./dist/cli.js" },
  "keywords": ["mcp","model-context-protocol","deepseek","deepseek-harness","dsh","dsh-plugin"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // ← the whole dsh field. minimal.
  "dependencies": { "@modelcontextprotocol/sdk": "^1.25.0", "yaml": "^2.8.1", "zod": "^3.25.76" },
  "engines": { "node": "^22.19.0 || >=24.0.0" }
}
```

Its `cordis.patch.yml` (where the plugin is actually wired) declares one plugin with a config block:

```yaml
# plugin id: dsh-plugin-mcp
config:
  host: 127.0.0.1
  port: !!js Number(process.env.DSH_PLUGIN_MCP_PORT ?? 8765)
  bridgeTools: true
  allowInstall: false
  allowRuntime: false
```

Install form: `dsh plugin --profile web add github:<owner>/<repo>` **or** `npm i -g <pkg>`.

### For AR: use `bobleer` for STRUCTURE, but flip the DIRECTION

`bobleer` exposes Harness's own tools **outward** as an MCP server. **AR needs the opposite: register AR's already-hosted remote MCP (`https://<ar-host>/mcp`, streamable HTTP) INWARD into Harness's MCP client**, so the harness agent gains AR's tools. Two shapes:

- **Shape 1 (recommended, least code):** the plugin's `cordis.patch.yml` adds AR's remote MCP server to Harness's **MCP client** config (the official `/mcp` client with server CRUD). AR runs no local process — you just register a streamable-HTTP server URL. Confirm the MCP-client's "add server" config key from the official `/mcp` client plugin or `PerryLink/dsh-mcp-panel` (which does exactly this CRUD).
- **Shape 2 (fallback):** bundle a thin local MCP bridge (like `bobleer`, using `@modelcontextprotocol/sdk`) that proxies to AR's remote `/mcp`. More code, fully self-contained.

Your `agentrouter-dsh-plugin` `package.json` = bobleer's shape with **AR's search metadata**: `name: "agentrouter-dsh-plugin"`, and a description/keywords front-loading the words a DSH user searches:

```jsonc
"description": "AgentRouter — pay-per-call access to verified on-chain / crypto / DeFi & market data and API capabilities for your agent (discovery + routing + x402/credits payment + verification).",
"keywords": ["dsh-plugin","mcp","deepseek-harness","agent","data","api","onchain","crypto","defi","web3","payments","x402","capabilities","smart-money","liquidation","funding-rate"]
```

### `README.md` (also indexed — repeat the search keywords)

- H1: **AgentRouter — verified data & API capabilities for your agent (MCP plugin)**
- One-paragraph what-it-does, with keywords (on-chain data, crypto, DeFi, market data, pay-per-call, x402, verified results).
- Install: shown in the market as one-click; also document manual add (DSH `/mcp` Settings → add server `https://<ar-host>/mcp`).
- A short "capabilities" list (smart money, liquidation, funding rate, DeFi/DeFiLlama, on-chain flows…) — these words help search hits.

### `icon.png`
- A recognizable icon (appears in market cards).

## Steps to go live

1. **Start from the confirmed template** `bobleer/deepseek-harness-plugin-mcp` (real, minimal, MCP). Also look at `PerryLink/dsh-mcp-panel` for the official MCP-client server-CRUD config (needed for Shape 1). These are the source of truth — the docs' unified manifest is still RFC-draft.
2. Create repo `agentrouter-dsh-plugin` from that shape; set AR name/description/keywords (search metadata, above); wire `cordis.patch.yml` to register AR's remote `/mcp` into the harness MCP client (Shape 1); add `README.md` + `icon.png`.
3. On GitHub → repo → About → **add topic `dsh-plugin`** (+ `mcp`, `agent`, `crypto`, `data`).
4. (Optional) `npm publish` — the market prioritizes npm installs over git clone.
5. Wait for the next market sync → search "AgentRouter" / "onchain data" / "crypto" in the DSH market → confirm it appears **and installs+runs**.
6. Also PR AR into the awesome lists for extra discovery surface: `Dominic789654/awesome-deepseek-harness`, `walkinglabs/awesome-deepseek-harness-plugins`.

## Searchable vs installable — two different bars

- **Searchable** (easy, confirmed): topic `dsh-plugin` + a `package.json` with the `dsh` field → indexed by the community markets within one sync cycle. Metadata drives the hit.
- **Installable + runs** (the real work): must be a valid **Cordis plugin** whose `apply()` actually registers AR's MCP server in the harness. A search hit that fails to install is dead weight — so **the template-copy in step 1 is the critical path**, not a nice-to-have.
- The exact `dsh.*` schema is Cordis-specific and partly RFC-unstable — **do not hand-write it; mirror a working plugin**. Pin any `harness-schema-version` the template uses.

## Honest notes

- **DSH is free / no payment layer.** Being listed = free acquisition; **AR still charges inside its own flow** (the DSH user's agent calls AR → AR meters via credits/x402). DSH does not handle payment.
- **This is breadth/distribution, not moat.** The plugin is a funnel into AR's paid network; AR's moat stays payment + verification + reputation.
- **Two markets, two reach levels:** the community markets (topic-sync, open — this doc) are reachable now; the **official in-app DSH Community Market** uses open-schema data sources / reviewed adapters and at preview may list only built-ins — pursue separately if you want in-app-official placement (verify its source-onboarding in `dsh-community-market/README.zh.md`).
