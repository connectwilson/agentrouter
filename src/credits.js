import crypto from "node:crypto";

import { authUserKey } from "./auth.js";
import {
  listPersistentCreditLedger,
  listPersistentCreditApiKeys,
  persistenceEnabled,
  persistentCreditBalance,
  readPersistentCreditAccountByOwner,
  readPersistentCreditAccountByDepositAddress,
  readPersistentCreditApiKeyByHash,
  touchPersistentCreditApiKey,
  revokePersistentCreditApiKey,
  upsertPersistentCreditAccount,
  writePersistentCreditApiKey,
  writePersistentCreditLedgerEntry
} from "./persistence.js";

export const CREDIT_DECIMALS = 6;
export const CREDIT_SCALE = 10 ** CREDIT_DECIMALS;

export function creditsToAtomic(value, { allowZero = false } = {}) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw creditAmountError("Credit amount must be a positive decimal number.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > CREDIT_DECIMALS) throw creditAmountError("Credit amounts support at most six decimal places.");
  const atomic = (Number(whole) * CREDIT_SCALE) + Number(fraction.padEnd(CREDIT_DECIMALS, "0"));
  if (!Number.isSafeInteger(atomic)) throw creditAmountError("Credit amount is too large.");
  if (atomic < 0 || (!allowZero && atomic === 0)) throw creditAmountError("Credit amount must be positive.");
  return atomic;
}

export function atomicToCredits(value) {
  const atomic = Number(value || 0);
  if (!Number.isSafeInteger(atomic)) throw creditAmountError("Credit atomic amount must be a safe integer.");
  const sign = atomic < 0 ? "-" : "";
  const absolute = Math.abs(atomic);
  const whole = Math.floor(absolute / CREDIT_SCALE);
  const fraction = String(absolute % CREDIT_SCALE).padStart(CREDIT_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export async function ensureCreditAccount(store, user) {
  const ownerKey = authUserKey(user);
  if (!ownerKey) throw creditError("A signed-in user is required.", 401, "AUTHENTICATION_REQUIRED");

  const persistence = creditStatePersistence(store);
  const cached = store.creditAccounts.get(ownerKey);
  if (persistence.enabled) {
    const persisted = await persistence.readAccountByOwner(ownerKey);
    if (persisted) {
      store.creditAccounts.set(ownerKey, persisted);
      return persisted;
    }
  } else if (cached) return cached;

  const account = {
    account_id: stableId("acct", ownerKey),
    owner_key: ownerKey,
    user_profile: publicUserProfile(user),
    settings: { max_price_per_call: DEFAULT_MAX_PRICE_PER_CALL },
    deposit_address: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const saved = persistence.enabled ? await persistence.upsertAccount(account) : account;
  store.creditAccounts.set(ownerKey, saved);
  return saved;
}

// A balance an agent can spend without asking is only safe with a ceiling on
// any one call. Without it a single mispriced or misrouted request can drain
// the account, and the agent is by design not pausing to check.
export const DEFAULT_MAX_PRICE_PER_CALL = String(process.env.ADN_CREDITS_DEFAULT_MAX_PER_CALL || "2");
const MAX_SPEND_LIMIT = 1000;

export function accountSpendLimit(account) {
  const configured = account?.settings?.max_price_per_call;
  const value = configured === undefined || configured === null || configured === ""
    ? DEFAULT_MAX_PRICE_PER_CALL
    : configured;
  return String(value);
}

export function normalizeSpendLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw creditError("A per-call limit must be a positive number of credits.", 400, "INVALID_SPEND_LIMIT");
  }
  if (number > MAX_SPEND_LIMIT) {
    throw creditError(`A per-call limit cannot exceed ${MAX_SPEND_LIMIT} credits.`, 400, "SPEND_LIMIT_TOO_HIGH");
  }
  creditsToAtomic(number);
  return String(number);
}

// Checked before the debit, not after: refusing a call costs nothing, whereas
// debiting and refunding leaves the caller charged for a request it was never
// allowed to make.
export function assertWithinSpendLimit(account, amount) {
  const limit = accountSpendLimit(account);
  if (creditsToAtomic(amount, { allowZero: true }) > creditsToAtomic(limit)) {
    throw creditError(
      `This call costs ${amount} credits, above the ${limit} per-call limit on this account.`,
      402,
      "SPEND_LIMIT_EXCEEDED"
    );
  }
  return limit;
}

export async function setAccountSpendLimit(store, { account, maxPricePerCall }) {
  if (!account?.account_id) throw creditError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  const limit = normalizeSpendLimit(maxPricePerCall);
  const updated = {
    ...account,
    settings: { ...(account.settings || {}), max_price_per_call: limit },
    updated_at: new Date().toISOString()
  };
  const persistence = creditStatePersistence(store);
  const saved = persistence.enabled ? await persistence.upsertAccount(updated) : updated;
  const merged = { ...updated, ...(saved || {}) };
  store.creditAccounts.set(merged.owner_key, merged);
  return { account_id: merged.account_id, max_price_per_call: accountSpendLimit(merged) };
}

// Binding is one-way and first-come: an address that has paid one account can
// never later credit a different one.
export async function bindDepositAddress(store, account, depositAddress) {
  const address = String(depositAddress || "").toLowerCase();
  if (!address || account.deposit_address === address) return account;
  const updated = { ...account, deposit_address: address, updated_at: new Date().toISOString() };
  const persistence = creditStatePersistence(store);
  const saved = persistence.enabled ? await persistence.upsertAccount(updated) : updated;
  const merged = { ...updated, ...(saved || {}) };
  store.creditAccounts.set(merged.owner_key, merged);
  return merged;
}

export async function findAccountByDepositAddress(store, depositAddress) {
  const address = String(depositAddress || "").toLowerCase();
  if (!address) return null;
  const persistence = creditStatePersistence(store);
  if (persistence.enabled) {
    const account = await persistence.readAccountByDepositAddress(address);
    if (account?.owner_key) store.creditAccounts.set(account.owner_key, account);
    return account;
  }
  for (const account of store.creditAccounts.values()) {
    if (String(account.deposit_address || "").toLowerCase() === address) return account;
  }
  return null;
}

export async function createCreditApiKey(store, {
  account,
  label = "AgentRouter client",
  authMethod = "api_key",
  clientName = null,
  prefix = "ar_live"
}) {
  if (!account?.account_id) throw creditError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  const rawKey = `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
  // 192 bits of entropy; showing 6 leading and 4 trailing characters leaves
  // well over 100, which is what makes a recognisable hint safe to store.
  const keyPrefix = `${rawKey.slice(0, prefix.length + 7)}…${rawKey.slice(-4)}`;
  const record = {
    key_id: `key_${crypto.randomUUID()}`,
    account_id: account.account_id,
    owner_key: account.owner_key || null,
    user_profile: account.user_profile || {},
    key_hash: hashApiKey(rawKey),
    key_prefix: keyPrefix,
    last_used_at: null,
    label: String(label || "AgentRouter client").slice(0, 120),
    auth_method: authMethod === "device" ? "device" : "api_key",
    client_name: clientName ? String(clientName).slice(0, 120) : null,
    created_at: new Date().toISOString(),
    revoked_at: null
  };
  const persistence = creditStatePersistence(store);
  const persisted = persistence.enabled ? await persistence.writeApiKey(record) : null;
  const saved = persisted ? { ...persisted, owner_key: record.owner_key, user_profile: record.user_profile } : record;
  store.creditApiKeys.set(record.key_hash, saved);
  return {
    key_id: saved.key_id,
    label: saved.label,
    key_prefix: saved.key_prefix || keyPrefix,
    api_key: rawKey,
    created_at: saved.created_at,
    auth_method: saved.auth_method || record.auth_method,
    client_name: saved.client_name || record.client_name
  };
}

export async function listCreditApiKeys(store, accountId, { limit = 100 } = {}) {
  const persistence = creditStatePersistence(store);
  const rows = persistence.enabled
    ? await persistence.listApiKeys(accountId, { limit })
    : [...store.creditApiKeys.values()]
      .filter((key) => key.account_id === accountId)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  return rows.map((key) => ({
    key_id: key.key_id,
    label: key.label || "AgentRouter client",
    created_at: key.created_at,
    revoked_at: key.revoked_at || null,
    status: key.revoked_at ? "revoked" : "active",
    auth_method: key.auth_method || "api_key",
    client_name: key.client_name || null,
    key_prefix: key.key_prefix || null,
    last_used_at: key.last_used_at || null
  }));
}

export async function revokeCreditApiKey(store, { accountId, keyId }) {
  if (!accountId || !keyId) throw creditError("API key not found.", 404, "API_KEY_NOT_FOUND");
  const persistence = creditStatePersistence(store);
  let revoked;
  if (persistence.enabled) {
    revoked = await persistence.revokeApiKey(accountId, keyId);
  } else {
    revoked = [...store.creditApiKeys.values()].find((key) => key.account_id === accountId && key.key_id === keyId) || null;
    if (revoked) revoked.revoked_at ||= new Date().toISOString();
  }
  if (!revoked) throw creditError("API key not found.", 404, "API_KEY_NOT_FOUND");

  for (const [keyHash, cached] of store.creditApiKeys.entries()) {
    if (cached.account_id === accountId && cached.key_id === keyId) {
      store.creditApiKeys.set(keyHash, { ...cached, revoked_at: revoked.revoked_at });
    }
  }
  return {
    key_id: revoked.key_id,
    label: revoked.label || "AgentRouter client",
    auth_method: revoked.auth_method || "api_key",
    client_name: revoked.client_name || null,
    status: "revoked",
    revoked_at: revoked.revoked_at
  };
}

export function creditApiKeyFromRequest(req) {
  const headers = req?.headers || {};
  const direct = headerValue(headers, "x-agentrouter-api-key") || headerValue(headers, "x-api-key");
  if (direct) return String(direct).trim();
  const authorization = String(headerValue(headers, "authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

// "Last used" is worth a timestamp, not a database write per request. Recorded
// at most once every few minutes; a stale-by-minutes value tells the reader
// everything a fresh one would.
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

function markKeyUsed(store, key, persistence) {
  const now = Date.now();
  const previous = key.last_used_at ? new Date(key.last_used_at).getTime() : 0;
  if (now - previous < LAST_USED_THROTTLE_MS) return;
  key.last_used_at = new Date(now).toISOString();
  store.creditApiKeys.set(key.key_hash, key);
  if (persistence.enabled) {
    // Fire and forget: a call must not fail because bookkeeping did.
    persistence.touchApiKey(key.key_id).catch(() => {});
  }
}

async function accountSettingsForOwner(store, ownerKey, persistence) {
  if (!persistence.enabled) return store.creditAccounts.get(ownerKey) || null;
  const account = await persistence.readAccountByOwner(ownerKey);
  if (account) store.creditAccounts.set(ownerKey, account);
  else store.creditAccounts.delete(ownerKey);
  return account;
}

export async function authenticateCreditRequest(store, req) {
  const rawKey = creditApiKeyFromRequest(req);
  if (!rawKey) return null;
  const keyHash = hashApiKey(rawKey);
  const persistence = creditStatePersistence(store);
  const cached = store.creditApiKeys.get(keyHash) || null;
  let key = persistence.enabled
    ? await persistence.readApiKeyByHash(keyHash)
    : cached;
  if (!key || key.revoked_at) {
    store.creditApiKeys.delete(keyHash);
    return null;
  }
  if (!key.last_used_at && cached?.last_used_at) key = { ...key, last_used_at: cached.last_used_at };
  store.creditApiKeys.set(keyHash, key);
  // Settings travel with the account, not the key. Returning an account without
  // them made every spend limit read as the default: the ceiling a user set in
  // the dashboard had no effect on the one path that matters, agent calls
  // authenticated by API key.
  const owner = key.owner_key ? await accountSettingsForOwner(store, key.owner_key, persistence) : null;
  if (persistence.enabled && (!key.owner_key || !owner)) {
    store.creditApiKeys.delete(keyHash);
    return null;
  }
  markKeyUsed(store, key, persistence);
  return {
    account: {
      account_id: key.account_id,
      owner_key: key.owner_key || null,
      user_profile: key.user_profile || {},
      settings: owner?.settings || {},
      deposit_address: owner?.deposit_address || null
    },
    key: {
      key_id: key.key_id,
      label: key.label || null,
      created_at: key.created_at || null,
      auth_method: key.auth_method || "api_key",
      client_name: key.client_name || null
    }
  };
}

export async function getCreditBalance(store, accountId) {
  const atomic = persistenceEnabled()
    ? await persistentCreditBalance(accountId)
    : store.creditLedger.filter((entry) => entry.account_id === accountId).reduce((sum, entry) => sum + Number(entry.delta_atomic), 0);
  return atomicToCredits(atomic);
}

export async function listCreditLedger(store, accountId, { limit = 100 } = {}) {
  const rows = persistenceEnabled()
    ? await listPersistentCreditLedger(accountId, { limit })
    : store.creditLedger
      .filter((entry) => entry.account_id === accountId)
      .reverse()
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  return rows.map(publicLedgerEntry);
}

export async function grantCredits(store, { accountId, amount, kind = "topup", serviceId = null, requestId = null, metadata = {}, entryId = null }) {
  return writeLedgerEntry(store, {
    accountId,
    deltaAtomic: creditsToAtomic(amount),
    kind,
    serviceId,
    requestId,
    metadata,
    entryId
  });
}

export async function refundCredits(store, { accountId, amount, serviceId, requestId, metadata = {} }) {
  return grantCredits(store, {
    accountId,
    amount,
    kind: "refund",
    serviceId,
    requestId,
    metadata
  });
}

export async function debitCredits(store, { accountId, amount, serviceId, requestId, metadata = {} }) {
  return writeLedgerEntry(store, {
    accountId,
    deltaAtomic: -creditsToAtomic(amount),
    kind: "service_call",
    serviceId,
    requestId,
    metadata,
    requireSufficientBalance: true
  });
}

export function creditPaymentRequired({ amount, currency = "credits", baseUrl = "" }) {
  return {
    error: "Payment Required",
    code: "CREDITS_REQUIRED",
    payment: {
      backend: "credits",
      amount: String(amount),
      currency,
      account_url: baseUrl ? new URL("/account", baseUrl).toString() : "/account",
      topup_url: baseUrl ? new URL("/account/credits/topup", baseUrl).toString() : "/account/credits/topup"
    }
  };
}

async function writeLedgerEntry(store, { accountId, deltaAtomic, kind, serviceId = null, requestId = null, metadata = {}, requireSufficientBalance = false, entryId = null }) {
  if (!accountId) throw creditError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  entryId ||= `cle_${crypto.randomUUID()}`;
  let row;
  if (persistenceEnabled()) {
    row = await writePersistentCreditLedgerEntry({
      entryId,
      accountId,
      deltaAtomic,
      kind,
      serviceId,
      requestId,
      metadata,
      requireSufficientBalance
    });
  } else {
    const existing = store.creditLedger.find((entry) => entry.entry_id === entryId);
    if (existing) return publicLedgerEntry(existing);
    const balanceBefore = store.creditLedger
      .filter((entry) => entry.account_id === accountId)
      .reduce((sum, entry) => sum + Number(entry.delta_atomic), 0);
    const balanceAfter = balanceBefore + deltaAtomic;
    if (requireSufficientBalance && balanceAfter < 0) {
      const error = creditError("Insufficient credits.", 402, "INSUFFICIENT_CREDITS");
      error.balance_atomic = balanceBefore;
      error.required_atomic = Math.abs(deltaAtomic);
      throw error;
    }
    row = {
      entry_id: entryId,
      account_id: accountId,
      delta_atomic: deltaAtomic,
      balance_after_atomic: balanceAfter,
      currency: "credits",
      kind,
      service_id: serviceId,
      request_id: requestId,
      metadata,
      created_at: new Date().toISOString()
    };
    store.creditLedger.push(row);
  }
  return publicLedgerEntry(row);
}

function publicLedgerEntry(row) {
  return {
    entry_id: row.entry_id,
    account_id: row.account_id,
    delta: atomicToCredits(row.delta_atomic),
    balance: atomicToCredits(row.balance_after_atomic),
    currency: row.currency || "credits",
    kind: row.kind,
    service_id: row.service_id || null,
    request_id: row.request_id || null,
    metadata: row.metadata || {},
    created_at: row.created_at
  };
}

function publicUserProfile(user) {
  return {
    provider: user.provider || null,
    id: user.id ? String(user.id) : null,
    name: user.name || null,
    email: user.email || null,
    handle: user.handle || null,
    avatar_url: user.avatar_url || null
  };
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function hashApiKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function headerValue(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function creditStatePersistence(store) {
  if (store?.creditPersistence) {
    return {
      enabled: store.creditPersistence.enabled !== false,
      readAccountByOwner: store.creditPersistence.readAccountByOwner?.bind(store.creditPersistence),
      readAccountByDepositAddress: store.creditPersistence.readAccountByDepositAddress?.bind(store.creditPersistence),
      upsertAccount: store.creditPersistence.upsertAccount?.bind(store.creditPersistence),
      writeApiKey: store.creditPersistence.writeApiKey?.bind(store.creditPersistence),
      listApiKeys: store.creditPersistence.listApiKeys?.bind(store.creditPersistence),
      readApiKeyByHash: store.creditPersistence.readApiKeyByHash?.bind(store.creditPersistence),
      revokeApiKey: store.creditPersistence.revokeApiKey?.bind(store.creditPersistence),
      touchApiKey: store.creditPersistence.touchApiKey?.bind(store.creditPersistence)
    };
  }
  return {
    enabled: persistenceEnabled(),
    readAccountByOwner: readPersistentCreditAccountByOwner,
    readAccountByDepositAddress: readPersistentCreditAccountByDepositAddress,
    upsertAccount: upsertPersistentCreditAccount,
    writeApiKey: writePersistentCreditApiKey,
    listApiKeys: listPersistentCreditApiKeys,
    readApiKeyByHash: readPersistentCreditApiKeyByHash,
    revokeApiKey: revokePersistentCreditApiKey,
    touchApiKey: touchPersistentCreditApiKey
  };
}

function creditAmountError(message) {
  return creditError(message, 400, "INVALID_CREDIT_AMOUNT");
}

function creditError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
