import assert from "node:assert/strict";
import test from "node:test";

process.env.ADN_AUTH_SESSION_SECRET = "remote-mcp-resilience-shared-secret-32-bytes";
process.env.ADN_PAYMENT_BACKEND = "credits";

const { createServer } = await import("../src/server.js");
const {
  approveDeviceAuthorization,
  beginDeviceAuthorization,
  getDeviceAuthorizationByUserCode,
  pollDeviceAuthorization
} = await import("../src/device-auth.js");
const { createCreditApiKey, grantCredits, revokeCreditApiKey } = await import("../src/credits.js");
const { baseFundFlowManifest } = await import("../src/fixtures.js");
const { registerService } = await import("../src/registry.js");
const { createMemoryStore } = await import("../src/store.js");

const ACCOUNT = {
  account_id: "acct_remote_mcp_resilience",
  owner_key: "github:remote-mcp-owner",
  user_profile: { handle: "remote-mcp-owner", email: "private-owner@example.test" },
  settings: { max_price_per_call: "1" },
  deposit_address: null
};

function copy(value) {
  return value == null ? value : structuredClone(value);
}

function createSharedDeviceAuthPersistence() {
  const records = new Map();
  return {
    enabled: true,
    records,
    async create(record) {
      if (records.has(record.device_code_hash)) return null;
      if ([...records.values()].some((entry) => entry.user_code_hash === record.user_code_hash)) return null;
      records.set(record.device_code_hash, copy(record));
      return copy(record);
    },
    async readByDeviceCodeHash(deviceCodeHash) {
      return copy(records.get(deviceCodeHash) || null);
    },
    async readByUserCodeHash(userCodeHash) {
      return copy([...records.values()].find((entry) => entry.user_code_hash === userCodeHash) || null);
    },
    async approve(userCodeHash, { accountId, ownerKey, now }) {
      const record = [...records.values()].find((entry) => entry.user_code_hash === userCodeHash) || null;
      if (!record || record.status === "consumed" || record.expires_at <= now) return null;
      if (record.status === "pending") {
        record.status = "approved";
        record.account_id = accountId;
        record.owner_key = ownerKey;
        record.approved_at = now;
      }
      return copy(record);
    },
    async updatePoll(deviceCodeHash, { lastPollAt, pollIntervalMs }) {
      const record = records.get(deviceCodeHash);
      if (!record) return null;
      record.last_poll_at = lastPollAt;
      record.poll_interval_ms = pollIntervalMs;
      return copy(record);
    },
    async claimApproved(deviceCodeHash, now) {
      const record = records.get(deviceCodeHash);
      if (!record || record.status !== "approved" || record.expires_at <= now) return null;
      record.status = "issuing";
      return copy(record);
    },
    async complete(deviceCodeHash, now) {
      const record = records.get(deviceCodeHash);
      if (!record || record.status !== "issuing") return null;
      record.status = "consumed";
      record.consumed_at = now;
      return copy(record);
    },
    async release(deviceCodeHash) {
      const record = records.get(deviceCodeHash);
      if (!record || record.status !== "issuing") return null;
      record.status = "approved";
      return copy(record);
    }
  };
}

function createSharedRemoteMcpPersistence() {
  const records = new Map();
  return {
    enabled: true,
    records,
    async read(sessionIdHash) {
      return copy(records.get(sessionIdHash) || null);
    },
    async write(record) {
      records.set(record.session_id_hash, copy(record));
      return copy(record);
    },
    async delete(sessionIdHash) {
      return records.delete(sessionIdHash);
    }
  };
}

function createSharedCreditPersistence() {
  const accounts = new Map([[ACCOUNT.owner_key, copy(ACCOUNT)]]);
  const keys = new Map();
  let failKeyReads = false;
  return {
    enabled: true,
    accounts,
    keys,
    failNextKeyRead() {
      failKeyReads = true;
    },
    async readAccountByOwner(ownerKey) {
      return copy(accounts.get(ownerKey) || null);
    },
    async readAccountByDepositAddress() {
      return null;
    },
    async upsertAccount(account) {
      accounts.set(account.owner_key, copy(account));
      return copy(account);
    },
    async writeApiKey(key) {
      keys.set(key.key_hash, copy(key));
      return copy(key);
    },
    async listApiKeys(accountId) {
      return [...keys.values()].filter((key) => key.account_id === accountId).map(copy);
    },
    async readApiKeyByHash(keyHash) {
      if (failKeyReads) {
        failKeyReads = false;
        throw new Error("authoritative credential store unavailable");
      }
      const key = keys.get(keyHash);
      return !key || key.revoked_at ? null : copy(key);
    },
    async revokeApiKey(accountId, keyId) {
      const key = [...keys.values()].find((entry) => entry.account_id === accountId && entry.key_id === keyId) || null;
      if (!key) return null;
      key.revoked_at ||= new Date().toISOString();
      return copy(key);
    },
    async touchApiKey() {
      return true;
    }
  };
}

function createInstance({ device, remote, credit }) {
  const store = createMemoryStore();
  store.deviceAuthPersistence = device;
  store.remoteMcpPersistence = remote;
  store.creditPersistence = credit;
  return store;
}

async function listen(store) {
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`
  };
}

async function rpc(origin, { sessionId = "", apiKey = "", id = 1, method = "tools/call", name, args = {} } = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(apiKey ? { "x-agentrouter-api-key": apiKey } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "resilience-test", version: "1" } }
        : { name, arguments: args }
    })
  });
  const payload = await response.json();
  const result = method === "tools/call"
    ? JSON.parse(payload.result.content[0].text)
    : payload.result;
  return {
    response,
    result,
    sessionId: response.headers.get("mcp-session-id") || sessionId
  };
}

test("pending device approval survives instances and issues a credential only once", async () => {
  const persistence = createSharedDeviceAuthPersistence();
  const storeA = createMemoryStore();
  const storeB = createMemoryStore();
  storeA.deviceAuthPersistence = persistence;
  storeB.deviceAuthPersistence = persistence;

  const started = await beginDeviceAuthorization(storeA, {
    baseUrl: "https://agentrouter.network",
    clientName: "Cross-instance agent",
    now: 1_000
  });
  const persistedBeforeApproval = JSON.stringify([...persistence.records.values()]);
  assert.ok(persistence.records.size > 0, "pending authorization must be durable");
  assert.equal(persistedBeforeApproval.includes(started.device_code), false);
  assert.equal(persistedBeforeApproval.includes(started.user_code), false);

  const pending = await getDeviceAuthorizationByUserCode(storeB, started.user_code, { now: 2_000 });
  assert.equal(pending.status, "pending");
  await approveDeviceAuthorization(storeB, { userCode: started.user_code, account: ACCOUNT, now: 3_000 });
  assert.equal(JSON.stringify([...persistence.records.values()]).includes(ACCOUNT.user_profile.email), false);

  let issued = 0;
  const issueCredential = async () => {
    issued += 1;
    return { api_key: `ar_device_once_${issued}`, key_id: `key_once_${issued}` };
  };
  const results = await Promise.all([
    pollDeviceAuthorization(storeA, { deviceCode: started.device_code, issueCredential, now: 4_000 }),
    pollDeviceAuthorization(storeB, { deviceCode: started.device_code, issueCredential, now: 4_000 })
  ]);
  assert.equal(issued, 1, "an approved device code must have one cross-instance issuer");
  assert.equal(results.filter((result) => result.access_token).length, 1);
});

test("a completion-write failure never reopens a device authorization for duplicate issuance", async () => {
  const persistence = createSharedDeviceAuthPersistence();
  const store = createMemoryStore();
  store.deviceAuthPersistence = persistence;
  const started = await beginDeviceAuthorization(store, {
    baseUrl: "https://agentrouter.network",
    clientName: "Completion failure agent",
    now: 10_000
  });
  await approveDeviceAuthorization(store, { userCode: started.user_code, account: ACCOUNT, now: 11_000 });

  const complete = persistence.complete.bind(persistence);
  persistence.complete = async () => {
    throw new Error("device completion store unavailable");
  };
  let issued = 0;
  const issueCredential = async () => ({
    api_key: `ar_device_completion_${++issued}`,
    key_id: `key_completion_${issued}`
  });
  await assert.rejects(
    () => pollDeviceAuthorization(store, { deviceCode: started.device_code, issueCredential, now: 12_000 }),
    /completion store unavailable/
  );
  persistence.complete = complete;

  const retry = await pollDeviceAuthorization(store, {
    deviceCode: started.device_code,
    issueCredential,
    now: 13_000
  });
  assert.equal(issued, 1, "a minted credential must never be minted again after an uncertain completion write");
  assert.equal(retry.access_token, undefined);
  assert.match(retry.error, /authorization_pending|expired_token/);
});

test("hosted MCP connection survives rolling deploy and revocation immediately requires reconnect", async () => {
  const device = createSharedDeviceAuthPersistence();
  const remote = createSharedRemoteMcpPersistence();
  const credit = createSharedCreditPersistence();
  const stores = Array.from({ length: 3 }, () => createInstance({ device, remote, credit }));
  const servers = await Promise.all(stores.map(listen));
  try {
    const initialized = await rpc(servers[0].origin, { method: "initialize" });
    const sessionId = initialized.sessionId;
    assert.match(sessionId, /^armcp_/);

    const started = await rpc(servers[0].origin, {
      sessionId,
      id: 2,
      name: "agentrouter_connect",
      args: { client_name: "Rolling MCP" }
    });
    assert.equal(started.result.status, "authorization_required");

    await approveDeviceAuthorization(stores[1], {
      userCode: started.result.user_code,
      account: ACCOUNT
    });
    const connectedOnB = await rpc(servers[1].origin, {
      sessionId,
      id: 3,
      name: "agentrouter_connect"
    });
    assert.equal(connectedOnB.result.status, "connected");

    const connectedOnFreshC = await rpc(servers[2].origin, {
      sessionId,
      id: 4,
      name: "agentrouter_connect"
    });
    assert.equal(connectedOnFreshC.result.status, "connected");
    assert.ok(remote.records.size > 0, "remote MCP session must be durable");
    assert.doesNotMatch(JSON.stringify([...remote.records.values()]), /ar_device_|consumer_api_key|access_token/);

    credit.failNextKeyRead();
    const validationOutage = await rpc(servers[2].origin, {
      sessionId,
      id: 41,
      name: "agentrouter_connect"
    });
    assert.notEqual(validationOutage.result.status, "connected");
    assert.equal(validationOutage.result.status, "authorization_unavailable");
    assert.equal(validationOutage.result.retryable, true);

    const [key] = [...credit.keys.values()];
    assert.ok(key?.key_id);
    await revokeCreditApiKey(stores[0], { accountId: ACCOUNT.account_id, keyId: key.key_id });

    const blockedInvoke = await rpc(servers[2].origin, {
      sessionId,
      id: 5,
      name: "agentrouter_request",
      args: { capability: "token_price", params: { symbol: "BTC" } }
    });
    assert.equal(blockedInvoke.result.status, "connection_required");
    assert.equal(blockedInvoke.result.action_required?.preferred_tool, "agentrouter_connect");

    const reconnect = await rpc(servers[2].origin, {
      sessionId,
      id: 6,
      name: "agentrouter_connect"
    });
    assert.notEqual(reconnect.result.status, "connected");
    assert.match(reconnect.result.status, /authorization|required|revoked/);
  } finally {
    await Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve))));
  }
});

test("a revoked request-header API key is rejected before remote MCP invocation", async () => {
  const credit = createSharedCreditPersistence();
  const store = createInstance({
    device: createSharedDeviceAuthPersistence(),
    remote: createSharedRemoteMcpPersistence(),
    credit
  });
  const running = await listen(store);
  try {
    const service = registerService(store, baseFundFlowManifest, running.origin);
    service.verification_status = "verified";
    const created = await createCreditApiKey(store, { account: ACCOUNT, label: "Revocation boundary" });
    await grantCredits(store, { accountId: ACCOUNT.account_id, amount: "0.05" });
    const request = {
      apiKey: created.api_key,
      name: "agentrouter_request",
      args: {
        capability: "fund_flow",
        params: { chain: "base", days: 7 },
        constraints: { max_price_usdc: "0.05" }
      }
    };

    const allowed = await rpc(running.origin, { ...request, id: 10 });
    assert.equal(allowed.result.ok, true, JSON.stringify(allowed.result));
    const ledgerCount = store.creditLedger.length;

    await revokeCreditApiKey(store, { accountId: ACCOUNT.account_id, keyId: created.key_id });
    const blocked = await rpc(running.origin, {
      ...request,
      sessionId: allowed.sessionId,
      id: 11
    });
    assert.equal(blocked.result.status, "connection_required");
    assert.equal(blocked.result.action_required?.preferred_tool, "agentrouter_connect");
    assert.equal(store.creditLedger.length, ledgerCount, "revoked credentials must not reach billing or provider invocation");
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test("an unreadable persisted MCP session fails closed with a typed reconnect", async () => {
  const remote = createSharedRemoteMcpPersistence();
  const common = {
    device: createSharedDeviceAuthPersistence(),
    remote,
    credit: createSharedCreditPersistence()
  };
  const first = await listen(createInstance(common));
  const second = await listen(createInstance(common));
  try {
    const initialized = await rpc(first.origin, { method: "initialize" });
    const [record] = [...remote.records.values()];
    record.state_opaque.ciphertext = `${record.state_opaque.ciphertext[0] === "A" ? "B" : "A"}${record.state_opaque.ciphertext.slice(1)}`;
    remote.records.set(record.session_id_hash, record);

    const response = await rpc(second.origin, {
      sessionId: initialized.sessionId,
      id: 20,
      name: "agentrouter_request",
      args: { capability: "token_price", params: { symbol: "BTC" } }
    });
    assert.equal(response.result.status, "connection_required");
    assert.equal(response.result.action_required?.preferred_tool, "agentrouter_connect");
    assert.match(response.result.pending_reason, /session|reconnect/);
  } finally {
    await Promise.all([first, second].map(({ server }) => new Promise((resolve) => server.close(resolve))));
  }
});
