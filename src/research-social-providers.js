import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const BACKENDS = {
  x: [
    { id: "opencli-twitter", command: "opencli", args: (query, limit) => ["twitter", "search", query, "--limit", String(limit), "-f", "json"] },
    { id: "twitter-cli", command: "twitter", args: (query, limit) => ["search", query, "-n", String(limit), "--json"] }
  ],
  reddit: [
    { id: "opencli-reddit", command: "opencli", timeout: 40000, args: (query, limit) => ["reddit", "search", query, "--limit", String(limit), "-f", "json"] },
    { id: "rdt-cli", command: "rdt", args: (query, limit) => ["search", query, "--limit", String(limit), "--json"] }
  ],
  xiaohongshu: [
    { id: "opencli-xiaohongshu", command: "opencli", timeout: 90000, args: (query, limit) => ["xiaohongshu", "search", query, "--limit", String(limit), "-f", "json"] },
    { id: "xhs-cli", command: "xhs", args: (query) => ["search", query, "--json"] }
  ],
  bilibili: [
    { id: "bili-cli", command: "bili", args: (query, limit) => ["search", query, "--type", "video", "-n", String(limit)] },
    { id: "opencli-bilibili", command: "opencli", timeout: 90000, args: (query, limit) => ["bilibili", "search", query, "--limit", String(limit), "-f", "json"] }
  ],
  youtube: [
    { id: "opencli-youtube", command: "opencli", timeout: 120000, args: (query, limit) => ["youtube", "search", query, "--limit", String(limit), "-f", "json"] },
    { id: "yt-dlp", command: "yt-dlp", timeout: 40000, args: (query, limit) => ["--dump-json", `ytsearch${limit}:${query}`] }
  ],
  facebook: [
    { id: "opencli-facebook", command: "opencli", args: (query, limit) => ["facebook", "search", query, "--limit", String(limit), "-f", "json"] }
  ]
};

export async function searchLocalSocialPlatform(platform, query, limit = 10, options = {}) {
  const run = options.runCommand || runCommand;
  const attempts = [];
  for (const provider of options.providers?.[platform] || []) {
    let result;
    try {
      result = await provider.search(query, limit);
    } catch (error) {
      result = { status: "provider_error", error: error.message, rows: [] };
    }
    attempts.push({ backend_id: provider.id, status: result.status, error: result.error || null });
    if (result.status === "completed" && Array.isArray(result.rows) && result.rows.length) {
      return { status: "completed", backend_id: provider.id, rows: result.rows, attempts };
    }
    if (result.status === "auth_required") continue;
  }
  for (const backend of BACKENDS[platform] || []) {
    const result = await run(backend.command, backend.args(query, limit), { timeout: backend.timeout });
    attempts.push({ backend_id: backend.id, status: result.status, error: result.error || null });
    if (result.status !== "completed") continue;
    const rows = extractRows(result.data);
    if (!rows.length) continue;
    return { status: "completed", backend_id: backend.id, rows, attempts };
  }
  return {
    status: attempts.some((item) => item.status === "auth_required") ? "auth_required" : attempts.some((item) => item.status === "provider_error") ? "provider_error" : "not_configured",
    backend_id: null,
    rows: [],
    attempts
  };
}

export async function getSocialProviderHealth(options = {}) {
  const run = options.runCommand || runCommand;
  const channels = {};
  for (const platform of Object.keys(BACKENDS)) {
    const probes = [];
    for (const backend of BACKENDS[platform]) {
      const result = await run(backend.command, ["--help"], { timeout: 5000 });
      probes.push({ backend_id: backend.id, status: result.status === "missing" ? "missing" : "installed" });
    }
    channels[platform] = {
      status: probes.some((probe) => probe.status === "installed") ? "installed_needs_live_check" : "not_configured",
      backends: probes
    };
  }
  return {
    health_version: "creator_social_provider_health_v1",
    channels,
    safety_notice: "Cookie-based channels should use a dedicated account. Credentials remain in the local upstream tool and are never returned by AgentRouter."
  };
}

export async function searchSemanticWeb(query, limit = 10, options = {}) {
  const run = options.runCommand || runCommand;
  const queries = [query, query.replace(/site:(x|reddit|xiaohongshu)\.com/gi, "").trim()];
  const attempts = [];
  for (const candidateQuery of [...new Set(queries)]) {
    const result = await run("mcporter", ["call", "exa.web_search_exa", "--args", JSON.stringify({ query: candidateQuery, numResults: limit }), "--output", "json"], { timeout: 45000 });
    attempts.push({ query: candidateQuery, status: result.status, error: result.error || null });
    if (result.status !== "completed") continue;
    const rows = parseExaRows(result.data);
    if (rows.length) return { status: "completed", backend_id: "exa-via-mcporter", rows, attempts };
  }
  return { status: attempts.some((item) => item.status === "missing") ? "not_configured" : "no_results", backend_id: null, rows: [], attempts };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      env: { ...process.env, PATH: localToolPath() },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(0, 4 * 1024 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(error.code === "ENOENT"
      ? { status: "missing", error: `${command} is not installed` }
      : { status: "provider_error", error: error.message }));
    child.on("exit", (code) => {
      if (code === 0) return finish({ status: "completed", data: parseOutput(stdout) });
      const detail = `${stderr} ${stdout}`.trim().slice(0, 500);
      finish(/auth|login|cookie|credential|unauthorized|forbidden/i.test(detail)
        ? { status: "auth_required", error: detail }
        : { status: "provider_error", error: detail || `${command} exited with code ${code}` });
    });
    const timeoutMs = options.timeout || 20000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "provider_error", error: `${command} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

function localToolPath() {
  return [
    path.join(os.homedir(), ".npm-global", "bin"),
    path.join(os.homedir(), ".agent-reach-venv", "bin"),
    process.env.PATH || ""
  ].join(path.delimiter);
}

function parseExaRows(data) {
  const text = Array.isArray(data?.content) ? data.content.map((item) => item?.text || "").join("\n") : typeof data === "string" ? data : "";
  if (!text || /No search results found/i.test(text)) return [];
  return text.split(/\n---\n/).map((block) => {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const url = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim();
    const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
    const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
    const highlights = block.split(/^Highlights:\s*$/m)[1]?.trim();
    if (!url) return null;
    return { title, url, published_at: published === "N/A" ? null : published, author: author === "N/A" ? null : author, snippet: highlights };
  }).filter(Boolean);
}

function parseOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (lines.length) return lines;
  const start = Math.min(...[trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0));
  if (Number.isFinite(start)) {
    try { return JSON.parse(trimmed.slice(start)); } catch {}
  }
  return [];
}

function extractRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "items", "results", "posts", "tweets", "notes", "feeds"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    const deeper = extractRows(nested);
    if (deeper.length) return deeper;
  }
  return [];
}
