#!/usr/bin/env node
import { formatInstallResult, installAgentRouter, installUsage, parseInstallArgs } from "../server/index.js";

try {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(installUsage());
  } else {
    const result = await installAgentRouter(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatInstallResult(result));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`AgentRouter install failed: ${error.message}\n\n${installUsage()}`);
  process.exitCode = 1;
}
