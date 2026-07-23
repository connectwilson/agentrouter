#!/usr/bin/env node
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import { publishApiDrafts } from "../src/openapi-import.js";
import { loadProviderConfigs } from "../src/registry.js";
import { listProviderConfigs } from "../src/provider-config.js";

const args = parseArgs(process.argv.slice(2));

if (!args.remoteUrl) {
  console.error("Usage: node scripts/sync-provider-configs.js --remote-url <url> [--remote-cookie-env <ENV_NAME>] [--provider <provider_id>] [--secret-env <ENV_NAME>] [--auth-header <header>] [--limit 10]");
  process.exit(1);
}

const remoteToken = args.remoteTokenEnv ? process.env[args.remoteTokenEnv] || "" : "";
if (args.remoteTokenEnv && !remoteToken) {
  console.error(`Missing remote publish token: environment variable ${args.remoteTokenEnv} is not set.`);
  process.exit(1);
}
const remoteCookie = args.remoteCookieEnv ? process.env[args.remoteCookieEnv] || "" : "";
if (args.remoteCookieEnv && !remoteCookie) {
  console.error(`Missing remote provider session cookie: environment variable ${args.remoteCookieEnv} is not set.`);
  process.exit(1);
}
const providerSecret = args.secretEnv ? process.env[args.secretEnv] || "" : "";
if (args.secretEnv && !providerSecret) {
  console.error(`Missing provider secret: environment variable ${args.secretEnv} is not set.`);
  process.exit(1);
}
if (remoteToken) process.env.ADN_REMOTE_PUBLISH_TOKEN = remoteToken;
if (remoteCookie) process.env.ADN_REMOTE_SESSION_COOKIE = remoteCookie;
process.env.ADN_REMOTE_REGISTRY_URL = args.remoteUrl;

const store = createMemoryStore();
const server = createServer({ store });

try {
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await loadProviderConfigs(store, baseUrl, { validate: false });

  const configs = await listProviderConfigs();
  const selected = configs
    .filter((config) => config?.source?.type === "hosted_http")
    .filter((config) => !args.provider || config.manifest?.provider?.provider_id === args.provider)
    .slice(0, args.limit ? Math.max(0, Number(args.limit) || 0) : undefined);

  if (!selected.length) {
    console.log(JSON.stringify({
      ok: false,
      error: "NO_PROVIDER_CONFIGS",
      provider: args.provider || "",
      message: "No matching hosted_http provider configs were found."
    }, null, 2));
    process.exit(1);
  }

  const success = [];
  const failed = [];
  console.error(`Syncing ${selected.length} provider configs to ${args.remoteUrl}...`);
  for (let index = 0; index < selected.length; index += 1) {
    const config = selected[index];
    const draft = draftFromProviderConfig(config, {
      secretValue: providerSecret,
      authHeader: args.authHeader || ""
    });
    process.stderr.write(`[${index + 1}/${selected.length}] ${draft.service_id} ... `);
    const result = await publishApiDrafts({
      drafts: [{ ...draft, selected: true }],
      publish_scope: "remote_and_local",
      remote_registry_url: args.remoteUrl
    }, store, baseUrl);
    const publishedOne = result.published || [];
    const failedOne = result.failed || [];
    success.push(...publishedOne);
    failed.push(...failedOne);
    process.stderr.write(publishedOne.length
      ? "published\n"
      : `failed: ${failedOne[0]?.message || failedOne[0]?.error || "unknown"}\n`);
  }

  console.log(JSON.stringify({
    ok: failed.length === 0,
    remote_registry_url: args.remoteUrl,
    provider: args.provider || "",
    selected: selected.length,
    published: success.length,
    failed: failed.length,
    published_service_ids: success.map((item) => item.service_id),
    failed_preview: failed.slice(0, 40).map((item) => ({
      service_id: item.service_id,
      error: item.error,
      message: item.message,
      validation_error: item.validation?.error,
      provider_error: item.validation?.provider_error?.code
    }))
  }, null, 2));
  process.exit(failed.length ? 2 : 0);
} finally {
  await close(server);
}

function draftFromProviderConfig(config, { secretValue = "", authHeader = "" } = {}) {
  const manifest = config.manifest || {};
  const source = config.source || {};
  return {
    selected: true,
    service_id: manifest.service_id,
    provider_id: manifest.provider?.provider_id || "provider",
    title: manifest.title || manifest.service_id,
    description_for_agent: manifest.description_for_agent || source.summary || manifest.title || manifest.service_id,
    capabilities: manifest.capabilities || [],
    price: manifest.pricing?.amount || "0.01",
    sample_request: manifest.sample_request || {},
    preview_data: manifest.sample_response?.data ?? source.preview_data ?? {},
    upstream_url: source.upstream_url,
    method: source.method || source.upstream_method || manifest.endpoint?.method || "POST",
    secret_name: source.auth?.secret_name || "PROVIDER_SECRET",
    secret_value: secretValue,
    auth_header: authHeader || source.auth?.header || (secretValue ? "auto" : "authorization"),
    summary: source.summary || manifest.agent_contract?.summary || manifest.description_for_agent || manifest.title,
    payout_address: manifest.provider?.payout_address || ""
  };
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
