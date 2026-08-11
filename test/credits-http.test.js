import test from "node:test";
import assert from "node:assert/strict";

process.env.ADN_PAYMENT_BACKEND = "credits";
process.env.ADN_CREDITS_ALLOW_MANUAL_TOPUP = "true";

const { createServer } = await import("../src/server.js");
const { createMemoryStore } = await import("../src/store.js");
const { registerService } = await import("../src/registry.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");

async function withCreditServer(run) {
  const store = createMemoryStore();
  const server = createServer({ store });
  const user = {
    provider: "github",
    id: "credit-http-user",
    name: "Credit HTTP User",
    email: "credit-http@example.com",
    handle: "credit-http-user"
  };
  store.authSessions.set("credit-http-session", {
    user,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  registerService(store, baseFundFlowManifest, baseUrl).verification_status = "verified";
  try {
    await run({ store, baseUrl, cookie: "ar_session=credit-http-session" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("credit account API requires login and returns balance", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    const accountPageRedirect = await fetch(`${baseUrl}/account`, { redirect: "manual" });
    assert.equal(accountPageRedirect.status, 302);
    assert.equal(accountPageRedirect.headers.get("location"), "/auth/login?return_to=%2Faccount");

    const accountPage = await fetch(`${baseUrl}/account`, { headers: { cookie } });
    assert.equal(accountPage.status, 200);
    const accountHtml = await accountPage.text();
    assert.match(accountHtml, /AgentRouter dashboard/);
    assert.match(accountHtml, /--dash-bg:var\(--color-bg\)/);
    assert.doesNotMatch(accountHtml, /body \{ background:#07100f/);

    const denied = await fetch(`${baseUrl}/account/credits`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${baseUrl}/account/credits`, { headers: { cookie } });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.balance, "0");
    assert.match(payload.account.account_id, /^acct_/);
    assert.deepEqual(payload.ledger, []);
  });
});

test("account dashboard exposes only the signed-in user's credit summary and safe API-key metadata", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    const initial = await fetch(`${baseUrl}/account/dashboard`, { headers: { cookie } });
    assert.equal(initial.status, 200);
    const initialPayload = await initial.json();
    assert.equal(initialPayload.summary.available_credits, "0");
    assert.equal(initialPayload.summary.successful_paid_calls, 0);
    assert.deepEqual(initialPayload.api_keys, []);

    await fetch(`${baseUrl}/account/credits/topup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ amount: "1.00" })
    });
    const created = await fetch(`${baseUrl}/account/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Dashboard test" })
    });
    assert.equal(created.status, 201);

    const dashboard = await fetch(`${baseUrl}/account/dashboard`, { headers: { cookie } });
    const payload = await dashboard.json();
    assert.equal(payload.summary.available_credits, "1");
    assert.equal(payload.summary.active_api_keys, 1);
    assert.equal(payload.api_keys[0].label, "Dashboard test");
    assert.equal("api_key" in payload.api_keys[0], false);
  });
});

test("an installed agent can connect through browser approval without copying an API key", async () => {
  await withCreditServer(async ({ store, baseUrl, cookie }) => {
    const started = await fetch(`${baseUrl}/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Desktop" })
    });
    assert.equal(started.status, 201);
    const flow = await started.json();
    assert.match(flow.device_code, /^ard_/);
    assert.match(flow.user_code, /^AR-/);
    assert.equal(flow.verification_uri, `${baseUrl}/connect`);

    const pending = await fetch(`${baseUrl}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: flow.device_code })
    });
    assert.equal(pending.status, 400);
    assert.equal((await pending.json()).error, "authorization_pending");

    const signedOutPage = await fetch(flow.verification_uri_complete, { redirect: "manual" });
    assert.equal(signedOutPage.status, 302);
    assert.match(signedOutPage.headers.get("location"), /^\/\?login=1&return_to=/);

    const approvalPage = await fetch(flow.verification_uri_complete, { headers: { cookie } });
    assert.equal(approvalPage.status, 200);
    const approvalHtml = await approvalPage.text();
    assert.match(approvalHtml, /Connect Claude Desktop/);
    assert.match(approvalHtml, new RegExp(flow.user_code));
    assert.doesNotMatch(approvalHtml, new RegExp(flow.device_code));

    const approved = await fetch(`${baseUrl}/auth/device/approve`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ user_code: flow.user_code })
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).status, "approved");

    const tokenResponse = await fetch(`${baseUrl}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: flow.device_code })
    });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    assert.match(token.access_token, /^ar_device_/);
    assert.equal(token.token_type, "Bearer");

    const dashboard = await fetch(`${baseUrl}/account/dashboard`, { headers: { cookie } });
    const dashboardPayload = await dashboard.json();
    const connection = dashboardPayload.api_keys.find((key) => key.key_id === token.key_id);
    assert.equal(connection.auth_method, "device");
    assert.equal(connection.client_name, "Claude Desktop");

    const { authenticateCreditRequest } = await import("../src/credits.js");
    const authenticated = await authenticateCreditRequest(store, {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    assert.equal(authenticated.account.owner_key, "github:credit-http-user");
    assert.equal(authenticated.key.auth_method, "device");

    const revoked = await fetch(`${baseUrl}/account/api-keys/${encodeURIComponent(token.key_id)}/revoke`, {
      method: "POST",
      headers: { cookie }
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).status, "revoked");
    assert.equal(await authenticateCreditRequest(store, {
      headers: { authorization: `Bearer ${token.access_token}` }
    }), null);
  });
});

test("account dashboard presents agent connections as the default and developer keys as advanced", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    const response = await fetch(`${baseUrl}/account`, { headers: { cookie } });
    const html = await response.text();
    assert.match(html, /Connected agents/);
    assert.match(html, /Developer API keys/);
    assert.match(html, /No API key needs to be copied into an MCP configuration/);
    assert.doesNotMatch(html, /Use it only in your MCP client configuration/);
  });
});

test("localhost development login creates a session only when explicitly enabled", async () => {
  const previous = process.env.ADN_AUTH_ALLOW_DEV_LOGIN;
  process.env.ADN_AUTH_ALLOW_DEV_LOGIN = "true";
  try {
    await withCreditServer(async ({ store, baseUrl }) => {
      const loginRedirect = await fetch(`${baseUrl}/auth/login?return_to=%2Faccount`, { redirect: "manual" });
      assert.equal(loginRedirect.status, 302);
      assert.equal(loginRedirect.headers.get("location"), "/?login=1&return_to=%2Faccount");
      const loginPage = await fetch(`${baseUrl}/?login=1&return_to=%2Faccount`);
      assert.match(await loginPage.text(), /Continue locally/);

      const login = await fetch(`${baseUrl}/auth/dev/start?return_to=%2Faccount`, {
        method: "POST",
        redirect: "manual"
      });
      assert.equal(login.status, 302);
      assert.equal(login.headers.get("location"), "/account");
      const cookie = login.headers.get("set-cookie");
      assert.match(cookie, /ar_session=/);

      const account = await fetch(`${baseUrl}/account`, { headers: { cookie } });
      assert.equal(account.status, 200);
      const accountHtml = await account.text();
      assert.match(accountHtml, /AgentRouter dashboard/);
      assert.match(accountHtml, /href="\/auth\/logout"[^>]*>Sign out<\/a>/);

      const studio = await fetch(`${baseUrl}/studio`, { headers: { cookie } });
      assert.equal(studio.status, 200);
      assert.match(await studio.text(), /href="\/auth\/logout"[^>]*>Sign out<\/a>/);

      const research = await fetch(`${baseUrl}/research`, { headers: { cookie } });
      assert.equal(research.status, 200);
      assert.match(await research.text(), /href="\/auth\/logout"[^>]*>退出登录<\/a>/);

      const sessionId = cookie.match(/ar_session=([^;]+)/)?.[1];
      assert.ok(sessionId);
      assert.equal(store.authSessions.has(sessionId), true);

      const logout = await fetch(`${baseUrl}/auth/logout`, {
        headers: { cookie },
        redirect: "manual"
      });
      assert.equal(logout.status, 302);
      assert.equal(logout.headers.get("location"), "/");
      assert.match(logout.headers.get("set-cookie"), /ar_session=;/);
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(store.authSessions.has(sessionId), false);

      const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
      assert.equal((await me.json()).authenticated, false);
    });
  } finally {
    if (previous === undefined) delete process.env.ADN_AUTH_ALLOW_DEV_LOGIN;
    else process.env.ADN_AUTH_ALLOW_DEV_LOGIN = previous;
  }
});

test("insufficient credits are not recorded as a collected payment", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    await fetch(`${baseUrl}/account/credits/topup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ amount: "0.005" })
    });
    const keyResponse = await fetch(`${baseUrl}/account/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Low balance client" })
    });
    const { api_key: apiKey } = await keyResponse.json();

    const response = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentrouter-api-key": apiKey
      },
      body: JSON.stringify({
        service_id: "chain_fund_flow_7d_base",
        input: { chain: "base", days: 7 },
        budget: { max_amount: "0.05" }
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 402, JSON.stringify(payload));
    assert.equal(payload.feedback.payment_collected, false);
    assert.equal(payload.feedback.billing_status, "not_charged");

    const account = await fetch(`${baseUrl}/account/credits`, { headers: { cookie } });
    assert.equal((await account.json()).balance, "0.005");
  });
});

test("local manual topup, API key creation, and server-side service debit work end to end", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    const topup = await fetch(`${baseUrl}/account/credits/topup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ amount: "1.00" })
    });
    assert.equal(topup.status, 201);
    assert.equal((await topup.json()).balance, "1");

    const keyResponse = await fetch(`${baseUrl}/account/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Claude Desktop" })
    });
    assert.equal(keyResponse.status, 201);
    const { api_key: apiKey } = await keyResponse.json();
    assert.match(apiKey, /^ar_live_/);

    const unpaid = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(unpaid.status, 402);
    assert.equal((await unpaid.json()).code, "CREDITS_REQUIRED");

    const paid = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentrouter-api-key": apiKey
      },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paid.status, 200);
    const result = await paid.json();
    assert.equal(result.status, "success");
    assert.equal(result.metadata.billing.payment_backend, "credits");
    assert.equal(result.metadata.billing.amount, "0.01");

    const account = await fetch(`${baseUrl}/account/credits`, { headers: { cookie } });
    const accountPayload = await account.json();
    assert.equal(accountPayload.balance, "0.99");
    assert.equal(accountPayload.ledger[0].kind, "service_call");
    assert.equal(accountPayload.ledger[0].service_id, "chain_fund_flow_7d_base");
  });
});

test("manual topup is disabled unless explicitly enabled", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    const previous = process.env.ADN_CREDITS_ALLOW_MANUAL_TOPUP;
    delete process.env.ADN_CREDITS_ALLOW_MANUAL_TOPUP;
    try {
      const response = await fetch(`${baseUrl}/account/credits/topup`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ amount: "1" })
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED");
    } finally {
      process.env.ADN_CREDITS_ALLOW_MANUAL_TOPUP = previous;
    }
  });
});

test("the connector forwards a credit key and performs one paid invocation", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    await fetch(`${baseUrl}/account/credits/topup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ amount: "0.05" })
    });
    const keyResponse = await fetch(`${baseUrl}/account/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "MCP" })
    });
    const { api_key: apiKey } = await keyResponse.json();

    const response = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentrouter-api-key": apiKey
      },
      body: JSON.stringify({
        service_id: "chain_fund_flow_7d_base",
        input: { chain: "base", days: 7 },
        budget: { max_amount: "0.05" }
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.result.status, "success");
    assert.equal(payload.feedback.payment_backend, "credits");
    assert.equal(payload.feedback.payment_collected, true);

    const account = await fetch(`${baseUrl}/account/credits`, { headers: { cookie } });
    assert.equal((await account.json()).balance, "0.04");
  });
});

test("remote MCP forwards the credit key through structured routing", async () => {
  await withCreditServer(async ({ baseUrl, cookie }) => {
    await fetch(`${baseUrl}/account/credits/topup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ amount: "0.05" })
    });
    const keyResponse = await fetch(`${baseUrl}/account/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Remote MCP" })
    });
    const { api_key: apiKey } = await keyResponse.json();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentrouter-api-key": apiKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agentrouter_request",
          arguments: {
            capability: "fund_flow",
            params: { chain: "base", days: 7 },
            constraints: { max_price_usdc: "0.05" }
          }
        }
      })
    });
    assert.equal(response.status, 200);
    const rpc = await response.json();
    const toolPayload = JSON.parse(rpc.result.content[0].text);
    assert.equal(toolPayload.ok, true);
    assert.equal(toolPayload.result.status, "success");

    const account = await fetch(`${baseUrl}/account/credits`, { headers: { cookie } });
    assert.equal((await account.json()).balance, "0.04");
  });
});
