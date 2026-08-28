import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { launchBrowserAuthorization } from "../packages/agentrouter-mcp/server/browser-launcher.js";

test("browser authorization launches the complete approval URL without a shell", async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const result = await launchBrowserAuthorization(
    "https://agentrouter.network/connect?user_code=AR-TEST",
    { platform: "darwin", spawnProcess, allowedOrigins: ["https://agentrouter.network"] }
  );

  assert.equal(result.status, "opened");
  assert.deepEqual(calls[0].args, ["https://agentrouter.network/connect?user_code=AR-TEST"]);
  assert.equal(calls[0].options.shell, false);
});

test("browser authorization rejects non-HTTP and foreign-origin targets", async () => {
  let calls = 0;
  const spawnProcess = () => { calls += 1; };
  for (const target of ["file:///tmp/secret", "https://evil.example/connect?user_code=AR-TEST"]) {
    const result = await launchBrowserAuthorization(target, {
      spawnProcess,
      allowedOrigins: ["https://agentrouter.network"]
    });
    assert.equal(result.status, "blocked");
  }
  assert.equal(calls, 0);
});

test("headless clients can disable automatic browser launch while retaining the URL", async () => {
  const result = await launchBrowserAuthorization(
    "https://agentrouter.network/connect?user_code=AR-TEST",
    { disabled: true, spawnProcess: () => { throw new Error("must not spawn"); } }
  );
  assert.deepEqual(result, { attempted: false, opened: false, status: "disabled" });
});
