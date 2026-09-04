import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "adn-mvp-test-"));
process.env.ADN_DIR = path.join(runtimeRoot, ".adn");
process.env.ADN_PROVIDER_DIR = path.join(runtimeRoot, "providers");
process.env.ADN_WALLET_PASSPHRASE = "test-passphrase";
process.env.ADN_PAYMENT_BACKEND = "circle_arc";
process.env.ADN_ARC_BALANCE_MOCK = "1000";
process.env.ADN_ARC_TRANSFER_MODE = "mock";
process.env.ADN_ARC_VERIFY_MODE = "mock";
process.env.ADN_ARC_ANCHOR_MODE = "mock";
process.env.ADN_ERC8004_MODE = "mock";
process.env.ADN_ERC8004_AGENT_ID = "1001";
process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb";
process.env.ADN_STUDIO_API_TOKEN = "test-provider-publish-token";
process.env.ADN_ADMIN_API_TOKEN = "test-admin-token";

const { createServer, publicApiAutomationOptions, seedDemoService } = await import("../src/server.js");
const { loadProviderConfigs, registerService, searchServices } = await import("../src/registry.js");
const { withCurrentRuntimeEndpoint } = await import("../src/registry.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const { DiscoveryConnector, runConsumerDemo } = await import("../src/connector.js");
const { discoverApiServices } = await import("../src/openapi-import.js");
const { readPaymentLog, resetWalletForTests } = await import("../src/wallet.js");
const { initSessionWallet, readWallet } = await import("../src/wallet.js");
const { createArcPaymentProof } = await import("../src/payment.js");
const { classifyArcRpcError, sendArcUsdcTransfer } = await import("../src/arc-payment.js");
const { getRequestBaseUrl, normalizeEndpoint } = await import("../src/http-utils.js");
const { createMemoryStore } = await import("../src/store.js");
const { quoteCapabilityRequest } = await import("../src/router.js");
const { verifyServiceResult } = await import("../src/verifier.js");
const { keccak256Hex } = await import("../src/keccak.js");
const { currentPaymentBackend } = await import("../src/payment-adapter.js");
const { invokePaidServiceWithLocalWallet } = await import("../src/local-invoke.js");
const { DEFAULT_PACKAGE_SPEC, diagnoseAgentRouter, formatDoctorResult, formatInstallResult, installAgentRouter, installUsage, parseInstallArgs } = await import("../src/agentrouter-installer.js");
const { buildServiceAwareInput, inferIntent } = await import("../src/agent-router.js");
const { createHostedHttpProviderConfig, deleteProviderConfig, writeProviderConfig } = await import("../src/provider-config.js");

test.after(async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
});

async function withServer(fn, options = {}) {
  await resetWalletForTests();
  await fs.rm(process.env.ADN_PROVIDER_DIR, { recursive: true, force: true });
  await fs.mkdir(process.env.ADN_PROVIDER_DIR, { recursive: true });
  await initSessionWallet();
  const server = createServer(options.serverBaseUrl ? { baseUrl: options.serverBaseUrl } : {});
  const authCookie = "ar_session=test-session";
  const testUser = {
    provider: "github",
    id: "test-provider",
    name: "Test Provider",
    email: "provider@example.com",
    avatar_url: "",
    handle: "test-provider"
  };
  server.store.authSessions.set("test-session", {
    user: testUser,
    created_at: Date.now(),
    expires_at: Date.now() + 60 * 60 * 1000
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const requestUrl = typeof input === "string" ? input : input?.url;
    const method = String(init.method || input?.method || "GET").toUpperCase();
    let parsed = null;
    try { parsed = new URL(requestUrl); } catch {}
    const isLocal = parsed?.origin === baseUrl;
    const needsAdminAuth = isLocal && method === "POST" && (
      /^\/services\/[^/]+\/(?:payout|validate|erc8004\/register)$/.test(parsed.pathname) ||
      parsed.pathname === "/agent-router/health-check"
    );
    const needsProviderAuth = isLocal && (
      (method !== "GET" && parsed.pathname.startsWith("/studio/")) ||
      (method === "POST" && parsed.pathname === "/agent-router/feedback")
    );
    if (!needsProviderAuth && !needsAdminAuth) return previousFetch(input, init);
    const headers = new Headers(init.headers || input?.headers || {});
    if (needsAdminAuth && !headers.has("authorization")) {
      headers.set("authorization", "Bearer test-admin-token");
    } else if (!headers.has("cookie")) {
      headers.set("cookie", authCookie);
    }
    return previousFetch(input, { ...init, headers });
  };
  try {
    await seedDemoService(baseUrl, server.store);
    await fn({ server, baseUrl, authCookie, testUser, rawFetch: previousFetch });
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

function runProcess(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("registry seeds and validates demo service", async () => {
  await withServer(async ({ server }) => {
    const record = server.store.services.get("chain_fund_flow_7d_base");
    assert.equal(record.verification_status, "verified");
    assert.equal(record.validation_runs.length, 1);
    assert.equal(record.validation_runs[0].ok, true);
  });
});

test("BNB judge mode and golden-task API are public and expose four first-class categories", async () => {
  await withServer(async ({ baseUrl, rawFetch }) => {
    const pageResponse = await rawFetch(`${baseUrl}/bnb`);
    const page = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(page, /Discover and hire trusted BSC agents/);

    const response = await rawFetch(`${baseUrl}/agent-router/bnb/golden-tasks`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.golden_task_list_version, "agent_router_bnb_golden_tasks_v1");
    assert.equal(payload.total, 4);
    assert.deepEqual(payload.tasks.map((task) => task.id), [
      "rebalancing",
      "grid-trading",
      "yield-optimization",
      "health-factor-monitoring"
    ]);
    assert.match(response.headers.get("cache-control"), /no-store/);
  });
});

test("home page and Provider Studio render separately", async () => {
  await withServer(async ({ baseUrl, authCookie, rawFetch }) => {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /rel="icon"/);
    assert.match(homeHtml, /\/favicon\.png/);
    assert.match(homeHtml, /Agent-native API routing layer/);
    assert.match(homeHtml, /Network snapshot/);
    assert.match(homeHtml, /Open provider dashboard/);
    assert.match(homeHtml, /Open agent API hub/);
    assert.match(homeHtml, /npx @agentrouternetwork\/agentrouter/);
    assert.doesNotMatch(homeHtml, /npx @agentrouternetwork\/agentrouter --full/);
    assert.doesNotMatch(homeHtml, /npx agentrouter(?:\s|$)/);
    assert.doesNotMatch(homeHtml, /--skill AgentRouter -g -y/);
    assert.match(homeHtml, /Give this to your AI agent/);
    assert.match(homeHtml, /Installs the Skill, connects one detected AI client/);
    assert.doesNotMatch(homeHtml, /curl -fsSL https:\/\/agentrouter\.network\/install\.sh \| bash/);
    assert.doesNotMatch(homeHtml, /Remote MCP/);
    assert.doesNotMatch(homeHtml, /Local MCP/);

    const human = await fetch(`${baseUrl}/human`);
    assert.equal(human.status, 200);
    const humanHtml = await human.text();
    assert.match(humanHtml, /Your API inventory stays private/);
    assert.match(humanHtml, /Add data\/API/);
    assert.doesNotMatch(humanHtml, /Your API cards/);

    const signedInHuman = await rawFetch(`${baseUrl}/human`, { headers: { cookie: authCookie } });
    assert.equal(signedInHuman.status, 200);
    const signedInHumanHtml = await signedInHuman.text();
    assert.match(signedInHumanHtml, /Feedback events/);
    assert.match(signedInHumanHtml, /Quality loop/);

    const humanStats = await fetch(`${baseUrl}/human/stats`);
    assert.equal(humanStats.status, 401);

    const agent = await fetch(`${baseUrl}/agent`);
    assert.equal(agent.status, 200);
    const agentHtml = await agent.text();
    assert.match(agentHtml, /API Hub for agents/);
    assert.doesNotMatch(agentHtml, /Built-in capabilities/);
    assert.match(agentHtml, /Social research/);
    assert.match(agentHtml, /Available services/);
    assert.match(agentHtml, /Use browser/);
    assert.match(agentHtml, /Free/);
    assert.doesNotMatch(agentHtml, /Universal MCP command/);

    const builtInCapabilitiesResponse = await fetch(`${baseUrl}/agent-router/builtin-capabilities`);
    assert.equal(builtInCapabilitiesResponse.status, 200);
    const builtInCapabilities = await builtInCapabilitiesResponse.json();
    assert.equal(builtInCapabilities.total, 2);
    assert.deepEqual(
      builtInCapabilities.capabilities.map((capability) => capability.capability),
      ["social_user_voice_research", "social_post_read"]
    );
    assert.deepEqual(builtInCapabilities.capabilities[0].platforms, ["X", "Reddit", "小红书", "B站", "YouTube", "Facebook"]);
    assert.equal(builtInCapabilities.capabilities[0].execution_location, "user_device");
    assert.equal(builtInCapabilities.capabilities[0].credential_policy, "never_upload");

    const lockedStudio = await fetch(`${baseUrl}/studio`, { redirect: "manual" });
    assert.equal(lockedStudio.status, 302);
    assert.match(lockedStudio.headers.get("location"), /\/auth\/login\?return_to=%2Fstudio/);
    const lockedStudioPost = await rawFetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(lockedStudioPost.status, 401);

    const studio = await fetch(`${baseUrl}/studio`, { headers: { cookie: authCookie } });
    assert.equal(studio.status, 200);
    const studioHtml = await studio.text();
    assert.match(studioHtml, /rel="icon"/);
    assert.match(studioHtml, /Provider Studio/);
    assert.match(studioHtml, /Verify & Publish Selected/);
    assert.doesNotMatch(studioHtml, /Buyer auth/);

    const favicon = await fetch(`${baseUrl}/favicon.png`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/png");
    assert.ok(Number(favicon.headers.get("content-length")) > 0);
  });
});

test("AgentRouter origin document is available from well-known and fallback paths", async () => {
  await withServer(async ({ baseUrl }) => {
    for (const pathName of ["/.well-known/agentrouter.json", "/agentrouter.json", "/agent-router/origin"]) {
      const response = await fetch(`${baseUrl}${pathName}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type").includes("application/json"), true);
      const payload = await response.json();
      assert.equal(payload.agentrouter, "1");
      assert.equal(payload.origin, baseUrl);
      assert.equal(payload.layer_role, "execution_routing_verification");
      assert.ok(payload.endpoints.remote_mcp.endsWith("/mcp"));
      assert.ok(payload.services.some((service) => service.service_id === "chain_fund_flow_7d_base"));
    }

    const head = await fetch(`${baseUrl}/.well-known/agentrouter.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type").includes("application/json"), true);
  });
});

test("AgentRouter skill can be installed without cloning GitHub", async () => {
  await withServer(async ({ baseUrl }) => {
    const homeResponse = await fetch(baseUrl);
    assert.equal(homeResponse.status, 200);
    const homeHtml = await homeResponse.text();
    assert.match(
      homeHtml,
      /npx @agentrouternetwork\/agentrouter/
    );

    const canonicalSkill = await fetch(`${baseUrl}/SKILL.md`);
    assert.equal(canonicalSkill.status, 200);
    assert.match(canonicalSkill.headers.get("content-type"), /text\/markdown/);
    const skillText = await canonicalSkill.text();
    assert.match(skillText, /name: AgentRouter/);
    assert.match(skillText, /https:\/\/agentrouter\.network\/mcp/);
    assert.match(
      skillText,
      /npx @agentrouternetwork\/agentrouter/
    );
    assert.doesNotMatch(skillText, /--skill AgentRouter -g -y/);
    assert.match(skillText, /explicit authorization/i);
    assert.match(skillText, /one detected current-user AI client/i);
    assert.match(skillText, /initialize.*tools\/list/is);
    assert.match(skillText, /AgentRouter SETUP COMPLETE \(client reload required\)/);
    assert.match(skillText, /AgentRouter READY \(MCP mode\)/);
    assert.match(skillText, /timestamped backup/i);
    assert.match(skillText, /Do not attempt alternate writes around it/i);
    assert.match(skillText, /Do not create or configure a local wallet/i);
    assert.match(skillText, /Agent Data Routing/);
    assert.match(skillText, /Payment Gate/);
    assert.match(skillText, /Do not require the user to mention AgentRouter/);
    assert.match(skillText, /not a software-development workflow router/);
    assert.match(skillText, /BMAD, OpenSpec, Superpowers/);
    // The canonical endpoint stays primary. Only the active Singapore Render
    // origin may be named as the bounded fallback; the retired original Render
    // service must never return to the Skill.
    assert.match(skillText, /agentrouter\.network\/agent-router\/fetch/);
    assert.match(skillText, /agentrouter-markets-sg\.onrender\.com\/agent-router\/fetch/);
    assert.doesNotMatch(skillText, /https:\/\/agentrouter-markets\.onrender\.com/, "the skill must not point at the retired host");
    assert.match(skillText, /mcp__market-data__\*/);
    assert.match(skillText, /fund_local_agentrouter_wallet/);
    assert.match(skillText, /Do not continue with web search/);

    const healthResponse = await fetch(`${baseUrl}/agent-router/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.deepEqual(health.runtime_modes, ["http", "remote_mcp"]);
    assert.equal(health.http_fetch, `${baseUrl}/agent-router/fetch`);
    assert.equal(health.features.vendor_registration_paymaster.configured, false);
    assert.equal(health.features.vendor_registration_paymaster.standard, "BEP-414");

    const legacySkill = await fetch(`${baseUrl}/skills/AgentRouter/SKILL.md`);
    assert.equal(legacySkill.status, 200);
    assert.equal(await legacySkill.text(), skillText);

    const installScript = await fetch(`${baseUrl}/install.sh`);
    assert.equal(installScript.status, 200);
    assert.match(installScript.headers.get("content-type"), /text\/x-shellscript/);
    const scriptText = await installScript.text();
    assert.match(scriptText, /SKILL_URL="\$\{AGENT_ROUTER_URL%\/\}\/SKILL.md"/);
    assert.match(scriptText, /\$HOME\/\.agents\/skills\/agentrouter/);
    assert.match(scriptText, /claude_desktop_config\.json/);
    assert.match(scriptText, /config\.mcpServers\.AgentRouter/);
    assert.match(scriptText, /CURSOR_MCP_CONFIG/);
    assert.match(scriptText, /@agentrouternetwork\/mcp@latest/);
    assert.doesNotMatch(scriptText, /ADN_|AGENT_ROUTER_MAX_PRICE|wallet/i);
    assert.doesNotMatch(scriptText, /agentrouter-markets/);
    assert.doesNotMatch(scriptText, /wallet create-session/);
    assert.match(scriptText, /No desktop MCP config was changed/);
    assert.match(scriptText, /AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP=1/);
    assert.match(scriptText, /AGENTROUTER_CONFIGURE_CURSOR=1/);
    assert.match(scriptText, /Restart or reload the configured AI client/);
    assert.match(scriptText, /Then ask a normal data\/API question/);
    assert.doesNotMatch(scriptText, /github\.com/);

    const home = await fs.mkdtemp(path.join(runtimeRoot, "agent-native-install-"));
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    const scriptPath = path.join(home, "install.sh");
    const originalConfig = {
      mcpServers: {
        OtherTool: { command: "other-tool", args: ["serve"] }
      }
    };
    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.writeFile(cursorConfig, JSON.stringify(originalConfig, null, 2));
    await fs.writeFile(scriptPath, scriptText, { mode: 0o700 });

    const defaultInstall = await runProcess("bash", [scriptPath], {
      HOME: home,
      AGENT_ROUTER_URL: baseUrl,
      CURSOR_MCP_CONFIG: cursorConfig,
      CLAUDE_DESKTOP_CONFIG: path.join(home, "missing-claude.json")
    });
    assert.equal(defaultInstall.code, 0, defaultInstall.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(cursorConfig, "utf8")), originalConfig);

    const explicitInstall = await runProcess("bash", [scriptPath], {
      HOME: home,
      AGENT_ROUTER_URL: baseUrl,
      CURSOR_MCP_CONFIG: cursorConfig,
      CLAUDE_DESKTOP_CONFIG: path.join(home, "missing-claude.json"),
      AGENTROUTER_CONFIGURE_CURSOR: "1"
    });
    assert.equal(explicitInstall.code, 0, explicitInstall.stderr);
    const configured = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.deepEqual(configured.mcpServers.OtherTool, originalConfig.mcpServers.OtherTool);
    assert.deepEqual(configured.mcpServers.AgentRouter.env, { AGENT_ROUTER_URL: baseUrl });
  });
});

test("AgentRouter exposes a repository-independent remote update channel", async () => {
  await withServer(async ({ baseUrl }) => {
    const manifestResponse = await fetch(`${baseUrl}/agent-router/update-manifest.json`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type"), /application\/json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.schema_version, "agentrouter_update_manifest_v1");
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.skill_version, "0.8.0");
    assert.equal(manifest.routing_policy_version, "external_information_first_v1");
    assert.equal(manifest.mcp.package, "@agentrouternetwork/mcp");
    assert.equal(manifest.mcp.spec, "@agentrouternetwork/mcp@latest");
    assert.equal(manifest.remote_mcp_url, `${baseUrl}/mcp`);
    assert.equal(manifest.skill_url, `${baseUrl}/SKILL.md`);
    assert.equal(manifest.update_script_url, `${baseUrl}/update.sh`);
    assert.equal(manifest.repository_access_required, false);

    const updateResponse = await fetch(`${baseUrl}/update.sh`);
    assert.equal(updateResponse.status, 200);
    assert.match(updateResponse.headers.get("content-type"), /text\/x-shellscript/);
    const updateScript = await updateResponse.text();
    assert.match(updateScript, /agent-router\/update-manifest\.json/);
    assert.match(updateScript, /@agentrouternetwork\/mcp@latest/);
    assert.match(updateScript, /AgentRouter updated\. READY/);
    assert.doesNotMatch(updateScript, /agentrouter-markets/);
    assert.doesNotMatch(updateScript, /github\.com/);
  });
});

test("hosted update script migrates an existing install without touching user state", async () => {
  await withServer(async ({ baseUrl }) => {
    const home = await fs.mkdtemp(path.join(runtimeRoot, "hosted-update-"));
    const skillDir = path.join(home, ".codex", "skills", "agentrouter");
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    const walletDir = path.join(home, ".agentrouter", "adn");
    const walletSecret = path.join(walletDir, "wallet-session.key");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# old skill\n");
    await fs.writeFile(walletSecret, "preserve-wallet-secret");
    await fs.writeFile(cursorConfig, JSON.stringify({
      mcpServers: {
        OtherTool: { command: "other-tool", args: ["serve"] },
        AgentRouter: {
          command: "npx",
          args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"],
          env: {
            AGENT_ROUTER_URL: "https://custom.agentrouter.example",
            AGENT_ROUTER_API_KEY: "ar_live_preserve",
            USER_DEFINED_SETTING: "keep-me",
            ADN_DIR: walletDir
          }
        }
      }
    }, null, 2));

    const scriptPath = path.join(home, "update.sh");
    await fs.writeFile(scriptPath, await fetch(`${baseUrl}/update.sh`).then((response) => response.text()), { mode: 0o700 });
    const result = await runProcess("bash", [scriptPath], {
      HOME: home,
      AGENT_ROUTER_URL: baseUrl,
      CURSOR_MCP_CONFIG: cursorConfig,
      CLAUDE_DESKTOP_CONFIG: path.join(home, "missing-claude.json")
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /AgentRouter updated\. READY/);
    const updated = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.deepEqual(updated.mcpServers.OtherTool, { command: "other-tool", args: ["serve"] });
    assert.deepEqual(updated.mcpServers.AgentRouter.args, ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]);
    assert.equal(updated.mcpServers.AgentRouter.env.AGENT_ROUTER_URL, "https://custom.agentrouter.example");
    assert.equal(updated.mcpServers.AgentRouter.env.AGENT_ROUTER_API_KEY, "ar_live_preserve");
    assert.equal(updated.mcpServers.AgentRouter.env.USER_DEFINED_SETTING, "keep-me");
    assert.equal(await fs.readFile(walletSecret, "utf8"), "preserve-wallet-secret");
    assert.match(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8"), /name: AgentRouter/);
    assert.equal((await fs.readdir(path.dirname(cursorConfig))).some((name) => name.startsWith("mcp.json.bak.")), true);
  });
});

test("AgentRouter natural-language parser maps HYPE smart-money requests to HyperEVM", () => {
  const intent = inferIntent("查 HYPE 近 24 小时聪明钱动向");
  assert.equal(intent.wants_smart_money_activity, true);
  assert.equal(intent.token, "HYPE");
  assert.equal(intent.chain, "hyperevm");
  assert.equal(intent.input.chain, "hyperevm");
  assert.equal(intent.input.window, "24h");
  assert.equal(typeof intent.input.date.from, "string");
  assert.equal(typeof intent.input.date.to, "string");
});

test("AgentRouter fills date range for Nansen token-flow services even when manifest omits date", () => {
  const intent = inferIntent("查 ETH 近 24 小时聪明钱 netflow");
  const manifest = {
    service_id: "nansen_tgm_flows",
    title: "Nansen TGM who bought sold flows",
    description_for_agent: "Use this Nansen service for token-level smart money flow intelligence and who bought/sold data.",
    capabilities: ["nansen", "data_service", "token_god_mode", "token_flow", "smart_money"],
    sample_request: {
      chain: "ethereum",
      token_address: "0x0000000000000000000000000000000000000000",
      pagination: { page: 1, per_page: 10 }
    },
    input_schema: {
      type: "object",
      properties: {
        chain: { type: "string" },
        token_address: { type: "string" },
        pagination: { type: "object" }
      }
    }
  };
  const input = buildServiceAwareInput({
    ...intent,
    input: {
      ...intent.input,
      token_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }, manifest);
  assert.equal(input.chain, "ethereum");
  assert.equal(input.token_address, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  assert.deepEqual(input.pagination, { page: 1, per_page: 24 });
  assert.equal(typeof input.date.from, "string");
  assert.equal(typeof input.date.to, "string");
});

test("structured token smart-money quotes preserve Nansen date input before payment", () => {
  const store = createMemoryStore();
  const record = registerService(store, {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: "nansen_tgm_flows_test",
    provider: { provider_id: "provider_nansen_test" },
    title: "Nansen TGM who bought sold flows",
    description_for_agent: "Use this Nansen API service for token-level smart money flow intelligence and who bought/sold data.",
    capabilities: ["nansen", "data_service", "token_god_mode", "token_data", "token_flow", "smart_money"],
    input_schema: {
      type: "object",
      required: ["chain", "token_address"],
      properties: {
        chain: { type: "string" },
        token_address: { type: "string" },
        pagination: { type: "object" }
      }
    },
    output_schema: {
      type: "object",
      properties: {
        schema_version: { type: "string" },
        data: { type: "object" }
      }
    },
    sample_request: {
      chain: "ethereum",
      token_address: "0x0000000000000000000000000000000000000000",
      pagination: { page: 1, per_page: 10 }
    },
    sample_response: {
      schema_version: "agent_data_envelope_v1",
      service_id: "nansen_tgm_flows_test",
      request_id: "sample_req",
      status: "success",
      query: {},
      data: { rows: [] },
      metadata: { freshness_seconds: 60 },
      summary: "Sample token flow data."
    },
    pricing: {
      amount: "0.01",
      currency: "USDC",
      network: "arc-testnet",
      protocol: "x402"
    },
    endpoint: {
      url: "/provider/custom/nansen_tgm_flows_test",
      method: "POST"
    }
  }, "http://127.0.0.1:8800");
  record.verification_status = "verified";

  const quote = quoteCapabilityRequest(store, {
    capability: "token_smart_money_activity",
    params: {
      token_symbol: "ETH",
      token_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      chain: "ethereum",
      window: "24h"
    },
    constraints: { max_price_usdc: "0.05" }
  });
  assert.equal(quote.ok, true);
  assert.equal(quote.selected_service.service_id, "nansen_tgm_flows_test");
  assert.equal(quote.input.token_address, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  assert.equal(typeof quote.input.date.from, "string");
  assert.equal(typeof quote.input.date.to, "string");
});

test("wallet default path is stable outside temporary working directories", async () => {
  const env = { ...process.env };
  delete env.ADN_DIR;
  env.HOME = path.join(runtimeRoot, "home-default-wallet");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import('./src/wallet.js').then((m) => console.log(m.WALLET_PATH))"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), path.join(env.HOME, ".agentrouter", "adn", "wallet.json"));
});

test("agentrouter one-command installer is HTTP-ready without changing MCP config or creating a wallet", async () => {
  const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-http-install-"));
  const cursorConfig = path.join(home, ".cursor", "mcp.json");
  const originalConfig = {
    mcpServers: {
      OtherTool: { command: "other-tool", args: ["serve"] }
    }
  };
  await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
  await fs.writeFile(cursorConfig, JSON.stringify(originalConfig, null, 2));

  const previousFetch = globalThis.fetch;
  const requestedUrls = [];
  try {
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({
        ok: true,
        runtime_modes: ["http", "remote_mcp"],
        http_fetch: "https://agentrouter.network/agent-router/fetch"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const result = await installAgentRouter({
      home,
      cursorConfig,
      skillText: "---\nname: AgentRouter\n---\n# AgentRouter\n"
    });

    assert.equal(result.ok, true);
    assert.equal(result.readiness.status, "READY");
    assert.equal(result.readiness.runtime_mode, "http");
    assert.deepEqual(result.configured_clients, []);
    assert.equal(result.wallet, null);
    assert.deepEqual(JSON.parse(await fs.readFile(cursorConfig, "utf8")), originalConfig);
    assert.equal(await fs.access(path.join(home, ".agentrouter", "adn", "wallet.json")).then(() => true, () => false), false);
    assert.deepEqual(requestedUrls, ["https://agentrouter.network/agent-router/health"]);
    assert.match(formatInstallResult(result), /AgentRouter installed\. READY \(HTTP mode\)/);
    assert.doesNotMatch(formatInstallResult(result), /Rerun|wallet|MCP configured/i);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(parseInstallArgs([]), { clients: [] });
  assert.deepEqual(parseInstallArgs(["--mcp", "--wallet"]), {
    clients: ["auto"],
    createWallet: true
  });
  assert.match(installUsage(), /npx @agentrouternetwork\/agentrouter/);
  assert.match(installUsage(), /--mcp/);
  assert.match(installUsage(), /--wallet/);
});

test("public agentrouter npm installer configures one local MCP bridge by default", async () => {
  await withServer(async ({ baseUrl }) => {
    const packageDir = path.join(process.cwd(), "packages", "agentrouter-installer");
    const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
    assert.equal(packageJson.name, "@agentrouternetwork/agentrouter");
    assert.equal(packageJson.version, "0.10.0");
    assert.deepEqual(packageJson.files, ["bin", "server", "README.md", "LICENSE"]);
    assert.deepEqual(packageJson.bin, { agentrouter: "./bin/agentrouter.js" });
    assert.deepEqual(packageJson.dependencies || {}, {});

    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-public-package-"));
    const skillDir = path.join(home, ".agents", "skills", "agentrouter");
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    const result = await runProcess(process.execPath, [
      path.join(packageDir, "bin", "agentrouter.js"),
      "--url",
      baseUrl,
      "--json"
    ], {
      HOME: home,
      AGENTROUTER_SKILL_DIRS: skillDir,
      CURSOR_MCP_CONFIG: cursorConfig,
      AGENTROUTER_SKIP_BROWSER_SETUP: "1"
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.runtime_mode, "mcp");
    assert.equal(payload.health_url, `${baseUrl}/agent-router/health`);
    assert.equal(payload.fetch_url, `${baseUrl}/agent-router/fetch`);
    assert.equal(await fs.access(path.join(skillDir, "SKILL.md")).then(() => true, () => false), true);
    const configured = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.deepEqual(configured.mcpServers.AgentRouter.args, [
      "-y",
      "--package",
      "@agentrouternetwork/mcp@latest",
      "agentrouter-mcp"
    ]);
    assert.equal(await fs.access(path.join(home, ".agentrouter", "adn", "wallet.json")).then(() => true, () => false), false);
  });
});

test("public agentrouter installer migrates an existing legacy bridge before choosing an unrelated client", async () => {
  await withServer(async ({ baseUrl }) => {
    const packageDir = path.join(process.cwd(), "packages", "agentrouter-installer");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-public-migrate-"));
    const claudeCodeConfig = path.join(home, ".claude.json");
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.writeFile(claudeCodeConfig, JSON.stringify({
      mcpServers: { OtherTool: { command: "other-tool" } }
    }));
    await fs.writeFile(cursorConfig, JSON.stringify({
      mcpServers: {
        OtherTool: { command: "keep-me" },
        AgentRouter: {
          command: "npx",
          args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"],
          env: {
            AGENT_ROUTER_URL: baseUrl,
            AGENT_ROUTER_API_KEY: "keep-this-secret-reference",
            USER_DEFINED_SETTING: "keep-me"
          }
        }
      }
    }));

    const result = await runProcess(process.execPath, [
      path.join(packageDir, "bin", "agentrouter.js"),
      "--url",
      baseUrl,
      "--json"
    ], {
      HOME: home,
      // No invoking client: scrub host-detection vars the parent shell may export.
      CLAUDECODE: "",
      CLAUDE_CODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      CLAUDE_CODE_CONFIG: "",
      CURSOR_AGENT: "",
      CURSOR_TRACE_ID: "",
      CURSOR_SESSION_ID: "",
      CURSOR_MCP_CONFIG: "",
      CODEX_SANDBOX: "",
      CODEX_SANDBOX_NETWORK_DISABLED: "",
      CODEX_THREAD_ID: "",
      CODEX_HOME: "",
      CODEX_MCP_CONFIG: "",
      CLAUDE_DESKTOP: "",
      CLAUDE_DESKTOP_MCP_CONFIG: "",
      AGENTROUTER_SKIP_BROWSER_SETUP: "1"
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.configured_clients.map((client) => client.name), ["Cursor"]);
    const claude = JSON.parse(await fs.readFile(claudeCodeConfig, "utf8"));
    assert.equal(claude.mcpServers.AgentRouter, undefined);
    const cursor = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.deepEqual(cursor.mcpServers.OtherTool, { command: "keep-me" });
    assert.deepEqual(cursor.mcpServers.AgentRouter.args, [
      "-y",
      "--package",
      "@agentrouternetwork/mcp@latest",
      "agentrouter-mcp"
    ]);
    assert.equal(cursor.mcpServers.AgentRouter.env.AGENT_ROUTER_API_KEY, "keep-this-secret-reference");
    assert.equal(cursor.mcpServers.AgentRouter.env.USER_DEFINED_SETTING, "keep-me");
  });
});

test("public agentrouter installer prefers the invoking AI client over a legacy entry elsewhere", async () => {
  await withServer(async ({ baseUrl }) => {
    const packageDir = path.join(process.cwd(), "packages", "agentrouter-installer");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-public-current-client-"));
    const claudeCodeConfig = path.join(home, ".claude.json");
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.writeFile(claudeCodeConfig, JSON.stringify({ mcpServers: {} }));
    await fs.writeFile(cursorConfig, JSON.stringify({
      mcpServers: {
        AgentRouter: {
          command: "npx",
          args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"]
        }
      }
    }));

    const result = await runProcess(process.execPath, [
      path.join(packageDir, "bin", "agentrouter.js"),
      "--url",
      baseUrl,
      "--json"
    ], { HOME: home, CLAUDECODE: "1", AGENTROUTER_SKIP_BROWSER_SETUP: "1" });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.configured_clients.map((client) => client.name), ["Claude Code"]);
    const claude = JSON.parse(await fs.readFile(claudeCodeConfig, "utf8"));
    assert.equal(claude.mcpServers.AgentRouter.command, "npx");
    const cursor = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.match(cursor.mcpServers.AgentRouter.args.join(" "), /github:connectwilson/);
  });
});

test("public agentrouter installer keeps an explicit HTTP-only escape hatch", async () => {
  await withServer(async ({ baseUrl }) => {
    const packageDir = path.join(process.cwd(), "packages", "agentrouter-installer");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-public-http-only-"));
    const cursorConfig = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.writeFile(cursorConfig, JSON.stringify({
      mcpServers: { OtherTool: { command: "other-tool" } }
    }));

    const result = await runProcess(process.execPath, [
      path.join(packageDir, "bin", "agentrouter.js"),
      "--http-only",
      "--url",
      baseUrl,
      "--json"
    ], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtime_mode, "http");
    const configured = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.equal(configured.mcpServers.AgentRouter, undefined);
  });
});

test("public agentrouter --full configures one MCP client and verifies agentrouter_fetch", async () => {
  await withServer(async ({ baseUrl }) => {
    const packageDir = path.join(process.cwd(), "packages", "agentrouter-installer");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-public-full-"));
    const claudeCodeConfig = path.join(home, ".claude.json");
    const originalConfig = {
      mcpServers: {
        OtherTool: { command: "other-tool", args: ["serve"] }
      }
    };
    await fs.writeFile(claudeCodeConfig, JSON.stringify(originalConfig, null, 2));

    const result = await runProcess(process.execPath, [
      path.join(packageDir, "bin", "agentrouter.js"),
      "--full",
      "--url",
      baseUrl,
      "--json"
    ], {
      HOME: home,
      CLAUDE_CODE_CONFIG: claudeCodeConfig,
      AGENTROUTER_SKIP_BROWSER_SETUP: "1"
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.runtime_mode, "mcp");
    assert.equal(payload.bridge_configured, true);
    assert.equal(payload.remote_mcp_verified, true);
    assert.ok(payload.mcp_tools.includes("agentrouter_fetch"));
    assert.deepEqual(payload.configured_clients.map((client) => client.name), ["Claude Code"]);

    const configured = JSON.parse(await fs.readFile(claudeCodeConfig, "utf8"));
    assert.deepEqual(configured.mcpServers.OtherTool, originalConfig.mcpServers.OtherTool);
    assert.equal(configured.mcpServers.AgentRouter.command, "npx");
    assert.deepEqual(configured.mcpServers.AgentRouter.args, [
      "-y",
      "--package",
      "@agentrouternetwork/mcp@latest",
      "agentrouter-mcp"
    ]);
    assert.deepEqual(configured.mcpServers.AgentRouter.env, {
      AGENT_ROUTER_URL: baseUrl
    });
    assert.equal(await fs.access(path.join(home, ".agentrouter", "adn", "wallet.json")).then(() => true, () => false), false);
  });
});

test("installer browser connector best-effort installs OpenCLI and always returns guidance", async () => {
  const { ensureLocalBrowserConnector } = await import("../packages/agentrouter-installer/server/index.js");
  const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-connector-"));
  const binDir = path.join(home, ".npm-global", "bin");

  // Missing + autoInstall: the mock "npm install" drops the opencli bin into place.
  const calls = [];
  const missing = await ensureLocalBrowserConnector({
    home,
    env: { PATH: "" },
    autoInstall: true,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(path.join(binDir, "opencli"), "#!/bin/sh\n", { mode: 0o755 });
      return { status: "completed" };
    }
  });
  assert.deepEqual(calls[0], ["npm", "install", "-g", "@jackwener/opencli"]);
  assert.equal(missing.installed, true);
  assert.equal(missing.install_attempted, true);
  assert.equal(missing.install_ok, true);
  assert.equal(missing.package, "@jackwener/opencli");
  assert.ok(missing.path.endsWith(path.join("bin", "opencli")));

  // Already present + autoInstall disabled: detect only, never spawn, still guide.
  let spawned = false;
  const present = await ensureLocalBrowserConnector({
    home,
    env: { PATH: binDir },
    autoInstall: false,
    runCommand: async () => { spawned = true; return { status: "completed" }; }
  });
  assert.equal(spawned, false);
  assert.equal(present.installed, true);
  assert.equal(present.install_attempted, false);
  assert.equal(present.install_command, "npm install -g @jackwener/opencli");
  assert.ok(Array.isArray(present.next_steps) && present.next_steps.length >= 1);
});

test("agentrouter CLI installer configures local MCP clients only when explicitly requested", async () => {
  assert.equal(DEFAULT_PACKAGE_SPEC, "@agentrouternetwork/mcp@latest");
  const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-install-"));
  const cursorDir = path.join(home, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });
  const claudeConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cursorConfig = path.join(cursorDir, "mcp.json");
  const result = await installAgentRouter({
    home,
    clients: ["claude-desktop"],
    claudeConfig,
    cursorConfig,
    skillText: "---\nname: AgentRouter\n---\n# AgentRouter\n",
    createWallet: false,
    requireConfiguredClient: true,
    skipNetworkCheck: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.readiness.status, "READY");
  assert.equal(result.configured_clients.length, 1);
  assert.deepEqual(result.configured_clients.map((client) => client.name), ["Claude Desktop"]);
  assert.equal(await fs.readFile(path.join(home, ".agents", "skills", "agentrouter", "SKILL.md"), "utf8"), "---\nname: AgentRouter\n---\n# AgentRouter\n");

  const claudeJson = JSON.parse(await fs.readFile(claudeConfig, "utf8"));
  assert.equal(claudeJson.mcpServers.AgentRouter.command, "npx");
  assert.deepEqual(claudeJson.mcpServers.AgentRouter.args, ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]);
  assert.equal(claudeJson.mcpServers.AgentRouter.env.AGENT_ROUTER_URL, "https://agentrouter.network");
  assert.equal(claudeJson.mcpServers.AgentRouter.env.ADN_PAYMENT_BACKEND, "circle_arc");
  assert.match(claudeJson.mcpServers.AgentRouter.env.ADN_DIR, /\.agentrouter\/adn$/);
  assert.equal(await fs.access(cursorConfig).then(() => true, () => false), false);

  assert.match(formatInstallResult(result), /AgentRouter installed\. READY/);
  assert.deepEqual(parseInstallArgs(["install", "--client", "cursor", "--no-wallet"]), {
    clients: ["cursor"],
    createWallet: false
  });
});

test("agentrouter update refreshes existing installs without replacing user settings", async () => {
  const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-update-"));
  const claudeConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cursorConfig = path.join(home, ".cursor", "mcp.json");
  const skillDir = path.join(home, ".codex", "skills", "agentrouter");
  const adnDir = path.join(home, "custom-agentrouter-wallet");
  await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(adnDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: AgentRouter\nmetadata:\n  version: 0.1.0\n---\n# Old AgentRouter\n");
  await fs.writeFile(path.join(adnDir, "wallet.json"), JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }));
  await fs.writeFile(path.join(adnDir, "wallet-session.key"), "keep-this-wallet-secret");
  await fs.writeFile(cursorConfig, JSON.stringify({
    mcpServers: {
      OtherTool: { command: "other-tool", args: ["serve"] },
      AgentRouter: {
        command: "npx",
        args: ["-y", "--package", "@agentrouter/mcp@0.1.0", "agent-router-mcp"],
        env: {
          AGENT_ROUTER_URL: "https://custom.agentrouter.example",
          AGENT_ROUTER_MAX_PRICE: "0.12",
          AGENT_ROUTER_API_KEY: "ar_live_keep_me",
          ADN_PAYMENT_BACKEND: "circle_arc",
          ADN_ARC_RPC_URL: "https://custom.arc.example",
          ADN_DIR: adnDir,
          USER_DEFINED_SETTING: "keep-me"
        }
      }
    }
  }, null, 2));

  const result = await installAgentRouter({
    home,
    update: true,
    claudeConfig,
    cursorConfig,
    skillText: "---\nname: AgentRouter\nmetadata:\n  version: 0.2.0\n---\n# New AgentRouter\n",
    skipNetworkCheck: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.wallet, null);
  assert.deepEqual(result.configured_clients.map((client) => client.name), ["Cursor"]);
  assert.equal(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8"), "---\nname: AgentRouter\nmetadata:\n  version: 0.2.0\n---\n# New AgentRouter\n");
  assert.equal(await fs.access(claudeConfig).then(() => true, () => false), false);

  const updated = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
  assert.deepEqual(updated.mcpServers.OtherTool, { command: "other-tool", args: ["serve"] });
  assert.deepEqual(updated.mcpServers.AgentRouter.args, ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]);
  assert.equal(updated.mcpServers.AgentRouter.env.AGENT_ROUTER_URL, "https://custom.agentrouter.example");
  assert.equal(updated.mcpServers.AgentRouter.env.AGENT_ROUTER_MAX_PRICE, "0.12");
  assert.equal(updated.mcpServers.AgentRouter.env.AGENT_ROUTER_API_KEY, "ar_live_keep_me");
  assert.equal(updated.mcpServers.AgentRouter.env.ADN_ARC_RPC_URL, "https://custom.arc.example");
  assert.equal(updated.mcpServers.AgentRouter.env.ADN_DIR, adnDir);
  assert.equal(updated.mcpServers.AgentRouter.env.USER_DEFINED_SETTING, "keep-me");
  assert.equal(await fs.readFile(path.join(adnDir, "wallet-session.key"), "utf8"), "keep-this-wallet-secret");
  assert.match(formatInstallResult(result), /AgentRouter updated\. READY/);
  assert.deepEqual(parseInstallArgs(["update", "--no-network-check"]), {
    clients: [],
    update: true,
    skipNetworkCheck: true
  });

  await installAgentRouter({
    home,
    update: true,
    maxPrice: "0.25",
    claudeConfig,
    cursorConfig,
    skillText: "---\nname: AgentRouter\nmetadata:\n  version: 0.2.0\n---\n# New AgentRouter\n",
    skipNetworkCheck: true
  });
  const explicitlyOverridden = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
  assert.equal(explicitlyOverridden.mcpServers.AgentRouter.env.AGENT_ROUTER_MAX_PRICE, "0.25");
});

test("agentrouter doctor reports readiness when skill wallet and MCP config are present", async () => {
  const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-doctor-"));
  const adnDir = path.join(home, ".agentrouter", "adn");
  const cursorConfig = path.join(home, ".cursor", "mcp.json");
  const result = await installAgentRouter({
    home,
    clients: ["cursor"],
    createWallet: true,
    adnDir,
    cursorConfig,
    skillText: "---\nname: AgentRouter\n---\n# AgentRouter\n",
    skipNetworkCheck: true
  });
  assert.equal(result.ok, true);

  const doctor = await diagnoseAgentRouter({
    home,
    adnDir,
    cursorConfig,
    skipNetwork: true
  });
  assert.equal(doctor.ready, true);
  assert.equal(doctor.status, "READY");
  assert.match(formatDoctorResult(doctor), /AgentRouter doctor: READY/);
  assert.ok(doctor.checks.some((check) => check.name === "wallet" && check.ok));
});

test("GitHub login entrypoint renders and OAuth callback creates a session", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const login = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/?login=1");

    const loginPage = await fetch(`${baseUrl}/?login=1`);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /id="auth-modal"/);
    assert.match(loginHtml, /data-login-modal-open="true"/);
    assert.match(loginHtml, /Continue with GitHub|GitHub/);
    assert.doesNotMatch(loginHtml, /Google|GOOGLE_CLIENT_ID/);
    assert.match(loginHtml, /Welcome back/);

    const previousEnv = {
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET
    };
    const previousFetch = globalThis.fetch;
    try {
      process.env.GITHUB_CLIENT_ID = "github-client";
      process.env.GITHUB_CLIENT_SECRET = "github-secret";
      const start = await fetch(`${baseUrl}/auth/github/start?return_to=%2Fstudio`, { redirect: "manual" });
      assert.equal(start.status, 302);
      const location = start.headers.get("location");
      assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize/);
      const state = new URL(location).searchParams.get("state");
      const oauthCookie = start.headers.get("set-cookie");
      assert.match(oauthCookie, /^ar_oauth_state_[A-Za-z0-9_-]{20}=/);
      assert.ok(server.store.oauthStates.has(state));

      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "test-access-token" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (target === "https://api.github.com/user") {
          return new Response(JSON.stringify({
            id: 42,
            login: "octo",
            name: "Octo User",
            email: "octo@example.com",
            avatar_url: "https://avatars.example/octo.png"
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`Unexpected fetch ${target}`);
      };

      const callback = await previousFetch(`${baseUrl}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { cookie: oauthCookie.split(";", 1)[0] },
        redirect: "manual"
      });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), "/studio");
      const cookie = callback.headers.get("set-cookie");
      assert.match(cookie, /ar_session=/);
      assert.match(cookie, /ar_oauth_state_[A-Za-z0-9_-]{20}=;/);

      const me = await previousFetch(`${baseUrl}/auth/me`, { headers: { cookie } });
      assert.equal(me.status, 200);
      const payload = await me.json();
      assert.equal(payload.authenticated, true);
      assert.equal(payload.user.provider, "github");
      assert.equal(payload.user.email, "octo@example.com");

      const human = await previousFetch(`${baseUrl}/human`, { headers: { cookie } });
      assert.equal(human.status, 200);
      const humanHtml = await human.text();
      assert.match(humanHtml, /Provider Dashboard/);
      assert.match(humanHtml, /Your API cards/);

      const humanStats = await previousFetch(`${baseUrl}/human/stats`, { headers: { cookie } });
      assert.equal(humanStats.status, 200);
      const stats = await humanStats.json();
      assert.equal(stats.registered_services, 0);
      assert.equal(Array.isArray(stats.services), true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnv.GITHUB_CLIENT_ID === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = previousEnv.GITHUB_CLIENT_ID;
      if (previousEnv.GITHUB_CLIENT_SECRET === undefined) delete process.env.GITHUB_CLIENT_SECRET;
      else process.env.GITHUB_CLIENT_SECRET = previousEnv.GITHUB_CLIENT_SECRET;
    }
  });
});

test("provider dashboard only exposes services owned by the signed-in provider", async () => {
  await withServer(async ({ server, baseUrl, authCookie, rawFetch }) => {
    const ownedManifest = structuredClone(baseFundFlowManifest);
    ownedManifest.service_id = "owned_provider_private_demo";
    ownedManifest.title = "Owned Provider Private Demo";
    ownedManifest.provider = { provider_id: "provider_private_alice" };
    ownedManifest.capabilities = ["private_provider_demo", "data_service"];
    const ownedResponse = await rawFetch(`${baseUrl}/services/register`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify(ownedManifest)
    });
    assert.equal(ownedResponse.status, 201);

    const foreignManifest = structuredClone(baseFundFlowManifest);
    foreignManifest.service_id = "foreign_provider_private_demo";
    foreignManifest.title = "Foreign Provider Private Demo";
    foreignManifest.provider = { provider_id: "provider_private_bob" };
    foreignManifest.capabilities = ["private_provider_demo", "data_service"];
    foreignManifest.registration = {
      ...(foreignManifest.registration || {}),
      owner: {
        user_key: "github:other-provider",
        provider: "github",
        user_id: "other-provider",
        handle: "other-provider",
        created_at: new Date().toISOString()
      }
    };
    registerService(server.store, foreignManifest, baseUrl);

    const statsResponse = await rawFetch(`${baseUrl}/human/stats`, {
      headers: { cookie: authCookie }
    });
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.deepEqual(stats.services.map((service) => service.service_id), ["owned_provider_private_demo"]);
    assert.equal(stats.registered_services, 1);

    const editOwned = await rawFetch(`${baseUrl}/studio?service_id=owned_provider_private_demo`, {
      headers: { cookie: authCookie }
    });
    assert.equal(editOwned.status, 200);
    const editForeign = await rawFetch(`${baseUrl}/studio?service_id=foreign_provider_private_demo`, {
      headers: { cookie: authCookie }
    });
    assert.equal(editForeign.status, 403);
  });
});

test("published services can bind an Arc payout wallet without re-registration", async () => {
  await withServer(async ({ baseUrl }) => {
    const payoutAddress = "0x1111111111111111111111111111111111111111";
    const update = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/payout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout_address: payoutAddress })
    });
    assert.equal(update.status, 200);
    const payload = await update.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.payout_address, payoutAddress);
    assert.equal(payload.manifest.provider.payout_address, payoutAddress);
    assert.equal(payload.manifest.pricing.pay_to, payoutAddress);
    assert.equal(payload.manifest.pricing.settlement_model, "direct_provider_wallet");

    const manifestResponse = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/manifest`);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.provider.payout_address, payoutAddress);
    assert.equal(manifest.pricing.pay_to, payoutAddress);

    const invalid = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/payout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout_address: "not-an-address" })
    });
    assert.equal(invalid.status, 422);
    const errorPayload = await invalid.json();
    assert.equal(errorPayload.error.code, "INVALID_PAYOUT_ADDRESS");
  });
});

test("published services can register ERC-8004 identity metadata and use it for feedback", async () => {
  await withServer(async ({ baseUrl, server }) => {
    const metadataResponse = await fetch(`${baseUrl}/.well-known/erc8004/agents/chain_fund_flow_7d_base.json`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    // Indexers key off the EIP's schema id and camelCase supportedTrust; a
    // private card shape is unreadable to them however valid the JSON is.
    assert.equal(metadata.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    assert.ok(metadata.image, "card must carry an image so listings can render the agent");
    assert.deepEqual(metadata.supportedTrust, ["reputation", "validation"]);
    assert.equal(metadata.services[0].service_id, "chain_fund_flow_7d_base");
    assert.equal(metadata.services[0].name, "agentrouter_data_api");
    assert.equal(metadata.registrations[0].chain, "arc-testnet");
    assert.equal(metadata.registrations[0].agentRegistry, "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e");

    const toolManifestResponse = await fetch(`${baseUrl}/.well-known/erc8257/tools/chain_fund_flow_7d_base.json`);
    assert.equal(toolManifestResponse.status, 200);
    const toolManifest = await toolManifestResponse.json();
    assert.equal(toolManifest.standard, "ERC-8257");
    assert.equal(toolManifest.tool_id, "chain_fund_flow_7d_base");
    assert.equal(toolManifest.tool_type, "hosted_http_data_api");
    assert.equal(toolManifest.agentrouter.layer_role, "execution_routing_verification");

    const registerResponse = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/erc8004/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(registerResponse.status, 200);
    const payload = await registerResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.erc8004.standard, "ERC-8004");
    assert.equal(payload.erc8004.registry_type, "identity");
    assert.equal(payload.erc8004.status, "registered");
    assert.equal(payload.manifest.registration.erc8004.agent_id, "1001");
    assert.equal(payload.manifest.provider.erc8004_agent_id, "1001");

    const record = server.store.services.get("chain_fund_flow_7d_base");
    assert.equal(record.manifest.registration.erc8004.identity_registry, payload.erc8004.registry_address);
  });
});

test("discovery connector searches, previews, invokes, and records feedback", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "Base 7d fund flow",
      capabilities: ["onchain_data", "fund_flow"],
      max_price: "0.05"
    });
    assert.equal(services.length, 1);
    assert.equal(services[0].service_id, "chain_fund_flow_7d_base");
    assert.deepEqual(services[0].request_data.example, { chain: "base", days: 7 });
    assert.ok(services[0].response_data.fields.includes("metrics.net_flow_usd"));
    assert.equal(services[0].pre_call_context.buyer_requirements.needs_buyer_api_key, false);
    assert.equal(services[0].pre_call_context.buyer_requirements.payment_protocol, "x402");
    assert.equal(services[0].pre_call_context.freshness.max_data_lag_seconds, 7200);
    assert.ok(services[0].pre_call_context.limitations.includes("Sample response is historical and not current."));

    const manifest = await connector.getManifest("chain_fund_flow_7d_base");
    assert.equal(manifest.title, "Base 7D Fund Flow");
    assert.equal(manifest.manifest_type, "hosted_http_data_api");
    assert.equal(manifest.version, "1.0.0");
    assert.match(manifest.integrity.manifest_hash, /^0x[0-9a-f]{64}$/);
    assert.match(manifest.integrity.config_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(manifest.registration.manifest_hash, manifest.integrity.manifest_hash);
    assert.equal(manifest.erc8257.tool_manifest_standard, "ERC-8257");
    assert.equal(manifest.routing.routing_version, "agentrouter_structured_routing_v1");
    assert.ok(manifest.routing.domains.includes("crypto"));

    const preview = await connector.previewService("chain_fund_flow_7d_base", manifest.sample_request);
    assert.equal(preview.sample_type, "historical");
    assert.equal(preview.schema_version, "agent_data_envelope_v1");

    const invocation = await connector.invokePaidService(
      "chain_fund_flow_7d_base",
      { chain: "base", days: 7 },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.schema_version, "agent_data_envelope_v1");
    assert.equal(invocation.feedback.schema_valid, true);
    assert.match(invocation.feedback.payment_tx, /^0x[0-9a-f]{64}$/);
    assert.equal(invocation.feedback.payment_collected, true);
    assert.equal(invocation.feedback.billing_status, "charged_success");
    assert.equal(invocation.feedback.result_delivery_status, "delivered");

    const feedback = await connector.getFeedback("chain_fund_flow_7d_base");
    assert.equal(feedback.length, 1);

    const statsResponse = await fetch(`${baseUrl}/agent-router/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.equal(stats.registered_services, 2);
    assert.equal(stats.total_calls, 1);
    assert.equal(stats.services.find((service) => service.service_id === "chain_fund_flow_7d_base").total_calls, 1);
    assert.equal(stats.services.find((service) => service.service_id === "chain_fund_flow_7d_base").health_status, "healthy");

    const homeStatsResponse = await fetch(`${baseUrl}/agent-router/home-stats`);
    assert.equal(homeStatsResponse.status, 200);
    assert.equal(homeStatsResponse.headers.get("cache-control"), "no-store");
    const homeStats = await homeStatsResponse.json();
    assert.equal(homeStats.stats_version, "agent_router_home_stats_v2");
    assert.equal(homeStats.registered_services, 2);
    assert.ok(homeStats.services.length <= 16);
    assert.equal(homeStats.services.some((service) => Object.prototype.hasOwnProperty.call(service, "sample_request")), false);

    const detailResponse = await fetch(`${baseUrl}/agent-router/service?service_id=chain_fund_flow_7d_base`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.service_detail_version, "agent_router_service_detail_v1");
    assert.equal(detail.service.source_provenance.source_provenance_level, "wrapped_api");
    assert.ok(detail.service.badges.some((badge) => badge.code === "verified_live_endpoint"));

    const detailHtmlResponse = await fetch(`${baseUrl}/agent-router/service?service_id=chain_fund_flow_7d_base&format=html`);
    assert.equal(detailHtmlResponse.status, 200);
    const detailHtml = await detailHtmlResponse.text();
    assert.match(detailHtml, /Service calls/);
    assert.match(detailHtml, /Success rate/);
    assert.match(detailHtml, /Trust score/);
    assert.match(detailHtml, /Health/);
    assert.match(detailHtml, /Request schema/);
    assert.match(detailHtml, /Response schema/);
    assert.match(detailHtml, /Evidence traces/);
    assert.match(detailHtml, /Routing signals/);
    assert.match(detailHtml, /Selection hints/);

    const qualityResponse = await fetch(`${baseUrl}/agent-router/quality?service_id=chain_fund_flow_7d_base`);
    assert.equal(qualityResponse.status, 200);
    const quality = await qualityResponse.json();
    assert.equal(quality.quality_feed_version, "agent_router_quality_events_v1");
    assert.equal(quality.count, 1);
    assert.equal(quality.events[0].business_error.detected, false);

    const healthCheckResponse = await fetch(`${baseUrl}/agent-router/health-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service_id: "chain_fund_flow_7d_base" })
    });
    assert.equal(healthCheckResponse.status, 200);
    const healthCheck = await healthCheckResponse.json();
    assert.equal(healthCheck.event_version, "agent_service_health_check_v1");
    assert.equal(healthCheck.ok, true);
  });
});

test("consumer demo completes final analysis", async () => {
  await withServer(async ({ baseUrl }) => {
    const demo = await runConsumerDemo({ baseUrl });
    assert.equal(demo.selected_service.service_id, "chain_fund_flow_7d_base");
    assert.equal(demo.paid_result.status, "success");
    assert.equal(demo.feedback_count, 1);
    assert.match(demo.analysis, /Base shows a 7-day net inflow/);
  });
});

test("endpoint normalization treats bare hostnames as HTTPS URLs", () => {
  assert.equal(
    normalizeEndpoint("api.example.com/v1/data/market-flow", "http://127.0.0.1:8800"),
    "https://api.example.com/v1/data/market-flow"
  );
  assert.equal(
    normalizeEndpoint("/mock/api", "http://127.0.0.1:8800"),
    "http://127.0.0.1:8800/mock/api"
  );
});

test("keccak helper matches Ethereum address hashing vectors", () => {
  assert.equal(keccak256Hex(Buffer.alloc(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex(Buffer.from("hello")), "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
});

test("payment backend aliases real mode to x402", () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousMode = process.env.ADN_PAYMENT_MODE;
  delete process.env.ADN_PAYMENT_BACKEND;
  process.env.ADN_PAYMENT_MODE = "real";
  assert.equal(currentPaymentBackend(), "x402");
  if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
  else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  if (previousMode === undefined) delete process.env.ADN_PAYMENT_MODE;
  else process.env.ADN_PAYMENT_MODE = previousMode;
});

test("custom provider manifests rebind to the current public runtime URL", () => {
  const manifest = {
    service_id: "example_custom",
    endpoint: {
      method: "POST",
      url: "http://127.0.0.1:10000/provider/custom/example_custom"
    }
  };
  const rebound = withCurrentRuntimeEndpoint(manifest, "https://agentrouter-markets.onrender.com");
  assert.equal(rebound.endpoint.url, "https://agentrouter-markets.onrender.com/provider/custom/example_custom");
});

test("request base URL honors forwarded HTTPS headers for OAuth redirects", () => {
  const baseUrl = getRequestBaseUrl({
    headers: {
      host: "internal-render-host",
      "x-forwarded-host": "agentrouter-markets.onrender.com",
      "x-forwarded-proto": "https"
    }
  });
  assert.equal(baseUrl, "https://agentrouter-markets.onrender.com");
});

test("request base URL infers HTTPS for Render hosts without forwarded protocol", () => {
  const baseUrl = getRequestBaseUrl({
    headers: { host: "agentrouter-markets.onrender.com" }
  });
  assert.equal(baseUrl, "https://agentrouter-markets.onrender.com");
});

test("AgentRouter HTTP endpoint routes and invokes BTC liquidation task", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 当前最大爆仓痛点是多少",
        max_price: "0.05"
      })
    });
    assert.equal(response.status, 200);
    const routed = await response.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.input.asset, "BTC");
    assert.equal(routed.input.market_type, "perpetual_futures");
    assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
    assert.equal(routed.feedback.schema_valid, true);
    assert.equal(routed.feedback.settlement_receipt.asset, "USDC");
    assert.equal(routed.feedback.settlement_receipt.payment_backend, "circle_arc");
    assert.match(routed.feedback.settlement_receipt.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.answer, /103500/);
  });
});

test("AgentRouter capability catalog and structured request route deterministically", async () => {
  await withServer(async ({ baseUrl }) => {
    const catalogResponse = await fetch(`${baseUrl}/capabilities`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.catalog_version, "agent_router_capability_catalog_v1");
    assert.ok(catalog.capabilities.some((item) => item.capability === "perp_liquidation_max_pain"));

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05",
          freshness_seconds: 300,
          min_confidence: 0.7
        }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.status, "routed");
    assert.equal(routed.request.capability, "perp_liquidation_max_pain");
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.selected_service.trust_score, 0.7);
    assert.match(routed.selected_service.selection_reason, /trust=/);
    assert.equal(routed.quote.quote_version, "agent_router_payment_quote_v1");
    assert.equal(routed.quote.would_pay, true);
    assert.equal(routed.quote.payment_backend.backend, "circle_arc");
    assert.equal(routed.verification.schema_valid, true);
    assert.equal(routed.verification.sanity_valid, true);
    assert.equal(routed.compact_result.answer_ready, true);
    assert.equal(routed.compact_result.request_id, routed.result.request_id);
    assert.equal(routed.compact_result.quality.schema_valid, true);
    assert.equal(routed.compact_result.quality.data_non_empty, true);
    assert.equal(routed.compact_result.quality.sanity_valid, true);
    assert.equal(routed.compact_result.payment.price.amount, "0.02");
    assert.equal(routed.feedback.settlement_receipt.protocol, "x402");
    assert.equal(routed.protocol.semantic_parser, "external_main_agent");
    assert.equal(routed.consumer_feedback_request.endpoint, "/agent-router/feedback");
    assert.equal(routed.consumer_feedback_request.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.consumer_feedback_request.request_id, routed.result.request_id);
    assert.equal(routed.evidence.evidence_version, "agent_router_evidence_v1");
    assert.equal(routed.evidence.evidence_profile.profile_type, "paid_hosted_http_data_api_execution");
    assert.equal(routed.evidence.route_type, "structured_capability_request");
    assert.equal(routed.evidence.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.evidence.service_binding.service_id, "btc_liquidation_max_pain_demo");
    assert.match(routed.evidence.manifest_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.input_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.output_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.verification_report.report_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.trace_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.result_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(routed.evidence.arc_anchor.network, "arc-testnet");
    assert.equal(routed.evidence.arc_anchor.status, "anchored");
    assert.equal(routed.evidence.arc_anchor.mode, "mock");
    assert.equal(routed.evidence.arc_anchor.storage_model, "full_evidence_offchain_hashes_onchain");
    assert.equal(routed.observation.observation_version, "agent_router_route_observation_v1");
    assert.equal(routed.observation.status, "routed");
    assert.equal(routed.observation.selected_service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.observation.score_model.name, "heuristic_weighted_ranker");
    assert.equal(routed.observation.outcome.evidence_trace_hash, routed.evidence.trace_hash);

    const evidenceResponse = await fetch(`${baseUrl}/agent-router/evidence?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(evidenceResponse.status, 200);
    const evidenceEvents = await evidenceResponse.json();
    assert.equal(evidenceEvents.storage, "offchain_memory_db");
    // The label names the chain that actually anchors. Pinning it to Arc meant a
    // response could say bsc and arc_testnet in the same breath.
    assert.equal(evidenceEvents.chain_anchor, "arc-testnet_hash_anchor");
    assert.equal(evidenceEvents.count, 1);
    assert.equal(evidenceEvents.events[0].trace_hash, routed.evidence.trace_hash);

    const trustResponse = await fetch(`${baseUrl}/agent-router/trust?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(trustResponse.status, 200);
    const trust = await trustResponse.json();
    assert.equal(trust.trust_snapshot_version, "agent_router_trust_snapshot_v1");
    assert.equal(trust.services[0].provider_id, "provider_derivatives_bob");

    const feedbackResponse = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: routed.selected_service.service_id,
        request_id: routed.result.request_id,
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          data_quality_score: 0.95,
          used_in_final_answer: true,
          reason: "The result directly answered the requested liquidation max-pain task.",
          confidence: 0.9
        }
      })
    });
    assert.equal(feedbackResponse.status, 200);
    const feedbackPayload = await feedbackResponse.json();
    assert.equal(feedbackPayload.ok, true);
    assert.equal(feedbackPayload.trust.consumer_feedback_count, 1);
    assert.equal(feedbackPayload.trust.usefulness_rate, 1);

    const observationsResponse = await fetch(`${baseUrl}/agent-router/observations?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(observationsResponse.status, 200);
    const observations = await observationsResponse.json();
    assert.equal(observations.observation_feed_version, "agent_router_route_observations_v1");
    assert.equal(observations.storage, "offchain_memory_db");
    assert.equal(observations.count, 1);
    assert.equal(observations.observations[0].observation_id, routed.observation.observation_id);
  });
});

test("local wallet paid invocation records evidence trace verification and consumer feedback", async () => {
  await withServer(async ({ baseUrl, rawFetch }) => {
    const invocation = await invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId: "btc_liquidation_max_pain_demo",
      input: { asset: "BTC", market_type: "perpetual_futures", window: "current" },
      budget: { max_amount: "0.05", currency: "USDC" }
    });
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.evidence_recording.ok, true);
    assert.equal(invocation.evidence_recording.status, "completed_invocation_recorded");
    assert.equal(invocation.evidence_recording.request_id, invocation.result.request_id);
    assert.equal(invocation.evidence_recording.verification.schema_valid, true);
    assert.equal(invocation.evidence_recording.payment_verification.ok, true);
    assert.equal(invocation.evidence_recording.payment_verification.status, "verified_settlement_transfer");
    assert.equal(invocation.evidence_recording.feedback.payment_tx, invocation.local_payment.payment_tx);
    assert.equal(invocation.evidence_recording.feedback.payment_collected, true);
    assert.equal(invocation.evidence_recording.feedback.billing_status, "charged_success");
    assert.equal(invocation.evidence_recording.feedback.result_delivery_status, "delivered");
    assert.match(invocation.evidence_recording.evidence.trace_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(invocation.evidence_recording.evidence.request_id, invocation.result.request_id);
    assert.equal(invocation.evidence_recording.evidence.arc_anchor.status, "anchored");
    assert.equal(invocation.evidence_recording.evidence.arc_anchor.mode, "mock");
    assert.equal(invocation.evidence_recording.consumer_feedback_request.request_id, invocation.result.request_id);
    assert.match(invocation.evidence_recording.consumer_feedback_request.feedback_token, /^[A-Za-z0-9_-]{32,}$/);

    const evidenceResponse = await fetch(`${baseUrl}/agent-router/evidence?request_id=${invocation.result.request_id}`);
    assert.equal(evidenceResponse.status, 200);
    const evidencePayload = await evidenceResponse.json();
    assert.equal(evidencePayload.count, 1);
    assert.equal(evidencePayload.events[0].trace_hash, invocation.evidence_recording.evidence.trace_hash);

    const feedbackEventsResponse = await fetch(`${baseUrl}/agent-router/feedback?request_id=${invocation.result.request_id}`);
    assert.equal(feedbackEventsResponse.status, 200);
    const feedbackEvents = await feedbackEventsResponse.json();
    assert.equal(feedbackEvents.count, 1);
    assert.equal(feedbackEvents.events[0].verification.schema_valid, true);

    const consumerFeedbackResponse = await rawFetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: invocation.result.request_id,
        feedback_token: invocation.evidence_recording.consumer_feedback_request.feedback_token,
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          data_quality_score: 0.9,
          used_in_final_answer: true,
          reason: "The paid result was fresh, parseable, and answered the liquidation max-pain task.",
          confidence: 0.85
        }
      })
    });
    const consumerFeedback = await consumerFeedbackResponse.json();
    assert.equal(consumerFeedbackResponse.status, 200, JSON.stringify(consumerFeedback));
    assert.equal(consumerFeedback.ok, true);
    assert.equal(consumerFeedback.arc_anchor.status, "not_used");
    assert.equal(consumerFeedback.arc_anchor.superseded_by, "ERC-8004");
    assert.equal(consumerFeedback.erc8004.standard, "ERC-8004");
    assert.equal(consumerFeedback.erc8004.status, "consumer_submission_required");
    assert.equal(consumerFeedback.erc8004.registry_type, "reputation");
    assert.equal(consumerFeedback.trust_anchor.primary_standard, "ERC-8004");

    const updatedFeedback = await fetch(`${baseUrl}/agent-router/feedback?request_id=${invocation.result.request_id}`).then((res) => res.json());
    assert.equal(updatedFeedback.events[0].consumer_feedback.answer_useful, "yes");
    assert.equal(updatedFeedback.events[0].consumer_rating, 0.975);
    assert.equal(updatedFeedback.events[0].consumer_feedback_arc_anchor.status, "not_used");
    assert.equal(updatedFeedback.events[0].consumer_feedback_erc8004.status, "consumer_submission_required");
  });
});

test("BNB Paymaster proxy rejects unauthenticated callers", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/paymaster`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "pm_isSponsorable", params: [] })
    });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.status, "authentication_required");
  });
});

test("AgentRouter services endpoint returns paginated lightweight service summaries", async () => {
  await withServer(async ({ baseUrl }) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          title: `Paged Service ${index}`,
          provider_name: "Paged Provider",
          description_for_agent: "Use this service to test paginated agent hub loading.",
          capabilities: "data_service,paged_demo",
          price: "0.01",
          sample_request: "{}",
          sample_data: JSON.stringify({ records: [{ service: `paged_${index}`, score: index }] }),
          live_data: JSON.stringify({ records: [{ service: `paged_${index}`, score: index + 100 }] }),
          summary: "Paged service demo."
        })
      });
      assert.equal(response.status, 201, await response.text());
    }

    const pageResponse = await fetch(`${baseUrl}/agent-router/services?q=paged&limit=2&offset=0&verified_only=true`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.service_list_version, "agent_router_service_list_v2");
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 0);
    assert.equal(page.has_more, true);
    assert.equal(page.services.length, 2);
    assert.equal(page.services[0].latest_validation, undefined);
    assert.equal(page.services[0].sample_response, undefined);
    assert.equal(page.services[0].pre_call_context, undefined);

    const detailResponse = await fetch(`${baseUrl}/agent-router/services?q=paged&include_details=true`);
    assert.equal(detailResponse.status, 200);
    const detailPage = await detailResponse.json();
    assert.equal(detailPage.service_list_version, "agent_router_service_list_v1");
    assert.ok(detailPage.services[0].sample_response);
  });
});

test("AgentRouter category endpoint returns only populated, mutually-exclusive callable-service categories", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/service-categories`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.category_list_version, "agent_router_service_categories_v1");
    assert.ok(payload.total > 0);
    assert.ok(payload.categories.length > 0);
    assert.ok(payload.categories.every((entry) => entry.count > 0));
    assert.equal(
      payload.total,
      payload.categories.reduce((total, entry) => total + entry.count, 0),
      "All must equal the sum of the visible child categories"
    );
    assert.ok(payload.categories.every((entry) => !["Animals", "Finance", "Weather"].includes(entry.category)));
  });
});

test("AgentRouter capability packs expose live availability and filter the service catalog", async () => {
  await withServer(async ({ baseUrl }) => {
    const services = [
      { title: "Pack DEX Liquidity", capabilities: "data_service,dex_liquidity,onchain_data" },
      { title: "Pack Generic Dataset", capabilities: "data_service,paged_demo" }
    ];
    for (const [index, service] of services.entries()) {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          title: service.title,
          provider_name: "Capability Pack Provider",
          description_for_agent: `Live ${service.capabilities} test service.`,
          capabilities: service.capabilities,
          price: "0.004",
          sample_request: "{}",
          sample_data: JSON.stringify({ records: [{ ok: true, pack_fixture: index }] }),
          live_data: JSON.stringify({ records: [{ ok: true, pack_fixture: index }] }),
          summary: "Capability pack API test."
        })
      });
      assert.equal(response.status, 201, await response.text());
    }

    const packResponse = await fetch(`${baseUrl}/agent-router/capability-packs`);
    assert.equal(packResponse.status, 200);
    assert.equal(packResponse.headers.get("cache-control"), "no-store");
    const packPayload = await packResponse.json();
    assert.equal(packPayload.capability_pack_list_version, "agent_router_capability_packs_v1");
    assert.equal(packPayload.total, 9);
    assert.ok(packPayload.packs.find((pack) => pack.id === "onchain").service_count >= 1);
    assert.deepEqual(
      packPayload.packs.filter((pack) => pack.group === "smart_money_jobs").map((pack) => pack.id),
      ["rebalancing", "grid-trading", "yield-optimization", "health-factor-monitoring"]
    );

    const catalog = await fetch(`${baseUrl}/capabilities`).then((response) => response.json());
    assert.ok(catalog.capability_packs.some((pack) => pack.contract === "onchain.analyze_activity"));
    assert.deepEqual(catalog.capability_packs[0].input_schema.required, ["task"]);

    const filteredResponse = await fetch(`${baseUrl}/agent-router/services?q=pack&pack=onchain`);
    assert.equal(filteredResponse.status, 200);
    const filtered = await filteredResponse.json();
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.services[0].capabilities.slice().sort(), ["data_service", "dex_liquidity", "onchain_data"]);

    const canonicalQuoteResponse = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "onchain.analyze_activity",
        params: { task: "Compare DEX liquidity and onchain activity" },
        constraints: { max_price_usdc: "0.003" }
      })
    });
    assert.equal(canonicalQuoteResponse.status, 200);
    const canonicalQuote = await canonicalQuoteResponse.json();
    assert.equal(canonicalQuote.status, "quote_blocked");
    assert.equal(canonicalQuote.request.capability, "onchain.analyze_activity");
    assert.equal(canonicalQuote.capability_pack.id, "onchain");
    assert.equal(canonicalQuote.capability_pack.resolved_capability, "dex_liquidity");
    assert.equal(canonicalQuote.selected_service.service_id, filtered.services[0].service_id);
    assert.equal(canonicalQuote.quote.budget.max_price_usdc, "0.003");

    const trustGuardResponse = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "onchain.analyze_activity",
        params: { task: "Compare DEX liquidity and onchain activity" },
        constraints: { max_price_usdc: "0.004", min_trust_score: 0.99 }
      })
    });
    assert.equal(trustGuardResponse.status, 200);
    const trustGuard = await trustGuardResponse.json();
    assert.equal(trustGuard.status, "no_match");
    assert.equal(trustGuard.request.capability, "onchain.analyze_activity");
    assert.equal(trustGuard.capability_pack.resolved_capability, "dex_liquidity");
    assert.equal(trustGuard.selected_service, undefined);

    const canonicalRequestResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "onchain.analyze_activity",
        params: { task: "Compare DEX liquidity and onchain activity" },
        constraints: { max_price_usdc: "0.004" }
      })
    });
    assert.equal(canonicalRequestResponse.status, 200);
    const canonicalResult = await canonicalRequestResponse.json();
    assert.equal(canonicalResult.ok, true);
    assert.equal(canonicalResult.status, "routed");
    assert.equal(canonicalResult.request.capability, "onchain.analyze_activity");
    assert.equal(canonicalResult.request.resolved_capability, "dex_liquidity");
    assert.equal(canonicalResult.protocol.external_contract, "onchain.analyze_activity");
    assert.equal(canonicalResult.capability_pack.resolved_capability, "dex_liquidity");
    assert.equal(canonicalResult.selected_service.service_id, filtered.services[0].service_id);
    assert.ok(canonicalResult.result.request_id);
    assert.equal(canonicalResult.evidence.request.consumer_context.capability_pack_contract, "onchain.analyze_activity");

    const invalidRequestResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "research.find_evidence", params: {} })
    });
    assert.equal(invalidRequestResponse.status, 422);
    const invalidRequest = await invalidRequestResponse.json();
    assert.equal(invalidRequest.status, "invalid_request");
    assert.equal(invalidRequest.error, "MISSING_TASK");
    assert.equal(invalidRequest.capability_pack.contract, "research.find_evidence");
  });
});

test("Public API automation keeps draining validated candidates instead of waiting a day", () => {
  const options = publicApiAutomationOptions({});
  assert.equal(options.validationLimit, 50);
  assert.equal(options.refreshIntervalMs, 5 * 60 * 1000);
  assert.equal(options.catalogRefreshIntervalMs, 24 * 60 * 60 * 1000);
  assert.equal(options.allowSyntheticProxyAddresses, false);
  assert.equal(publicApiAutomationOptions({ ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES: "1" }).allowSyntheticProxyAddresses, true);
});

test("Public API HTTP runs inherit the explicit synthetic-proxy compatibility setting", () => {
  const previous = process.env.ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES;
  process.env.ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES = "1";
  try {
    const server = createServer();
    assert.equal(server.publicApiPipelineOptions.allowSyntheticProxyAddresses, true);
    server.close();
  } finally {
    if (previous == null) delete process.env.ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES;
    else process.env.ADN_ALLOW_SYNTHETIC_PROXY_ADDRESSES = previous;
  }
});

test("AgentRouter quote simulates route and payment guards without invoking provider", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05",
          freshness_seconds: 300
        }
      })
    });
    assert.equal(response.status, 200);
    const quoted = await response.json();
    assert.equal(quoted.ok, true);
    assert.equal(quoted.status, "quoted");
    assert.equal(quoted.exact_match, true);
    assert.equal(quoted.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(quoted.preflight_validation.ok, true);
    assert.equal(quoted.route_decision.next_action, "connect_credits_or_configure_local_payment");
    assert.equal(quoted.route_decision.main_agent_policy.payment_required_is_not_failure, true);
    assert.equal(quoted.route_decision.main_agent_policy.do_not_blind_invoke_alternatives, true);
    assert.equal(quoted.quote.would_pay, true);
    assert.equal(quoted.quote.guard_result, "pass");
    assert.equal(quoted.quote.payment_backend.backend, "circle_arc");
    assert.equal(quoted.quote.agent_decision.quote_status, "quote_ready");
    assert.equal(quoted.quote.agent_decision.payment_authorized_by_budget, true);
    assert.equal(quoted.quote.agent_decision.payment_executor_available, false);
    assert.equal(quoted.quote.agent_decision.execution_available, false);
    assert.equal(quoted.quote.agent_decision.auto_invoke_allowed, false);
    assert.equal(quoted.quote.agent_decision.requires_additional_user_confirmation, false);
    assert.match(quoted.quote.agent_decision.why_paid_data_is_justified, /public/i);
    assert.ok(quoted.quote.agent_decision.expected_data.length > 0);
    assert.equal(quoted.quote.agent_decision.main_agent_next_action, "connect_credits_or_configure_local_payment");
    assert.equal(quoted.quote_feedback_request.recommended_if_not_invoked, true);
    assert.equal(quoted.quote_feedback_request.must_submit_if_not_invoked, false);
    assert.equal(quoted.result, undefined);
    const feedback = await fetch(`${baseUrl}/services/btc_liquidation_max_pain_demo/feedback`).then((res) => res.json());
    assert.equal(feedback.length, 0);
  });
});

test("AgentRouter quote returns capability boundary instead of blind alternative invocation", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "ethereum_net_unrealized_profit_loss",
        params: {
          asset: "ETH",
          metric: "NUPL",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05"
        }
      })
    });
    assert.equal(response.status, 200);
    const quoted = await response.json();
    assert.equal(quoted.ok, false);
    assert.equal(quoted.status, "no_match");
    assert.equal(quoted.exact_match, false);
    assert.equal(quoted.route_decision.exact_match, false);
    assert.equal(quoted.route_decision.main_agent_policy.do_not_guess_service_names, true);
    assert.equal(quoted.route_decision.main_agent_policy.do_not_blind_invoke_alternatives, true);
    assert.ok(["report_no_exact_match", "ask_user_to_confirm_alternative"].includes(quoted.route_decision.next_action));
    assert.equal(quoted.result, undefined);
    assert.equal(quoted.quote, undefined);
  });
});

test("AgentRouter quote blocks payments above budget before invocation", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.001"
        }
      })
    });
    assert.equal(response.status, 200);
    const quoted = await response.json();
    assert.equal(quoted.ok, false);
    assert.equal(quoted.status, "quote_blocked");
    assert.equal(quoted.quote.guard_result, "budget_too_low");
    assert.equal(quoted.quote.would_pay, false);
    assert.equal(quoted.quote.agent_decision.auto_invoke_allowed, false);
    assert.equal(quoted.quote.agent_decision.requires_additional_user_confirmation, true);
    assert.equal(quoted.quote.agent_decision.main_agent_next_action, "ask_user_to_raise_budget_or_choose_free_answer");
  });
});

test("AgentRouter records quote skip feedback when a main agent chooses not to invoke", async () => {
  await withServer(async ({ baseUrl }) => {
    const quoteResponse = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    const quoted = await quoteResponse.json();
    assert.equal(quoted.quote_feedback_request.endpoint, "/agent-router/quote-feedback");

    const skipResponse = await fetch(`${baseUrl}/agent-router/quote-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quote_id: quoted.quote.quote_id,
        service_id: quoted.selected_service.service_id,
        consumer_id: "main_agent_test",
        decision: "not_invoked",
        reason_code: "free_source_used",
        reason: "The main agent chose a public answer after seeing the quote."
      })
    });
    assert.equal(skipResponse.status, 200);
    const payload = await skipResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.event.decision, "not_invoked");
    assert.equal(payload.event.reason_code, "free_source_used");

    const stats = await fetch(`${baseUrl}/agent-router/stats`).then((res) => res.json());
    assert.equal(stats.quote_feedback_events, 1);
  });
});

test("public AgentRouter HTTP routes do not invoke paid services without protocol payment", async () => {
  await withServer(async ({ baseUrl }) => {
      const structured = await fetch(`${baseUrl}/agent-router/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          constraints: {
            max_price_usdc: "0.05"
          }
        })
      });
      assert.equal(structured.status, 402);
      const structuredPayload = await structured.json();
      assert.equal(structuredPayload.ok, false);
      assert.equal(structuredPayload.status, "payment_required");
      assert.equal("result" in structuredPayload, false);
      assert.equal(structuredPayload.protocol.invocation_policy, "quote_only_no_server_side_payment");

      const natural = await fetch(`${baseUrl}/agent-router/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "BTC 当前最大爆仓痛点是多少",
          max_price: "0.05"
        })
      });
      assert.equal(natural.status, 402);
      const naturalPayload = await natural.json();
      assert.equal(naturalPayload.ok, false);
      assert.equal(naturalPayload.status, "payment_required");
      assert.equal("result" in naturalPayload, false);
      assert.match(naturalPayload.next_step, /payment-capable backend/);

      const fetched = await fetch(`${baseUrl}/agent-router/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "BTC liquidation max pain",
          data_requirements: [
            {
              capability: "perp_liquidation_max_pain",
              params: {
                asset: "BTC",
                market_type: "perpetual_futures",
                window: "current"
              }
            }
          ],
          constraints: {
            max_price_usdc: "0.05"
          }
        })
      });
      assert.equal(fetched.status, 402);
      const fetchedPayload = await fetched.json();
      assert.equal(fetchedPayload.status, "payment_required");
      assert.equal(fetchedPayload.protocol.external_contract, "single_agent_data_call");
      assert.equal(fetchedPayload.data_requirements_count, 1);
      assert.equal("result" in fetchedPayload.results[0], false);

      const connector = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service_id: "btc_liquidation_max_pain_demo",
          input: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          budget: { max_amount: "0.05", currency: "USDC" }
        })
      });
      assert.equal(connector.status, 402);
      const connectorPayload = await connector.json();
      assert.equal(connectorPayload.ok, false);
      assert.equal(connectorPayload.status, "payment_required");
      assert.equal("result" in connectorPayload, false);
  }, { serverBaseUrl: "https://agentrouter-markets.onrender.com" });
});

test("public provider endpoints require Arc payment even with direct endpoint access", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/provider/btc-liquidation-max-pain`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "agentrouter-markets.onrender.com"
      },
      body: JSON.stringify({
        asset: "BTC",
        market_type: "perpetual_futures",
        window: "current"
      })
    });
    assert.equal(response.status, 402);
    const payload = await response.json();
    assert.equal(payload.error, "Payment Required");
    assert.equal(payload.payment.x402_version, "arc-x402-v1");
    assert.equal(payload.payment.network, "arc-testnet");
    assert.equal("result" in payload, false);
  });
});

test("remote MCP endpoint exposes AgentRouter tools over HTTP JSON-RPC", async () => {
  await withServer(async ({ baseUrl, authCookie, rawFetch }) => {
    const packageMetadata = JSON.parse(await fs.readFile("packages/agentrouter-mcp/package.json", "utf8"));
    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "remote-mcp-test", version: "0.1.0" }
        }
      })
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.headers.get("access-control-allow-origin"), "*");
    const mcpSessionId = initialize.headers.get("mcp-session-id");
    assert.ok(mcpSessionId, "initialize must create a remote MCP session");
    const initialized = await initialize.json();
    assert.equal(initialized.result.serverInfo.name, "AgentRouter");
    assert.equal(initialized.result.serverInfo.version, packageMetadata.version);
    assert.deepEqual(initialized.result.capabilities, { tools: {} });

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    assert.equal(listed.status, 200);
    const listPayload = await listed.json();
    assert.equal(listPayload.result.tools[0].name, "agentrouter_fetch");
    assert.ok(/single tool/.test(listPayload.result.tools[0].description));
    assert.match(listPayload.result.tools[0].description, /default first hop/i);
    assert.match(listPayload.result.tools[0].description, /research, search, URLs, platforms/i);
    assert.ok(listPayload.result.tools.some((tool) => tool.name === "agentrouter_request"));
    assert.ok(listPayload.result.tools.some((tool) => tool.name === "agentrouter_ask"));
    assert.ok(listPayload.result.tools.some((tool) => tool.name === "agentrouter_connect"));

    const connectCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "agentrouter_connect", arguments: { client_name: "QA client", wait_seconds: 0 } }
      })
    });
    const connectPayload = await connectCall.json();
    const connectResult = JSON.parse(connectPayload.result.content[0].text);
    assert.equal(connectResult.status, "authorization_required");
    assert.match(connectResult.verification_uri_complete, /\/connect\?user_code=/);
    assert.equal("access_token" in connectResult, false);

    const approval = await rawFetch(`${baseUrl}/auth/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify({ user_code: connectResult.user_code })
    });
    assert.equal(approval.status, 200);

    const connectedCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "agentrouter_connect", arguments: { client_name: "QA client", wait_seconds: 0 } }
      })
    });
    const connectedPayload = await connectedCall.json();
    const connectedResult = JSON.parse(connectedPayload.result.content[0].text);
    assert.equal(connectedResult.status, "connected");
    assert.equal("access_token" in connectedResult, false);

    const capabilityCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "agentrouter_capabilities", arguments: {} }
      })
    });
    assert.equal(capabilityCall.status, 200);
    const capabilityPayload = await capabilityCall.json();
    const toolResult = JSON.parse(capabilityPayload.result.content[0].text);
    assert.equal(toolResult.catalog_version, "agent_router_capability_catalog_v1");
    assert.ok(Array.isArray(toolResult.capabilities));

    const quoteCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "agentrouter_quote",
          arguments: {
            capability: "perp_liquidation_max_pain",
            params: { asset: "BTC", market_type: "perpetual_futures", window: "current" },
            constraints: { max_price_usdc: "0.05" }
          }
        }
      })
    });
    assert.equal(quoteCall.status, 200);
    const quotePayload = await quoteCall.json();
    const quoteResult = JSON.parse(quotePayload.result.content[0].text);
    assert.equal(quoteResult.selected_service, undefined);
    assert.equal(quoteResult.service_match.matched, true);
    assert.equal(quoteResult.presentation_policy.hide_provider_details, true);
    assert.equal(JSON.stringify(quoteResult).includes("btc_liquidation_max_pain_demo"), false);

    const fetchCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "agentrouter_fetch",
          arguments: {
            task: "BTC liquidation max pain",
            data_requirements: [
              {
                capability: "perp_liquidation_max_pain",
                params: { asset: "BTC", market_type: "perpetual_futures", window: "current" }
              }
            ],
            constraints: { max_price_usdc: "0.05" }
          }
        }
      })
    });
    assert.equal(fetchCall.status, 200);
    const fetchCallPayload = await fetchCall.json();
    const fetchCallResult = JSON.parse(fetchCallPayload.result.content[0].text);
    assert.equal(fetchCallResult.status, "data_returned");
    assert.equal(fetchCallResult.data_returned_count, 1);
    assert.equal(fetchCallResult.results[0].result.data.max_liquidation_pain_price, 103500);
    assert.equal(fetchCallResult.results[0].selected_service, undefined);
  });
});

test("public HTTP surface handles HEAD, CORS preflight, malformed JSON, and security headers", async () => {
  await withServer(async ({ baseUrl, rawFetch }) => {
    const home = await rawFetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    assert.equal(home.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(home.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);

    const head = await rawFetch(`${baseUrl}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const preflight = await rawFetch(`${baseUrl}/agent-router/fetch`, {
      method: "OPTIONS",
      headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);

    const malformed = await rawFetch(`${baseUrl}/agent-router/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad"
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: { code: "INVALID_JSON", message: "Request body must be valid JSON." }
    });

    const statsResponse = await rawFetch(`${baseUrl}/agent-router/stats`);
    assert.match(statsResponse.headers.get("cache-control") || "", /max-age=30/);
    const stats = await statsResponse.json();
    assert.equal("sample_request" in stats.services[0], false);
    assert.equal("endpoint_url" in stats.services[0], false);
    assert.equal("latest_feedback_event" in stats.services[0], false);
  });
});

test("AgentRouter MCP server exposes Claude-callable tools", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const client = createMcpClient({ AGENT_ROUTER_URL: baseUrl, ADN_WALLET_PASSPHRASE: "" });
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mvp-test", version: "0.1.0" }
      });
      assert.equal(initialized.serverInfo.name, "AgentRouter");
      assert.equal(initialized.agentrouter.auto_wallet.enabled, true);
      assert.equal(typeof initialized.agentrouter.auto_wallet.created, "boolean");
      assert.equal(initialized.agentrouter.auto_wallet.status, "wallet_ready");
      assert.equal(initialized.agentrouter.auto_wallet.key_management, "local_session_secret");
      assert.match(initialized.agentrouter.auto_wallet.address, /^0x[0-9a-f]{40}$/);

      const listed = await client.request("tools/list", {});
      assert.equal(listed.tools[0].name, "agentrouter_fetch");
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_ask"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_request"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_quote"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_status"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_create"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_init"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_setup"));

      const walletStatusCall = await client.request("tools/call", {
        name: "agentrouter_wallet_status",
        arguments: {}
      });
      const walletPayload = JSON.parse(walletStatusCall.content[0].text);
      assert.equal(walletPayload.initialized, true);
      assert.equal(walletPayload.address_type, "evm");
      assert.equal(walletPayload.key_management, "local_session_secret");
      assert.equal(walletPayload.payment_backend, "circle_arc");
      assert.equal(walletPayload.arc_payment_active, true);
      assert.match(walletPayload.address, /^0x[0-9a-f]{40}$/);
      assert.equal("private_key_pem" in walletPayload, false);

      const called = await client.request("tools/call", {
        name: "agentrouter_request",
        arguments: {
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          constraints: {
            max_price_usdc: "0.05",
            freshness_seconds: 300
          }
        }
      });
      const routed = JSON.parse(called.content[0].text);
      assert.equal(routed.ok, true);
      assert.equal(routed.selected_service, undefined);
      assert.equal(routed.service_match.matched, true);
      assert.equal(routed.request.capability, "perp_liquidation_max_pain");
      assert.equal(routed.compact_result.answer_ready, true);
      assert.equal(routed.compact_result.data.max_liquidation_pain_price, 103500);
      assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
      assert.match(routed.result.request_id, /^req_/);
      assert.equal(routed.evidence, undefined);
      assert.equal(JSON.stringify(routed).includes("btc_liquidation_max_pain_demo"), false);
      assert.equal(routed.presentation_policy.hide_provider_details, true);

      const fetched = await client.request("tools/call", {
        name: "agentrouter_fetch",
        arguments: {
          task: "BTC current liquidation max pain",
          data_requirements: [
            {
              capability: "perp_liquidation_max_pain",
              params: {
                asset: "BTC",
                market_type: "perpetual_futures",
                window: "current"
              }
            }
          ],
          constraints: {
            max_price_usdc: "0.05",
            freshness_seconds: 300
          }
        }
      });
      const fetchPayload = JSON.parse(fetched.content[0].text);
      assert.equal(fetchPayload.ok, true);
      assert.equal(fetchPayload.protocol.external_contract, "single_agent_data_call");
      assert.equal(fetchPayload.data_requirements_count, 1);
      assert.equal(fetchPayload.data_returned_count, 1);
      assert.equal(fetchPayload.compact_results[0].answer_ready, true);
      assert.equal(fetchPayload.results[0].selected_service, undefined);
      assert.equal(fetchPayload.presentation_policy.response_flow.includes("Do not write temp files"), true);
    } finally {
      client.close();
    }
  });
});

test("AgentRouter MCP server returns hard funding instructions when Arc balance is insufficient", async () => {
  await withServer(async ({ baseUrl }) => {
    const client = createMcpClient({
      AGENT_ROUTER_URL: baseUrl,
      ADN_ARC_BALANCE_MOCK: "0",
      ADN_PAYMENT_BACKEND: "circle_arc"
    });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mvp-funding-test", version: "0.1.0" }
      });
      const called = await client.request("tools/call", {
        name: "agentrouter_request",
        arguments: {
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          constraints: {
            max_price_usdc: "0.05"
          }
        }
      });
      assert.equal(called.isError, true);
      const payload = JSON.parse(called.content[0].text);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "wallet_needs_funding");
      assert.equal(payload.action_required, "fund_local_agentrouter_wallet");
      assert.equal(payload.final_answer_available, false);
      assert.equal(payload.data_returned, false);
      assert.equal(payload.do_not_use_cached_or_previous_results, true);
      assert.equal(payload.funding_instruction.network, "Arc Testnet");
      assert.equal(payload.funding_instruction.token, "USDC");
      assert.match(payload.funding_instruction.wallet_address, /^0x[0-9a-f]{40}$/);
      assert.match(payload.next_step, /Do not answer/);
    } finally {
      client.close();
    }
  });
});

test("AgentRouter npm MCP package exposes the same structured tools", async () => {
  await withServer(async ({ baseUrl }) => {
    const client = createMcpClient(
      { AGENT_ROUTER_URL: baseUrl },
      "packages/agentrouter-mcp/bin/agentrouter-mcp.js"
    );
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "npm-package-test", version: "0.1.0" }
      });
      assert.equal(initialized.serverInfo.name, "AgentRouter");

      const listed = await client.request("tools/list", {});
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_request"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_capabilities"));
    } finally {
      client.close();
    }
  });
});

test("AgentRouter npm MCP package discovers new tools from remote MCP without a package update", async () => {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = message.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "AgentRouter", version: "remote" }
        }
      : {
          tools: [{
            name: "server_added_after_client_publish",
            description: "A tool defined only by the remote server.",
            inputSchema: { type: "object", properties: {} }
          }]
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createMcpClient(
    { AGENT_ROUTER_URL: `http://127.0.0.1:${server.address().port}` },
    "packages/agentrouter-mcp/bin/agentrouter-mcp.js"
  );
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "npm-remote-discovery-test", version: "0.1.0" }
    });
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "agentrouter_connect",
      "agentrouter_complete_handoff",
      "server_added_after_client_publish"
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentRouter desktop extension discovers new tools from remote MCP without reinstalling", async () => {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = message.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "AgentRouter", version: "remote" }
        }
      : {
          tools: [{
            name: "desktop_remote_tool",
            description: "A remotely defined desktop tool.",
            inputSchema: { type: "object", properties: {} }
          }]
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createMcpClient(
    { AGENT_ROUTER_URL: `http://127.0.0.1:${server.address().port}` },
    "mcpb/agentrouter/server/index.js"
  );
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "desktop-remote-discovery-test", version: "0.1.0" }
    });
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["desktop_remote_tool"]);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentRouter npm MCP forwards the prepaid credits API key", async () => {
  let receivedKey = "";
  const server = http.createServer(async (request, response) => {
    receivedKey = String(request.headers["x-agentrouter-api-key"] || "");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = message.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "AgentRouter", version: "remote" }
        }
      : {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              status: "data_returned",
              result: { status: "success", data: { value: 42 } }
            })
          }],
          isError: false
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createMcpClient(
    {
      AGENT_ROUTER_URL: baseUrl,
      AGENT_ROUTER_API_KEY: "ar_live_mcp_forwarding_test"
    },
    "packages/agentrouter-mcp/bin/agentrouter-mcp.js"
  );
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "npm-credits-test", version: "0.1.0" }
    });
    const called = await client.request("tools/call", {
      name: "agentrouter_request",
      arguments: {
        capability: "test_data",
        params: { asset: "TEST" },
        constraints: { max_price_usdc: "0.05" }
      }
    });
    const payload = JSON.parse(called.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(receivedKey, "ar_live_mcp_forwarding_test");
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentRouter structured request returns machine-readable validation errors", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          window: "current"
        }
      })
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "MISSING_REQUIRED_PARAM");
    assert.deepEqual(body.missing, ["market_type"]);
    assert.equal(body.expected_schema.type, "object");
  });
});

test("AgentRouter structured request failure includes an actionable retry plan", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05"
        }
      })
    });
    assert.equal(response.status, 422);
    const routed = await response.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "invalid_request");
    assert.equal(routed.retry_plan.retryable, false);
    assert.equal(routed.retry_plan.reason_code, "missing_required_param");
    assert.ok(routed.retry_plan.suggested_next_actions.length > 0);
  });
});

test("deterministic verifier flags abnormal timestamps and all-zero metric payloads", () => {
  const manifest = {
    output_schema: {
      type: "object",
      required: ["status", "data", "metadata"],
      properties: {
        status: { type: "string" },
        data: { type: "object" },
        metadata: { type: "object" }
      }
    },
    freshness: { max_data_lag_seconds: 300 }
  };
  const verification = verifyServiceResult({
    manifest,
    intent: { capability: "onchain_fund_flow", asset: "ETH" },
    constraints: { freshness_seconds: 300 },
    result: {
      status: "success",
      query: { asset: "ETH" },
      data: {
        asset: "ETH",
        rows: [
          { timestamp: -86400000, inflow_usd: 0, outflow_usd: 0, net_flow_usd: 0 }
        ]
      },
      metadata: {
        generated_at: new Date().toISOString(),
        freshness_seconds: 60,
        confidence: 0.9,
        data_sources: ["test"]
      },
      agent_hints: { preferred_summary_fields: ["net_flow_usd"] }
    }
  });
  assert.equal(verification.data_non_empty, true);
  assert.equal(verification.sanity_valid, false);
  assert.ok(verification.data_quality_issues.some((issue) => issue.code === "ABNORMAL_TIMESTAMP"));
  assert.ok(verification.data_quality_issues.some((issue) => issue.code === "ALL_ZERO_NUMERIC_METRICS"));
  assert.ok(verification.issues.some((issue) => issue.code === "DATA_QUALITY_SANITY_FAILED"));
});

test("AgentRouter ask wrapper returns clarification for ambiguous max pain", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 最大痛点是多少？"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "needs_clarification");
    assert.equal(body.options[0].request.capability, "perp_liquidation_max_pain");
    assert.equal(body.options[1].request.capability, "options_max_pain");
  });
});

test("router routes ambiguous BTC liquidation task with explicit assumption and verifies result", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const routed = await connector.routeTask({
      task: "BTC 当前最大爆仓痛点是多少",
      constraints: {
        max_price_usdc: "0.05",
        freshness_seconds: 300
      }
    });
    assert.equal(routed.status, "route_with_assumption");
    assert.equal(routed.normalized_intent.capability, "perp_liquidation_max_pain");
    assert.equal(routed.normalized_intent.asset, "BTC");
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.match(routed.assumptions[0], /永续合约/);
    assert.equal(routed.verification.schema_valid, true);
    assert.equal(routed.verification.freshness_valid, true);
    assert.equal(routed.verification.coverage_valid, true);
    assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
    const eventsForRequest = server.store.services.get(routed.selected_service.service_id).feedback_events
      .filter((event) => event.request_id === routed.result.request_id);
    assert.equal(eventsForRequest.length, 1, "one invocation must produce one operational feedback event");
  });
});

test("router asks for clarification when max pain task omits market type", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const routed = await connector.routeTask({
      task: "BTC 最大痛点是多少",
      constraints: {
        max_price_usdc: "0.05",
        freshness_seconds: 300
      }
    });
    assert.equal(routed.status, "needs_clarification");
    assert.equal(routed.ambiguities[0].field, "capability");
    assert.match(routed.ambiguities[0].question, /永续合约/);
  });
});

test("budget guard blocks paid invocation when service is too expensive", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    await assert.rejects(
      () => connector.invokePaidService("chain_fund_flow_7d_base", { chain: "base", days: 7 }, { max_amount: "0.001", currency: "USDC" }),
      /Service costs/
    );
  });
});

test("provider onboarding CLI creates config, registers, validates, and enables paid invocation", async () => {
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);
    const payload = JSON.parse(onboard.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "community_sentiment_demo");
    assert.equal(payload.validation.ok, true);

    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "sentiment demo",
      capabilities: ["sentiment_data"],
      max_price: "0.05"
    });
    assert.equal(services.length, 1);
    assert.equal(services[0].service_id, "community_sentiment_demo");

    const invocation = await connector.invokePaidService(
      "community_sentiment_demo",
      { asset: "ETH", window: "7d" },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.asset, "ETH");
    assert.equal(invocation.feedback.schema_valid, true);
  });
});

test("hosted-http onboarding stores provider secret privately and calls upstream after payment", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--mode", "hosted-http", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);
    const payload = JSON.parse(onboard.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "hosted_http_sentiment_demo");
    assert.equal(payload.validation.ok, true);

    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "hosted_http_sentiment_demo.json"), "utf8"));
    assert.equal(config.source.auth.secret_value, undefined);
    assert.equal(config.source.auth.secret_ref, "hosted_http_sentiment_demo:PROVIDER_SECRET");
    assert.equal(config.manifest.runtime_secrets.public, false);
    assert.equal(JSON.stringify(config.manifest).includes("demo-provider-secret"), false);
    assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);

    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "hosted_http_sentiment_demo", "{\"asset\":\"ETH\",\"window\":\"7d\"}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const invocation = JSON.parse(invoke.stdout);
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.source, "mock_upstream_sentiment");
    assert.equal(invocation.result.data.sentiment_score, 0.79);
  });
});

test("provider secret storage can bootstrap a local runtime key for Studio MVP", async () => {
  const previousProviderPassphrase = process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  const previousWalletPassphrase = process.env.ADN_WALLET_PASSPHRASE;
  delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  delete process.env.ADN_WALLET_PASSPHRASE;
  try {
    await withServer(async ({ baseUrl }) => {
      const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "hosted-http",
          service_id: "studio_local_secret_key_demo",
          provider_id: "provider_studio",
          title: "Studio Local Secret Key Demo",
          description_for_agent: "Use this service to verify local secret key bootstrap.",
          capabilities: "sentiment_data,hosted_http,demo_data",
          price: "0.01",
          sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
          sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
          summary: "ETH sentiment from Provider Studio.",
          upstream_url: "/mock/upstream/sentiment",
          upstream_method: "POST",
          secret_name: "PROVIDER_SECRET",
          secret_value: "demo-provider-secret",
          auth_header: "authorization"
        })
      });
      assert.equal(studioResponse.status, 201);
      const payload = await studioResponse.json();
      assert.equal(payload.ok, true);
      const keyFile = await fs.readFile(path.join(process.env.ADN_DIR, "provider-secret.key"), "utf8");
      assert.ok(keyFile.trim().length >= 32);
      const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_local_secret_key_demo.json"), "utf8"));
      assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);
    });
  } finally {
    if (previousProviderPassphrase === undefined) delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
    else process.env.ADN_PROVIDER_SECRET_PASSPHRASE = previousProviderPassphrase;
    if (previousWalletPassphrase === undefined) delete process.env.ADN_WALLET_PASSPHRASE;
    else process.env.ADN_WALLET_PASSPHRASE = previousWalletPassphrase;
  }
});

test("Provider Studio API creates and validates hosted-http service", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_hosted_sentiment_demo",
        provider_id: "provider_studio",
        title: "Studio Hosted Sentiment Demo",
        description_for_agent: "Use this service to fetch sentiment data through Provider Studio.",
        capabilities: "sentiment_data,hosted_http,demo_data",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
        sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
        summary: "ETH sentiment from Provider Studio is positive.",
        upstream_url: "/mock/upstream/sentiment",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "studio_hosted_sentiment_demo");
    assert.equal(payload.validation.ok, true);
    assert.equal(JSON.stringify(payload.manifest).includes("demo-provider-secret"), false);
    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_hosted_sentiment_demo.json"), "utf8"));
    assert.equal(config.source.auth.secret_value, undefined);
    assert.equal(config.source.auth.secret_ref, "studio_hosted_sentiment_demo:PROVIDER_SECRET");

    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "studio_hosted_sentiment_demo", "{\"asset\":\"ETH\",\"window\":\"7d\"}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const invocation = JSON.parse(invoke.stdout);
    assert.equal(invocation.result.data.source, "mock_upstream_sentiment");
  });
});

test("Provider Studio auto-detects common API key headers during validation", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_auto_auth_header_demo",
        provider_id: "provider_studio",
        title: "Studio Auto Auth Header Demo",
        description_for_agent: "Use this service to fetch a generic provider dataset with automatic auth header detection.",
        capabilities: "data_service,provider_api_demo",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"status\":\"success\",\"rows\":[{\"metric\":\"sample_metric\",\"value\":42}]}",
        summary: "Generic provider API returned one row.",
        upstream_url: "/mock/upstream/header-key",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.validation.result_preview.rows[0].value, 42);
    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_auto_auth_header_demo.json"), "utf8"));
    assert.equal(config.source.auth.header, "auto");
    assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);
  });
});

test("hosted HTTP providers honor agent limit and keep compact validation previews", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_limited_rows_demo",
        provider_id: "provider_studio",
        title: "Studio Limited Rows Demo",
        description_for_agent: "Use this service to fetch provider rows with a caller-specified limit.",
        capabilities: "data_service,provider_api_demo",
        price: "0.01",
        sample_request: "{\"limit\":2,\"total_rows\":7}",
        sample_data: "{\"status\":\"success\",\"rows\":[{\"metric\":\"sample_metric_1\",\"value\":42}]}",
        summary: "Generic provider API returned limited rows.",
        upstream_url: "/mock/upstream/header-key",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.validation.result_preview.rows.length, 2);
    assert.equal(payload.validation.result_preview.agentrouter_page.total_available, 7);
    assert.equal(payload.validation.result_preview.agentrouter_page.truncated, true);

    const invokeResponse = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "studio_limited_rows_demo",
        input: { limit: 3, total_rows: 9 },
        budget: { max_amount: "0.05", currency: "USDC" }
      })
    });
    assert.equal(invokeResponse.status, 200);
    const invocation = await invokeResponse.json();
    assert.equal(invocation.result.data.rows.length, 3);
    assert.equal(invocation.result.data.agentrouter_page.total_available, 9);
    assert.equal(invocation.result.data.agentrouter_page.returned, 3);
  });
});

test("Provider Studio rejects duplicate or invalid service submissions", async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "Bad Service",
        provider_id: "provider",
        title: "Bad",
        description_for_agent: "Bad service.",
        capabilities: "demo",
        price: "0",
        sample_request: "{}",
        sample_data: "{}",
        live_data: "{}",
        summary: "Bad"
      })
    });
    assert.equal(invalid.status, 422);
    const invalidBody = await invalid.json();
    assert.match(invalidBody.error.message, /price/);

    const duplicate = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "chain_fund_flow_7d_base",
        provider_id: "provider",
        title: "Duplicate",
        description_for_agent: "Duplicate.",
        capabilities: "demo",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{}",
        live_data: "{}",
        summary: "Duplicate"
      })
    });
    assert.equal(duplicate.status, 422);
    const duplicateBody = await duplicate.json();
    assert.match(duplicateBody.error.message, /already registered/);
  });
});

test("Provider Studio can auto-generate service and provider ids", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "My Alpha Feed",
        provider_name: "Alice Data Lab",
        description_for_agent: "Use this service to fetch a simple alpha demo feed.",
        price: "0.01",
        sample_request: "{\"asset\":\"BTC\"}",
        sample_data: "{\"asset\":\"BTC\",\"score\":0.5,\"sample\":true}",
        live_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        summary: "BTC alpha score is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.service_id, "my_alpha_feed");
    assert.equal(payload.manifest.provider.provider_id, "alice_data_lab");
    assert.deepEqual(payload.manifest.capabilities, ["data_service"]);
  });
});

test("Provider Studio can derive preview data from result data by default", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Derived Preview Feed",
        provider_name: "Alice Data Lab",
        description_for_agent: "Use this service to fetch a derived preview demo feed.",
        price: "0.01",
        sample_request: "{\"asset\":\"BTC\"}",
        sample_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        live_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        summary: "BTC score is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.deepEqual(payload.manifest.sample_response.data, { asset: "BTC", score: 0.8 });
  });
});

test("consumer feedback updates trust and affects later routing", async () => {
  await withServer(async ({ server, baseUrl }) => {
    for (const service of [
      {
        service_id: "alpha_signal_good_source",
        provider_id: "provider_alpha_good",
        title: "Alpha Signal Good Source",
        score: 0.91,
        summary: "Alpha signal from the good source."
      },
      {
        service_id: "alpha_signal_weak_source",
        provider_id: "provider_alpha_weak",
        title: "Alpha Signal Weak Source",
        score: 0.12,
        summary: "Alpha signal from the weak source."
      }
    ]) {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: service.service_id,
          provider_id: service.provider_id,
          title: service.title,
          description_for_agent: "Use this service to fetch generic alpha signal data.",
          capabilities: "data_service,alpha_signal",
          price: "0.01",
          sample_request: "{}",
          sample_data: JSON.stringify({ alpha_signal_score: service.score, source: service.service_id }),
          live_data: JSON.stringify({ alpha_signal_score: service.score, source: service.service_id }),
          summary: service.summary
        })
      });
      assert.equal(response.status, 201);
    }

    for (const [serviceId, requestId] of [
      ["alpha_signal_good_source", "manual_eval_good"],
      ["alpha_signal_weak_source", "manual_eval_weak"]
    ]) {
      const record = server.store.services.get(serviceId);
      const event = {
        event_version: "agent_service_feedback_v1",
        request_id: requestId,
        service_id: serviceId,
        provider_id: record.manifest.provider.provider_id,
        consumer_id: "agentrouter_consumer",
        status: "success",
        schema_valid: true,
        verification: { coverage_valid: true, agent_friendly_score: 1 },
        created_at: new Date().toISOString()
      };
      record.feedback_events.push(event);
      server.store.feedbackEvents.push(event);
    }

    const goodFeedback = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "alpha_signal_good_source",
        request_id: "manual_eval_good",
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          data_quality_score: 0.95,
          used_in_final_answer: true,
          reason: "The data was directly usable for the alpha signal task.",
          confidence: 0.9
        }
      })
    }).then((res) => res.json());
    assert.equal(goodFeedback.ok, true);

    const weakFeedback = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "alpha_signal_weak_source",
        request_id: "manual_eval_weak",
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "partial",
          answer_useful: "no",
          data_quality_score: 0.2,
          used_in_final_answer: false,
          reason: "The data was related but not useful enough for the answer.",
          confidence: 0.8
        }
      })
    }).then((res) => res.json());
    assert.equal(weakFeedback.ok, true);
    assert.ok(goodFeedback.trust.trust_score > weakFeedback.trust.trust_score);

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "alpha_signal",
        params: {},
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "alpha_signal_good_source");
    assert.match(routed.selected_service.selection_reason, /consumer_feedback=1/);
  });
});

test("AgentRouter routes generic netflow requests to dynamic registered services", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "ETH Spot Netflow 24h",
        provider_name: "Flow Data Lab",
        description_for_agent: "Use this service to fetch ETH spot netflow data for recent windows.",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"24h\"}",
        sample_data: "{\"asset\":\"ETH\",\"window\":\"24h\",\"netflow_usd\":12345}",
        live_data: "{\"asset\":\"ETH\",\"window\":\"24h\",\"netflow_usd\":23456}",
        summary: "ETH 24h spot netflow is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const provider = await studioResponse.json();
    assert.ok(provider.manifest.capabilities.includes("netflow"));

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "查询ETH的近24小时的netflow",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.request.capability, "netflow");
    assert.equal(routed.selected_service.service_id, "eth_spot_netflow_24h");
    assert.deepEqual(routed.input, { asset: "ETH", window: "24h" });
    assert.equal(routed.result.data.netflow_usd, 23456);
  });
});

test("AgentRouter resolves token symbols before invoking token-address services", async () => {
  await withServer(async ({ baseUrl }) => {
    const newsSearchResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "article_news_search",
        title: "Search articles and news",
        provider_name: "News Lab",
        description_for_agent: "Use this service to search articles and news by keyword.",
        capabilities: "data_service,news_data,article_data",
        price: "0.01",
        sample_request: "{\"name\":\"AZTEC\"}",
        sample_data: "{\"articles\":[{\"title\":\"AZTEC news\"}]}",
        live_data: "{\"articles\":[{\"title\":\"AZTEC news\"}]}",
        summary: "Search article and news content."
      })
    });
    assert.equal(newsSearchResponse.status, 201);

    const searchResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_search_resolver",
        title: "Token Search Resolver",
        provider_name: "Token Directory Lab",
        description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
        capabilities: "data_service,token_search,entity_search,token_metadata",
        price: "0.01",
        sample_request: "{\"search_query\":\"AZTEC\",\"result_type\":\"token\",\"chain\":\"ethereum\",\"limit\":5}",
        sample_data: "{\"data\":[{\"symbol\":\"AZTEC\",\"name\":\"Aztec\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"chain\":\"ethereum\"}]}",
        live_data: "{\"data\":[{\"symbol\":\"AZTEC\",\"name\":\"Aztec\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"chain\":\"ethereum\"}]}",
        summary: "Resolve token symbols to token contract addresses."
      })
    });
    assert.equal(searchResponse.status, 201);

    const dexTradesResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_dex_trades",
        title: "Token God Mode DEX Trades",
        provider_name: "Token Flow Lab",
        description_for_agent: "Use this service for token-level DEX trades and token swap activity.",
        capabilities: "data_service,token_god_mode,token_data,dex_trades,token_activity",
        price: "0.01",
        sample_request: "{\"chain\":\"ethereum\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
        sample_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"trades\":[]}",
        live_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"trades\":[]}",
        summary: "Token-level DEX trades."
      })
    });
    assert.equal(dexTradesResponse.status, 201);

    const flowResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_flow_intelligence",
        title: "Token God Mode Flow Intelligence",
        provider_name: "Token Flow Lab",
        description_for_agent: "Use this service for token-level smart money activity, token flow intelligence, buyer seller movement, and recent token flow analysis.",
        capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
        price: "0.01",
        sample_request: "{\"chain\":\"ethereum\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
        sample_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"window\":\"24h\",\"smart_money_netflow_usd\":120000}",
        live_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"window\":\"24h\",\"smart_money_netflow_usd\":220000}",
        summary: "Token-level smart money flow intelligence."
      })
    });
    assert.equal(flowResponse.status, 201);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "通过 AgentRouter 查询 AZTEC 的聪明钱近24小时的动向",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "token_flow_intelligence");
    assert.equal(routed.token_resolution.status, "resolved");
    assert.equal(routed.token_resolution.resolver_service_id, "token_search_resolver");
    assert.equal(routed.token_resolution.resolution_type, "exact_symbol");
    assert.equal(routed.token_resolution.requires_disclosure, false);
    assert.equal(routed.input.token_address, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(routed.input.chain, "ethereum");
    assert.equal(routed.input.timeframe, "1d");
    assert.equal(routed.result.data.smart_money_netflow_usd, 220000);

    const structuredResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "token_smart_money_activity",
        params: {
          token_symbol: "AZTEC",
          chain: "ethereum",
          window: "24h",
          pagination: { page: 1, per_page: 24 }
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(structuredResponse.status, 200);
    const structured = await structuredResponse.json();
    assert.equal(structured.ok, true);
    assert.equal(structured.protocol.semantic_parser, "external_main_agent");
    assert.equal(structured.selected_service.service_id, "token_flow_intelligence");
    assert.equal(structured.token_resolution.status, "resolved");
    assert.equal(structured.token_resolution.resolver_service_id, "token_search_resolver");
    assert.equal(structured.token_resolution.resolution_type, "exact_symbol");
    assert.equal(structured.token_resolution.requires_disclosure, false);
    assert.equal(structured.input.token_address, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(structured.result.data.smart_money_netflow_usd, 220000);

    const client = createMcpClient({ AGENT_ROUTER_URL: baseUrl });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "token-resolution-test", version: "0.1.0" }
      });
      const called = await client.request("tools/call", {
        name: "agentrouter_request",
        arguments: {
          capability: "token_smart_money_activity",
          params: {
            token_symbol: "AZTEC",
            chain: "ethereum",
            window: "24h",
            pagination: { page: 1, per_page: 24 }
          },
          constraints: { max_price_usdc: "0.05" }
        }
      });
      const mcpRouted = JSON.parse(called.content[0].text);
      assert.equal(mcpRouted.ok, true);
      assert.equal(mcpRouted.token_resolution.status, "resolved");
      assert.equal(mcpRouted.token_resolution.token_address, "0x1234567890abcdef1234567890abcdef12345678");
      assert.equal(mcpRouted.token_resolution.resolution_type, "exact_symbol");
      assert.equal(mcpRouted.token_resolution.requires_disclosure, false);
      assert.equal(mcpRouted.input.token_address, "0x1234567890abcdef1234567890abcdef12345678");
      assert.equal(mcpRouted.result.data.smart_money_netflow_usd, 220000);
      assert.equal(mcpRouted.feedback_required, true);
      assert.match(mcpRouted.next_required_action, /agentrouter_feedback/);

      const mcpEvidenceResponse = await fetch(`${baseUrl}/agent-router/evidence?request_id=${mcpRouted.result.request_id}`);
      assert.equal(mcpEvidenceResponse.status, 200);
      const mcpEvidence = await mcpEvidenceResponse.json();
      assert.equal(mcpEvidence.count, 1);
      assert.equal(mcpEvidence.events[0].request.capability, "token_smart_money_activity");
      assert.equal(mcpEvidence.events[0].request.params, undefined);
      assert.match(mcpEvidence.events[0].input_hash, /^0x[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(mcpEvidence.events[0]).includes("0x1234567890abcdef1234567890abcdef12345678"), false);
    } finally {
      client.close();
    }
  });
});

test("AgentRouter discloses wrapped-token substitutions during token resolution", async () => {
  await withServer(async ({ baseUrl }) => {
    const resolverResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "wrapped_token_search_resolver",
        title: "Token Search Resolver",
        provider_name: "Token Directory Lab",
        description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
        capabilities: "data_service,token_search,entity_search,token_metadata",
        price: "0.01",
        sample_request: "{\"search_query\":\"HYPE\",\"result_type\":\"token\",\"chain\":\"hyperevm\",\"limit\":5}",
        sample_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
        live_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
        summary: "Resolve token symbols to token contract addresses."
      })
    });
    assert.equal(resolverResponse.status, 201);

    const flowResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "hyperevm_token_flow",
        title: "HyperEVM Token Flow",
        provider_name: "Token Flow Lab",
        description_for_agent: "Use this service for token-level smart money activity on HyperEVM token contracts.",
        capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
        price: "0.01",
        sample_request: "{\"chain\":\"hyperevm\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
        sample_data: "{\"token_symbol\":\"WHYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"window\":\"24h\",\"smart_money_netflow_usd\":0}",
        live_data: "{\"token_symbol\":\"WHYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"window\":\"24h\",\"smart_money_netflow_usd\":0}",
        summary: "Token-level smart money flow intelligence."
      })
    });
    assert.equal(flowResponse.status, 201);

    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "token_smart_money_activity",
        params: {
          token_symbol: "HYPE",
          chain: "hyperevm",
          window: "24h"
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(response.status, 200);
    const routed = await response.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.token_resolution.token_symbol, "HYPE");
    assert.equal(routed.token_resolution.matched_symbol, "WHYPE");
    assert.equal(routed.token_resolution.resolution_type, "wrapped_token_substitution");
    assert.equal(routed.token_resolution.requires_disclosure, true);
    assert.match(routed.token_resolution.disclosure, /wrapped-token \/ EVM contract data/);
    assert.equal(routed.input.token_address, "0x5555555555555555555555555555555555555555");

    const cli = await runAgentRouterCli(["ask", "查 HYPE 近 24 小时聪明钱动向"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(cli.code, 0, cli.stderr);
    const cliRouted = JSON.parse(cli.stdout);
    assert.equal(cliRouted.ok, true, JSON.stringify({
      ok: cliRouted.ok,
      status: cliRouted.status,
      error: cliRouted.error,
      attempted_services: cliRouted.attempted_services,
      error_payload: cliRouted.payload
    }, null, 2));
    assert.equal(cliRouted.status, "paid_with_local_wallet");
    assert.equal(cliRouted.token_resolution.token_symbol, "HYPE");
    assert.equal(cliRouted.token_resolution.chain, "hyperevm");
    assert.equal(cliRouted.token_resolution.resolution_type, "wrapped_token_substitution");
    assert.ok(cliRouted.token_resolution.confidence >= 0.9);
    assert.equal(cliRouted.token_resolution.match_strategy, "wrapped_symbol");
    assert.equal(cliRouted.token_resolution.candidate_count, 1);
    assert.equal(cliRouted.input.token_address, "0x5555555555555555555555555555555555555555");
    assert.match(cliRouted.timing.trace_id, /^trace_/);
    assert.ok(cliRouted.timing.phases.token_resolver_search.duration_ms >= 0);
    assert.ok(cliRouted.timing.resolve_route_ms == null);
    assert.ok(cliRouted.timing.token_resolver_search_ms >= 0);
    assert.ok(cliRouted.timing.quote_route_attempt_1_ms >= 0);
  });
});

test("AgentRouter retries the next token smart-money service when a provider fails before payment", async () => {
  await withServer(async ({ server, baseUrl }) => {
    let failingProviderRequests = 0;
    const failingUpstream = http.createServer((req, res) => {
      failingProviderRequests += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE" } }));
    });
    await new Promise((resolve) => failingUpstream.listen(0, "127.0.0.1", resolve));
    const failingUrl = `http://127.0.0.1:${failingUpstream.address().port}/provider`;

    try {
      const resolverResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "retry_token_search_resolver",
          title: "Token Search Resolver",
          provider_name: "Token Directory Lab",
          description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
          capabilities: "data_service,token_search,entity_search,token_metadata",
          price: "0.01",
          sample_request: "{\"search_query\":\"HYPE\",\"result_type\":\"token\",\"chain\":\"hyperevm\",\"limit\":5}",
          sample_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
          live_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
          summary: "Resolve token symbols to token contract addresses."
        })
      });
      assert.equal(resolverResponse.status, 201);

      const failingFlowResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "failing_hype_flow",
          title: "HyperEVM Token Flow A",
          provider_name: "Token Flow Lab",
          description_for_agent: "Use this service for token-level smart money activity on HyperEVM token contracts.",
          capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
          price: "0.01",
          sample_request: "{\"chain\":\"hyperevm\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
          sample_data: "{\"token_symbol\":\"WHYPE\",\"smart_money_netflow_usd\":0}",
          live_data: "{\"token_symbol\":\"WHYPE\",\"smart_money_netflow_usd\":0}",
          summary: "Token-level smart money flow intelligence."
        })
      });
      assert.equal(failingFlowResponse.status, 201);
      server.store.services.get("failing_hype_flow").manifest.endpoint.url = failingUrl;

      const healthyFlowResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "healthy_hype_flow",
          title: "HyperEVM Token Flow B",
          provider_name: "Token Flow Lab B",
          description_for_agent: "Use this service for token-level smart money activity on HyperEVM token contracts.",
          capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
          price: "0.01",
          sample_request: "{\"chain\":\"hyperevm\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"24h\"}",
          sample_data: "{\"token_symbol\":\"WHYPE\",\"smart_money_netflow_usd\":0}",
          live_data: "{\"token_symbol\":\"WHYPE\",\"smart_money_netflow_usd\":42}",
          summary: "Token-level smart money flow intelligence."
        })
      });
      assert.equal(healthyFlowResponse.status, 201);

      const cli = await runAgentRouterCli(["ask", "查 HYPE 近 24 小时聪明钱动向"], {
        ADN_REGISTRY_URL: baseUrl
      });
      assert.equal(cli.code, 0, cli.stderr);
      const payload = JSON.parse(cli.stdout);
      assert.equal(payload.ok, true, JSON.stringify({
        ok: payload.ok,
        status: payload.status,
        error: payload.error,
        attempted_services: payload.attempted_services,
        error_payload: payload.payload
      }, null, 2));
      assert.equal(payload.selected_service.service_id, "healthy_hype_flow");
      assert.equal(payload.attempted_services[0].service_id, "failing_hype_flow");
      assert.equal(payload.attempted_services[0].status, "PROVIDER_HTTP_UNSAFE_TARGET");
      assert.equal(failingProviderRequests, 0, "the private endpoint must be rejected before provider I/O");
      assert.ok(payload.timing.quote_route_attempt_2_ms >= 0);
    } finally {
      await Promise.all(["retry_token_search_resolver", "failing_hype_flow", "healthy_hype_flow"].map((serviceId) =>
        fs.rm(path.join(process.env.ADN_PROVIDER_DIR, `${serviceId}.json`), { force: true })
      ));
      await new Promise((resolve) => failingUpstream.close(resolve));
    }
  });
});

test("AgentRouter excludes circuit-broken services during candidate ranking", async () => {
  await withServer(async ({ server, baseUrl }) => {
    try {
      const resolverResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "circuit_token_search_resolver",
          title: "Token Search Resolver",
          provider_name: "Token Directory Lab Circuit",
          description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
          capabilities: "data_service,token_search,entity_search,token_metadata",
          price: "0.01",
          sample_request: "{\"search_query\":\"HYPE\",\"result_type\":\"token\",\"chain\":\"hyperevm\",\"limit\":5}",
          sample_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
          live_data: "{\"data\":[{\"symbol\":\"WHYPE\",\"name\":\"Wrapped HYPE\",\"token_address\":\"0x5555555555555555555555555555555555555555\",\"chain\":\"hyperevm\"}]}",
          summary: "Resolve HYPE token symbols to token contract addresses."
        })
      });
      assert.equal(resolverResponse.status, 201);

      for (const serviceId of ["circuit_broken_hype_flow", "circuit_healthy_hype_flow"]) {
        const isHealthy = serviceId === "circuit_healthy_hype_flow";
        const response = await fetch(`${baseUrl}/studio/providers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "static-json",
            service_id: serviceId,
            title: isHealthy ? "HyperEVM Token Flow Healthy" : "HyperEVM Token Flow Broken",
            provider_name: isHealthy ? "Token Flow Lab Healthy Circuit" : "Token Flow Lab Broken Circuit",
            description_for_agent: "Use this service for token-level smart money activity on HyperEVM token contracts.",
            capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
            price: "0.01",
            sample_request: "{\"chain\":\"hyperevm\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"24h\"}",
            sample_data: JSON.stringify({ token_symbol: "WHYPE", sample_source: serviceId, smart_money_netflow_usd: isHealthy ? 42 : 7 }),
            live_data: JSON.stringify({ token_symbol: "WHYPE", service_id: serviceId, smart_money_netflow_usd: isHealthy ? 42 : 7 }),
            summary: isHealthy ? "Healthy token-level smart money flow intelligence." : "Broken token-level smart money flow intelligence."
          })
        });
        assert.equal(response.status, 201);
      }

      const broken = server.store.services.get("circuit_broken_hype_flow");
      broken.feedback_events.push(
        ...[1, 2, 3].map((index) => ({
          event_version: "agent_service_feedback_v1",
          request_id: `circuit_fail_${index}`,
          service_id: "circuit_broken_hype_flow",
          provider_id: broken.manifest.provider.provider_id,
          status: "error",
          http_status: 503,
          schema_valid: false,
          latency_ms: 25,
          created_at: new Date(Date.now() - (4 - index) * 1000).toISOString()
        }))
      );

      const response = await fetch(`${baseUrl}/agent-router/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "token_smart_money_activity",
          params: {
            token_symbol: "HYPE",
            chain: "hyperevm",
            window: "24h"
          },
          constraints: { max_price_usdc: "0.05" }
        })
      });
      assert.equal(response.status, 200);
      const routed = await response.json();
      assert.equal(routed.ok, true);
      assert.equal(routed.selected_service.service_id, "circuit_healthy_hype_flow");
      assert.equal(routed.result.data.service_id, "circuit_healthy_hype_flow");
      assert.equal(routed.selected_service.selection_badges?.includes("circuit_breaker_active"), false);
    } finally {
      await Promise.all(["circuit_token_search_resolver", "circuit_broken_hype_flow", "circuit_healthy_hype_flow"].map((serviceId) =>
        fs.rm(path.join(process.env.ADN_PROVIDER_DIR, `${serviceId}.json`), { force: true })
      ));
    }
  });
});

test("AgentRouter blocks ambiguous token symbol substitutions before target payment", async () => {
  await withServer(async ({ baseUrl }) => {
    try {
      const resolverResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "ambiguous_token_search_resolver",
          title: "Token Search Resolver",
          provider_name: "Ambiguous Token Directory",
          description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
          capabilities: "data_service,token_search,entity_search,token_metadata",
          price: "0.01",
          sample_request: "{\"search_query\":\"GENIUS\",\"result_type\":\"token\",\"chain\":\"ethereum\",\"limit\":5}",
          sample_data: "{\"data\":[{\"symbol\":\"GNUS\",\"name\":\"Genius Token & NFT Collections\",\"token_address\":\"0x614577036f0a024dbc1c88ba616b394dd65d105a\",\"chain\":\"ethereum\"}]}",
          live_data: "{\"data\":[{\"symbol\":\"GNUS\",\"name\":\"Genius Token & NFT Collections\",\"token_address\":\"0x614577036f0a024dbc1c88ba616b394dd65d105a\",\"chain\":\"ethereum\"}]}",
          summary: "Resolve token symbols to token contract addresses."
        })
      });
      assert.equal(resolverResponse.status, 201);

      const flowResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: "ambiguous_token_flow",
          title: "Token Flow Intelligence",
          provider_name: "Ambiguous Token Flow Lab",
          description_for_agent: "Use this service for token-level smart money activity and token flow intelligence.",
          capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
          price: "0.01",
          sample_request: "{\"chain\":\"ethereum\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
          sample_data: "{\"smart_money_netflow_usd\":0}",
          live_data: "{\"smart_money_netflow_usd\":0}",
          summary: "Token-level smart money flow intelligence."
        })
      });
      assert.equal(flowResponse.status, 201);

      const cli = await runAgentRouterCli(["ask", "查 GENIUS 近 24 小时聪明钱动向"], {
        ADN_REGISTRY_URL: baseUrl
      });
      assert.equal(cli.code, 0, cli.stderr);
      const payload = JSON.parse(cli.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "token_resolution_ambiguous");
      assert.equal(payload.data_returned, false);
      assert.equal(payload.token_resolution.resolution_type, "symbol_substitution");
      assert.equal(payload.token_resolution.matched_symbol, "GNUS");
      assert.ok(payload.token_resolution.confidence < 0.5);
      assert.equal(payload.token_resolution.match_strategy, "name_contains_symbol");
      assert.equal(payload.token_resolution.candidate_count, 1);
      assert.match(payload.token_resolution.blocking_reason, /will not auto-pay/);
      assert.equal(payload.local_payment, undefined);
      assert.match(payload.timing.trace_id, /^trace_/);
      assert.equal(payload.timing.quote_route_attempt_1_ms, undefined);
    } finally {
      await Promise.all(["ambiguous_token_search_resolver", "ambiguous_token_flow"].map((serviceId) =>
        fs.rm(path.join(process.env.ADN_PROVIDER_DIR, `${serviceId}.json`), { force: true })
      ));
    }
  });
});

test("AgentRouter builds service-aware input for address profile endpoints", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Address Related Wallets",
        provider_name: "Wallet Intel Lab",
        description_for_agent: "Use this service to fetch related wallets for an EVM address by chain.",
        capabilities: "data_service,wallet_profile,address_intelligence,related_wallets,wallet_cluster",
        price: "0.01",
        sample_request: "{\"address\":\"0x0000000000000000000000000000000000000000\",\"chain\":\"ethereum\",\"pagination\":{\"page\":1,\"per_page\":10}}",
        sample_data: "{\"data\":[],\"pagination\":{\"page\":1,\"per_page\":10,\"is_last_page\":true}}",
        live_data: "{\"data\":[{\"address\":\"0x1111111111111111111111111111111111111111\",\"relation\":\"Deployed Contract\"}],\"pagination\":{\"page\":1,\"per_page\":3,\"is_last_page\":true}}",
        summary: "Related wallet data for address due diligence."
      })
    });
    assert.equal(studioResponse.status, 201);

    const distractorResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Address Points Leaderboard",
        provider_name: "Wallet Intel Lab",
        description_for_agent: "Use this service to fetch points leaderboard rows for addresses.",
        capabilities: "data_service,wallet_profile,leaderboard_data,points",
        price: "0.01",
        sample_request: "{\"address\":\"0x0000000000000000000000000000000000000000\",\"pagination\":{\"page\":1,\"per_page\":10}}",
        sample_data: "{\"results\":[],\"page\":1}",
        live_data: "{\"results\":[{\"address\":\"0x2222222222222222222222222222222222222222\",\"rank\":1}],\"page\":1}",
        summary: "Address points leaderboard."
      })
    });
    assert.equal(distractorResponse.status, 201);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "查询地址 0xbbfb6566ad064c233af6314aeb1eee4c26a5f921 在 Arbitrum 的 related wallets 前 3 条",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "address_related_wallets");
    assert.deepEqual(routed.input, {
      address: "0xbbfb6566ad064c233af6314aeb1eee4c26a5f921",
      chain: "arbitrum",
      pagination: { page: 1, per_page: 3 }
    });
    assert.equal(routed.result.data.data[0].relation, "Deployed Contract");
  });
});

test("hosted publish requires persistent storage when the deployment requires it", async () => {
  const previousRequired = process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
  const previousDatabase = process.env.DATABASE_URL;
  const previousPassphrase = process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  process.env.ADN_REQUIRE_PERSISTENT_REGISTRY = "true";
  delete process.env.DATABASE_URL;
  process.env.ADN_PROVIDER_SECRET_PASSPHRASE = "stable-test-passphrase";
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "hosted-http",
          service_id: "persistent_required_demo",
          provider_id: "provider_studio",
          title: "Persistent Required Demo",
          description_for_agent: "Use this service to verify hosted publish persistence guards.",
          capabilities: "persistent_required_demo,data_service",
          price: "0.01",
          sample_request: "{}",
          sample_data: "{\"ok\":true}",
          summary: "Persistent required demo.",
          upstream_url: "/mock/upstream/sentiment",
          upstream_method: "POST",
          secret_name: "PROVIDER_SECRET",
          secret_value: "provider-owned-secret",
          auth_header: "authorization"
        })
      });
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.error.code, "PERSISTENT_REGISTRY_REQUIRED");
    });
  } finally {
    if (previousRequired === undefined) delete process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
    else process.env.ADN_REQUIRE_PERSISTENT_REGISTRY = previousRequired;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousPassphrase === undefined) delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
    else process.env.ADN_PROVIDER_SECRET_PASSPHRASE = previousPassphrase;
  }
});

test("AgentRouter ask does not route partial token-only matches to unrelated services", async () => {
  await withServer(async ({ baseUrl }) => {
    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "用 AgentRouter 查询 BTC custom metric 数据",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "no_service_found");
    assert.equal(routed.selected_service, undefined);
  });
});

test("Provider Studio imports OpenAPI data endpoints into multiple services", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: `${baseUrl}/mock/api`,
        default_price: "0.01"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 2);
    assert.equal(discovered.skipped.length, 2);
    assert.deepEqual(
      discovered.drafts.map((draft) => draft.service_id).sort(),
      ["get_funding_rate", "get_liquidation_max_pain"]
    );
    assert.deepEqual(
      discovered.drafts.find((draft) => draft.service_id === "get_funding_rate").preview_data,
      { asset: "BTC", funding_rate: 0.00018, venue: "Binance" }
    );

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.published.length, 2);

    const duplicateDraft = {
      ...discovered.drafts.find((draft) => draft.service_id === "get_funding_rate"),
      service_id: "get_funding_rate_copy"
    };
    const duplicateResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: [duplicateDraft], publish_scope: "local_only" })
    });
    assert.equal(duplicateResponse.status, 201);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.published[0].already_registered, true);
    assert.equal(duplicate.published[0].duplicate_reason, "same_provider_source");
    assert.equal(duplicate.published[0].service_id, "get_funding_rate");
    assert.equal(server.store.services.has("get_funding_rate_copy"), false);

    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "funding rate",
      max_price: "0.05",
      verified_only: true
    });
    assert.ok(services.some((service) => service.service_id === "get_funding_rate"));

    const invocation = await connector.invokePaidService(
      "get_funding_rate",
      { asset: "BTC" },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.asset, "BTC");
    assert.equal(invocation.result.data.source, "mock_openapi");

    const dynamicResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "funding_rate",
        params: { asset: "BTC" },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(dynamicResponse.status, 200);
    const dynamicRouted = await dynamicResponse.json();
    assert.equal(dynamicRouted.ok, true);
    assert.equal(dynamicRouted.request.capability, "funding_rate");
    assert.equal(dynamicRouted.selected_service.service_id, "get_funding_rate");
    assert.deepEqual(dynamicRouted.input, { asset: "BTC" });
    assert.equal(dynamicRouted.result.data.source, "mock_openapi");

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 当前最大爆仓痛点是多少",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.request.capability, "perp_liquidation_max_pain");
    assert.equal(routed.selected_service.service_id, "get_liquidation_max_pain");
    assert.equal(routed.result.data.source, "mock_openapi");
    assert.equal(routed.feedback.schema_valid, true);
  });
});

test("remote Provider Studio publish requires a provider account session and records owner metadata", async () => {
  await withServer(async ({ server, baseUrl, authCookie, testUser, rawFetch }) => {
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: `${baseUrl}/mock/api`,
        default_price: "0.01"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();

    const unauthenticated = await rawFetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: [discovered.drafts[0]], publish_scope: "local_only" })
    });
    assert.equal(unauthenticated.status, 401);

    const sessionPublish = await rawFetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: authCookie
      },
      body: JSON.stringify({ drafts: [discovered.drafts[0]], publish_scope: "local_only" })
    });
    assert.equal(sessionPublish.status, 201);
    const payload = await sessionPublish.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.published.length, 1);
    assert.equal(payload.published[0].service_id, discovered.drafts[0].service_id);
    const record = server.store.services.get(discovered.drafts[0].service_id);
    assert.equal(record.manifest.registration.owner.user_key, `${testUser.provider}:${testUser.id}`);
    assert.equal(record.manifest.registration.owner.handle, testUser.handle);
  });
});

test("Provider Studio imports a direct API endpoint when no OpenAPI document exists", async () => {
  await withServer(async ({ baseUrl }) => {
    const endpointUrl = `${baseUrl}/api/v1/data/market-snapshot`;
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: endpointUrl,
        default_price: "0.01",
        secret_value: "provider-owned-secret"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.mode, "direct_endpoint");
    assert.equal(discovered.drafts.length, 1);
    const draft = discovered.drafts[0];
    assert.equal(draft.upstream_url, endpointUrl);
    assert.equal(draft.method, "POST");
    assert.equal(draft.auth_header, "auto");
    assert.equal(draft.secret_name, "PROVIDER_SECRET");
    assert.ok(draft.capabilities.includes("data_service"));
    assert.deepEqual(draft.sample_request, {});
    assert.deepEqual(draft.preview_data, { ok: true });

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 422);
    const published = await publishResponse.json();
    assert.equal(published.ok, false);
    assert.equal(published.published.length, 0);
    assert.equal(published.failed[0].service_id, "post_api_v1_data_market_snapshot");
    assert.equal(published.failed[0].error, "VALIDATION_FAILED");
    assert.equal(published.failed[0].validation.ok, false);

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "smart_money_holdings",
        params: {
          chains: ["ethereum"],
          pagination: { page: 1, per_page: 10 }
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "no_match");
    assert.equal(routed.observation.observation_version, "agent_router_route_observation_v1");
    assert.equal(routed.observation.status, "no_match");
    assert.equal(routed.observation.request.capability, "smart_money_holdings");
    assert.equal(routed.observation.candidates_considered, 0);

    const observationsResponse = await fetch(`${baseUrl}/agent-router/observations?status=no_match`);
    assert.equal(observationsResponse.status, 200);
    const observations = await observationsResponse.json();
    assert.ok(observations.observations.some((event) => event.observation_id === routed.observation.observation_id));
  });
});

test("Provider Studio publish replaces an unverified duplicate service and retries validation", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const serviceId = "get_api_v1_data_header_key_retry";
    server.store.services.set(serviceId, {
      manifest: {
        service_id: serviceId,
        provider: { provider_id: "api_pro_example" },
        registration: { source_fingerprint: "stale_unverified_source" }
      },
      verification_status: "pending",
      validation_runs: [{ ok: false, error: "previous validation failed" }],
      feedback_events: [],
      quality_events: [],
      health_checks: []
    });

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publish_scope: "local_only",
        drafts: [{
          selected: true,
          service_id: serviceId,
          provider_id: "api_pro_example",
          provider_name: "API Pro Example",
          title: "Header key retry",
          description_for_agent: "Use this service to fetch header-key protected data.",
          capabilities: ["data_service", "header_key_retry"],
          price: "0.01",
          method: "GET",
          path: "/api/v1/data/header-key",
          upstream_url: `${baseUrl}/mock/upstream/header-key`,
          auth_header: "auto",
          secret_name: "PROVIDER_SECRET",
          secret_value: "demo-provider-secret",
          sample_request: {},
          preview_data: { status: "success", rows: [{ metric: "sample_metric_1", value: 42 }] },
          summary: "Header key retry returns one row."
        }]
      })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.failed.length, 0);
    assert.equal(published.published[0].service_id, serviceId);
    assert.equal(published.published[0].validation.ok, true);
    assert.equal(server.store.services.get(serviceId).verification_status, "verified");
  });
});

test("Provider Studio imports endpoint drafts from a Skill document", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/blockbeats-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# BlockBeats API Skill

Base URL: \`http://127.0.0.1:${upstream.address().port}\` Auth: All requests require Header \`api-key: $BLOCKBEATS_API_KEY\`

# 1. BTC ETF net inflow
curl -s -H "api-key: $BLOCKBEATS_API_KEY" \\
  "http://127.0.0.1:${upstream.address().port}/v1/data/btc_etf"

### Data Endpoints
BTC ETF net inflow \`GET /v1/data/btc_etf\` none
Top 10 on-chain net inflow \`GET /v1/data/top10_netflow\` \`network=solana/base/ethereum\`
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/blockbeats-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.equal(discovered.provider.provider_name, "BlockBeats");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/v1/data/btc_etf"));
    const netflow = discovered.drafts.find((draft) => draft.path === "/v1/data/top10_netflow");
    assert.equal(netflow.auth_header, "api-key");
    assert.equal(netflow.sample_request.network, "solana");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports loose endpoint references from a Skill document", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/loose-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# Loose Market Skill

Base URL: http://127.0.0.1:${upstream.address().port}
Auth: Header x-api-key: $MARKET_API_KEY

## Available data calls

Name: Exchange overview
Endpoint: GET /api/market/exchanges

The ticker endpoint is also available at http://127.0.0.1:${upstream.address().port}/api/market/ticker?symbol=BTC
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: [{ symbol: "BTC", price: 1 }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/loose-skill`,
      default_price: "0.01",
      secret_value: "market_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/api/market/exchanges"));
    const ticker = discovered.drafts.find((draft) => draft.path === "/api/market/ticker");
    assert.equal(ticker.sample_request.symbol, "BTC");
    assert.equal(ticker.auth_header, "x-api-key");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports ClawHub-style HTML embedded Skill readme", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/clawhub-skill") {
      const readme = `---\r\nname: blockbeats-skill\r\n---\r\n\r\n# BlockBeats API Skill\r\n\r\n**Base URL**: \`http://127.0.0.1:${upstream.address().port}\`\r\n**Auth**: All requests require Header \`api-key: $BLOCKBEATS_API_KEY\`\r\n\r\n### Data Endpoints\r\n\r\n| Endpoint | URL | Key Parameters |\r\n|----------|-----|----------------|\r\n| BTC ETF net inflow | \`GET /v1/data/btc_etf\` | none |\r\n| Top 10 on-chain net inflow | \`GET /v1/data/top10_netflow\` | \`network=solana/base/ethereum\` |\r\n`;
      const escaped = readme
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/</g, "\\x3C");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><script>window.__SSR={readme:"${escaped}",ssr:!0}</script></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/clawhub-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/v1/data/btc_etf"));
    const netflow = discovered.drafts.find((draft) => draft.path === "/v1/data/top10_netflow");
    assert.equal(netflow.auth_header, "api-key");
    assert.equal(netflow.sample_request.network, "solana");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio normalizes endpoint-aware Skill titles and tags", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/blockbeats-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# BlockBeats API Skill

Base URL: \`http://127.0.0.1:${upstream.address().port}\`
Auth: Header \`api-key: $BLOCKBEATS_API_KEY\`

### Data Endpoints

| Endpoint | URL | Key Parameters |
|----------|-----|----------------|
| All articles | \`GET /v1/article\` | none |
| All articles | \`GET /v1/article/24h\` | none |
| up to 50) | \`GET /v1/article/important\` | none |
| Original | \`GET /v1/newsflash/onchain\` | none |
| (no pagination) | \`GET /v1/newsflash/original\` | none |
| Request example (AI newsflash) | \`GET /v1/newsflash/ai\` | \`page=1\` |
| Triggers : search [keyword], find [keyword], [keyword] news, what&#x27;s happening with [keyword] | \`GET /v1/search\` | \`name=BTC\` |
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/blockbeats-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    const byPath = Object.fromEntries(discovered.drafts.map((draft) => [draft.path, draft]));
    assert.equal(byPath["/v1/article"].title, "All articles");
    assert.equal(byPath["/v1/article/24h"].title, "Articles from last 24h");
    assert.equal(byPath["/v1/article/important"].title, "Important articles");
    assert.equal(byPath["/v1/newsflash/onchain"].title, "On-chain newsflashes");
    assert.equal(byPath["/v1/newsflash/original"].title, "Original newsflashes");
    assert.equal(byPath["/v1/newsflash/ai"].title, "AI newsflashes");
    assert.equal(byPath["/v1/search"].title, "Search articles and news");
    assert.ok(byPath["/v1/article/important"].capabilities.includes("article_data"));
    assert.ok(byPath["/v1/newsflash/onchain"].capabilities.includes("news_data"));
    assert.ok(byPath["/v1/newsflash/onchain"].capabilities.includes("onchain_data"));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio explains CLI-only Skill documents instead of treating them as HTTP APIs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/cli-data-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`---
name: market-data-cli
allowed-tools: Bash(marketdata:*)
---

# Market Data

All commands: \`marketdata research flows <sub> [options]\`

\`\`\`bash
marketdata research flows netflow --chain solana --limit 10
marketdata research flows holdings --chain solana --limit 10
\`\`\`
`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    await assert.rejects(
      discoverApiServices({
        api_url: `${baseUrl}/cli-data-skill`,
        default_price: "0.01",
        secret_value: "provider_test_key"
      }, baseUrl),
      (error) => {
        assert.equal(error.statusCode, 422);
        assert.equal(error.code, "CLI_SKILL_NOT_HTTP_API");
        assert.match(error.message, /CLI-based Skill/);
        assert.ok(error.validation.detected_cli_commands.some((command) => command.includes("marketdata research flows")));
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports generic API docs overview into POST API drafts", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <a href="/api/market/netflows">Netflows</a>
        <a href="/api/market/holdings">Holdings</a>
        <a href="/api/changelog">Changelog</a>
      `);
      return;
    }
    if (req.url === "/api/market/netflows") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Netflows</h1>
        <p>Get aggregated token flow analysis.</p>
        <p>post</p>
        <p>https://api.example.com/api/v1/market/netflow</p>
        <p>Authorizations</p><p>ApiKeyAuth</p><p>apiKey string Required</p>
        <pre>POST /api/v1/market/netflow HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{
  "chains": ["ethereum", "solana"],
  "pagination": {"page": 1, "per_page": 10},
  "order_by": [{"field": "net_flow_24h_usd", "direction": "DESC"}]
}</pre>
        <pre>{
  "data": [{"token_symbol": "ETH", "net_flow_24h_usd": 1}],
  "pagination": {"page": 1, "per_page": 10, "is_last_page": true}
}</pre>
      </main>`);
      return;
    }
    if (req.url === "/api/market/holdings") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Holdings</h1>
        <p>https://api.example.com/api/v1/market/holdings</p>
        <pre>POST /api/v1/market/holdings HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{
  "chains": ["ethereum"],
  "pagination": {"page": 1, "per_page": 10}
}</pre>
        <pre>{"data":[{"token_symbol":"ETH","value_usd":1}]}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data",
      secret_value: "provider_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "api_docs");
    assert.equal(discovered.provider.provider_name, "Example Data");
    assert.equal(discovered.api_url, "https://api.example.com");
    assert.equal(discovered.docs.auth_header, "apiKey");
    assert.equal(discovered.drafts.length, 2);
    const netflow = discovered.drafts.find((draft) => draft.path === "/api/v1/market/netflow");
    assert.equal(netflow.method, "POST");
    assert.equal(netflow.auth_header, "apiKey");
    assert.equal(netflow.upstream_url, "https://api.example.com/api/v1/market/netflow");
    assert.deepEqual(netflow.sample_request.chains, ["ethereum", "solana"]);
    assert.equal(netflow.preview_data.data[0].token_symbol, "ETH");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio decodes encoded path templates from API docs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <a href="/api/points-leaderboard/%7Baddress%7D">Points Leaderboard</a>
      `);
      return;
    }
    if (req.url === "/api/points-leaderboard/%7Baddress%7D") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Points Leaderboard</h1>
        <p>https://api.example.com/api/points-leaderboard/%7Baddress%7D</p>
        <pre>GET /api/points-leaderboard/%7Baddress%7D HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY</pre>
        <pre>{"data":[{"rank":1,"points":100}]}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 1);
    const draft = discovered.drafts[0];
    assert.equal(draft.title, "Points Leaderboard");
    assert.equal(draft.path, "/api/points-leaderboard/{address}");
    assert.equal(draft.upstream_url, "https://api.example.com/api/points-leaderboard/{address}");
    assert.equal(draft.sample_request.address, "0x0000000000000000000000000000000000000000");
    assert.equal(draft.service_id.includes("7baddress"), false);
    assert.equal(draft.summary.includes("%7B"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio generates routing-rich endpoint summaries and tags", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/api/v1/tgm/transfers": {
            post: {
              summary: "Get Token God Mode transfers data",
              description: "Returns token transfer activity for a token address, chain, date range, filters, and pagination.",
              security: [{ apiKey: [] }],
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        token_address: { type: "string" },
                        date: { type: "string" },
                        pagination: { type: "object" },
                        filters: { type: "object" },
                        order_by: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: {
                200: {
                  content: {
                    "application/json": {
                      example: {
                        data: [{ wallet_address: "0xabc", amount: "1.2", tx_hash: "0x123" }],
                        pagination: { page: 1, per_page: 10 }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        components: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "apiKey" }
          }
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    const draft = discovered.drafts[0];
    assert.match(draft.summary, /Endpoint: POST \/api\/v1\/tgm\/transfers/);
    assert.match(draft.summary, /Inputs: chain, token_address, date, pagination, filters, order_by/);
    assert.match(draft.summary, /Returns JSON fields such as data/);
    assert.match(draft.summary, /Routing keywords:/);
    assert.deepEqual(draft.data_contract.request_data.fields, ["chain", "token_address", "date", "pagination", "filters", "order_by"]);
    assert.equal(draft.data_contract.request_data.example.token_address, "0x0000000000000000000000000000000000000000");
    assert.ok(draft.data_contract.response_data.fields.includes("data.wallet_address"));
    assert.equal(draft.data_contract.response_data.preview.data[0].tx_hash, "0x123");
    assert.equal(draft.data_contract.pre_call_context.buyer_requirements.needs_buyer_api_key, false);
    assert.match(draft.data_contract.pre_call_context.validation_hint, /JSON/);
    assert.ok(draft.capabilities.includes("token_god_mode"));
    assert.ok(draft.capabilities.includes("token_transfers"));
    assert.ok(draft.capabilities.includes("wallet_activity"));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio preserves text around angle brackets in HTML docs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><a href="/api/research-fast">Research Fast</a>`);
      return;
    }
    if (req.url === "/api/research-fast") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Interact with the Nan<span>s</span>en Research Agent in "fa<span>s</span>t" mode</h1>
        <p>https://api.example.com/api/v1/agent/fast</p>
        <p>A<span>s</span>k the Nan<span>s</span>en AI agent a research question and receive a stream<span>ed</span> an<span>s</span>wer backed by on-chain data. The **fast** variant u<span>s</span>es quick mode.</p>
        <p>Use text like value < string and ask a question.</p>
        <pre>POST /api/v1/agent/fast HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{"text":"What are ETH smart money flows?","conversation_id":"abc"}</pre>
        <pre>{"data":{"answer":"example"}}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    const draft = discovered.drafts[0];
    assert.match(draft.summary, /Nansen Research Agent/);
    assert.match(draft.summary, /Ask the Nansen AI agent a research question/);
    assert.equal(draft.summary.includes("Nan en"), false);
    assert.equal(draft.summary.includes("fa t"), false);
    assert.equal(draft.summary.includes("A k"), false);
    assert.equal(draft.summary.includes("stream ed"), false);
    assert.equal(draft.summary.includes("an wer"), false);
    assert.equal(draft.summary.includes("u es"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio uses endpoint-local signals for capabilities", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/api/v1/agent/fast": {
            post: {
              summary: "Interact with the Nansen Research Agent in fast mode",
              description: "Ask a research question and receive an answer backed by on-chain data and token context.",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        conversation_id: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: { answer: "ok" } } } } } }
            }
          },
          "/api/v1/tgm/transfers": {
            post: {
              summary: "Get Token God Mode transfers data",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        token_address: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: [{ tx_hash: "0x1" }] } } } } }
            }
          },
          "/api/v1/smart-money/netflow": {
            post: {
              summary: "Get Smart Money Netflow Data",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        date: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: [{ inflow: 1, outflow: 2 }] } } } } }
            }
          }
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    const agent = discovered.drafts.find((draft) => draft.path === "/api/v1/agent/fast");
    const transfers = discovered.drafts.find((draft) => draft.path === "/api/v1/tgm/transfers");
    const netflow = discovered.drafts.find((draft) => draft.path === "/api/v1/smart-money/netflow");
    assert.ok(agent);
    assert.ok(transfers);
    assert.ok(netflow);
    assert.ok(transfers.capabilities.includes("token_transfers"));
    assert.equal(agent.capabilities.includes("token_transfers"), false);
    assert.ok(netflow.capabilities.includes("smart_money_netflow"));
    assert.equal(netflow.capabilities.includes("etf_data"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio published direct endpoints are immediately routable by validation data", async () => {
  await withServer(async ({ baseUrl }) => {
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: `${baseUrl}/api/v1/data/header-key`,
        default_price: "0.01",
        default_method: "GET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts[0].auth_header, "auto");

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.published[0].service_id, "get_api_v1_data_header_key");

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "Use AgentRouter to query header key sample metric data",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "get_api_v1_data_header_key");
    assert.equal(routed.result.data.rows[0].value, 42);
  });
});

test("AgentRouter refuses to publish unreachable direct endpoint services", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const endpointUrl = `${baseUrl}/api/v1/data/market-flow`;
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: endpointUrl,
        default_price: "0.01",
        secret_value: "provider-owned-secret"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 1);
    assert.ok(discovered.drafts[0].capabilities.includes("data_service"));

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 422);
    const published = await publishResponse.json();
    assert.equal(published.ok, false);
    assert.equal(published.failed[0].service_id, "post_api_v1_data_market_flow");
    assert.equal(published.failed[0].error, "VALIDATION_FAILED");

    const search = searchServices(server.store, { query: "market flow", verifiedOnly: false });
    assert.equal(search.some((service) => service.service_id === "post_api_v1_data_market_flow"), false);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "通过 AgentRouter 查询 ETH 的近 24 小时 netflow",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 422);
    const routed = await askResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "capability_not_available");
    assert.equal(routed.must_not_request_payment_authorization, true);
  });
});

test("Provider Studio surfaces hosted HTTP upstream failures during validation", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_bad_secret_demo",
        provider_id: "provider_studio",
        title: "Studio Bad Secret Demo",
        description_for_agent: "Use this service to verify upstream errors are visible.",
        capabilities: "sentiment_data,hosted_http,demo_data",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
        sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
        summary: "ETH sentiment from Provider Studio.",
        upstream_url: "/mock/upstream/sentiment",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "wrong-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.equal(payload.validation.ok, false);
    assert.ok(payload.validation.schema_errors.length);

    const searchResponse = await fetch(`${baseUrl}/services/search?query=bad%20secret`);
    assert.equal(searchResponse.status, 200);
    const services = await searchResponse.json();
    assert.equal(services.some((service) => service.service_id === "studio_bad_secret_demo"), false);
  });
});

test("Provider runtime reports non-JSON upstream responses clearly", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "html_upstream_demo",
        provider_id: "provider_studio",
        title: "HTML Upstream Demo",
        description_for_agent: "Use this service to verify non JSON upstream errors are visible.",
        capabilities: "html_upstream_demo,data_service",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"ok\":true}",
        summary: "HTML upstream demo.",
        upstream_url: "/mock/upstream/html-error",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.match(JSON.stringify(payload.validation), /UPSTREAM_NON_JSON_RESPONSE/);
  });
});

test("unauthenticated payment challenges never consume hosted upstream quota", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "prepay_validation_sentiment_demo",
        provider_id: "provider_studio",
        title: "Prepay Validation Sentiment Demo",
        description_for_agent: "Use this service to verify payment challenges do not call the credential-backed upstream.",
        capabilities: "sentiment_data,hosted_http,demo_data",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
        sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
        summary: "ETH sentiment from Provider Studio.",
        upstream_url: "/mock/upstream/sentiment",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: "authorization"
      })
    });
    assert.ok([200, 201].includes(studioResponse.status));

    const direct = await fetch(`${baseUrl}/provider/custom/prepay_validation_sentiment_demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "BAD", window: "7d" })
    });
    assert.equal(direct.status, 402);
    const directPayload = await direct.json();
    assert.notEqual(directPayload.error?.code || directPayload.error, "PREPAY_VALIDATION_FAILED");
    assert.equal(directPayload.payment?.service_id, "prepay_validation_sentiment_demo");
    assert.match(directPayload.payment?.nonce || "", /^nonce_/);

    const beforeLog = await readPaymentLog();
    const afterLog = await readPaymentLog();
    assert.equal(afterLog.length, beforeLog.length);
  });
});

test("Arc RPC failures are classified for payment troubleshooting", () => {
  const root = Object.assign(new Error("getaddrinfo ENOTFOUND rpc.testnet.arc.network"), {
    code: "ENOTFOUND",
    hostname: "rpc.testnet.arc.network"
  });
  const wrapped = new Error("fetch failed", { cause: root });
  const classified = classifyArcRpcError(wrapped, {
    stage: "balance_check",
    rpc_url: "https://rpc.testnet.arc.network",
    wallet_address: "0xe3cbf7e987157348616024f9e9a438bab73a23e4"
  });

  assert.equal(classified.status, "arc_payment_unavailable");
  assert.equal(classified.code, "ARC_RPC_DNS_FAILED");
  assert.equal(classified.retryable, true);
  assert.equal(classified.arc_rpc.stage, "balance_check");
  assert.equal(classified.arc_rpc.hostname, "rpc.testnet.arc.network");
  assert.equal(classified.arc_rpc.wallet_address, "0xe3cbf7e987157348616024f9e9a438bab73a23e4");
});

test("Provider Studio rejects JSON application-level upstream errors", async () => {
  await resetWalletForTests();
  await withServer(async ({ server, baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "application_error_demo",
        provider_id: "provider_studio",
        title: "Application Error Demo",
        description_for_agent: "Use this service to verify JSON application errors are not publishable.",
        capabilities: "application_error_demo,data_service",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"ok\":true}",
        summary: "Application error demo.",
        upstream_url: "/mock/upstream/app-error",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.match(JSON.stringify(payload.validation), /UPSTREAM_APPLICATION_ERROR/);
    assert.equal(payload.validation.provider_error.code, "UPSTREAM_ERROR");
    const search = searchServices(server.store, { query: "application error demo", verifiedOnly: false });
    assert.equal(search.some((service) => service.service_id === "application_error_demo"), false);
  });
});

test("provider configs can be reloaded into a fresh registry after restart", async () => {
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--mode", "hosted-http", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);

    const freshServer = createServer();
    await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
    const freshBaseUrl = `http://127.0.0.1:${freshServer.address().port}`;
    try {
      await loadProviderConfigs(freshServer.store, freshBaseUrl, { validate: false });
      const record = freshServer.store.services.get("hosted_http_sentiment_demo");
      assert.ok(record);
      assert.equal(record.manifest.title, "Hosted HTTP Sentiment Demo");
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });
});

test("provider config reload skips a duplicate persisted source without breaking service discovery", async () => {
  const firstId = "duplicate_source_reload_one";
  const secondId = "duplicate_source_reload_two";
  const baseUrl = "http://127.0.0.1:8799";
  const makeConfig = (serviceId) => createHostedHttpProviderConfig({
    baseUrl,
    serviceId,
    providerId: "duplicate_source_reload_provider",
    title: "Duplicate source reload",
    description: "Reload safety test.",
    capabilities: ["data_service"],
    price: "0.01",
    sampleRequest: {},
    sampleData: {},
    upstreamUrl: "https://example.com/identical-source",
    upstreamMethod: "GET",
    summary: "Reload safety test."
  });
  await writeProviderConfig(makeConfig(firstId));
  await writeProviderConfig(makeConfig(secondId));
  try {
    const store = createMemoryStore();
    const loaded = await loadProviderConfigs(store, baseUrl, { validate: false });
    assert.equal(store.services.has(firstId) || store.services.has(secondId), true);
    assert.equal(loaded.some((entry) => entry.duplicate_source === true), true);
  } finally {
    await deleteProviderConfig(firstId);
    await deleteProviderConfig(secondId);
  }
});

test("failed provider configs are not persisted or loaded after failed registration", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "failed_reload_demo",
        provider_id: "provider_studio",
        title: "Failed Reload Demo",
        description_for_agent: "Use this service to verify failed configs are not persisted.",
        capabilities: "reload_failure_demo,data_service",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\"}",
        sample_data: "{\"asset\":\"ETH\",\"sample\":true}",
        summary: "Failed reload demo.",
        upstream_url: "/missing/upstream",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    await assert.rejects(
      fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "failed_reload_demo.json"), "utf8")
    );

    const freshServer = createServer();
    await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
    const freshBaseUrl = `http://127.0.0.1:${freshServer.address().port}`;
    try {
      await loadProviderConfigs(freshServer.store, freshBaseUrl, { validate: true });
      assert.equal(freshServer.store.services.has("failed_reload_demo"), false);
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });
});

test("CLI wallet signs local payment automatically within policy", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const init = await runCli(["wallet", "init"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(init.code, 0, init.stderr);
    const wallet = JSON.parse(init.stdout);
    assert.match(wallet.address, /^0x[0-9a-f]{40}$/);
    const walletFile = await fs.readFile(path.join(process.env.ADN_DIR, "wallet.json"), "utf8");
    assert.equal(walletFile.includes("private_key_pem"), false);
    assert.equal(walletFile.includes("encrypted_private_key"), true);
    const unlockedWallet = await readWallet();
    assert.match(unlockedWallet.private_key_hex, /^0x[0-9a-f]{64}$/);

    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const payload = JSON.parse(invoke.stdout);
    assert.equal(payload.result.status, "success");
    assert.equal(payload.local_payment.status, "success");
    assert.equal(payload.local_payment.amount, "0.01");
    assert.equal(payload.local_payment.currency, "USDC");

    const log = await readPaymentLog();
    assert.ok(log.length >= 1);
    assert.equal(log.at(-1).service_id, "chain_fund_flow_7d_base");
  });
});

test("CLI route resolves service and pays with local wallet", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runCli(["route", "BTC 当前最大爆仓痛点是多少", "--max-price", "0.05", "--freshness", "300"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "route_with_assumption");
    assert.equal(payload.execution_status, "paid_with_local_wallet");
    assert.equal(payload.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(payload.local_payment.status, "success");
    assert.equal(payload.local_payment.amount, "0.02");
    assert.equal(payload.verification.schema_valid, true);
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("agent-router ask uses local wallet instead of quote-only path when wallet is present", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runAgentRouterCli(["ask", "BTC 当前最大爆仓痛点是多少"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "route_with_assumption");
    assert.equal(payload.execution_status, "paid_with_local_wallet");
    assert.equal(payload.local_payment.status, "success");
    assert.notEqual(payload.protocol?.invocation_policy, "quote_only_no_server_side_payment");
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("agent-router fetch is the single-call paid CLI fallback for natural-language tasks", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runAgentRouterCli(["fetch", "BTC 当前最大爆仓痛点是多少"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    assert.doesNotMatch(routed.stdout, /btc_liquidation_max_pain_demo/);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "route_with_assumption");
    assert.equal(payload.execution_status, "paid_with_local_wallet");
    assert.equal(payload.data_returned, true);
    assert.equal(payload.result.status, "success");
    assert.ok(payload.result.data.max_liquidation_pain_price || payload.result.data.max_pain_price);
    assert.equal(payload.service_match.matched, true);
    assert.equal(payload.local_payment, undefined);
    assert.equal(payload.presentation_policy.hide_provider_details, true);
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("agent-router fetch accepts structured data requirements without manual preview or invoke", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const payload = {
      task: "BTC liquidation max pain",
      data_requirements: [
        {
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          }
        }
      ],
      constraints: {
        max_price_usdc: "0.05"
      }
    };
    const routed = await runAgentRouterCli(["fetch", JSON.stringify(payload), "--local-wallet"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    assert.doesNotMatch(routed.stdout, /btc_liquidation_max_pain_demo/);
    const result = JSON.parse(routed.stdout);
    assert.equal(result.status, "data_returned");
    assert.equal(result.protocol.protocol_version, "agentrouter_fetch_v1");
    assert.equal(result.protocol.external_contract, "single_agent_data_call");
    assert.equal(result.data_requirements_count, 1);
    assert.equal(result.data_returned_count, 1);
    assert.equal(result.results[0].status, "paid_with_local_wallet");
    assert.equal(result.results[0].data_returned, true);
    assert.equal(result.results[0].local_payment, undefined);
    assert.equal(result.presentation_policy.hide_provider_details, true);
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("agent-router request --local-wallet pays structured requests with the local wallet", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const request = {
      capability: "perp_liquidation_max_pain",
      params: {
        asset: "BTC",
        market_type: "perpetual_futures",
        window: "current"
      },
      constraints: {
        max_price_usdc: "0.05"
      }
    };
    const routed = await runAgentRouterCli(["request", JSON.stringify(request), "--local-wallet"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "paid_with_local_wallet");
    assert.equal(payload.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(payload.local_payment.status, "success");
    assert.equal(payload.local_payment.amount, "0.02");
    assert.equal(payload.data_returned, true);
    assert.equal(payload.verification.schema_valid, true);
    assert.equal(payload.evidence_recording.feedback.billing_status, "charged_success");
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("agent-router ask does not silently fall back to quote-only when local payment is not ready", async () => {
  await resetWalletForTests();
  const emptyAdnDir = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-empty-adn-"));
  await withServer(async ({ baseUrl }) => {
    const routed = await runAgentRouterCli(["ask", "BTC 当前最大爆仓痛点是多少"], {
      ADN_REGISTRY_URL: baseUrl,
      ADN_DIR: emptyAdnDir
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "local_payment_not_ready");
    assert.equal(payload.data_returned, false);
    assert.equal(payload.repair_command, "curl -fsSL https://agentrouter.network/update.sh | bash");

    const quoteOnly = await runAgentRouterCli(["ask", "--quote-only", "BTC 当前最大爆仓痛点是多少"], {
      ADN_REGISTRY_URL: baseUrl,
      ADN_DIR: emptyAdnDir
    });
    assert.equal(quoteOnly.code, 0, quoteOnly.stderr);
    const quoteOnlyPayload = JSON.parse(quoteOnly.stdout);
    assert.notEqual(quoteOnlyPayload.status, "local_payment_not_ready");
    assert.equal(quoteOnlyPayload.local_payment, undefined);
  });
});

test("CLI route returns clarification before payment for unclear max pain task", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runCli(["route", "BTC 最大痛点是多少", "--max-price", "0.05", "--freshness", "300"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "needs_clarification");
    assert.ok(Array.isArray(payload.ambiguities), JSON.stringify(payload, null, 2));
    assert.equal(payload.ambiguities[0].field, "capability");
    const log = await readPaymentLog();
    assert.equal(log.filter((event) => event.consumer_id === "cli").length, 0);
  });
});

test("CLI invoke can use the local session wallet without exporting a passphrase", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(
      ["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"],
      { ADN_REGISTRY_URL: baseUrl, ADN_WALLET_PASSPHRASE: "" }
    );
    assert.equal(invoke.code, 0, invoke.stderr);
    const payload = JSON.parse(invoke.stdout);
    assert.equal(payload.local_payment.status, "success");
  });
});

test("CLI wallet policy blocks payment above per-call limit", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    await runCli(["wallet", "policy", "set", "--per-call", "0.001"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 1);
    assert.match(invoke.stderr, /exceeds per-call policy limit/);
  });
});

test("CLI wallet lock disables automatic signing", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    await runCli(["wallet", "lock"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 1);
    assert.match(invoke.stderr, /Wallet policy is disabled/);
  });
});

test("provider rejects replayed wallet payment challenge", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const wallet = await readWallet();
    const firstResponse = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(firstResponse.status, 402);
    const challenge = await firstResponse.json();
    const tx = await sendArcUsdcTransfer({
      wallet,
      payment: challenge.payment
    });
    const proof = createArcPaymentProof({
      wallet,
      serviceId: "chain_fund_flow_7d_base",
      amount: challenge.payment.amount,
      currency: challenge.payment.asset,
      network: challenge.payment.network,
      payTo: challenge.payment.pay_to,
      challenge: challenge.payment,
      tx
    });

    const paidOnce = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidOnce.status, 200);
    const paidTwice = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidTwice.status, 402);
    const body = await paidTwice.json();
    assert.equal(body.code, "UNKNOWN_OR_REPLAYED_PAYMENT_CHALLENGE");
  });
});

test("provider rejects a second challenge settled by an already-used on-chain tx", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const wallet = await readWallet();
    const issue = async () => {
      const response = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: "base", days: 7 })
      });
      assert.equal(response.status, 402);
      return (await response.json()).payment;
    };
    const challengeA = await issue();
    const challengeB = await issue();
    const tx = await sendArcUsdcTransfer({ wallet, payment: challengeA });
    const proofFor = (challenge) => createArcPaymentProof({
      wallet,
      serviceId: "chain_fund_flow_7d_base",
      amount: challenge.amount,
      currency: challenge.asset,
      network: challenge.network,
      payTo: challenge.pay_to,
      challenge,
      tx
    });

    const paidA = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proofFor(challengeA) },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidA.status, 200);

    const paidB = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proofFor(challengeB) },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidB.status, 402);
    assert.equal((await paidB.json()).code, "ARC_TX_ALREADY_SETTLED");
  });
});

test("circle_arc backend verifies x402-style Arc USDC payment before returning provider data", async () => {
  await resetWalletForTests();
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousProviderReceive = process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
  const previousTransferMode = process.env.ADN_ARC_TRANSFER_MODE;
  const previousVerifyMode = process.env.ADN_ARC_VERIFY_MODE;
  const previousBalanceMock = process.env.ADN_ARC_BALANCE_MOCK;
  process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.ADN_ARC_TRANSFER_MODE = "mock";
  process.env.ADN_ARC_VERIFY_MODE = "mock";
  process.env.ADN_ARC_BALANCE_MOCK = "1";
  try {
    await withServer(async ({ baseUrl }) => {
      process.env.ADN_PAYMENT_BACKEND = "circle_arc";
      await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
      const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
        ADN_REGISTRY_URL: baseUrl,
        ADN_PAYMENT_BACKEND: "circle_arc",
        ADN_ARC_TRANSFER_MODE: "mock",
        ADN_ARC_VERIFY_MODE: "mock"
      });
      assert.equal(invoke.code, 0, invoke.stderr);
      const payload = JSON.parse(invoke.stdout);
      assert.equal(payload.result.status, "success");
      assert.equal(payload.local_payment.backend, "circle_arc");
      assert.equal(payload.local_payment.network, "arc-testnet");
      assert.equal(payload.local_payment.pay_to, "0x1111111111111111111111111111111111111111");
      assert.match(payload.local_payment.payment_tx, /^0x[0-9a-f]{64}$/);
      assert.match(payload.local_payment.event_hash, /^0x[0-9a-f]{64}$/);
      assert.equal(payload.feedback.settlement_receipt.payment_backend, "circle_arc");
      assert.equal(payload.feedback.settlement_receipt.chain_id, 5042002);
      assert.equal(payload.feedback.settlement_receipt.settlement_model, "direct_provider_wallet");
      assert.match(payload.feedback.feedback_hash, /^0x[0-9a-f]{64}$/);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
    if (previousProviderReceive === undefined) delete process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
    else process.env.ADN_PROVIDER_RECEIVE_ADDRESS = previousProviderReceive;
    if (previousTransferMode === undefined) delete process.env.ADN_ARC_TRANSFER_MODE;
    else process.env.ADN_ARC_TRANSFER_MODE = previousTransferMode;
    if (previousVerifyMode === undefined) delete process.env.ADN_ARC_VERIFY_MODE;
    else process.env.ADN_ARC_VERIFY_MODE = previousVerifyMode;
    if (previousBalanceMock === undefined) delete process.env.ADN_ARC_BALANCE_MOCK;
    else process.env.ADN_ARC_BALANCE_MOCK = previousBalanceMock;
  }
});

test("circle_arc local wallet returns funding guidance before payment when USDC balance is too low", async () => {
  await resetWalletForTests();
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousProviderReceive = process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
  const previousTransferMode = process.env.ADN_ARC_TRANSFER_MODE;
  const previousVerifyMode = process.env.ADN_ARC_VERIFY_MODE;
  const previousBalanceMock = process.env.ADN_ARC_BALANCE_MOCK;
  process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.ADN_ARC_TRANSFER_MODE = "mock";
  process.env.ADN_ARC_VERIFY_MODE = "mock";
  process.env.ADN_ARC_BALANCE_MOCK = "1000";
  try {
    await withServer(async ({ baseUrl }) => {
      process.env.ADN_PAYMENT_BACKEND = "circle_arc";
      process.env.ADN_ARC_BALANCE_MOCK = "0";
      await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
      const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
        ADN_REGISTRY_URL: baseUrl,
        ADN_PAYMENT_BACKEND: "circle_arc",
        ADN_ARC_TRANSFER_MODE: "mock",
        ADN_ARC_VERIFY_MODE: "mock",
        ADN_ARC_BALANCE_MOCK: "0"
      });
      assert.notEqual(invoke.code, 0);
      assert.match(invoke.stderr, /Arc Testnet USDC balance is 0/);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
    if (previousProviderReceive === undefined) delete process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
    else process.env.ADN_PROVIDER_RECEIVE_ADDRESS = previousProviderReceive;
    if (previousTransferMode === undefined) delete process.env.ADN_ARC_TRANSFER_MODE;
    else process.env.ADN_ARC_TRANSFER_MODE = previousTransferMode;
    if (previousVerifyMode === undefined) delete process.env.ADN_ARC_VERIFY_MODE;
    else process.env.ADN_ARC_VERIFY_MODE = previousVerifyMode;
    if (previousBalanceMock === undefined) delete process.env.ADN_ARC_BALANCE_MOCK;
    else process.env.ADN_ARC_BALANCE_MOCK = previousBalanceMock;
  }
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/adn.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ADN_WALLET_PASSPHRASE: "test-passphrase", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runAgentRouterCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/agent-router.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ADN_WALLET_PASSPHRASE: "test-passphrase", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function createMcpClient(env = {}, serverPath = "bin/agent-router-mcp.js") {
  const child = spawn(process.execPath, [path.join(process.cwd(), serverPath)], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const message of readMcpMessages()) {
      const callbacks = pending.get(message.id);
      if (!callbacks) continue;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    }
  });

  child.stderr.on("data", (chunk) => {
    if (!pending.size) return;
    const error = new Error(chunk.toString("utf8"));
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });

  child.on("exit", (code) => {
    if (!pending.size) return;
    const error = new Error(`MCP server exited with code ${code}`);
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });

  function readMcpMessages() {
    const messages = [];
    while (buffer.length) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      const lineEnd = buffer.indexOf("\n");
      // Newline-delimited JSON (MCP stdio) — no Content-Length header first.
      if (headerEnd === -1 || (lineEnd !== -1 && lineEnd < headerEnd)) {
        if (lineEnd === -1) break;
        const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
        buffer = buffer.subarray(lineEnd + 1);
        if (line) messages.push(JSON.parse(line));
        continue;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) throw new Error("Missing Content-Length header");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) break;
      messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
      buffer = buffer.subarray(bodyEnd);
    }
    return messages;
  }

  return {
    request(method, params) {
      const id = nextId++;
      const message = { jsonrpc: "2.0", id, method, params };
      const body = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      child.kill();
    }
  };
}

test("public agentrouter installer configures Codex through its TOML config", async () => {
  await withServer(async ({ baseUrl }) => {
    const { installAgentRouter } = await import("../packages/agentrouter-installer/server/index.js");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-codex-"));
    const configPath = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, [
      'model = "gpt-5.6-sol"',
      "",
      "[mcp_servers.node_repl]",
      'command = "/usr/bin/node_repl"',
      "",
      "[mcp_servers.AgentRouter]",
      'command = "npx"',
      'args = ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"]',
      "",
      "[mcp_servers.AgentRouter.env]",
      'AGENT_ROUTER_URL = "https://agentrouter.network"',
      'MY_CUSTOM = "keep-me"',
      "",
      '[projects."/x"]',
      'trust_level = "trusted"',
      ""
    ].join("\n"));

    const result = await installAgentRouter({
      home,
      client: "codex",
      agentRouterUrl: baseUrl,
      env: { AGENTROUTER_SKIP_BROWSER_SETUP: "1" },
      skillDirs: path.join(home, "skills")
    });
    assert.deepEqual(result.configured_clients.map((client) => client.name), ["Codex"]);
    assert.equal(result.setup_action, "updated");
    assert.equal(result.reload_required, true);

    const written = await fs.readFile(configPath, "utf8");
    // The stale github bridge is replaced by the published package...
    assert.match(written, /\[mcp_servers\.AgentRouter\]/);
    assert.match(written, /@agentrouternetwork\/mcp@latest.*agentrouter-mcp/);
    assert.equal(written.includes("github:connectwilson"), false);
    assert.equal(written.includes("agent-router-mcp\"]"), false);
    // ...custom env is preserved, and unrelated tables survive untouched.
    assert.match(written, /MY_CUSTOM = "keep-me"/);
    assert.match(written, /\[mcp_servers\.node_repl\]/);
    assert.match(written, /\[projects\."\/x"\]/);
    // Exactly one AgentRouter table, not a duplicate appended each run.
    assert.equal((written.match(/^\[mcp_servers\.AgentRouter\]$/gm) || []).length, 1);

    // Re-running must stay idempotent rather than stacking blocks.
    const repeated = await installAgentRouter({
      home, client: "codex", agentRouterUrl: baseUrl,
      env: { AGENTROUTER_SKIP_BROWSER_SETUP: "1" }, skillDirs: path.join(home, "skills")
    });
    assert.equal(repeated.setup_action, "already_configured");
    assert.equal(repeated.reload_required, false);
    assert.equal(repeated.configured_clients[0].changed, false);
    const again = await fs.readFile(configPath, "utf8");
    assert.equal((again.match(/^\[mcp_servers\.AgentRouter\]$/gm) || []).length, 1);
    assert.equal((again.match(/^\[mcp_servers\.node_repl\]$/gm) || []).length, 1);
  });
});

test("installer detects Codex as the invoking client", async () => {
  const { parseInstallArgs } = await import("../packages/agentrouter-installer/server/index.js");
  assert.equal(parseInstallArgs(["--client", "codex"]).client, "codex");
});

test("installer configures Windsurf, Gemini, opencode, and any client via --config-path", async () => {
  await withServer(async ({ baseUrl }) => {
    const { installAgentRouter } = await import("../packages/agentrouter-installer/server/index.js");
    const base = { agentRouterUrl: baseUrl, env: { AGENTROUTER_SKIP_BROWSER_SETUP: "1" } };
    const expectedArgs = ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"];

    // Windsurf and Gemini use the standard mcpServers shape at their own paths.
    for (const [client, name, rel] of [
      ["windsurf", "Windsurf", [".codeium", "windsurf", "mcp_config.json"]],
      ["gemini", "Gemini CLI", [".gemini", "settings.json"]]
    ]) {
      const home = await fs.mkdtemp(path.join(runtimeRoot, `agentrouter-${client}-`));
      const result = await installAgentRouter({ ...base, home, client, skillDirs: path.join(home, "skills") });
      assert.deepEqual(result.configured_clients.map((entry) => entry.name), [name]);
      const config = JSON.parse(await fs.readFile(path.join(home, ...rel), "utf8"));
      assert.deepEqual(config.mcpServers.AgentRouter.args, expectedArgs);
      assert.equal(config.mcpServers.AgentRouter.env.AGENT_ROUTER_URL, baseUrl);
    }

    // opencode stores servers under "mcp" with argv as one array and
    // "environment" instead of "env" — the standard writer would be wrong.
    const opencodeHome = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-opencode-"));
    const opencodePath = path.join(opencodeHome, ".config", "opencode", "opencode.json");
    await fs.mkdir(path.dirname(opencodePath), { recursive: true });
    await fs.writeFile(opencodePath, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      mcp: { other: { type: "local", command: ["other"] } }
    }));
    await installAgentRouter({ ...base, home: opencodeHome, client: "opencode", skillDirs: path.join(opencodeHome, "skills") });
    const opencodeConfig = JSON.parse(await fs.readFile(opencodePath, "utf8"));
    assert.deepEqual(opencodeConfig.mcp.AgentRouter.command, ["npx", ...expectedArgs]);
    assert.equal(opencodeConfig.mcp.AgentRouter.type, "local");
    assert.equal(opencodeConfig.mcp.AgentRouter.enabled, true);
    assert.equal(opencodeConfig.mcp.AgentRouter.environment.AGENT_ROUTER_URL, baseUrl);
    // Unrelated settings and servers survive.
    assert.equal(opencodeConfig.theme, "dark");
    assert.deepEqual(opencodeConfig.mcp.other.command, ["other"]);

    // Any other client can be pointed at explicitly instead of being guessed.
    const customHome = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-custom-"));
    const customPath = path.join(customHome, "myagent.json");
    const custom = await installAgentRouter({
      ...base, home: customHome, client: "MyAgent", configPath: customPath, skillDirs: path.join(customHome, "skills")
    });
    assert.deepEqual(custom.configured_clients.map((entry) => entry.name), ["MyAgent"]);
    assert.deepEqual(JSON.parse(await fs.readFile(customPath, "utf8")).mcpServers.AgentRouter.args, expectedArgs);
  });
});

test("installer configures OpenClaw under its nested mcp.servers key", async () => {
  await withServer(async ({ baseUrl }) => {
    const { installAgentRouter } = await import("../packages/agentrouter-installer/server/index.js");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-openclaw-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    // OpenClaw keeps plugin and tool settings in the same file.
    await fs.writeFile(configPath, JSON.stringify({
      plugins: { enabled: true, allow: ["agent-wallet"] },
      tools: { alsoAllow: ["get_btc_fee_rates"] },
      mcp: { servers: { other: { command: "other" } } }
    }));

    const result = await installAgentRouter({
      home, client: "openclaw", agentRouterUrl: baseUrl,
      env: { AGENTROUTER_SKIP_BROWSER_SETUP: "1" }, skillDirs: path.join(home, "skills")
    });
    assert.deepEqual(result.configured_clients.map((entry) => entry.name), ["OpenClaw"]);

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    // Servers nest under mcp.servers, not a top-level mcpServers block.
    assert.equal(config.mcpServers, undefined);
    assert.deepEqual(config.mcp.servers.AgentRouter.args, ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]);
    assert.equal(config.mcp.servers.AgentRouter.env.AGENT_ROUTER_URL, baseUrl);
    // Unrelated plugin/tool settings and other servers survive.
    assert.deepEqual(config.plugins, { enabled: true, allow: ["agent-wallet"] });
    assert.deepEqual(config.tools, { alsoAllow: ["get_btc_fee_rates"] });
    assert.deepEqual(config.mcp.servers.other, { command: "other" });
  });
});

test("installer configures WorkBuddy without disturbing its connector proxy", async () => {
  await withServer(async ({ baseUrl }) => {
    const { installAgentRouter } = await import("../packages/agentrouter-installer/server/index.js");
    const home = await fs.mkdtemp(path.join(runtimeRoot, "agentrouter-workbuddy-"));
    // WorkBuddy uses a standard mcpServers block, but in a dotfile.
    const configPath = path.join(home, ".workbuddy", ".mcp.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        "connector-proxy": { type: "http", url: "http://127.0.0.1:50684/mcp", description: "Aggregated proxy" }
      }
    }));

    const result = await installAgentRouter({
      home, client: "workbuddy", agentRouterUrl: baseUrl,
      env: { AGENTROUTER_SKIP_BROWSER_SETUP: "1" }, skillDirs: path.join(home, "skills")
    });
    assert.deepEqual(result.configured_clients.map((entry) => entry.name), ["WorkBuddy"]);
    assert.equal(result.configured_clients[0].config_path, configPath);

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(config.mcpServers.AgentRouter.args, ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"]);
    assert.equal(config.mcpServers.AgentRouter.env.AGENT_ROUTER_URL, baseUrl);
    assert.equal(config.mcpServers["connector-proxy"].url, "http://127.0.0.1:50684/mcp");
  });
});

test("Apify actor provider source runs through the normal paid flow", async () => {
  const { executeApifyActor } = await import("../src/provider-runtime.js");
  const { finalizeProviderConfig, writeProviderConfig, readProviderConfig } = await import("../src/provider-config.js");

  await withServer(async ({ baseUrl }) => {
    process.env.ADN_APIFY_API_BASE = `${baseUrl}/mock/upstream/apify`;
    const source = (over = {}) => ({
      type: "apify_actor",
      actor_id: "apify~google-search-scraper",
      auth: { mode: "apify_token", secret_value: "mock-apify-token" },
      input_template: { resultsPerPage: 10 },
      input_allowlist: ["queries", "maxPagesPerQuery"],
      dataset: { clean: true, max_items: 2, fields: ["title", "url"] },
      summary: "Google SERP via Apify",
      ...over
    });
    const config = (over = {}) => ({ manifest: { service_id: "apify_google_search" }, source: source(over) });

    // Buyer input is filtered to the allowlist and merged over input_template.
    const ok = await executeApifyActor(config(), {
      queries: "agentrouter", maxPagesPerQuery: 1, NOT_ALLOWED: "leak"
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "success");
    assert.equal(ok.body.data.item_count, 2, "dataset.max_items caps the returned items");
    assert.equal(ok.body.data.actor_id, "apify~google-search-scraper");
    assert.deepEqual(ok.body.metadata.data_sources, ["provider_config_apify_actor"]);
    // dataset.fields projects each item down to just those keys.
    assert.deepEqual(Object.keys(ok.body.data.items[0]), ["title", "url"]);

    const unprojected = await executeApifyActor(config({ dataset: { clean: true } }), { queries: "x", NOT_ALLOWED: "leak" });
    const echoed = unprojected.body.data.items[0].echoed_input;
    assert.equal(Object.hasOwn(echoed, "NOT_ALLOWED"), false, "disallowed buyer keys never reach the actor");
    assert.equal(echoed.resultsPerPage, 10, "input_template defaults are merged under buyer input");
    assert.equal(echoed.queries, "x");

    // Error matrix.
    const missing = await executeApifyActor(config({ actor_id: "apify~missing-actor" }), { queries: "x" });
    assert.equal(missing.status, 502);
    assert.equal(missing.body.error.code, "UPSTREAM_ERROR");

    const slow = await executeApifyActor(config({ actor_id: "apify~slow-actor" }), { queries: "x" });
    assert.equal(slow.status, 504);
    assert.equal(slow.body.error.code, "APIFY_RUN_TIMEOUT");
    assert.equal(slow.body.error.retryable, true);

    const badToken = await executeApifyActor(config({ auth: { mode: "apify_token", secret_value: "wrong" } }), { queries: "x" });
    assert.equal(badToken.status, 502);
    assert.equal(badToken.body.error.code, "UPSTREAM_APPLICATION_ERROR");

    // A succeeded-but-empty run stays a success envelope so the existing
    // empty-result verification fires rather than being masked as an error.
    const empty = await executeApifyActor(config({ actor_id: "apify~empty-actor" }), { queries: "x" });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.status, "success");
    assert.deepEqual(empty.body.data.items, []);

    // Async execution is rejected at registration, not at invoke time.
    assert.throws(
      () => finalizeProviderConfig(config({ execution_mode: "async" })),
      (error) => error.code === "APIFY_ASYNC_NOT_SUPPORTED"
    );
    assert.throws(
      () => finalizeProviderConfig(config({ actor_id: "" })),
      (error) => error.code === "APIFY_ACTOR_ID_REQUIRED"
    );

    // Registration stores the token as a secret ref, never in the config.
    const registered = config();
    registered.manifest.service_id = "apify_secret_check";
    await writeProviderConfig(registered);
    const stored = await readProviderConfig("apify_secret_check");
    assert.equal(stored.source.auth.secret_value, undefined, "the raw token must not persist");
    assert.match(stored.source.auth.secret_ref, /apify_secret_check/);
    assert.equal(JSON.stringify(stored).includes("mock-apify-token"), false);
    assert.equal(stored.source.execution_mode, "sync", "execution_mode defaults to sync");

    // The stored config still runs, resolving the token from the secret store.
    const viaSecret = await executeApifyActor(stored, { queries: "agentrouter" });
    assert.equal(viaSecret.status, 200);
    assert.equal(viaSecret.body.data.item_count, 2);
  });
  delete process.env.ADN_APIFY_API_BASE;
});

test("Apify actors onboard through Provider Studio and can pre-fill from actor metadata", async () => {
  const { fetchApifyActorMetadata } = await import("../src/provider-runtime.js");
  const { createApifyActorProviderConfig } = await import("../src/provider-config.js");

  await withServer(async ({ baseUrl }) => {
    process.env.ADN_APIFY_API_BASE = `${baseUrl}/mock/upstream/apify`;

    // PRD 9-B: actor metadata pre-fills a draft instead of retyping it.
    const draft = await fetchApifyActorMetadata("apify~google-search-scraper", "mock-apify-token");
    assert.equal(draft.title, "Google Search Scraper");
    assert.deepEqual(draft.input_allowlist, ["queries", "maxPagesPerQuery", "resultsPerPage"]);
    assert.equal(draft.sample_request.queries, "agentrouter");
    assert.equal(draft.default_timeout_secs, 120);

    await assert.rejects(
      fetchApifyActorMetadata("apify~missing-actor", "mock-apify-token"),
      (error) => error.code === "APIFY_ACTOR_NOT_FOUND"
    );
    await assert.rejects(
      fetchApifyActorMetadata("apify~google-search-scraper", "wrong-token"),
      (error) => error.code === "APIFY_ACTOR_METADATA_FAILED"
    );

    // The Studio factory produces a runnable apify_actor config.
    const config = createApifyActorProviderConfig({
      baseUrl,
      serviceId: "studio_apify_serp",
      providerId: "studio_provider",
      title: draft.title,
      description: draft.description,
      capabilities: ["data_service", "web_search"],
      price: "0.02",
      sampleRequest: draft.sample_request,
      sampleData: { items: [] },
      actorId: draft.actor_id,
      inputAllowlist: draft.input_allowlist,
      inputTemplate: { resultsPerPage: 10 },
      datasetFields: ["title", "url"],
      maxItems: 5,
      secretValue: "mock-apify-token",
      summary: "Google SERP via Apify"
    });
    assert.equal(config.source.type, "apify_actor");
    assert.equal(config.source.execution_mode, "sync");
    assert.equal(config.source.dataset.max_items, 5);
    assert.deepEqual(config.source.dataset.fields, ["title", "url"]);
    assert.deepEqual(config.source.input_allowlist, draft.input_allowlist);
    // Actors run on Apify, so there is no provider-owned origin to bind to.
    assert.equal(config.manifest.origin_binding, undefined);
    assert.equal(config.manifest.pricing.amount, "0.02");

    const { executeApifyActor } = await import("../src/provider-runtime.js");
    const run = await executeApifyActor(config, { queries: "agentrouter" });
    assert.equal(run.status, 200);
    assert.equal(run.body.data.item_count, 3, "max_items caps at 5 but the mock returns 3");
    assert.deepEqual(Object.keys(run.body.data.items[0]), ["title", "url"]);
  });
  delete process.env.ADN_APIFY_API_BASE;
});

test("seed Apify actors register end to end with the token kept out of the config", async () => {
  const { SEED_ACTORS, buildSeedConfig } = await import("../scripts/seed-apify-actors.js");
  const { writeProviderConfig, readProviderConfig, deleteProviderConfig } = await import("../src/provider-config.js");
  const { executeApifyActor } = await import("../src/provider-runtime.js");

  await withServer(async ({ baseUrl }) => {
    process.env.ADN_APIFY_API_BASE = `${baseUrl}/mock/upstream/apify`;
    try {

    // The seed list is the PRD's initial catalog, not an empty placeholder.
    assert.deepEqual(SEED_ACTORS.map((seed) => seed.actorId), [
      "apify~google-search-scraper",
      "apify~rag-web-browser"
    ]);

    for (const seed of SEED_ACTORS) {
      const config = buildSeedConfig(seed, { baseUrl, secretValue: "mock-apify-token" });
      assert.equal(config.source.type, "apify_actor");
      assert.equal(config.source.execution_mode, "sync");
      assert.equal(config.manifest.pricing.amount, seed.price);

      await writeProviderConfig(config);
      const stored = await readProviderConfig(seed.serviceId);
      // The token becomes a named secret ref and never persists in the config.
      assert.equal(stored.source.auth.secret_value, undefined);
      assert.equal(stored.source.auth.secret_ref, `${seed.serviceId}:APIFY_TOKEN`);
      assert.equal(JSON.stringify(stored).includes("mock-apify-token"), false);

      // The stored config runs, resolving the token from the secret store.
      const run = await executeApifyActor(stored, seed.sampleRequest);
      assert.equal(run.status, 200);
      assert.equal(run.body.status, "success");
      assert.equal(run.body.data.actor_id, seed.actorId);
      if (seed.datasetFields.length) {
        assert.deepEqual(Object.keys(run.body.data.items[0]), seed.datasetFields);
      }
    }
    } finally {
      // These use fixed service ids in a shared provider dir; leaving them
      // behind changes what later tests see.
      for (const seed of SEED_ACTORS) await deleteProviderConfig(seed.serviceId);
    }
  });
  delete process.env.ADN_APIFY_API_BASE;
});

test("an unknown capability names what exists instead of a bare no-match", async () => {
  const { routeCapabilityRequest, getCapabilityCatalog } = await import("../src/router.js");
  const store = createMemoryStore();
  const known = getCapabilityCatalog().map((entry) => entry.capability);

  const diagnose = async (capability) => {
    const result = await routeCapabilityRequest(store, { capability, params: { query: "x" } }, {});
    return result.error || result.diagnostics || result;
  };

  // Guessed names are reported as unknown, not as "no service matched", and the
  // caller is handed the real list so the next call can succeed.
  const webSearch = await diagnose("web_search");
  assert.equal(webSearch.code, "UNKNOWN_CAPABILITY");
  assert.deepEqual(webSearch.available_capabilities, known);
  assert.deepEqual(webSearch.did_you_mean, ["external_api_query"]);
  assert.match(webSearch.next_actions[0], /external_api_query/);

  // Token overlap covers names no hint list anticipated.
  assert.deepEqual((await diagnose("liquidation_stuff")).did_you_mean, ["perp_liquidation_max_pain"]);

  // Browser-backed capabilities explain that the hosted API cannot serve them.
  const socialSearch = await diagnose("social_search");
  assert.match(socialSearch.runs_locally, /on your device/);
  assert.ok(socialSearch.did_you_mean.includes("social_user_voice_research"));

  // A name with nothing close still returns the catalog rather than guessing.
  const nonsense = await diagnose("totally_made_up_thing");
  assert.equal(nonsense.code, "UNKNOWN_CAPABILITY");
  assert.equal(nonsense.did_you_mean, undefined);
  assert.deepEqual(nonsense.available_capabilities, known);

  // A real capability with no matching service keeps the original diagnosis.
  const registered = await diagnose(known[0]);
  assert.notEqual(registered.code, "UNKNOWN_CAPABILITY");
});

test("an unidentified query cannot buy a service on one shared word", async () => {
  const { askAgentRouter, meetsRelevanceFloor, inferIntent } = await import("../src/agent-router.js");
  const store = createMemoryStore();
  const schema = { type: "object", properties: {} };
  // The service that was actually mis-sold: a crypto points leaderboard.
  const record = registerService(store, {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: "points_leaderboard",
    title: "GET api points leaderboard api",
    description_for_agent: "Retrieve the points leaderboard",
    capabilities: ["data_service", "wallet_profile"],
    pricing: { amount: "0.01", currency: "USDC", network: "base" },
    provider: { provider_id: "nansen" },
    endpoint: { url: "http://example.test/leaderboard", method: "POST" },
    input_schema: schema, output_schema: schema, sample_request: {}, sample_response: {}
  }, "http://127.0.0.1:8787");
  record.verification_status = "verified";

  // A jobs question shares only the word "crypto" with this service. It must not
  // reach a payment quote, in any of the shapes that previously slipped through.
  for (const task of [
    "crypto",
    "找相似岗位",
    "crypto jobs",
    "find similar job openings crypto product manager"
  ]) {
    const result = await askAgentRouter(store, { task, invoke: false });
    assert.equal(result.status, "no_service_found", `${task} must not select a service`);
    assert.equal(result.selected_service, undefined);
  }

  // A genuinely relevant query still routes, so the floor is not just "refuse".
  const relevant = await askAgentRouter(store, { task: "points leaderboard", invoke: false });
  assert.equal(relevant.selected_service.service_id, "points_leaderboard");

  // A single term is never enough evidence, however high its hit ratio.
  const service = { service_id: "points_leaderboard", title: "GET api points leaderboard api", capabilities: [] };
  assert.equal(meetsRelevanceFloor(service, inferIntent("crypto")), false);
  assert.equal(meetsRelevanceFloor(service, inferIntent("points leaderboard")), true);
  // Identified crypto intents keep their existing path untouched.
  assert.equal(meetsRelevanceFloor(service, inferIntent("BTC 最大爆仓痛点")), true);
});

test("public reputation reports rates with their sample size and stays aggregate", async () => {
  const { publicReputation, summarizeHomeStats } = await import("../src/store.js");
  const store = createMemoryStore();
  const schema = { type: "object", properties: {} };
  const record = registerService(store, {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: "rated_service",
    title: "Rated service",
    description_for_agent: "d",
    capabilities: ["data_service"],
    pricing: { amount: "0.01", currency: "USDC", network: "base" },
    provider: { provider_id: "p" },
    endpoint: { url: "http://example.test/x", method: "POST" },
    input_schema: schema, output_schema: schema, sample_request: {}, sample_response: {}
  }, "http://127.0.0.1:8787");

  // No feedback must read as "none", never as a flattering default.
  const empty = publicReputation(record);
  assert.equal(empty.has_feedback, false);
  assert.equal(empty.has_agent_ratings, false);
  assert.equal(empty.sample_size, 0);
  assert.equal(empty.intent_fit_rate, null);
  assert.equal(empty.usefulness_rate, null);
  assert.equal(empty.display, "No calls yet");

  // Calls without ratings are still a track record and must be reported as one,
  // not hidden behind "nothing is known about this service".
  record.feedback_events = [
    { status: "success", schema_valid: true },
    { status: "success", schema_valid: true },
    { status: "success", schema_valid: true },
    { status: "error", schema_valid: false }
  ];
  const unrated = publicReputation(record);
  assert.equal(unrated.has_feedback, true);
  assert.equal(unrated.has_agent_ratings, false, "no agent submitted a rating");
  assert.equal(unrated.call_count, 4);
  assert.equal(unrated.intent_fit_rate, null, "success rate is not an intent-fit rate");
  assert.match(unrated.display, /75% success \(4 calls\) · no agent ratings yet/);

  record.feedback_events = [
    { status: "success", schema_valid: true, consumer_feedback: { intent_fit: "yes", answer_useful: "yes", consumer_score: 0.9, buyer_id: "user-a", query: "secret query" } },
    { status: "success", schema_valid: true, consumer_feedback: { intent_fit: "no", answer_useful: "no", consumer_score: 0.1, buyer_id: "user-b", query: "another secret" } }
  ];
  const rated = publicReputation(record);
  assert.equal(rated.has_feedback, true);
  assert.equal(rated.sample_size, 2, "the sample must travel with the rate");
  assert.equal(rated.intent_fit_rate, 0.5);
  assert.equal(rated.usefulness_rate, 0.5);
  assert.match(rated.display, /50% intent fit \(2 ratings\)/);

  // Aggregates only: buyer identity and raw queries must not be published.
  const serialized = JSON.stringify(rated);
  assert.equal(serialized.includes("user-a"), false);
  assert.equal(serialized.includes("secret query"), false);

  // The home payload carries it per service, not as one global counter.
  const home = summarizeHomeStats(store);
  const summary = home.services.find((item) => item.service_id === "rated_service");
  assert.equal(summary.reputation.sample_size, 2);
  assert.equal(JSON.stringify(home).includes("another secret"), false);
});

test("the public page shows per-service ratings and an honest empty state", async () => {
  await withServer(async ({ baseUrl }) => {
    const page = await (await fetch(`${baseUrl}/`)).text();
    assert.match(page, /Agent rating/, "the listing has a rating column");
    assert.match(page, /No calls yet/, "unused services say so");
    assert.match(page, /Quarantined/, "quarantined services are labelled");
    // Inline scripts must still parse after the markup change.
    for (const [, script] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(script));
    }
  });
});

test("every registered API reports reputation, on every surface that lists them", async () => {
  const { getExternalApiCatalog } = await import("../src/external-api-capability.js");

  await withServer(async ({ baseUrl }) => {
    // Services are assembled independently in three places; a service missing
    // reputation on any one of them shows blank metrics to buyers.
    const surfaces = [
      ["/agent-router/stats", "services"],
      ["/agent-router/home-stats", "services"],
      ["/agent-router/home-stats", "featured_services"],
      ["/agent-router/services?limit=200", "services"]
    ];
    for (const [path, key] of surfaces) {
      const payload = await (await fetch(`${baseUrl}${path}`)).json();
      const list = payload[key];
      assert.ok(Array.isArray(list), `${path} should expose ${key}`);
      const missing = list.filter((item) => !item.reputation).map((item) => item.service_id);
      assert.deepEqual(missing, [], `${path} .${key} left these without reputation`);
      // Unrated services must say so rather than render as blank metrics.
      for (const item of list.filter((entry) => !entry.reputation.has_agent_ratings)) {
        assert.equal(item.reputation.intent_fit_rate, null, "unrated services claim no intent fit");
        assert.match(item.reputation.display, /No calls yet|no agent ratings yet/);
      }
    }
  });

  // External API sources are callable and rateable too, so they report the same
  // shape as registered services rather than a separate set of blank fields.
  const store = createMemoryStore();
  const untouched = getExternalApiCatalog(store, "").find((item) => item.source === "exa");
  assert.equal(untouched.reputation.has_feedback, false);
  assert.equal(untouched.reputation.display, "No calls yet");

  // A source that has been called but never rated reports its call record —
  // this is the case that previously rendered as a blank card.
  store.feedbackEvents = [
    { service_id: "external_api_exa", status: "success", schema_valid: true },
    { service_id: "external_api_exa", status: "success", schema_valid: true }
  ];
  const called = getExternalApiCatalog(store, "").find((item) => item.source === "exa");
  assert.equal(called.reputation.has_feedback, true);
  assert.equal(called.reputation.call_count, 2);
  assert.match(called.reputation.display, /no agent ratings yet/);

  store.feedbackEvents = [
    { service_id: "external_api_exa", status: "success", schema_valid: true, consumer_feedback: { intent_fit: "yes", answer_useful: "yes", consumer_score: 0.9 } },
    { service_id: "external_api_exa", status: "success", schema_valid: true, consumer_feedback: { intent_fit: "no", answer_useful: "no", consumer_score: 0.2 } }
  ];
  const rated = getExternalApiCatalog(store, "").find((item) => item.source === "exa");
  assert.equal(rated.reputation.sample_size, 2);
  assert.equal(rated.reputation.intent_fit_rate, 0.5);
  assert.match(rated.reputation.display, /50% intent fit \(2 ratings\)/);
});

test("reputation markup ships with the styles that make it visible", async () => {
  await withServer(async ({ baseUrl }) => {
    // The card renderer lived in one file and the live stylesheet in another, so
    // the row rendered with no styling and looked like nothing had been added.
    for (const path of ["/", "/agent", "/human"]) {
      const page = await (await fetch(`${baseUrl}${path}`)).text();
      const rendersReputation = page.includes("reputationRow") || page.includes("reputationCell");
      if (!rendersReputation) continue;
      assert.match(page, /\.rep-row/, `${path} renders reputation but ships no .rep-row style`);
      assert.match(page, /\.rep-empty/, `${path} needs the empty-state style`);
    }
  });
});

test("a question with no matching service gets a route it can actually take", async () => {
  await withServer(async ({ baseUrl }) => {
    const ask = async (task) => (await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, invoke: false })
    })).json();

    // The registry holds crypto services, so most questions have no match. A
    // bare "no_service_found" leaves the agent guessing; it now gets the call
    // that works, on the same entry point the MCP fetch route already used.
    // Anonymous agents must first establish the AgentRouter account boundary;
    // this is distinct from asking the user for a source API key.
    const jobs = await ask("find senior crypto product manager jobs remote");
    assert.equal(jobs.status, "connection_required");
    assert.equal(jobs.action_required.action, "connect_agentrouter_account");
    assert.equal(jobs.action_required.authorization_kind, "agentrouter_account_login");
    assert.equal(jobs.suggested_route.call.capability, "external_api_query");
    assert.equal(jobs.suggested_route.call.params.source, "exa");
    assert.match(jobs.next_actions[0], /Retry as a structured call/);
    assert.equal(jobs.handoff.kind, "agentrouter_route");
    assert.equal(jobs.handoff.tool, "agentrouter_request");
    assert.deepEqual(jobs.handoff.request, jobs.suggested_route.call);
    assert.equal(jobs.handoff.preserve_route_context, true);

    // Naming a platform should route to the free browser read, not a paid
    // search source — the user already has that session open.
    for (const [task, platform] of [
      ["看看 twitter 上大家怎么评价 x402", "x"],
      ["reddit 上关于 MCP 的讨论", "reddit"],
      ["小红书上 AI 工具推荐", "xiaohongshu"]
    ]) {
      const routed = await ask(task);
      assert.equal(routed.suggested_route.call.capability, "social_search", task);
      assert.equal(routed.suggested_route.call.params.platform, platform, task);
    }

    // Verticals still reach their own source when no platform is named.
    assert.equal((await ask("东京明天天气")).suggested_route.call.params.source, "open_meteo");

    // A key-gated source must offer the free path instead of demanding an
    // account connection, which the agent has no tool to satisfy here.
    const gated = await (await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "external_api_query", params: { source: "x", operation: "search", query: "crypto jobs", limit: 20 } })
    })).json();
    // The 401 stands — the source really does need a credential — but the
    // response also carries the call that needs none.
    assert.equal(gated.recommended_action, "use_free_local_alternative");
    assert.equal(gated.action_required.preferred_tool, "agentrouter_connect");
    assert.deepEqual(gated.free_alternative.call, {
      capability: "social_search",
      params: { platform: "x", query: "crypto jobs", limit: 20 }
    });
  });
});
