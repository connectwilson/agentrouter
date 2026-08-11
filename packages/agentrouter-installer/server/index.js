import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_ROUTER_URL = "https://agentrouter.network";
const MCP_PACKAGE = "@agentrouternetwork/mcp@latest";
const OPENCLI_PACKAGE = "@jackwener/opencli";
const INSTALLER_VERSION = "0.10.0";

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
    payment: {
      mode: "prepaid_credits",
      account_url: `${origin}/account`,
      local_wallet_created: false
    },
    updates: "Hosted capabilities, providers, routing, and tools update automatically."
  };

  if (options.full === false) return result;

  const client = await resolveCurrentClient({
    home,
    env: options.env || process.env,
    preferredClient: options.client || "",
    customConfigPath: options.configPath || ""
  });
  if (!client) {
    throw new Error(
      "No supported current AI client configuration was found. " +
      "Rerun with --client <name> (claude-code, codex, cursor, claude-desktop, windsurf, gemini, opencode, openclaw, workbuddy) or --client <name> --config-path <file> for any other client."
    );
  }

  const configuredClient = await configureMcpClient(client, origin);
  const verification = await verifyRemoteMcp(result.remote_mcp_url);
  if (!verification.tools.includes("agentrouter_fetch")) {
    throw new Error(`AgentRouter MCP at ${result.remote_mcp_url} did not expose agentrouter_fetch.`);
  }

  const env = options.env || process.env;
  const browserConnector = await ensureLocalBrowserConnector({
    home,
    env,
    autoInstall: options.setupBrowserConnector !== false && !env.AGENTROUTER_SKIP_BROWSER_SETUP,
    runCommand: options.runCommand || runShell
  });

  return {
    ...result,
    runtime_mode: "mcp",
    bridge_configured: true,
    remote_mcp_verified: true,
    mcp_tools: verification.tools,
    configured_clients: [configuredClient],
    browser_connector: browserConnector
  };
}

// Free local social reads (e.g. X posts) run through the OpenCLI browser
// connector on the user's device. Hosted MCP/API tools work without it; this
// step best-effort installs OpenCLI and always returns the manual next steps,
// because connecting the Chrome extension and signing in cannot be scripted.
export async function ensureLocalBrowserConnector({ home, env = process.env, autoInstall = true, runCommand = runShell }) {
  const guide = {
    package: OPENCLI_PACKAGE,
    install_command: `npm install -g ${OPENCLI_PACKAGE}`,
    next_steps: [
      "Install the OpenCLI browser extension in Google Chrome.",
      "Run `opencli doctor` and confirm the extension shows connected.",
      "Sign in to X once in that Chrome profile so reads use your own session."
    ]
  };
  let binPath = await findOpencli(home, env);
  let installAttempted = false;
  let installOk = null;
  if (!binPath && autoInstall) {
    installAttempted = true;
    const result = await runCommand("npm", ["install", "-g", OPENCLI_PACKAGE], { timeout: 180000 });
    installOk = result.status === "completed";
    binPath = await findOpencli(home, env);
  }
  if (!binPath) {
    return { ...guide, status: "not_installed", installed: false, install_attempted: installAttempted, install_ok: installOk };
  }
  return { ...guide, status: "installed", installed: true, path: binPath, install_attempted: installAttempted, install_ok: installOk };
}

function browserConnectorSearchDirs(home, env) {
  return [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...String(env.PATH || "").split(path.delimiter)
  ].filter(Boolean);
}

async function findOpencli(home, env) {
  for (const dir of [...new Set(browserConnectorSearchDirs(home, env))]) {
    const candidate = path.join(dir, "opencli");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function runShell(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ status: "error", error: error.message, stdout, stderr });
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: error.code === "ENOENT" ? "missing" : "error", error: error.message, stdout, stderr }));
    child.on("close", (code) => finish({ status: code === 0 ? "completed" : "failed", code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "timeout", stdout, stderr });
    }, Number(options.timeout) || 180000);
  });
}

export function formatInstallResult(result) {
  if (result.runtime_mode === "mcp") {
    return [
      "AgentRouter installed. SETUP COMPLETE (client reload required)",
      `Skill installed: ${result.skill_paths.join(", ")}`,
      `MCP configured: ${result.configured_clients.map((client) => client.name).join(", ")}`,
      `Remote MCP tools verified: ${result.mcp_tools.join(", ")}`,
      "Local MCP bridge configured. Reload the AI client once to activate local browser routing.",
      ...formatBrowserConnectorLines(result.browser_connector),
      "No local wallet was created. Hosted paid calls use AgentRouter account credits.",
      `For paid calls, sign in and manage credits at: ${result.payment.account_url}`,
      "No API key setup is required. On the first paid call, use agentrouter_connect and approve the named client in your browser.",
      "Reload the AI client once if the new tools are not visible yet."
    ].join("\n") + "\n";
  }
  return [
    "AgentRouter installed. READY (HTTP mode)",
    `Skill installed: ${result.skill_paths.join(", ")}`,
    `Runtime verified: ${result.health_url}`,
    "No MCP configuration or local wallet was changed.",
    `For paid calls, sign in and manage credits at: ${result.payment.account_url}`,
    "Ask a normal data/API question to use AgentRouter."
  ].join("\n") + "\n";
}

function formatBrowserConnectorLines(connector) {
  if (!connector) return [];
  if (connector.installed) {
    return [
      `Browser connector ready: OpenCLI at ${connector.path}.`,
      "To enable FREE local X/social reads, connect the OpenCLI Chrome extension (`opencli doctor`) and sign in to X once."
    ];
  }
  return [
    `Browser connector NOT installed (needed only for free local X/social reads). Install: ${connector.install_command}`,
    "Then connect the OpenCLI Chrome extension (`opencli doctor`) and sign in to X once. Hosted API/MCP tools work without this."
  ];
}

export function parseInstallArgs(argv) {
  const options = { full: true };
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
    } else if (arg === "--http-only") {
      options.full = false;
    } else if (arg === "--no-browser-setup") {
      options.setupBrowserConnector = false;
    } else if (arg === "--config-path") {
      options.configPath = requireValue(argv[++index], "--config-path");
    } else if (arg.startsWith("--config-path=")) {
      options.configPath = arg.slice("--config-path=".length);
    } else if (arg === "--client") {
      options.client = requireValue(argv[++index], "--client");
    } else if (arg.startsWith("--client=")) {
      options.client = arg.slice("--client=".length);
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
  npx @agentrouternetwork/agentrouter --client claude-code
  npx @agentrouternetwork/agentrouter --client codex
  npx @agentrouternetwork/agentrouter --client windsurf
  npx @agentrouternetwork/agentrouter --client gemini
  npx @agentrouternetwork/agentrouter --client opencode
  npx @agentrouternetwork/agentrouter --client openclaw
  npx @agentrouternetwork/agentrouter --client workbuddy
  npx @agentrouternetwork/agentrouter --client MyAgent --config-path ~/.myagent/mcp.json
  npx @agentrouternetwork/agentrouter --http-only
  npx @agentrouternetwork/agentrouter --json
  npx @agentrouternetwork/agentrouter --url https://agentrouter.network

Installs the AgentRouter Skill, configures one detected current AI client with
the local MCP bridge, verifies the hosted AgentRouter tools, and best-effort
installs the OpenCLI browser connector used for free local X/social reads. Use
--http-only to skip MCP configuration and --no-browser-setup to skip the
OpenCLI install. Neither mode creates a local wallet.
`;
}

async function resolveCurrentClient({ home, env, preferredClient = "", customConfigPath = "" }) {
  const candidates = [
    {
      id: "claude-code",
      name: "Claude Code",
      explicit: env.CLAUDE_CODE_CONFIG,
      configPath: env.CLAUDE_CODE_CONFIG || path.join(home, ".claude.json")
    },
    {
      id: "cursor",
      name: "Cursor",
      explicit: env.CURSOR_MCP_CONFIG,
      configPath: env.CURSOR_MCP_CONFIG || path.join(home, ".cursor", "mcp.json")
    },
    {
      id: "codex",
      name: "Codex",
      format: "toml",
      explicit: env.CODEX_MCP_CONFIG,
      configPath: env.CODEX_MCP_CONFIG || path.join(home, ".codex", "config.toml")
    },
    {
      id: "windsurf",
      name: "Windsurf",
      explicit: env.WINDSURF_MCP_CONFIG,
      configPath: env.WINDSURF_MCP_CONFIG || path.join(home, ".codeium", "windsurf", "mcp_config.json")
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      explicit: env.GEMINI_MCP_CONFIG,
      configPath: env.GEMINI_MCP_CONFIG || path.join(home, ".gemini", "settings.json")
    },
    {
      id: "opencode",
      name: "opencode",
      format: "opencode",
      explicit: env.OPENCODE_MCP_CONFIG,
      configPath: env.OPENCODE_MCP_CONFIG || path.join(home, ".config", "opencode", "opencode.json")
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      format: "openclaw",
      explicit: env.OPENCLAW_MCP_CONFIG,
      configPath: env.OPENCLAW_MCP_CONFIG || path.join(home, ".openclaw", "openclaw.json")
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      explicit: env.WORKBUDDY_MCP_CONFIG,
      configPath: env.WORKBUDDY_MCP_CONFIG || path.join(home, ".workbuddy", ".mcp.json")
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      explicit: env.CLAUDE_DESKTOP_MCP_CONFIG,
      configPath: env.CLAUDE_DESKTOP_MCP_CONFIG ||
        path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    }
  ];
  if (preferredClient && customConfigPath) {
    return {
      id: "custom",
      name: preferredClient,
      configPath: customConfigPath,
      format: customConfigPath.endsWith(".toml") ? "toml" : "json"
    };
  }
  const requested = normalizeClientId(preferredClient);
  if (requested) {
    const selected = candidates.find((candidate) => candidate.id === requested);
    if (!selected) throw new Error(`Unsupported client: ${preferredClient}`);
    return selected;
  }
  const explicit = candidates.find((candidate) => candidate.explicit);
  if (explicit) return explicit;
  const hostClientId = detectedHostClient(env);
  const hostClient = candidates.find((candidate) => candidate.id === hostClientId);
  if (hostClient) return hostClient;
  const existing = [];
  for (const candidate of candidates) {
    if (!await exists(candidate.configPath)) continue;
    existing.push({
      ...candidate,
      hasAgentRouter: await configHasAgentRouter(candidate.configPath),
      modifiedAt: await fs.stat(candidate.configPath).then((stat) => stat.mtimeMs, () => 0)
    });
  }
  return existing.sort((left, right) =>
    Number(right.hasAgentRouter) - Number(left.hasAgentRouter)
    || right.modifiedAt - left.modifiedAt
  )[0] || null;
}

function detectedHostClient(env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) return "cursor";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID || env.CODEX_HOME) return "codex";
  if (env.WINDSURF_SESSION_ID || env.WINDSURF_USER_ID) return "windsurf";
  if (env.GEMINI_CLI || env.GEMINI_API_KEY_SOURCE) return "gemini";
  if (env.OPENCODE || env.OPENCODE_SESSION_ID) return "opencode";
  if (env.OPENCLAW_HOME || env.OPENCLAW_SESSION_ID) return "openclaw";
  if (env.WORKBUDDY_HOME || env.WORKBUDDY_SESSION_ID) return "workbuddy";
  if (env.CLAUDE_DESKTOP) return "claude-desktop";
  return "";
}

function normalizeClientId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const aliases = {
    claude: "claude-code",
    "claude-code": "claude-code",
    cursor: "cursor",
    codex: "codex",
    windsurf: "windsurf",
    gemini: "gemini",
    "gemini-cli": "gemini",
    opencode: "opencode",
    openclaw: "openclaw",
    workbuddy: "workbuddy",
    "work-buddy": "workbuddy",
    desktop: "claude-desktop",
    "claude-desktop": "claude-desktop"
  };
  return aliases[normalized] || normalized;
}

async function configureMcpClient(client, origin) {
  if (client.format === "toml") return configureTomlMcpClient(client, origin);
  if (client.format === "opencode") return configureOpencodeMcpClient(client, origin);
  if (client.format === "openclaw") return configureOpenclawMcpClient(client, origin);
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
  const existing = mcpServers.AgentRouter && typeof mcpServers.AgentRouter === "object"
    ? mcpServers.AgentRouter
    : {};
  const {
    command: _oldCommand,
    args: _oldArgs,
    url: _oldUrl,
    type: _oldType,
    transport: _oldTransport,
    env: existingEnv,
    ...preservedSettings
  } = existing;
  config.mcpServers = {
    ...mcpServers,
    AgentRouter: {
      ...preservedSettings,
      command: "npx",
      args: ["-y", "--package", MCP_PACKAGE, "agentrouter-mcp"],
      env: {
        ...(existingEnv && typeof existingEnv === "object" ? existingEnv : {}),
        AGENT_ROUTER_URL: existingEnv?.AGENT_ROUTER_URL || origin
      }
    }
  };
  await fs.mkdir(path.dirname(client.configPath), { recursive: true });
  await fs.writeFile(client.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { name: client.name, config_path: client.configPath };
}

// OpenClaw nests servers under mcp.servers rather than a top-level mcpServers,
// and the same file holds unrelated plugin/tool configuration.
async function configureOpenclawMcpClient(client, origin) {
  const config = await readJsonConfig(client);
  const mcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp) ? config.mcp : {};
  const servers = mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers) ? mcp.servers : {};
  const existing = servers.AgentRouter && typeof servers.AgentRouter === "object" ? servers.AgentRouter : {};
  const existingEnv = existing.env && typeof existing.env === "object" ? existing.env : {};
  config.mcp = {
    ...mcp,
    servers: {
      ...servers,
      AgentRouter: {
        ...existing,
        command: "npx",
        args: ["-y", "--package", MCP_PACKAGE, "agentrouter-mcp"],
        env: { ...existingEnv, AGENT_ROUTER_URL: existingEnv.AGENT_ROUTER_URL || origin }
      }
    }
  };
  await writeJsonConfig(client, config);
  return { name: client.name, config_path: client.configPath };
}

async function readJsonConfig(client) {
  let config = {};
  if (await exists(client.configPath)) {
    const source = await fs.readFile(client.configPath, "utf8");
    try {
      config = JSON.parse(source);
    } catch {
      throw new Error(`${client.name} MCP configuration is not valid JSON: ${client.configPath}`);
    }
    await fs.copyFile(client.configPath, `${client.configPath}.bak.${Date.now()}`);
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error(`${client.name} MCP configuration must contain a JSON object: ${client.configPath}`);
  }
  return config;
}

async function writeJsonConfig(client, config) {
  await fs.mkdir(path.dirname(client.configPath), { recursive: true });
  await fs.writeFile(client.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// opencode keeps servers under "mcp" and expects the command as a single
// argv array with "environment" rather than "env".
async function configureOpencodeMcpClient(client, origin) {
  let config = {};
  if (await exists(client.configPath)) {
    const source = await fs.readFile(client.configPath, "utf8");
    try {
      config = JSON.parse(source);
    } catch {
      throw new Error(`${client.name} MCP configuration is not valid JSON: ${client.configPath}`);
    }
    await fs.copyFile(client.configPath, `${client.configPath}.bak.${Date.now()}`);
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error(`${client.name} MCP configuration must contain a JSON object: ${client.configPath}`);
  }
  const servers = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp) ? config.mcp : {};
  const existing = servers.AgentRouter && typeof servers.AgentRouter === "object" ? servers.AgentRouter : {};
  const existingEnv = existing.environment && typeof existing.environment === "object" ? existing.environment : {};
  config.mcp = {
    ...servers,
    AgentRouter: {
      ...existing,
      type: "local",
      command: ["npx", "-y", "--package", MCP_PACKAGE, "agentrouter-mcp"],
      enabled: true,
      environment: { ...existingEnv, AGENT_ROUTER_URL: existingEnv.AGENT_ROUTER_URL || origin }
    }
  };
  await fs.mkdir(path.dirname(client.configPath), { recursive: true });
  await fs.writeFile(client.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { name: client.name, config_path: client.configPath };
}

// Codex stores MCP servers in config.toml. Rather than depend on a TOML
// library, replace just the [mcp_servers.AgentRouter] block and leave every
// other line of the user's config untouched.
async function configureTomlMcpClient(client, origin) {
  let source = "";
  if (await exists(client.configPath)) {
    source = await fs.readFile(client.configPath, "utf8");
    await fs.copyFile(client.configPath, `${client.configPath}.bak.${Date.now()}`);
  }
  const existingEnv = readTomlAgentRouterEnv(source);
  const block = [
    "[mcp_servers.AgentRouter]",
    'command = "npx"',
    `args = ["-y", "--package", "${MCP_PACKAGE}", "agentrouter-mcp"]`,
    "startup_timeout_sec = 120",
    "",
    "[mcp_servers.AgentRouter.env]",
    `AGENT_ROUTER_URL = "${existingEnv.AGENT_ROUTER_URL || origin}"`,
    ...Object.entries(existingEnv)
      .filter(([key]) => key !== "AGENT_ROUTER_URL")
      .map(([key, value]) => `${key} = "${value}"`)
  ].join("\n");
  const stripped = stripTomlAgentRouterBlocks(source);
  const next = `${stripped ? `${stripped.replace(/\n+$/, "")}\n\n` : ""}${block}\n`;
  await fs.mkdir(path.dirname(client.configPath), { recursive: true });
  await fs.writeFile(client.configPath, next, { mode: 0o600 });
  return { name: client.name, config_path: client.configPath };
}

function stripTomlAgentRouterBlocks(source) {
  const lines = String(source || "").split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.AgentRouter(\.[A-Za-z0-9_-]+)?\]\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    // Any other table header ends the block we are dropping.
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function readTomlAgentRouterEnv(source) {
  const lines = String(source || "").split("\n");
  const env = {};
  let inEnv = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.AgentRouter\.env\]\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv && /^\s*\[/.test(line)) break;
    const match = inEnv && line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

async function configHasAgentRouter(filePath) {
  try {
    const source = await fs.readFile(filePath, "utf8");
    if (filePath.endsWith(".toml")) return /^\s*\[mcp_servers\.AgentRouter\]/m.test(source);
    const parsed = JSON.parse(source);
    if (parsed?.mcp?.AgentRouter || parsed?.mcp?.servers?.AgentRouter) return true;
    return Boolean(JSON.parse(source)?.mcpServers?.AgentRouter);
  } catch {
    return false;
  }
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
