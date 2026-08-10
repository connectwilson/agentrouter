# PRD: Agent Plugins package + research page script-extraction fix

**Status:** Ready for implementation
**Audience:** a coding agent with no context from the conversation that produced this
**Repo:** `/Users/huazhenghao/Downloads/Arc` (AgentRouter)

Two independent work items. **Item 1 is a small bug fix and should land first**, because
it is currently making the test suite red and would otherwise be confused with failures
from Item 2. Item 2 is a new distribution artifact.

---

# Item 1 — Fix the research page script-extraction test

## 1.1 Symptom

`npm test` fails:

```
not ok - research page and project API are available without social account authorization
  test/research.test.js:61
  Got unwanted exception.
  Actual message: "Unexpected token '<'"
```

The failure is **order-dependent and looks flaky** — which test reports it moves between
runs — because several test files share a process and the研究 page is also rendered
elsewhere. Do not chase the flakiness; the cause below is deterministic.

## 1.2 Root cause (verified, not inferred)

`test/research.test.js` extracts the page's inline JavaScript and asserts it parses:

```js
const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script);
assert.doesNotThrow(() => new Function(script));
```

That regex is **greedy**. It matches from the *first* `<script>` to the *last*
`</script>`.

The `/research` page used to contain exactly one `<script>` block, so greedy and
non-greedy were identical and the bug was invisible. In-flight work added a login modal
(`src/auth-modal.js`, imported by `src/research.js` and `src/home.js`) that renders a
**second** `<script>` block. The greedy capture now spans the gap between the two blocks
and therefore includes raw HTML, so `new Function()` receives markup and throws
`Unexpected token '<'`.

Measured on the live page:

| | length | contains `</script>` | `new Function()` |
|---|---|---|---|
| greedy `([\s\S]*)` | 16637 | **yes** | throws `Unexpected token '<'` |
| non-greedy `([\s\S]*?)` | 13969 | no | parses |

So: the page is fine, the **test's extraction is wrong**. `src/auth-modal.js` merely
exposed it.

## 1.3 Required change

In `test/research.test.js`, extract and validate **every** inline script block rather than
one greedy blob:

```js
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length >= 1);
for (const script of scripts) {
  assert.doesNotThrow(() => new Function(script));
}
```

Notes:
- Use the global flag and a **non-greedy** capture.
- Assert on all blocks, not just the first — the point of the test is that the page ships
  parseable JS, and that must hold as blocks are added.
- Only match `<script>` with no attributes, matching current behaviour. If a block with
  attributes (e.g. `<script type="application/json">`) is ever added, it must be excluded,
  since JSON is not valid JS.

## 1.4 Acceptance criteria

1. `npm test` is fully green from a clean checkout **with the auth-modal changes present**.
2. The test still fails if a genuinely broken inline script is introduced into the research
   page (verify by temporarily injecting `const = ;` into one block and confirming a red
   test, then reverting).
3. No change to `src/research.js`, `src/home.js`, or `src/auth-modal.js` is required by
   this item. If a change to those files seems necessary, the diagnosis above is wrong —
   re-verify before editing them.

---

# Item 2 — Ship AgentRouter as an Agent Plugins 1.0.0 package

## 2.1 Background

The **Agent Plugins** standard 1.0.0 was published 2026-08-06. It is vendor-neutral;
the steering committee includes Amazon, Cursor, Microsoft, OpenAI and Vercel, with Google
as a core maintainer. Clients supporting it at launch: **ChatGPT and Codex, Cursor, GitHub
Copilot, Kiro, VS Code**.

- Spec: https://github.com/agentplugins/agent-plugins-spec
- Schema base: `https://agent-plugins.org/schemas/1.0.0/`

A plugin packages exactly the two things AgentRouter already distributes:

```
plugin.json          # manifest
skills/SKILL.md      # Agent Skill
mcpServers { ... }   # MCP server declarations
```

**Why this matters here.** AgentRouter currently reaches clients through
`packages/agentrouter-installer`, which hand-writes MCP configuration in **three different
formats** across nine clients (standard `mcpServers` JSON; Codex's TOML; OpenClaw's nested
`mcp.servers`; opencode's argv-array + `environment`; WorkBuddy's `.mcp.json` dotfile).
A plugin replaces that per-client work with one artifact for every conformant client.

## 2.2 Goals / Non-goals

**Goals**
- Publish a spec-conformant Agent Plugins package that installs the AgentRouter Skill and
  MCP bridge in any conformant client.
- Keep the free local-browser capability intact (see §2.4 — this is the constraint that
  most easily gets broken).
- Keep the package in sync with the hosted Skill and the published bridge version.

**Non-goals**
- **Do not remove or weaken `packages/agentrouter-installer`.** The standard explicitly
  leaves distribution and installation out of scope, and most of AgentRouter's current
  target clients — Claude Code, Claude Desktop, hermes, opencode, OpenClaw, WorkBuddy,
  Windsurf, Gemini CLI — are **not** on the launch support list. The plugin is an
  additional channel, not a replacement.
- No changes to the MCP bridge's protocol behaviour.
- No new payment or routing code.

## 2.3 Deliverable

A new top-level directory `plugin/`:

```
plugin/
  plugin.json
  skills/
    agentrouter/
      SKILL.md
```

`plugin.json` must declare both the skill directory and the MCP server. Required manifest
fields per spec: `$schema` and `name`. Include `description` and `version` as well.

The MCP declaration follows `mcp.schema.json`. For a stdio server the shape is:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
  "env": { "AGENT_ROUTER_URL": "https://agentrouter.network" }
}
```

Constraints from the schema, which the implementation must respect:
- `type` and `command` are required for stdio; `type` and `url` for remote.
- `env` keys **must not** include `PLUGIN_ROOT` or `PLUGIN_DATA` — those are reserved.
- `cwd`, if used, must be plugin-relative or use the root variables.
- Remote servers use `type: "streamable-http"` (or legacy `"sse"`) with `url` and optional
  `headers`.

## 2.4 The constraint that must not be broken

AgentRouter has two runtime modes:

| Mode | Transport | What it provides |
|---|---|---|
| Local bridge | `stdio` (npx → `agentrouter-mcp`) | Hosted tools **plus** free local social reads that run OpenCLI against the user's own logged-in browser (X, YouTube, Bilibili, Reddit, Xiaohongshu, Zhihu, Weibo, TikTok) |
| Remote | `streamable-http` → `https://agentrouter.network/mcp` | Hosted tools only |

**The plugin must declare the stdio bridge.** A remote-only plugin silently loses the
local-browser reads, which are the product's main differentiator against resold-scraping
competitors. If both are declared, the stdio server must be the one named `AgentRouter`.

## 2.5 Skill content

`plugin/skills/agentrouter/SKILL.md` must not be a hand-written fork. The canonical Skill
is served at `https://agentrouter.network/SKILL.md` and is what
`packages/agentrouter-installer` writes to disk today. Either:

- **(preferred)** add a build/sync step that fetches the hosted Skill into the plugin
  directory, and a test asserting the committed copy matches the hosted one; or
- commit the copy with a header comment naming the hosted URL as the source of truth, plus
  the same drift test.

A silently diverging Skill is the main long-term failure mode of this deliverable.

## 2.6 Version coupling

The plugin pins `@agentrouternetwork/mcp@latest`, consistent with what the installer
writes. If the implementation pins an exact version instead, it must add a test that the
pinned version is the current published one, otherwise the plugin will rot.

## 2.7 Validation

The spec ships JSON schemas. Add a test that validates `plugin/plugin.json` against
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and the MCP block against
`mcp.schema.json`. **Fetch the schemas at test time and cache them locally**; do not let
the suite depend on network availability on every run — follow the existing pattern in
`test/` where upstream fetches are mocked. A vendored copy of the schemas with a
refresh script is acceptable and probably simpler.

## 2.8 Acceptance criteria

1. `plugin/plugin.json` validates against the 1.0.0 plugin schema; the MCP block validates
   against the MCP schema.
2. The declared MCP server is **stdio**, invoking the published bridge, with
   `AGENT_ROUTER_URL` set and no reserved env keys.
3. `plugin/skills/agentrouter/SKILL.md` matches the hosted `/SKILL.md`, enforced by a test
   that fails on drift.
4. `packages/agentrouter-installer` is unchanged in behaviour: its existing tests still
   pass, and it still configures all nine clients it supports today.
5. Full suite green (`npm test`). Baseline at the time of writing is **241 tests passing
   on a clean checkout**; Item 1 must be fixed for this to hold.
6. `docs/ARCHITECTURE.md` gains a short section describing the plugin as a distribution
   channel alongside the installer, and stating which clients each one serves.

## 2.9 Out of scope / open questions for the human

- Publishing the plugin to any registry or marketplace is **not** part of this task. Build
  the artifact; do not publish it anywhere.
- Whether to also ship a remote-only plugin variant for clients that cannot spawn
  processes is undecided — do not build it without asking.

---

## Appendix — repo facts an implementing agent will need

- Bridge package source: `packages/agentrouter-mcp` (published as
  `@agentrouternetwork/mcp`, bin `agentrouter-mcp`). Local version at time of writing:
  0.8.0; **published version may lag — check npm.**
- Installer source: `packages/agentrouter-installer` (published as
  `@agentrouternetwork/agentrouter`). Local version 0.8.0, likewise may lead npm.
- Hosted Skill: `GET https://agentrouter.network/SKILL.md`
- Remote MCP endpoint: `https://agentrouter.network/mcp` (7 tools; `agentrouter_fetch` is
  the primary entry point).
- Tests: `npm test` runs `node --test`. There is no framework; tests use `node:test` and
  `node:assert/strict`.
- Some existing tests are sensitive to shared state in `ADN_PROVIDER_DIR`; if a new test
  writes provider configs, it must delete them in a `finally` block.
