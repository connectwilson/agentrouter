#!/usr/bin/env node
// Sync the canonical committed AgentRouter skill into the Agent Plugins package.
// The hosted copy is deployed from this repository and can lag behind a change;
// it must never overwrite a newer routing policy during development.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const canonicalSkill = path.join(here, "..", "claude-skills", "agent-router", "SKILL.md");
const pluginSkill = path.join(here, "..", "plugin", "skills", "agentrouter", "SKILL.md");
const text = await fs.readFile(canonicalSkill, "utf8");

await fs.mkdir(path.dirname(pluginSkill), { recursive: true });
await fs.writeFile(pluginSkill, text);

console.log(`Synced plugin skill (${text.length} bytes) from ${path.relative(process.cwd(), canonicalSkill)}`);
console.log(`Wrote ${path.relative(process.cwd(), pluginSkill)}`);
