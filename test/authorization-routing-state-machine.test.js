import assert from "node:assert/strict";
import test from "node:test";

import { resolveMcpClientAction } from "../packages/agentrouter-mcp/server/action-state.js";

function payload(value) {
  return { result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
}

const account = {
  state: "authorize_account",
  action: "connect_agentrouter_account",
  preferred_tool: "agentrouter_connect",
  authorization_kind: "agentrouter_account_login",
  user_facing_label: "Log in and authorize AgentRouter"
};

const sourceAccess = (authorizationKind, label) => ({
  state: "authorize_source",
  preferred_tool: "agentrouter_connect_source",
  authorization_kind: authorizationKind,
  user_facing_label: label
});

const scenarios = [
  ["canonical account action", {
    action_required: { action: "connect_agentrouter_account", preferred_tool: "agentrouter_connect" }
  }, account],
  ["account preferred tool without action", {
    action_required: { preferred_tool: "agentrouter_connect" }
  }, account],
  ["account error code without action metadata", {
    error: { code: "AGENTROUTER_CONNECTION_REQUIRED" }
  }, account],
  ["account error outranks stale source action", {
    error: { code: "AGENTROUTER_CONNECTION_REQUIRED" },
    action_required: { action: "connect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, account],
  ["account error outranks stale source connection action", {
    error: { code: "AGENTROUTER_CONNECTION_REQUIRED" },
    connection_action: { action: "connect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, account],
  ["account error outranks stale source reconnect", {
    error: { code: "AGENTROUTER_CONNECTION_REQUIRED" },
    action_required: { action: "reconnect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, account],
  ["explicit account authorization status", {
    status: "account_authorization_required"
  }, account],
  ["legacy account connection status", {
    status: "connection_required",
    error: { code: "AGENTROUTER_CONNECTION_REQUIRED" },
    connection_action: { action: "connect_api_source" }
  }, account],

  ["generic source connection", {
    connection_action: { action: "connect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, sourceAccess("source_access", "Authorize data source access")],
  ["generic source preferred tool", {
    action_required: { preferred_tool: "agentrouter_connect_source" }
  }, sourceAccess("source_access", "Authorize data source access")],
  ["legacy string source action plus structured connection action", {
    action_required: "connect_api_source",
    connection_action: { action: "connect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, sourceAccess("source_access", "Authorize data source access")],
  ["source reconnect", {
    action_required: { action: "reconnect_api_source", preferred_tool: "agentrouter_connect_source" }
  }, sourceAccess("source_access", "Authorize data source access")],
  ["BYOK API credentials", {
    connection_action: {
      action: "configure_api_credentials",
      preferred_tool: "agentrouter_connect_source",
      authorization_kind: "api_credentials"
    }
  }, sourceAccess("api_credentials", "Configure API credentials in AgentRouter")],
  ["source OAuth", {
    connection_action: {
      action: "authorize_source_account",
      preferred_tool: "agentrouter_connect_source",
      authorization_kind: "oauth"
    }
  }, sourceAccess("oauth", "Log in and authorize the data source")],
  ["local browser session", {
    connection_action: {
      action: "authorize_local_browser_session",
      preferred_tool: "agentrouter_connect_source",
      authorization_kind: "local_browser_session"
    }
  }, sourceAccess("local_browser_session", "Continue in your signed-in browser")],
  ["source credentials required status", {
    status: "source_credentials_required",
    source: { authorization_mode: "api_credentials" },
    verification_uri: "https://agentrouter.network/research?connect_source=openalex"
  }, sourceAccess("api_credentials", "Configure API credentials in AgentRouter")],

  ["successful result has no authorization action", { ok: true, status: "completed" }, { state: "none" }],
  ["payment boundary has no authorization action", {
    ok: false, status: "payment_required", action_required: { action: "fund_credits" }
  }, { state: "none" }],
  ["budget boundary has no authorization action", {
    ok: false, status: "budget_exceeded", action_required: { action: "raise_budget" }
  }, { state: "none" }],
  ["free local alternative has no authorization action", {
    ok: false, status: "connection_required", action_required: "use_free_local_alternative"
  }, { state: "none" }],
  ["unsupported source has no authorization action", {
    ok: false, status: "unsupported_source", error: { code: "UNSUPPORTED_SOURCE" }
  }, { state: "none" }],
  ["unavailable source has no authorization action", {
    ok: false, status: "source_not_callable", action_required: "requires_partner_api"
  }, { state: "none" }],
  ["malformed content has no authorization action", {
    result: { content: [{ type: "image", data: "ignored" }] }
  }, { state: "none", raw: true }],
  ["non-JSON content has no authorization action", {
    result: { content: [{ type: "text", text: "not json" }] }
  }, { state: "none", raw: true }]
];

for (const [name, value, expected] of scenarios) {
  test(`authorization routing: ${name}`, () => {
    const input = expected.raw ? value : payload(value);
    const result = resolveMcpClientAction(input);
    assert.equal(result.state, expected.state);
    if (expected.state === "authorize_account") {
      assert.deepEqual({
        state: result.state,
        action: result.action,
        preferred_tool: result.preferred_tool,
        authorization_kind: result.authorization_kind,
        user_facing_label: result.user_facing_label
      }, expected);
    }
    if (expected.state === "authorize_source") {
      assert.equal(result.preferred_tool, expected.preferred_tool);
      assert.equal(result.authorization_kind, expected.authorization_kind);
      assert.equal(result.user_facing_label, expected.user_facing_label);
    }
  });
}

test("authorization routing remains deterministic across 50 consecutive passes", () => {
  for (let pass = 0; pass < 50; pass += 1) {
    for (const [, value, expected] of scenarios) {
      const input = expected.raw ? value : payload(value);
      assert.equal(resolveMcpClientAction(input).state, expected.state, `pass ${pass + 1}`);
    }
  }
});
