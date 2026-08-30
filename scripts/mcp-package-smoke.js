import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agentrouter-mcp-smoke-"));
const npmEnvironment = { ...process.env, npm_config_cache: path.join(temporaryDirectory, "npm-cache") };
process.stdout.write("Packing MCP package...\n");
const pack = spawnSync("npm", ["pack", "./packages/agentrouter-mcp", "--pack-destination", temporaryDirectory], {
  cwd: process.cwd(),
  env: npmEnvironment,
  encoding: "utf8",
  timeout: 120_000,
  killSignal: "SIGTERM"
});
if (pack.error) throw new Error(`npm pack failed: ${pack.error.message}`);
if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout || "npm pack failed");
const archive = path.join(temporaryDirectory, pack.stdout.trim().split(/\s+/).at(-1));
const consumerDirectory = path.join(temporaryDirectory, "consumer");
process.stdout.write("Installing packed MCP in a clean consumer...\n");
const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumerDirectory, archive], {
  cwd: process.cwd(),
  env: npmEnvironment,
  encoding: "utf8",
  timeout: 120_000,
  killSignal: "SIGTERM"
});
if (install.error) throw new Error(`packed MCP install failed: ${install.error.message}`);
if (install.status !== 0) throw new Error(install.stderr || install.stdout || "packed MCP install failed");

const installedPackage = path.join(consumerDirectory, "node_modules", "@agentrouternetwork", "mcp");
const manifest = JSON.parse(await readFile(path.join(installedPackage, "package.json"), "utf8"));
const executable = path.join(installedPackage, manifest.bin["agentrouter-mcp"]);
const child = spawn(process.execPath, [executable], {
  cwd: consumerDirectory,
  env: { ...process.env, AGENT_ROUTER_URL: "http://127.0.0.1:1" },
  stdio: ["pipe", "pipe", "pipe"]
});

const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("packed MCP initialize timed out")), 5_000);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n").find(Boolean);
    if (!line) return;
    clearTimeout(timer);
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code && !stdout) reject(new Error(`packed MCP exited ${code}: ${stderr}`));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
});
child.kill();
if (response?.result?.serverInfo?.name !== "AgentRouter") throw new Error("packed MCP returned an invalid initialize response");
process.stdout.write(`Packed MCP ${manifest.version} initialized successfully.\n`);
