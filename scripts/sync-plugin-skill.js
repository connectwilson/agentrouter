#!/usr/bin/env node
// Sync the hosted AgentRouter skill into the Agent Plugins package.
// Source of truth: https://agentrouter.network/SKILL.md
// The committed copy in plugin/skills/agentrouter/SKILL.md must match the hosted
// skill; test/agent-plugin.test.js fails on drift. Run this script to refresh.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSkill = path.join(here, "..", "plugin", "skills", "agentrouter", "SKILL.md");
const hostedSkillUrl =
  process.env.AGENTROUTER_SKILL_URL || "https://agentrouter.network/SKILL.md";

const res = await fetch(hostedSkillUrl, {
  signal: AbortSignal.timeout(30000)
});
if (!res.ok) {
  throw new Error(`Failed to fetch hosted skill at ${hostedSkillUrl}: HTTP ${res.status}`);
}
const text = await res.text();

await fs.mkdir(path.dirname(pluginSkill), { recursive: true });
await fs.writeFile(pluginSkill, text);

console.log(`Synced plugin skill (${text.length} bytes) from ${hostedSkillUrl}`);
console.log(`Wrote ${path.relative(process.cwd(), pluginSkill)}`);
