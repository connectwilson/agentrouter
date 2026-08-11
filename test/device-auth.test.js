import test from "node:test";
import assert from "node:assert/strict";

import {
  approveDeviceAuthorization,
  beginDeviceAuthorization,
  pollDeviceAuthorization
} from "../src/device-auth.js";
import { createMemoryStore } from "../src/store.js";

test("device authorization uses a short user code without retaining the raw device secret", () => {
  const store = createMemoryStore();
  const started = beginDeviceAuthorization(store, {
    baseUrl: "https://agentrouter.network",
    clientName: "Claude Desktop",
    now: 1_000
  });

  assert.match(started.device_code, /^ard_/);
  assert.match(started.user_code, /^AR-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(started.verification_uri, "https://agentrouter.network/connect");
  assert.match(started.verification_uri_complete, /\/connect\?user_code=AR-/);
  assert.equal(started.expires_in, 600);
  assert.equal(store.deviceAuthorizations.has(started.device_code), false);
  assert.equal(store.deviceAuthorizations.size, 1);
});

test("device authorization remains pending until the signed-in user approves it", async () => {
  const store = createMemoryStore();
  const started = beginDeviceAuthorization(store, {
    baseUrl: "https://agentrouter.network",
    clientName: "Codex",
    now: 10_000
  });

  const pending = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 14_000,
    issueCredential: async () => assert.fail("credential must not be issued before approval")
  });
  assert.equal(pending.error, "authorization_pending");

  const account = { account_id: "acct_test", owner_key: "github:42", user_profile: { handle: "octocat" } };
  const approved = approveDeviceAuthorization(store, {
    userCode: started.user_code.toLowerCase(),
    account,
    now: 15_000
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.client_name, "Codex");

  let issued = 0;
  const token = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 18_000,
    issueCredential: async ({ account: authorizedAccount, clientName }) => {
      issued += 1;
      assert.equal(authorizedAccount.account_id, "acct_test");
      assert.equal(clientName, "Codex");
      return { api_key: "ar_device_secret", key_id: "key_device" };
    }
  });
  assert.equal(token.access_token, "ar_device_secret");
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.key_id, "key_device");
  assert.equal(issued, 1);

  const consumed = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 22_000,
    issueCredential: async () => assert.fail("a consumed authorization must not issue twice")
  });
  assert.equal(consumed.error, "expired_token");
});

test("device authorization rejects unknown, expired, and over-polled requests", async () => {
  const store = createMemoryStore();
  const started = beginDeviceAuthorization(store, {
    baseUrl: "https://agentrouter.network",
    clientName: "Cursor",
    now: 20_000
  });

  assert.throws(
    () => approveDeviceAuthorization(store, { userCode: "AR-NOPE-NOPE", account: { account_id: "acct" }, now: 21_000 }),
    (error) => error.code === "INVALID_USER_CODE"
  );

  const first = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 23_000,
    issueCredential: async () => null
  });
  assert.equal(first.error, "authorization_pending");
  const fast = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 24_000,
    issueCredential: async () => null
  });
  assert.equal(fast.error, "slow_down");

  const expired = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    now: 621_000,
    issueCredential: async () => null
  });
  assert.equal(expired.error, "expired_token");
});
