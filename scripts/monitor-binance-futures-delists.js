#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const BINANCE_ORIGIN = process.env.BINANCE_ORIGIN || "https://www.binance.com";
const DEFAULT_STATE_FILE = path.join(process.cwd(), ".cache", "binance-futures-delists-state.json");
const FUTURES_DELIST_RE = /\bBinance Futures\b[\s\S]*\bDelist\b[\s\S]*\bPerpetual Contract/i;

const args = parseArgs(process.argv.slice(2));
const pollMs = Math.max(10_000, Number(args.interval || process.env.POLL_INTERVAL_MS || 60_000));
const stateFile = path.resolve(String(args.state || process.env.STATE_FILE || DEFAULT_STATE_FILE));
const once = Boolean(args.once);
const dryRun = Boolean(args.dryRun);
const notifyExisting = Boolean(args.notifyExisting);
const startedAt = Date.now();
const startupNotifyWindowMs = Math.max(0, Number(process.env.STARTUP_NOTIFY_WINDOW_MS || 10 * 60_000));

if (args.help) usage(0);

const barkConfig = getBarkConfig();
if (!dryRun && !barkConfig) {
  usage(1, "Missing Bark config. Set BARK_URL or BARK_KEY.");
}

let state = await readState(stateFile);

if (once) {
  await runOnce();
} else {
  console.log(`Monitoring Binance Futures delist announcements every ${pollMs}ms.`);
  console.log(`State file: ${stateFile}`);
  await runOnce();
  setInterval(() => {
    runOnce().catch((error) => {
      console.error(`[${new Date().toISOString()}] monitor error:`, error.message);
    });
  }, pollMs);
}

async function runOnce() {
  const articles = await fetchDelistingArticles();
  const futuresDelists = articles
    .filter((article) => FUTURES_DELIST_RE.test(article.title || ""))
    .sort((a, b) => Number(a.releaseDate || 0) - Number(b.releaseDate || 0));

  const fresh = futuresDelists.filter((article) => !state.seen[String(article.code || article.id)]);
  if (fresh.length === 0) {
    console.log(`[${new Date().toISOString()}] no new futures delist announcements`);
    return;
  }

  const firstRun = !state.initialized;
  state.initialized = true;

  const toNotify = firstRun && !notifyExisting
    ? fresh.filter((article) => Number(article.releaseDate || 0) >= startedAt - startupNotifyWindowMs)
    : fresh;
  const notifyKeys = new Set(toNotify.map((article) => String(article.code || article.id)));
  const toSeed = fresh.filter((article) => !notifyKeys.has(String(article.code || article.id)));

  for (const article of toSeed) markSeen(article);
  if (toSeed.length > 0 || firstRun) await writeState(stateFile, state);

  if (toNotify.length === 0) {
    console.log(`[${new Date().toISOString()}] seeded ${fresh.length} existing futures delist announcement(s)`);
    return;
  }

  for (const article of toNotify) {
    const message = formatAnnouncement(article);
    if (dryRun) {
      console.log("[dry-run]", message.title, message.body, message.url);
    } else {
      await sendBark(message);
      markSeen(article);
      await writeState(stateFile, state);
      console.log(`[${new Date().toISOString()}] pushed: ${article.title}`);
    }
  }
}

function markSeen(article) {
  const key = String(article.code || article.id);
  state.seen[key] = {
    id: article.id,
    code: article.code,
    title: article.title,
    releaseDate: article.releaseDate,
    seenAt: new Date().toISOString()
  };
}

async function fetchDelistingArticles() {
  const urls = [
    `${BINANCE_ORIGIN}/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=161&pageNo=1&pageSize=20&type=1`,
    `${BINANCE_ORIGIN}/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20`
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const payload = await fetchJson(url);
      const articles = extractArticles(payload);
      if (articles.length > 0) return dedupeArticles(articles);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Binance articles returned.");
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "clienttype": "web",
      "user-agent": "Mozilla/5.0 (compatible; binance-futures-delist-monitor/1.0)"
    }
  });
  const text = await response.text();
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

function formatAnnouncement(article) {
  const symbols = extractSymbols(article.title);
  const when = article.releaseDate ? new Date(Number(article.releaseDate)).toISOString() : "unknown time";
  const url = article.code
    ? `${BINANCE_ORIGIN}/en/support/announcement/detail/${article.code}`
    : `${BINANCE_ORIGIN}/en/support/announcement`;
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

function getBarkConfig() {
  if (process.env.BARK_URL) return { url: process.env.BARK_URL };
  if (!process.env.BARK_KEY) return null;
  const server = (process.env.BARK_SERVER || "https://api.day.app").replace(/\/+$/, "");
  return { url: `${server}/${process.env.BARK_KEY}` };
}

async function sendBark(message) {
  const base = barkConfig.url.replace(/\/+$/, "");
  const url = new URL(`${base}/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}`);
  url.searchParams.set("group", process.env.BARK_GROUP || "Binance");
  url.searchParams.set("sound", process.env.BARK_SOUND || "alarm");
  url.searchParams.set("level", process.env.BARK_LEVEL || "timeSensitive");
  url.searchParams.set("url", message.url);

  const response = await fetchWithRetry(url, { method: "GET" });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bark push failed ${response.status}: ${text.slice(0, 200)}`);
}

async function fetchWithRetry(url, options = {}) {
  const attempts = Math.max(1, Number(process.env.HTTP_RETRY_ATTEMPTS || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await sleep(500 * attempt);
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readState(file) {
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

async function writeState(file, nextState) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(nextState, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--notify-existing") parsed.notifyExisting = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--interval") parsed.interval = argv[++i];
    else if (arg === "--state") parsed.state = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(exitCode, message) {
  if (message) console.error(message);
  console.error(`
Usage:
  BARK_KEY=xxxx npm run monitor:binance:futures-delists
  BARK_URL=https://api.day.app/xxxx npm run monitor:binance:futures-delists -- --once

Options:
  --once              Check once and exit.
  --dry-run           Print alerts instead of pushing Bark.
  --notify-existing   Push already-listed matching announcements on first run.
  --interval <ms>     Poll interval, default 60000.
  --state <path>      State file, default .cache/binance-futures-delists-state.json.

Env:
  BARK_KEY            Bark device key.
  BARK_URL            Full Bark endpoint, e.g. https://api.day.app/<key>.
  BARK_SERVER         Bark server when using BARK_KEY, default https://api.day.app.
  BARK_GROUP          Bark group, default Binance.
  BARK_SOUND          Bark sound, default alarm.
  BARK_LEVEL          Bark level, default timeSensitive.
  STARTUP_NOTIFY_WINDOW_MS
                      On first run, still push announcements newer than this window, default 600000.
`);
  process.exit(exitCode);
}
