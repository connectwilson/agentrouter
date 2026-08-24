#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DiscoveryConnector } from "../src/connector.js";
import { normalizeId, suggestCapabilities } from "../src/id-utils.js";
import { invokePaidServiceWithLocalWallet } from "../src/local-invoke.js";
import { routeTaskWithLocalWallet } from "../src/local-route.js";
import { createHostedHttpProviderConfig, createStaticProviderConfig, writeProviderConfig } from "../src/provider-config.js";
import { initSessionWallet, initWallet, readPaymentLog, readWallet, updatePolicy, walletStatus } from "../src/wallet.js";
import { getX402ProductionPlan } from "../src/x402-adapter.js";

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.ADN_REGISTRY_URL || "http://127.0.0.1:8787";
const connector = new DiscoveryConnector({ baseUrl });

try {
  if (command === "payment" && args[0] === "plan") {
    print(getX402ProductionPlan());
  } else if (command === "wallet") {
    print(await handleWalletCommand(args));
  } else if (command === "provider" && args[0] === "onboard") {
    print(await onboardProvider(args.slice(1)));
  } else if (command === "search") {
    const query = args.join(" ");
    print(await connector.searchServices({ query, verified_only: false }));
  } else if (command === "manifest") {
    print(await connector.getManifest(requireArg(args[0], "service_id")));
  } else if (command === "preview") {
    print(await connector.previewService(requireArg(args[0], "service_id")));
  } else if (command === "invoke") {
    const serviceId = requireArg(args[0], "service_id");
    const input = args[1] ? JSON.parse(args[1]) : { chain: "base", days: 7 };
    print(await invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId,
      input,
      budget: { max_amount: "0.05", currency: "USDC" }
    }));
  } else if (command === "route") {
    const { task, maxPrice, freshnessSeconds } = parseRouteArgs(args);
    print(await routeTaskWithLocalWallet({
      baseUrl,
      task,
      constraints: {
        max_price_usdc: maxPrice,
        freshness_seconds: freshnessSeconds
      },
      budget: {
        max_amount: maxPrice,
        currency: "USDC"
      }
    }));
  } else if (command === "feedback") {
    print(await connector.getFeedback(requireArg(args[0], "service_id")));
  } else {
    console.log(`Usage:
  adn search "Base 7d fund flow"
  adn manifest <service_id>
  adn preview <service_id>
  adn invoke <service_id> '{"chain":"base","days":7}'
  adn route "BTC 当前最大爆仓痛点是多少" --max-price 0.05 --freshness 300
  adn feedback <service_id>
  adn wallet init
  adn wallet create-session
  adn wallet address
  adn wallet status
  adn wallet policy set --per-call 0.05 --daily 2
  adn wallet log
  adn payment plan
  adn provider onboard
  adn provider onboard --yes
  adn provider onboard --mode hosted-http --yes

Set ADN_REGISTRY_URL to target a running MVP server. Default: ${baseUrl}`);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, payload: error.payload }, null, 2));
  process.exitCode = 1;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function handleWalletCommand(args) {
  const subcommand = args[0];
  if (subcommand === "init") {
    const wallet = await initWallet({ force: args.includes("--force") });
    return {
      ok: true,
      address: wallet.address,
      address_type: wallet.address_type,
      network_hint: wallet.network_hint,
      next_step: "Fund this local EVM agent wallet with a small Base USDC budget before real x402 settlement."
    };
  }
  if (subcommand === "create-session") {
    const wallet = await initSessionWallet({ force: args.includes("--force") });
    return {
      ok: true,
      status: "wallet_ready",
      address: wallet.address,
      address_type: wallet.address_type,
      network_hint: wallet.network_hint,
      key_management: wallet.key_management,
      next_step: "Fund this local EVM session wallet with a small Base USDC budget before real x402 settlement."
    };
  }
  if (subcommand === "address") {
    const wallet = await readWallet();
    return { address: wallet.address };
  }
  if (subcommand === "status") {
    return walletStatus();
  }
  if (subcommand === "lock") {
    return updatePolicy({ enabled: false });
  }
  if (subcommand === "unlock") {
    return updatePolicy({ enabled: true });
  }
  if (subcommand === "log") {
    return readPaymentLog();
  }
  if (subcommand === "policy" && args[1] === "set") {
    const patch = {};
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] === "--per-call") patch.per_call_limit_usdc = requireArg(args[++i], "--per-call value");
      else if (args[i] === "--daily") patch.daily_limit_usdc = requireArg(args[++i], "--daily value");
      else if (args[i] === "--service-allowlist") patch.service_allowlist = parseList(requireArg(args[++i], "--service-allowlist value"));
      else if (args[i] === "--provider-allowlist") patch.provider_allowlist = parseList(requireArg(args[++i], "--provider-allowlist value"));
      else if (args[i] === "--pay-to-allowlist") patch.pay_to_allowlist = parseList(requireArg(args[++i], "--pay-to-allowlist value"));
      else if (args[i] === "--disable") patch.enabled = false;
      else if (args[i] === "--enable") patch.enabled = true;
    }
    return updatePolicy(patch);
  }

  return {
    usage: [
      "adn wallet init",
      "adn wallet create-session",
      "adn wallet address",
      "adn wallet status",
      "adn wallet lock",
      "adn wallet unlock",
      "adn wallet policy set --per-call 0.05 --daily 2",
      "adn wallet log"
    ]
  };
}

function parseList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseRouteArgs(args) {
  const taskParts = [];
  let maxPrice = "0.05";
  let freshnessSeconds = "300";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--max-price") {
      maxPrice = requireArg(args[++i], "--max-price value");
    } else if (args[i] === "--freshness") {
      freshnessSeconds = requireArg(args[++i], "--freshness value");
    } else {
      taskParts.push(args[i]);
    }
  }
  return {
    task: requireArg(taskParts.join(" "), "task"),
    maxPrice,
    freshnessSeconds
  };
}

async function onboardProvider(args) {
  const yes = args.includes("--yes") || args.includes("-y");
  const mode = getArgValue(args, "--mode") || "static-json";
  const answers = yes ? defaultProviderAnswers(mode) : await askProviderQuestions(mode);
  const config = answers.mode === "hosted-http"
    ? createHostedHttpProviderConfig({
      baseUrl,
      serviceId: answers.serviceId,
      providerId: answers.providerId,
      title: answers.title,
      description: answers.description,
      capabilities: answers.capabilities,
      price: answers.price,
      sampleRequest: answers.sampleRequest,
      sampleData: answers.sampleData,
      upstreamUrl: answers.upstreamUrl,
      upstreamMethod: answers.upstreamMethod,
      secretName: answers.secretName,
      secretValue: answers.secretValue,
      authHeader: answers.authHeader,
      summary: answers.summary
    })
    : createStaticProviderConfig({
      baseUrl,
      serviceId: answers.serviceId,
      providerId: answers.providerId,
      title: answers.title,
      description: answers.description,
      capabilities: answers.capabilities,
      price: answers.price,
      sampleRequest: answers.sampleRequest,
      sampleData: answers.sampleData,
      liveData: answers.liveData,
      summary: answers.summary
    });

  const configPath = await writeProviderConfig(config);
  const registration = await postJson("/services/register", config.manifest);
  const validation = await postJson(`/services/${config.manifest.service_id}/validate`, {});

  return {
    ok: validation.ok === true,
    service_id: config.manifest.service_id,
    provider_config_path: configPath,
    endpoint: config.manifest.endpoint.url,
    registration,
    validation,
    next_steps: [
      `node bin/adn.js search "${config.manifest.title}"`,
      `node bin/adn.js preview ${config.manifest.service_id}`,
      `node bin/adn.js invoke ${config.manifest.service_id} '${JSON.stringify(config.manifest.sample_request)}'`
    ]
  };
}

async function askProviderQuestions() {
  const rl = readline.createInterface({ input, output });
  try {
    const mode = await ask(rl, "Source type: static-json or hosted-http", "static-json");
    const title = await ask(rl, "Service title", "My Data Service");
    const providerName = await ask(rl, "Provider name", "Provider Bob");
    const serviceId = normalizeId(null, title, "service");
    const providerId = normalizeId(null, providerName, "provider");
    const description = await ask(rl, "Description for agents", "Use this service when you need my demo data.");
    const capabilitiesRaw = await ask(rl, "Capability tags, comma separated", suggestCapabilities(`${title} ${description}`));
    const price = await ask(rl, "Price per call in USDC", "0.01");
    const sampleRequestRaw = await ask(rl, "Example request JSON", "{\"chain\":\"base\",\"days\":7}");
    const sampleDataRaw = await ask(rl, "Preview data JSON", "{\"metric\":\"sample\",\"value\":1}");
    const summary = await ask(rl, "Paid response summary", "This service returned the paid live data.");
    if (mode === "hosted-http") {
      const upstreamUrl = await ask(rl, "API URL", `${baseUrl}/mock/upstream/sentiment`);
      const secretValue = await ask(rl, "Access token / secret, optional", "");
      return {
        mode,
        serviceId,
        providerId,
        title,
        description,
        capabilities: capabilitiesRaw.split(",").map((item) => item.trim()).filter(Boolean),
        price,
        sampleRequest: parseJson(sampleRequestRaw, "Sample request JSON"),
        sampleData: parseJson(sampleDataRaw, "Sample data JSON"),
        upstreamUrl,
        upstreamMethod: "POST",
        secretName: "PROVIDER_SECRET",
        secretValue,
        authHeader: "authorization",
        summary
      };
    }

    const liveDataRaw = await ask(rl, "Paid result data JSON", "{\"metric\":\"live\",\"value\":42}");

    return {
      mode,
      serviceId,
      providerId,
      title,
      description,
      capabilities: capabilitiesRaw.split(",").map((item) => item.trim()).filter(Boolean),
      price,
      sampleRequest: parseJson(sampleRequestRaw, "Sample request JSON"),
      sampleData: parseJson(sampleDataRaw, "Sample data JSON"),
      liveData: parseJson(liveDataRaw, "Paid response data JSON"),
      summary
    };
  } finally {
    rl.close();
  }
}

async function ask(rl, label, defaultValue) {
  const answer = await rl.question(`${label} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
}

function defaultProviderAnswers(mode = "static-json") {
  if (mode === "hosted-http") {
    return {
      mode,
      serviceId: "hosted_http_sentiment_demo",
      providerId: "provider_hosted_http_demo",
      title: "Hosted HTTP Sentiment Demo",
      description: "Use this service to fetch sentiment data through a hosted Provider Runtime with a private Provider Secret.",
      capabilities: ["sentiment_data", "hosted_http", "demo_data"],
      price: "0.01",
      sampleRequest: { asset: "ETH", window: "7d" },
      sampleData: {
        asset: "ETH",
        sentiment_score: 0.62,
        sample: true
      },
      upstreamUrl: `${baseUrl}/mock/upstream/sentiment`,
      upstreamMethod: "POST",
      secretName: "PROVIDER_SECRET",
      secretValue: "demo-provider-secret",
      authHeader: "authorization",
      summary: "ETH community sentiment from hosted HTTP runtime is positive."
    };
  }

  return {
    mode,
    serviceId: "community_sentiment_demo",
    providerId: "provider_local_demo",
    title: "Community Sentiment Demo",
    description: "Use this service to fetch a static MVP sentiment dataset for onboarding validation.",
    capabilities: ["sentiment_data", "demo_data"],
    price: "0.01",
    sampleRequest: { asset: "ETH", window: "7d" },
    sampleData: {
      asset: "ETH",
      sentiment_score: 0.61,
      sample: true
    },
    liveData: {
      asset: "ETH",
      sentiment_score: 0.74,
      mentions: 18230,
      positive_ratio: 0.67,
      negative_ratio: 0.18,
      neutral_ratio: 0.15
    },
    summary: "ETH community sentiment is positive over the selected window."
  };
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

async function postJson(path, body) {
  const publishToken = process.env.ADN_REMOTE_PUBLISH_TOKEN || process.env.ADN_STUDIO_API_TOKEN || "";
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(publishToken ? { authorization: `Bearer ${publishToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}
