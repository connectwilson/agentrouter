import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectAgentRouter,
  formatConnectResult,
  parseInstallArgs
} from "../packages/agentrouter-installer/server/index.js";

test("connect command authorizes an account without reinstalling or reloading the client", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-connect-"));
  const opened = [];
  const announced = [];
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/auth/device/start")) {
      return jsonResponse({
        device_code: "device-code",
        user_code: "AR-TEST",
        verification_uri: "https://agentrouter.network/connect",
        verification_uri_complete: "https://agentrouter.network/connect?user_code=AR-TEST",
        expires_in: 600,
        interval: 1
      });
    }
    polls += 1;
    return jsonResponse(polls === 1
      ? { error: "authorization_pending" }
      : { access_token: "secret-device-token", key_id: "key-1" });
  };

  const result = await connectAgentRouter({
    home,
    clientName: "Codex",
    fetchImpl,
    delay: async () => {},
    openBrowser: async (url) => opened.push(url),
    onAuthorization: (authorization) => announced.push(authorization)
  });

  assert.equal(result.status, "connected");
  assert.equal(result.auth_method, "device");
  assert.deepEqual(opened, ["https://agentrouter.network/connect?user_code=AR-TEST"]);
  assert.equal(announced[0].user_code, "AR-TEST");
  assert.equal(polls, 2);

  const credentialPath = path.join(home, ".agentrouter", "credentials.json");
  const credential = JSON.parse(await fs.readFile(credentialPath, "utf8"));
  assert.equal(credential.origins["https://agentrouter.network"].access_token, "secret-device-token");
  assert.equal(credential.origins["https://agentrouter.network"].client_name, "Codex");
  assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(path.join(home, ".codex", "config.toml")), { code: "ENOENT" });

  const message = formatConnectResult(result);
  assert.match(message, /account connected/i);
  assert.doesNotMatch(message, /install|reload|restart/i);
});

test("connect is parsed as authorization, not as the default installer command", () => {
  const options = parseInstallArgs(["connect", "--client-name", "Codex"]);
  assert.equal(options.command, "connect");
  assert.equal(options.clientName, "Codex");
  assert.equal(options.full, undefined);
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}
