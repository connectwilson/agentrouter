export function resolveMcpClientAction(payload) {
  const value = readMcpToolPayload(payload);
  if (!value) return { state: "none", value: null };
  const action = value.action_required?.action
    || value.connection_action?.action
    || (value.error?.code === "AGENTROUTER_CONNECTION_REQUIRED" ? "connect_agentrouter_account" : null);
  const preferredTool = value.action_required?.preferred_tool
    || value.connection_action?.preferred_tool
    || null;

  if (action === "connect_agentrouter_account" || preferredTool === "agentrouter_connect") {
    return {
      state: "authorize_account",
      action: "connect_agentrouter_account",
      preferred_tool: "agentrouter_connect",
      value
    };
  }
  if (action === "connect_api_source" || preferredTool === "agentrouter_connect_source") {
    return {
      state: "authorize_source",
      action: "connect_api_source",
      preferred_tool: "agentrouter_connect_source",
      value
    };
  }
  return { state: "none", value };
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
