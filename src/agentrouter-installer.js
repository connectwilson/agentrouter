import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");

export const DEFAULT_AGENT_ROUTER_URL = "https://agentrouter.network";
export const DEFAULT_PACKAGE_SPEC = "@agentrouternetwork/mcp@latest";
export const DEFAULT_MCP_COMMAND = "agentrouter-mcp";
export const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";

export async function installAgentRouter(options = {}) {
  const home = options.home || os.homedir();
  const update = options.update === true;
  const claudeConfig = options.claudeConfig || process.env.CLAUDE_DESKTOP_CONFIG || path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cursorConfig = options.cursorConfig || process.env.CURSOR_MCP_CONFIG || path.join(home, ".cursor", "mcp.json");
  const installedSettings = update ? await readInstalledMcpSettings([claudeConfig, cursorConfig]) : {};
  const agentRouterUrl = trimTrailingSlash(options.agentRouterUrl || process.env.AGENT_ROUTER_URL || installedSettings.AGENT_ROUTER_URL || DEFAULT_AGENT_ROUTER_URL);
  const maxPrice = String(options.maxPrice || process.env.AGENT_ROUTER_MAX_PRICE || installedSettings.AGENT_ROUTER_MAX_PRICE || "0.05");
  const arcRpcUrl = options.arcRpcUrl || process.env.ADN_ARC_RPC_URL || installedSettings.ADN_ARC_RPC_URL || DEFAULT_ARC_RPC_URL;
  const packageSpec = options.packageSpec || process.env.AGENTROUTER_MCP_PACKAGE || DEFAULT_PACKAGE_SPEC;
  const adnDir = path.resolve(options.adnDir || process.env.AGENTROUTER_ADN_DIR || installedSettings.ADN_DIR || path.join(home, ".agentrouter", "adn"));
  const requestedClients = options.clients?.length ? options.clients : parseClients(process.env.AGENTROUTER_CLIENT);
  const clients = normalizeClients(requestedClients || (update ? ["installed"] : []));
  const updateEnvOverrides = new Set([
    options.agentRouterUrl || process.env.AGENT_ROUTER_URL ? "AGENT_ROUTER_URL" : "",
    options.maxPrice || process.env.AGENT_ROUTER_MAX_PRICE ? "AGENT_ROUTER_MAX_PRICE" : "",
    options.arcRpcUrl || process.env.ADN_ARC_RPC_URL ? "ADN_ARC_RPC_URL" : "",
    options.adnDir || process.env.AGENTROUTER_ADN_DIR ? "ADN_DIR" : ""
  ].filter(Boolean));
  const result = {
    ok: true,
    action: update ? "update" : "install",
    agent_router_url: agentRouterUrl,
    skill_paths: [],
    configured_clients: [],
    skipped_clients: [],
    wallet: null,
    readiness: null,
    next_steps: []
  };

  if (options.installSkill !== false) {
    const skillText = await loadSkillMarkdown({
      skillText: options.skillText,
      skillUrl: options.skillUrl || `${agentRouterUrl}/skills/AgentRouter/SKILL.md`
    });
    const resolvedSkillDirs = resolveSkillDirs({ home, value: options.skillDirs || process.env.AGENTROUTER_SKILL_DIRS });
    const skillDirs = update ? await existingSkillDirsOrFallback(resolvedSkillDirs) : resolvedSkillDirs;
    for (const skillDir of skillDirs) {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillText);
      result.skill_paths.push(skillDir);
    }
  }

  const mcpServer = createMcpServerConfig({ agentRouterUrl, maxPrice, arcRpcUrl, adnDir, packageSpec });

  if (await shouldConfigureClient({ client: "claude-desktop", clients, configPath: claudeConfig, forceEnv: process.env.AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP })) {
    await writeMcpConfig(claudeConfig, mcpServer, { preserveAgentRouterSettings: update, overrideEnvKeys: updateEnvOverrides });
    result.configured_clients.push({ name: "Claude Desktop", config_path: claudeConfig });
  } else {
    result.skipped_clients.push({ name: "Claude Desktop", reason: "config directory not found" });
  }

  if (await shouldConfigureClient({ client: "cursor", clients, configPath: cursorConfig, forceEnv: process.env.AGENTROUTER_CONFIGURE_CURSOR })) {
    await writeMcpConfig(cursorConfig, mcpServer, { preserveAgentRouterSettings: update, overrideEnvKeys: updateEnvOverrides });
    result.configured_clients.push({ name: "Cursor", config_path: cursorConfig });
  } else {
    result.skipped_clients.push({ name: "Cursor", reason: "config directory not found" });
  }

  const shouldCreateWallet = options.createWallet === true;
  if (shouldCreateWallet) {
    result.wallet = await createLocalWallet({ adnDir, cwd: options.cwd || repoRoot });
  }

  result.readiness = await diagnoseAgentRouter({
    home,
    agentRouterUrl,
    adnDir,
    claudeConfig,
    cursorConfig,
    requireConfiguredClient: options.requireConfiguredClient === true,
    includeOptionalChecks: clients.size > 0 || shouldCreateWallet,
    skipNetwork: options.skipNetworkCheck === true
  });
  result.ok = result.readiness.ready;

  if (result.configured_clients.length) {
    result.next_steps.push("Optional MCP configured. Restart or reload that AI client to activate AgentRouter MCP tools.");
  } else {
    result.next_steps.push("AgentRouter is ready in HTTP mode. No additional configuration is required.");
  }
  if (update) {
    result.next_steps.push("Existing wallet files, API keys, and custom AgentRouter environment settings were preserved.");
  } else if (result.wallet?.address) {
    result.next_steps.push(`Fund ${result.wallet.address} with Arc Testnet USDC before the first paid data call.`);
  }
  result.next_steps.push("Then ask a normal data/API question; AgentRouter is available as the routing tool.");

  return result;
}

export function formatInstallResult(result) {
  const lines = [];
  const action = result.action === "update" ? "updated" : "installed";
  lines.push(result.ok
    ? `AgentRouter ${action}. READY (${result.readiness?.runtime_mode === "http" ? "HTTP mode" : "runtime ready"})`
    : `AgentRouter ${action}. NOT_READY`);
  if (result.skill_paths?.length) {
    lines.push(`Skill ${action}: ${result.skill_paths.join(", ")}`);
  }
  if (result.configured_clients?.length) {
    for (const client of result.configured_clients) {
      lines.push(`${client.name} MCP configured: ${client.config_path}`);
    }
  }
  if (result.wallet?.address) {
    lines.push("AgentRouter local payment wallet ready.");
    lines.push(`Fund address: ${result.wallet.address}`);
    lines.push("Network: Arc Testnet");
    lines.push("Token: USDC");
    lines.push("Suggested first top-up: 0.05 USDC");
  } else if (result.wallet?.error) {
    lines.push(`Wallet was not created automatically: ${result.wallet.error}`);
  }
  if (result.readiness) {
    lines.push(`Readiness: ${result.readiness.status}`);
    for (const check of result.readiness.checks || []) {
      lines.push(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`);
    }
  }
  for (const nextStep of result.next_steps || []) {
    lines.push(nextStep);
  }
  lines.push(`Remote MCP: ${trimTrailingSlash(result.agent_router_url)}/mcp`);
  return `${lines.join("\n")}\n`;
}

export function parseInstallArgs(argv) {
  const options = { clients: [] };
  const args = [...argv];
  if (args[0] === "install" || args[0] === "setup") args.shift();
  if (args[0] === "update" || args[0] === "upgrade") {
    options.update = true;
    args.shift();
  }
  if (args[0] === "doctor" || args[0] === "diagnose" || args[0] === "status") {
    options.doctor = true;
    args.shift();
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--client") {
      options.clients.push(requireValue(args[++i], "--client"));
    } else if (arg.startsWith("--client=")) {
      options.clients.push(arg.slice("--client=".length));
    } else if (arg === "--url") {
      options.agentRouterUrl = requireValue(args[++i], "--url");
    } else if (arg.startsWith("--url=")) {
      options.agentRouterUrl = arg.slice("--url=".length);
    } else if (arg === "--max-price") {
      options.maxPrice = requireValue(args[++i], "--max-price");
    } else if (arg.startsWith("--max-price=")) {
      options.maxPrice = arg.slice("--max-price=".length);
    } else if (arg === "--adn-dir") {
      options.adnDir = requireValue(args[++i], "--adn-dir");
    } else if (arg.startsWith("--adn-dir=")) {
      options.adnDir = arg.slice("--adn-dir=".length);
    } else if (arg === "--skill-url") {
      options.skillUrl = requireValue(args[++i], "--skill-url");
    } else if (arg.startsWith("--skill-url=")) {
      options.skillUrl = arg.slice("--skill-url=".length);
    } else if (arg === "--mcp") {
      if (!options.clients.length) options.clients.push("auto");
    } else if (arg === "--wallet") {
      options.createWallet = true;
    } else if (arg === "--no-wallet") {
      options.createWallet = false;
    } else if (arg === "--no-skill") {
      options.installSkill = false;
    } else if (arg === "--no-network-check") {
      options.skipNetworkCheck = true;
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
  npx @agentrouternetwork/agentrouter
  agentrouter install
  agentrouter update
  agentrouter doctor
  agentrouter --mcp
  agentrouter --mcp --wallet
  agentrouter install --client cursor
  agentrouter install --client claude-desktop
  agentrouter install --client all

Default behavior:
  Installs the AgentRouter Skill and verifies the hosted HTTP runtime.
  Does not modify MCP configuration, create a wallet, or require a second command.

Options:
  --url <url>        AgentRouter server URL. Default: https://agentrouter.network
  --max-price <n>   Default max price per data call in USDC. Default: 0.05
  --adn-dir <path>  Local AgentRouter wallet/payment directory.
  --mcp             Optionally configure detected local MCP clients.
  --wallet          Optionally create a local payment wallet.
  --client <name>   Configure one MCP client: cursor, claude-desktop, or all.
  --json            Print machine-readable JSON.
  --no-network-check  Skip remote health check.
  --no-wallet       Compatibility flag; wallet creation is already off by default.
  --no-skill        Configure only explicitly requested optional components.
`;
}

export async function diagnoseAgentRouter(options = {}) {
  const home = options.home || os.homedir();
  const agentRouterUrl = trimTrailingSlash(options.agentRouterUrl || process.env.AGENT_ROUTER_URL || DEFAULT_AGENT_ROUTER_URL);
  const adnDir = path.resolve(options.adnDir || process.env.AGENTROUTER_ADN_DIR || path.join(home, ".agentrouter", "adn"));
  const claudeConfig = options.claudeConfig || process.env.CLAUDE_DESKTOP_CONFIG || path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cursorConfig = options.cursorConfig || process.env.CURSOR_MCP_CONFIG || path.join(home, ".cursor", "mcp.json");
  const skillDirs = resolveSkillDirs({ home, value: options.skillDirs || process.env.AGENTROUTER_SKILL_DIRS });
  const checks = [];

  checks.push(await checkAnySkillInstalled(skillDirs));
  let claude = null;
  let cursor = null;
  if (options.includeOptionalChecks !== false) {
    checks.push(await checkWallet(adnDir));
    claude = await checkMcpConfig("Claude Desktop", claudeConfig, { agentRouterUrl, adnDir });
    cursor = await checkMcpConfig("Cursor", cursorConfig, { agentRouterUrl, adnDir });
    checks.push(claude, cursor);
  }
  if (options.skipNetwork !== true) checks.push(await checkRemoteHealth(agentRouterUrl));

  const hasClient = Boolean(claude?.ok || cursor?.ok);
  if (options.requireConfiguredClient === true) {
    checks.push({
      name: "client_config",
      ok: hasClient,
      message: hasClient ? "At least one local MCP client is configured." : "No supported local MCP client config contains AgentRouter."
    });
  }

  const ready = checks.filter((check) => check.required !== false).every((check) => check.ok);
  return {
    ok: ready,
    ready,
    status: ready ? "READY" : "NOT_READY",
    runtime_mode: ready ? "http" : null,
    agent_router_url: agentRouterUrl,
    checks,
    repair_command: "npx @agentrouternetwork/agentrouter",
    next_step: ready
      ? "AgentRouter is ready in HTTP mode. Ask a normal data/API question."
      : "Run the repair command, then run agentrouter doctor again."
  };
}

export function formatDoctorResult(result) {
  const lines = [`AgentRouter doctor: ${result.status}`];
  for (const check of result.checks || []) {
    lines.push(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`);
  }
  if (!result.ready) lines.push(`Repair: ${result.repair_command}`);
  lines.push(result.next_step);
  return `${lines.join("\n")}\n`;
}

async function loadSkillMarkdown({ skillText, skillUrl }) {
  if (skillText) return skillText;
  try {
    const response = await fetch(skillUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    const fallbackPath = path.join(repoRoot, "claude-skills", "agent-router", "SKILL.md");
    try {
      return await fs.readFile(fallbackPath, "utf8");
    } catch {
      throw new Error(`Unable to fetch AgentRouter Skill from ${skillUrl}: ${error.message}`);
    }
  }
}

async function checkAnySkillInstalled(skillDirs) {
  const installed = [];
  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillDir, "SKILL.md");
    if (await fileExists(skillPath)) installed.push(skillPath);
  }
  return {
    name: "skill",
    ok: installed.length > 0,
    message: installed.length ? `Found AgentRouter Skill at ${installed.join(", ")}` : "AgentRouter Skill is not installed.",
    paths: installed
  };
}

async function checkWallet(adnDir) {
  const walletPath = path.join(adnDir, "wallet.json");
  const sessionPath = path.join(adnDir, "wallet-session.key");
  if (!await fileExists(walletPath)) {
    return {
      name: "wallet",
      required: false,
      ok: false,
      message: `Local payment wallet is missing at ${walletPath}.`,
      wallet_path: walletPath
    };
  }
  try {
    const wallet = JSON.parse(await fs.readFile(walletPath, "utf8"));
    return {
      name: "wallet",
      required: false,
      ok: Boolean(wallet.address && await fileExists(sessionPath)),
      message: wallet.address && await fileExists(sessionPath)
        ? `Local payment wallet is ready: ${wallet.address}`
        : "Local payment wallet exists but session secret or address is missing.",
      wallet_path: walletPath,
      address: wallet.address || null
    };
  } catch (error) {
    return {
      name: "wallet",
      required: false,
      ok: false,
      message: `Local payment wallet is unreadable: ${error.message}`,
      wallet_path: walletPath
    };
  }
}

async function checkMcpConfig(clientName, configPath, { agentRouterUrl, adnDir }) {
  if (!await fileExists(configPath)) {
    return {
      name: `${slug(clientName)}_mcp`,
      required: false,
      ok: false,
      message: `${clientName} MCP config is missing at ${configPath}.`,
      config_path: configPath
    };
  }
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8") || "{}");
    const server = config?.mcpServers?.AgentRouter;
    const ok = Boolean(
      server &&
      server.command === "npx" &&
      Array.isArray(server.args) &&
      (server.args.includes("agentrouter-mcp") || server.args.includes("agent-router-mcp")) &&
      server.env?.AGENT_ROUTER_URL === agentRouterUrl &&
      server.env?.ADN_PAYMENT_BACKEND === "circle_arc" &&
      server.env?.ADN_DIR === adnDir
    );
    return {
      name: `${slug(clientName)}_mcp`,
      required: false,
      ok,
      message: ok ? `${clientName} MCP config is ready.` : `${clientName} MCP config exists but AgentRouter is missing or misconfigured.`,
      config_path: configPath
    };
  } catch (error) {
    return {
      name: `${slug(clientName)}_mcp`,
      required: false,
      ok: false,
      message: `${clientName} MCP config is not valid JSON: ${error.message}`,
      config_path: configPath
    };
  }
}

async function checkRemoteHealth(agentRouterUrl) {
  try {
    const response = await fetch(`${agentRouterUrl}/agent-router/health`, { signal: AbortSignal.timeout(8000) });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Health endpoint should be JSON, but the HTTP status is still useful.
    }
    const ok = response.ok &&
      payload.ok === true &&
      Array.isArray(payload.runtime_modes) &&
      payload.runtime_modes.includes("http") &&
      typeof payload.http_fetch === "string";
    return {
      name: "remote_health",
      ok,
      message: ok ? `AgentRouter server is reachable at ${agentRouterUrl}.` : `AgentRouter server health check failed with HTTP ${response.status}.`,
      status_code: response.status
    };
  } catch (error) {
    return {
      name: "remote_health",
      ok: false,
      message: `AgentRouter server is unreachable: ${error.message}`
    };
  }
}

function resolveSkillDirs({ home, value }) {
  if (value) {
    return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean).map((item) => expandHome(item, home));
  }
  return [
    path.join(home, ".agents", "skills", "agentrouter"),
    path.join(home, ".claude", "skills", "agentrouter"),
    path.join(home, ".codex", "skills", "agentrouter")
  ];
}

function createMcpServerConfig({ agentRouterUrl, maxPrice, arcRpcUrl, adnDir, packageSpec }) {
  return {
    command: "npx",
    args: ["-y", "--package", packageSpec, DEFAULT_MCP_COMMAND],
    env: {
      AGENT_ROUTER_URL: agentRouterUrl,
      AGENT_ROUTER_MAX_PRICE: maxPrice,
      ADN_PAYMENT_BACKEND: "circle_arc",
      ADN_ARC_RPC_URL: arcRpcUrl,
      ADN_DIR: adnDir
    }
  };
}

async function shouldConfigureClient({ client, clients, configPath, forceEnv }) {
  if (forceEnv === "1" || forceEnv === "true") return true;
  if (forceEnv === "0" || forceEnv === "false") return false;
  if (clients.has("installed")) return hasAgentRouterConfig(configPath);
  if (clients.has("all") || clients.has(client)) return true;
  if (clients.has("auto")) return directoryExists(path.dirname(configPath));
  return false;
}

async function writeMcpConfig(configPath, serverConfig, { preserveAgentRouterSettings = false, overrideEnvKeys = new Set() } = {}) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let config = {};
  if (await fileExists(configPath)) {
    try {
      config = JSON.parse(await fs.readFile(configPath, "utf8") || "{}");
      await fs.copyFile(configPath, `${configPath}.bak.${timestamp()}`);
    } catch {
      await fs.copyFile(configPath, `${configPath}.invalid.${Date.now()}`);
      config = {};
    }
  }
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  const existingServer = config.mcpServers.AgentRouter;
  const preservedEnv = {
    ...serverConfig.env,
    ...(existingServer?.env && typeof existingServer.env === "object" ? existingServer.env : {})
  };
  for (const key of overrideEnvKeys) preservedEnv[key] = serverConfig.env[key];
  config.mcpServers.AgentRouter = preserveAgentRouterSettings && existingServer && typeof existingServer === "object"
    ? {
        ...existingServer,
        ...serverConfig,
        env: preservedEnv
      }
    : serverConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readInstalledMcpSettings(configPaths) {
  for (const configPath of configPaths) {
    try {
      const config = JSON.parse(await fs.readFile(configPath, "utf8") || "{}");
      const env = config?.mcpServers?.AgentRouter?.env;
      if (env && typeof env === "object") return env;
    } catch {
      // Invalid or missing configs are handled by the normal installer backup path.
    }
  }
  return {};
}

async function hasAgentRouterConfig(configPath) {
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8") || "{}");
    return Boolean(config?.mcpServers?.AgentRouter);
  } catch {
    return false;
  }
}

async function existingSkillDirsOrFallback(skillDirs) {
  const installed = [];
  for (const skillDir of skillDirs) {
    if (await fileExists(path.join(skillDir, "SKILL.md"))) installed.push(skillDir);
  }
  return installed.length ? installed : skillDirs;
}

async function createLocalWallet({ adnDir, cwd }) {
  const adnBin = path.join(repoRoot, "bin", "adn.js");
  try {
    const { stdout } = await execFileAsync(process.execPath, [adnBin, "wallet", "create-session"], {
      cwd,
      env: { ...process.env, ADN_DIR: adnDir },
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const payload = JSON.parse(stdout || "{}");
    return {
      ok: true,
      address: payload.address,
      network: "Arc Testnet",
      token: "USDC",
      wallet_path: path.join(adnDir, "wallet.json")
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      network: "Arc Testnet",
      token: "USDC"
    };
  }
}

function parseClients(value) {
  if (!value) return null;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeClients(value) {
  const rawItems = Array.isArray(value) ? value : [value].filter(Boolean);
  const normalized = new Set();
  for (const rawItem of rawItems.flatMap((item) => String(item).split(","))) {
    const item = rawItem.trim().toLowerCase();
    if (!item) continue;
    if (["claude", "claude-desktop", "claude_desktop"].includes(item)) normalized.add("claude-desktop");
    else if (["cursor"].includes(item)) normalized.add("cursor");
    else if (item === "all") normalized.add("all");
    else if (item === "auto") normalized.add("auto");
    else normalized.add(item);
  }
  return normalized;
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
