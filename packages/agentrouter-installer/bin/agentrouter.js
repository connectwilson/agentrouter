#!/usr/bin/env node
import {
  connectAgentRouter,
  formatConnectResult,
  formatInstallResult,
  installAgentRouter,
  installUsage,
  parseInstallArgs
} from "../server/index.js";

try {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(installUsage());
  } else if (options.command === "connect") {
    const result = await connectAgentRouter({
      ...options,
      onAuthorization(authorization) {
        process.stdout.write([
          "AgentRouter account authorization started.",
          `Open: ${authorization.verification_uri_complete}`,
          `Code: ${authorization.user_code}`,
          "Waiting for browser approval..."
        ].join("\n") + "\n");
      }
    });
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatConnectResult(result));
  } else {
    const result = await installAgentRouter(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatInstallResult(result));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`AgentRouter command failed: ${error.message}\n\n${installUsage()}`);
  process.exitCode = 1;
}
