import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_ROUTER_URL = "https://agentrouter.network";

export async function installAgentRouter(options = {}) {
  const home = options.home || os.homedir();
  const origin = trimTrailingSlash(options.agentRouterUrl || process.env.AGENT_ROUTER_URL || DEFAULT_AGENT_ROUTER_URL);
  const skillUrl = `${origin}/SKILL.md`;
  const healthUrl = `${origin}/agent-router/health`;
  const skillText = await fetchText(skillUrl, "AgentRouter Skill");
  const skillDirs = resolveSkillDirs({
    home,
    value: options.skillDirs || process.env.AGENTROUTER_SKILL_DIRS
  });

  for (const skillDir of skillDirs) {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillText);
  }

  const health = await fetchJson(healthUrl, "AgentRouter HTTP runtime");
  const httpReady = health.ok === true &&
    Array.isArray(health.runtime_modes) &&
    health.runtime_modes.includes("http") &&
    typeof health.http_fetch === "string";

  if (!httpReady) {
    throw new Error(`AgentRouter HTTP runtime is not ready at ${healthUrl}.`);
  }

  return {
    ok: true,
    status: "READY",
    runtime_mode: "http",
    origin,
    health_url: healthUrl,
    fetch_url: health.http_fetch,
    skill_url: skillUrl,
    skill_paths: skillDirs,
    remote_mcp_url: health.remote_mcp || `${origin}/mcp`,
    updates: "Hosted capabilities, providers, routing, and tools update automatically."
  };
}

export function formatInstallResult(result) {
  return [
    "AgentRouter installed. READY (HTTP mode)",
    `Skill installed: ${result.skill_paths.join(", ")}`,
    `Runtime verified: ${result.health_url}`,
    "No MCP configuration or local wallet was changed.",
    "Ask a normal data/API question to use AgentRouter."
  ].join("\n") + "\n";
}

export function parseInstallArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "install" || arg === "setup") continue;
    if (arg === "--url") {
      options.agentRouterUrl = requireValue(argv[++index], "--url");
    } else if (arg.startsWith("--url=")) {
      options.agentRouterUrl = arg.slice("--url=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function installUsage() {
  return `Usage:
  npx agentrouter
  npx agentrouter --json
  npx agentrouter --url https://agentrouter.network

Installs the AgentRouter Skill and verifies the hosted HTTP runtime.
It does not edit MCP configuration or create a local wallet.
`;
}

async function fetchText(url, label) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(`${label} is unreachable at ${url}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} at ${url}.`);
  return response.text();
}

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(`${label} is unreachable at ${url}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} at ${url}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON at ${url}.`);
  }
}

function resolveSkillDirs({ home, value }) {
  if (value) {
    return String(value)
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => expandHome(item, home));
  }
  return [
    path.join(home, ".agents", "skills", "agentrouter"),
    path.join(home, ".claude", "skills", "agentrouter"),
    path.join(home, ".codex", "skills", "agentrouter")
  ];
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}
