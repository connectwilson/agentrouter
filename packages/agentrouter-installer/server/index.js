import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_ROUTER_URL = "https://agentrouter.network";
const MCP_PACKAGE = "@agentrouternetwork/mcp@latest";
const INSTALLER_VERSION = "0.2.0";

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

  const result = {
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

  if (!options.full) return result;

  const client = await resolveCurrentClient({ home, env: options.env || process.env });
  if (!client) {
    throw new Error(
      "No supported current AI client configuration was found. " +
      "Open Claude Code or Cursor once, then rerun with --full."
    );
  }

  const configuredClient = await configureMcpClient(client, origin);
  const verification = await verifyRemoteMcp(result.remote_mcp_url);
  if (!verification.tools.includes("agentrouter_fetch")) {
    throw new Error(`AgentRouter MCP at ${result.remote_mcp_url} did not expose agentrouter_fetch.`);
  }

  return {
    ...result,
    runtime_mode: "mcp",
    mcp_verified: true,
    mcp_tools: verification.tools,
    configured_clients: [configuredClient]
  };
}

export function formatInstallResult(result) {
  if (result.runtime_mode === "mcp") {
    return [
      "AgentRouter installed. READY (MCP mode)",
      `Skill installed: ${result.skill_paths.join(", ")}`,
      `MCP configured: ${result.configured_clients.map((client) => client.name).join(", ")}`,
      `MCP verified: ${result.mcp_tools.join(", ")}`,
      "No local wallet was created. Hosted paid calls use AgentRouter account credits.",
      "Reload the AI client once if the new tools are not visible yet."
    ].join("\n") + "\n";
  }
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
    } else if (arg === "--full") {
      options.full = true;
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
  npx @agentrouternetwork/agentrouter
  npx @agentrouternetwork/agentrouter --full
  npx @agentrouternetwork/agentrouter --json
  npx @agentrouternetwork/agentrouter --url https://agentrouter.network

Installs the AgentRouter Skill and verifies the hosted HTTP runtime.
Use --full to also configure the current supported AI client and verify
that its AgentRouter MCP endpoint exposes agentrouter_fetch.
Neither mode creates a local wallet.
`;
}

async function resolveCurrentClient({ home, env }) {
  const candidates = [
    {
      name: "Claude Code",
      explicit: env.CLAUDE_CODE_CONFIG,
      configPath: env.CLAUDE_CODE_CONFIG || path.join(home, ".claude.json")
    },
    {
      name: "Cursor",
      explicit: env.CURSOR_MCP_CONFIG,
      configPath: env.CURSOR_MCP_CONFIG || path.join(home, ".cursor", "mcp.json")
    },
    {
      name: "Claude Desktop",
      explicit: env.CLAUDE_DESKTOP_MCP_CONFIG,
      configPath: env.CLAUDE_DESKTOP_MCP_CONFIG ||
        path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    }
  ];
  const explicit = candidates.find((candidate) => candidate.explicit);
  if (explicit) return explicit;
  for (const candidate of candidates) {
    if (await exists(candidate.configPath)) return candidate;
  }
  return null;
}

async function configureMcpClient(client, origin) {
  let config = {};
  if (await exists(client.configPath)) {
    const source = await fs.readFile(client.configPath, "utf8");
    try {
      config = JSON.parse(source);
    } catch {
      throw new Error(`${client.name} MCP configuration is not valid JSON: ${client.configPath}`);
    }
    const backupPath = `${client.configPath}.bak.${Date.now()}`;
    await fs.copyFile(client.configPath, backupPath);
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error(`${client.name} MCP configuration must contain a JSON object: ${client.configPath}`);
  }
  const mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  config.mcpServers = {
    ...mcpServers,
    AgentRouter: {
      command: "npx",
      args: ["-y", "--package", MCP_PACKAGE, "agentrouter-mcp"],
      env: { AGENT_ROUTER_URL: origin }
    }
  };
  await fs.mkdir(path.dirname(client.configPath), { recursive: true });
  await fs.writeFile(client.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { name: client.name, config_path: client.configPath };
}

async function verifyRemoteMcp(url) {
  const initialize = await postMcp(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentrouter-installer", version: INSTALLER_VERSION }
    }
  });
  if (initialize.payload?.error || initialize.payload?.result?.serverInfo?.name !== "AgentRouter") {
    throw new Error(`AgentRouter MCP initialize failed at ${url}.`);
  }
  const listed = await postMcp(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, initialize.sessionId);
  if (listed.payload?.error || !Array.isArray(listed.payload?.result?.tools)) {
    throw new Error(`AgentRouter MCP tools/list failed at ${url}.`);
  }
  return {
    tools: listed.payload.result.tools
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
  };
}

async function postMcp(url, message, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`AgentRouter MCP is unreachable at ${url}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`AgentRouter MCP returned HTTP ${response.status} at ${url}.`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`AgentRouter MCP returned invalid JSON at ${url}.`);
  }
  return { payload, sessionId: response.headers.get("mcp-session-id") || sessionId };
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

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
