#!/usr/bin/env node
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { discoverApiServices, publishApiDrafts } from "../src/openapi-import.js";
import { loadProviderConfigs } from "../src/registry.js";

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error("Usage: node scripts/import-provider-docs.js --url <docs-url> --provider <name> --secret-env <ENV_NAME> [--auth-header <header>] [--price 0.01] [--remote-url <url> --remote-cookie-env <ENV_NAME>]");
  process.exit(1);
}

const secretValue = args.secretEnv ? process.env[args.secretEnv] || "" : "";
if (args.secretEnv && !secretValue) {
  console.error(`Missing API key: environment variable ${args.secretEnv} is not set.`);
  process.exit(1);
}
const remoteToken = args.remoteTokenEnv ? process.env[args.remoteTokenEnv] || "" : "";
if (args.remoteUrl && args.remoteTokenEnv && !remoteToken) {
  console.error(`Missing remote publish token: environment variable ${args.remoteTokenEnv} is not set.`);
  process.exit(1);
}
const remoteCookie = args.remoteCookieEnv ? process.env[args.remoteCookieEnv] || "" : "";
if (args.remoteUrl && args.remoteCookieEnv && !remoteCookie) {
  console.error(`Missing remote provider session cookie: environment variable ${args.remoteCookieEnv} is not set.`);
  process.exit(1);
}
if (args.remoteUrl) process.env.ADN_REMOTE_REGISTRY_URL = args.remoteUrl;
if (remoteToken) process.env.ADN_REMOTE_PUBLISH_TOKEN = remoteToken;
if (remoteCookie) process.env.ADN_REMOTE_SESSION_COOKIE = remoteCookie;

const store = createMemoryStore();
const server = createServer({ store });

try {
  await listen(server);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await loadProviderConfigs(store, baseUrl, { validate: false });

  console.error(`Discovering provider docs from ${args.url}...`);
  const discovered = await discoverApiServices({
    api_url: args.url,
    default_price: args.price || "0.01",
    provider_name: args.provider || "",
    secret_value: secretValue,
    auth_header: args.authHeader || "",
    payout_address: args.payoutAddress || ""
  }, baseUrl);

  const drafts = discovered.drafts.map((draft) => ({ ...draft, selected: true }));
  const success = [];
  const failed = [];
  const publishScope = args.remoteUrl ? "remote_and_local" : "local_only";
  console.error(`Discovered ${drafts.length} drafts from ${discovered.source}. Publishing with live validation to ${args.remoteUrl || "local registry"}...`);
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    process.stderr.write(`[${index + 1}/${drafts.length}] ${draft.service_id} ... `);
    const result = await publishApiDrafts({
      drafts: [draft],
      publish_scope: publishScope,
      remote_registry_url: args.remoteUrl || undefined
    }, store, baseUrl);
    const publishedOne = result.published || [];
    const failedOne = result.failed || [];
    success.push(...publishedOne);
    failed.push(...failedOne);
    if (publishedOne.length) {
      process.stderr.write("published\n");
    } else {
      process.stderr.write(`failed: ${failedOne[0]?.message || failedOne[0]?.error || "unknown"}\n`);
    }
  }

  console.log(JSON.stringify({
    ok: failed.length === 0,
    source: discovered.source,
    discovered: drafts.length,
    published: success.length,
    failed: failed.length,
    published_service_ids: success.map((item) => item.service_id),
    failed_preview: failed.slice(0, 20).map((item) => ({
      service_id: item.service_id,
      error: item.error,
      message: item.message,
      validation_error: item.validation?.error,
      validation_status: item.validation?.status,
      provider_error: item.validation?.provider_error?.code
    }))
  }, null, 2));
  process.exit(failed.length ? 2 : 0);
} finally {
  await close(server);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[name] = true;
      continue;
    }
    out[name] = next;
    index += 1;
  }
  return out;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
