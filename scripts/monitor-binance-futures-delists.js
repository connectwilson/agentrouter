#!/usr/bin/env node
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FUTURES_DELIST_RE = /\bBinance Futures\b[\s\S]*\bDelist\b[\s\S]*\bPerpetual Contract/i;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  if (args.notifyExisting && args.baselineExisting) {
    throw new Error("Choose either --notify-existing or --baseline-existing, not both.");
  }

  const pollMs = boundedInteger(args.interval || environment.POLL_INTERVAL_MS, 60_000, 10_000, 24 * 60 * 60_000);
  const stateFile = path.resolve(String(args.state || environment.STATE_FILE || defaultStateFile()));
  const dryRun = Boolean(args.dryRun);
  const baselineExisting = Boolean(args.baselineExisting);
  const barkConfig = getBarkConfig(environment);
  if (!dryRun && !barkConfig) {
    throw new Error("Missing Bark config. Set BARK_URL or BARK_KEY.");
  }

  let state = await readState(stateFile);
  const runOnce = async () => {
    const articles = await fetchDelistingArticles({
      origin: environment.BINANCE_ORIGIN || "https://www.binance.com",
      runtime: httpRuntimeFromEnvironment(environment)
    });
    const futuresDelists = articles
      .filter((article) => FUTURES_DELIST_RE.test(article.title || ""))
      .sort((a, b) => Number(a.releaseDate || 0) - Number(b.releaseDate || 0));

    const fresh = futuresDelists.filter((article) => !state.seen[String(article.code || article.id)]);
    const firstRun = !state.initialized;
    if (fresh.length === 0) {
      if (firstRun) {
        state.initialized = true;
        await writeState(stateFile, state);
      }
      console.log(`[${new Date().toISOString()}] no new futures delist announcements`);
      return;
    }

    state.initialized = true;
    const { notify: toNotify, seed: toSeed } = firstRun
      ? planFirstRun(fresh, { baselineExisting })
      : { notify: fresh, seed: [] };

    for (const article of toSeed) markSeen(state, article);
    if (toSeed.length > 0 || firstRun) await writeState(stateFile, state);

    if (toNotify.length === 0) {
      console.log(`[${new Date().toISOString()}] seeded ${fresh.length} existing futures delist announcement(s)`);
      return;
    }

    for (const article of toNotify) {
      const message = formatAnnouncement(article, environment.BINANCE_ORIGIN || "https://www.binance.com");
      if (dryRun) {
        console.log("[dry-run]", message.title, message.body, message.url);
      } else {
        await sendBark(message, { barkConfig, runtime: httpRuntimeFromEnvironment(environment), environment });
        markSeen(state, article);
        await writeState(stateFile, state);
        console.log(`[${new Date().toISOString()}] pushed: ${article.title}`);
      }
    }
  };

  const run = createNonOverlappingRunner(runOnce);
  if (args.once) {
    await run();
    return;
  }

  console.log(`Monitoring Binance Futures delist announcements every ${pollMs}ms.`);
  console.log(`State file: ${stateFile}`);
  await run();
  setInterval(() => {
    run()
      .then((result) => {
        if (result?.skipped) {
          console.warn(`[${new Date().toISOString()}] skipped poll: previous poll still running`);
        }
      })
      .catch((error) => {
        console.error(`[${new Date().toISOString()}] monitor error:`, error.message);
      });
  }, pollMs);
}

export function createNonOverlappingRunner(task) {
  let running = false;
  return async (...args) => {
    if (running) return { skipped: true, reason: "poll_in_progress" };
    running = true;
    try {
      return await task(...args);
    } finally {
      running = false;
    }
  };
}

export function defaultStateFile({ tempDirectory = os.tmpdir() } = {}) {
  return path.join(tempDirectory, "agentrouter", "binance-futures-delists-state.json");
}

export function planFirstRun(fresh, { baselineExisting = false } = {}) {
  return baselineExisting
    ? { notify: [], seed: fresh }
    : { notify: fresh, seed: [] };
}

function markSeen(state, article) {
  const key = String(article.code || article.id);
  state.seen[key] = {
    id: article.id,
    code: article.code,
    title: article.title,
    releaseDate: article.releaseDate,
    seenAt: new Date().toISOString()
  };
}

export async function fetchDelistingArticles({ origin = "https://www.binance.com", runtime = {} } = {}) {
  const urls = [
    `${origin}/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=161&pageNo=1&pageSize=20&type=1`,
    `${origin}/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20`
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const payload = await fetchJson(url, runtime);
      const articles = extractArticles(payload);
      if (articles.length > 0) return dedupeArticles(articles);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Binance articles returned.");
}

export async function fetchJson(url, runtime = {}) {
  const response = await fetchWithRetry(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "clienttype": "web",
      "user-agent": "Mozilla/5.0 (compatible; binance-futures-delist-monitor/1.0)"
    }
  }, runtime);
  const text = await readResponseText(response, runtime);
  if (!response.ok) {
    throw new Error(`Binance request failed ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function extractArticles(payload) {
  const catalogs = payload?.data?.catalogs || [];
  const articles = [...(payload?.data?.articles || [])];
  for (const catalog of catalogs) {
    if (catalog.catalogId === 161 || catalog.catalogName === "Delisting") {
      articles.push(...(catalog.articles || []));
    }
  }
  for (const catalog of catalogs) {
    for (const article of catalog.articles || []) {
      if (/\bDelist\b|\bRemoval\b/i.test(article.title || "")) articles.push(article);
    }
  }
  return articles;
}

function dedupeArticles(articles) {
  const seen = new Set();
  const out = [];
  for (const article of articles) {
    const key = String(article.code || article.id || article.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(article);
  }
  return out;
}

function formatAnnouncement(article, origin = "https://www.binance.com") {
  const symbols = extractSymbols(article.title);
  const when = article.releaseDate ? new Date(Number(article.releaseDate)).toISOString() : "unknown time";
  const url = article.code
    ? `${origin}/en/support/announcement/detail/${article.code}`
    : `${origin}/en/support/announcement`;
  const symbolText = symbols.length ? `\nSymbols: ${symbols.join(", ")}` : "";
  return {
    title: "Binance Futures Delist Alert",
    body: `${article.title}\nPublished: ${when}${symbolText}`,
    url
  };
}

function extractSymbols(title) {
  const matches = String(title).match(/\b[A-Z0-9]{2,20}(?:USDT|USDC|USD|PERP)\b/g) || [];
  return [...new Set(matches)];
}

function getBarkConfig(environment = process.env) {
  if (environment.BARK_URL) return { url: environment.BARK_URL };
  if (!environment.BARK_KEY) return null;
  const server = (environment.BARK_SERVER || "https://api.day.app").replace(/\/+$/, "");
  return { url: `${server}/${environment.BARK_KEY}` };
}

async function sendBark(message, { barkConfig, runtime = {}, environment = process.env } = {}) {
  const base = barkConfig.url.replace(/\/+$/, "");
  const url = new URL(`${base}/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}`);
  url.searchParams.set("group", environment.BARK_GROUP || "Binance");
  url.searchParams.set("sound", environment.BARK_SOUND || "alarm");
  url.searchParams.set("level", environment.BARK_LEVEL || "timeSensitive");
  url.searchParams.set("url", message.url);

  const response = await fetchWithRetry(url, { method: "GET" }, runtime);
  const text = await readResponseText(response, runtime);
  if (!response.ok) throw new Error(`Bark push failed ${response.status}: ${text.slice(0, 200)}`);
}

export async function fetchWithRetry(url, options = {}, runtime = {}) {
  const attempts = boundedInteger(runtime.attempts ?? process.env.HTTP_RETRY_ATTEMPTS, 3, 1, 10);
  const headerTimeoutMs = boundedInteger(runtime.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS, 1, 5 * 60_000);
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;
  const sleepFn = runtime.sleepFn || sleep;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchHeadersWithTimeout(fetchImpl, url, options, headerTimeoutMs);
      if (response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await sleepFn(500 * attempt);
  }
  throw lastError;
}

async function fetchHeadersWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });

  const timeoutError = codedError("HTTP_HEADER_TIMEOUT", `HTTP headers exceeded ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(controller.signal.reason || codedError("HTTP_REQUEST_ABORTED", "HTTP request aborted"));
    }, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve(fetchImpl(url, { ...options, signal: controller.signal })),
      aborted
    ]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function readResponseText(response, runtime = {}) {
  const bodyTimeoutMs = boundedInteger(runtime.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS, 1, 5 * 60_000);
  const maxResponseBytes = boundedInteger(
    runtime.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    32 * 1024 * 1024
  );
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const timeoutError = codedError("HTTP_BODY_TIMEOUT", `HTTP body exceeded ${bodyTimeoutMs}ms`);
  let timer;
  let totalBytes = 0;
  let text = "";
  const bodyRead = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        const error = codedError(
          "HTTP_RESPONSE_TOO_LARGE",
          `HTTP response exceeded ${maxResponseBytes} bytes`
        );
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  })();
  const bodyTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel(timeoutError).catch(() => {});
      reject(timeoutError);
    }, bodyTimeoutMs);
  });

  try {
    return await Promise.race([bodyRead, bodyTimeout]);
  } finally {
    clearTimeout(timer);
  }
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readState(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed.initialized),
      seen: parsed.seen && typeof parsed.seen === "object" ? parsed.seen : {}
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { initialized: false, seen: {} };
  }
}

export async function writeState(file, nextState, {
  fileApi = fs,
  tempSuffix = `.${process.pid}.${randomUUID()}.tmp`
} = {}) {
  const tempFile = `${file}${tempSuffix}`;
  await fileApi.mkdir(path.dirname(file), { recursive: true });
  try {
    await fileApi.writeFile(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fileApi.rename(tempFile, file);
  } catch (error) {
    await fileApi.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--notify-existing") parsed.notifyExisting = true;
    else if (arg === "--baseline-existing") parsed.baselineExisting = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--interval") parsed.interval = argv[++i];
    else if (arg === "--state") parsed.state = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage() {
  console.error(`
Usage:
  BARK_KEY=xxxx npm run monitor:binance:futures-delists
  BARK_URL=https://api.day.app/xxxx npm run monitor:binance:futures-delists -- --once

Options:
  --once              Check once and exit.
  --dry-run           Print alerts instead of pushing Bark.
  --notify-existing   Explicitly push matching announcements on first run (the safe default).
  --baseline-existing Mark matching announcements seen without pushing them on first run.
  --interval <ms>     Poll interval, default 60000.
  --state <path>      State file, default .cache/binance-futures-delists-state.json.

Env:
  BARK_KEY            Bark device key.
  BARK_URL            Full Bark endpoint, e.g. https://api.day.app/<key>.
  BARK_SERVER         Bark server when using BARK_KEY, default https://api.day.app.
  BARK_GROUP          Bark group, default Binance.
  BARK_SOUND          Bark sound, default alarm.
  BARK_LEVEL          Bark level, default timeSensitive.
  HTTP_HEADER_TIMEOUT_MS
                      Header timeout, default 10000.
  HTTP_BODY_TIMEOUT_MS
                      Response body timeout, default 10000.
  HTTP_MAX_RESPONSE_BYTES
                      Maximum response body, default 2097152.
`);
}

function httpRuntimeFromEnvironment(environment) {
  return {
    attempts: boundedInteger(environment.HTTP_RETRY_ATTEMPTS, 3, 1, 10),
    headerTimeoutMs: boundedInteger(environment.HTTP_HEADER_TIMEOUT_MS, DEFAULT_HEADER_TIMEOUT_MS, 1, 5 * 60_000),
    bodyTimeoutMs: boundedInteger(environment.HTTP_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS, 1, 5 * 60_000),
    maxResponseBytes: boundedInteger(
      environment.HTTP_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      32 * 1024 * 1024
    )
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

const invokedAsProgram = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsProgram) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
