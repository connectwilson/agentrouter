import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatInstallResult } from "../packages/agentrouter-installer/server/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = fs.readFileSync(path.join(here, "..", "claude-skills", "agent-router", "SKILL.md"), "utf8");

test("account connection language can never authorize running the installer", () => {
  assert.match(skill, /connect(?:ion)? intent.*not installation intent/i);
  assert.match(skill, /帮我连接 AgentRouter/);
  assert.match(skill, /must not run the installer/i);
  assert.match(skill, /configured but.*tool.*not visible.*reload/i);
  assert.match(skill, /reload.*does not authorize/i);
});

test("an idempotent installer run reports already configured instead of installed", () => {
  const message = formatInstallResult({
    runtime_mode: "mcp",
    setup_action: "already_configured",
    reload_required: false,
    skill_paths: ["/tmp/skill"],
    configured_clients: [{ name: "Codex" }],
    mcp_tools: ["agentrouter_fetch"],
    payment: { account_url: "https://agentrouter.network/account" }
  });

  assert.match(message, /already configured/i);
  assert.match(message, /No reinstall/i);
  assert.match(message, /agentrouter_connect/);
  assert.doesNotMatch(message, /SETUP COMPLETE \(client reload required\)/);
  assert.doesNotMatch(message, /AgentRouter installed\./);
});
