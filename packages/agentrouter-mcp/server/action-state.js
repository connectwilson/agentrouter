export function resolveMcpClientAction(payload) {
  const value = readMcpToolPayload(payload);
  if (!value) return { state: "none", value: null };
  const actionRequired = value.action_required && typeof value.action_required === "object"
    ? value.action_required
    : null;
  const connectionAction = value.connection_action && typeof value.connection_action === "object"
    ? value.connection_action
    : null;
  const action = actionRequired?.action || connectionAction?.action || null;
  const preferredTool = actionRequired?.preferred_tool || connectionAction?.preferred_tool || null;

  // Account authorization is the outer trust boundary. It must win over stale
  // or nested source metadata because a source cannot be authorized until the
  // AI client itself is connected to the user's AgentRouter account.
  const accountRequired = value.error?.code === "AGENTROUTER_CONNECTION_REQUIRED"
    || value.status === "account_authorization_required"
    || action === "connect_agentrouter_account"
    || preferredTool === "agentrouter_connect";

  if (accountRequired) {
    return {
      state: "authorize_account",
      action: "connect_agentrouter_account",
      preferred_tool: "agentrouter_connect",
      authorization_kind: "agentrouter_account_login",
      user_facing_label: "Log in and authorize AgentRouter",
      value
    };
  }

  const sourceActions = new Set([
    "connect_api_source",
    "reconnect_api_source",
    "configure_api_credentials",
    "authorize_source_account",
    "authorize_local_browser_session"
  ]);
  const sourceRequired = sourceActions.has(action)
    || preferredTool === "agentrouter_connect_source"
    || value.status === "source_credentials_required";
  if (sourceRequired) {
    const authorizationKind = actionRequired?.authorization_kind
      || connectionAction?.authorization_kind
      || value.source?.authorization_mode
      || "source_access";
    return {
      state: "authorize_source",
      action: action || "connect_api_source",
      preferred_tool: "agentrouter_connect_source",
      authorization_kind: authorizationKind,
      user_facing_label: sourceAuthorizationLabel(authorizationKind),
      value
    };
  }
  return { state: "none", value };
}

function sourceAuthorizationLabel(kind) {
  if (kind === "api_credentials") return "Configure API credentials in AgentRouter";
  if (kind === "oauth") return "Log in and authorize the data source";
  if (kind === "local_browser_session") return "Continue in your signed-in browser";
  return "Authorize data source access";
}

export function readMcpToolPayload(payload) {
  const block = payload?.result?.content?.find((item) => item?.type === "text" && item.text);
  if (!block) return null;
  try {
    const value = JSON.parse(block.text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function decorateBrowserAuthorization(result, originalRequest) {
  const block = result?.content?.find((item) => item?.type === "text" && item.text);
  if (!block) return result;
  let value;
  try {
    value = JSON.parse(block.text);
  } catch {
    return result;
  }
  if (value.status !== "authorization_required") return result;
  block.text = JSON.stringify({
    ...value,
    action: "open_browser_approval",
    preferred_tool: "agentrouter_connect",
    retry_original_request: true,
    original_tool: originalRequest?.params?.name || null,
    message: "Open the browser approval link. After approval, retry the original request."
  }, null, 2);
  return result;
}
