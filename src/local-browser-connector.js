// The browser protocol lives inside the publishable MCP package. Re-export it
// here so the hosted HTTP/MCP server and local bridge execute the same contract.
export * from "../packages/agentrouter-mcp/server/local-browser-connector.js";
