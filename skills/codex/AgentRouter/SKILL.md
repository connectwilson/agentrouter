---
name: agent-router-project
description: Use this skill when working on the AgentRouter / Agent Native Data Network codebase, especially for context restoration, MVP implementation, Provider Studio, AgentRouter CLI/HTTP routing, x402 dev payments, service registry, or reducing Codex context usage for this project.
---

# AgentRouter Project

Use this skill to work on the local Agent Native Data Network MVP without reloading long chat history.

## First Read

Read these files in order, only as needed:

1. `AGENTS.md` for the shortest project context.
2. `docs/STATUS.md` for current state and next decisions.
3. `docs/MVP_WORKFLOWS.md` for provider/demand-side flows.
4. `docs/ARCHITECTURE.md` for component boundaries and trust notes.

## Common Commands

```bash
npm test
npm start
PORT=8800 npm start
AGENT_ROUTER_URL=http://127.0.0.1:8800 node bin/agent-router.js ask "查询标记为 Matrixport 的地址"
```

## Editing Guidance

- Keep product decisions in `docs/`, not only in chat.
- Keep user-facing Claude instructions in `claude-skills/agent-router/SKILL.md`.
- Keep development-agent context in `AGENTS.md` and this skill.
- After meaningful changes, update `docs/STATUS.md` with current state and next decisions.
- Verify with `npm test` after code changes.
