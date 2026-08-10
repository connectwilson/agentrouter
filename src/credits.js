import crypto from "node:crypto";

import { authUserKey } from "./auth.js";
import {
  listPersistentCreditLedger,
  listPersistentCreditApiKeys,
  persistenceEnabled,
  persistentCreditBalance,
  readPersistentCreditAccountByOwner,
  readPersistentCreditApiKeyByHash,
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

  const cached = store.creditAccounts.get(ownerKey);
  if (cached) return cached;

  if (persistenceEnabled()) {
    const persisted = await readPersistentCreditAccountByOwner(ownerKey);
    if (persisted) {
      store.creditAccounts.set(ownerKey, persisted);
      return persisted;
    }
  }

  const account = {
    account_id: stableId("acct", ownerKey),
    owner_key: ownerKey,
    user_profile: publicUserProfile(user),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const saved = persistenceEnabled() ? await upsertPersistentCreditAccount(account) : account;
  store.creditAccounts.set(ownerKey, saved);
  return saved;
}

export async function createCreditApiKey(store, { account, label = "AgentRouter client" }) {
  if (!account?.account_id) throw creditError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  const rawKey = `ar_live_${crypto.randomBytes(24).toString("base64url")}`;
  const record = {
    key_id: `key_${crypto.randomUUID()}`,
    account_id: account.account_id,
    owner_key: account.owner_key || null,
    user_profile: account.user_profile || {},
    key_hash: hashApiKey(rawKey),
    label: String(label || "AgentRouter client").slice(0, 120),
    created_at: new Date().toISOString(),
    revoked_at: null
  };
  const persisted = persistenceEnabled() ? await writePersistentCreditApiKey(record) : null;
  const saved = persisted ? { ...persisted, owner_key: record.owner_key, user_profile: record.user_profile } : record;
  store.creditApiKeys.set(record.key_hash, saved);
  return {
    key_id: saved.key_id,
    label: saved.label,
    api_key: rawKey,
    created_at: saved.created_at
  };
}

export async function listCreditApiKeys(store, accountId, { limit = 100 } = {}) {
  const rows = persistenceEnabled()
    ? await listPersistentCreditApiKeys(accountId, { limit })
    : [...store.creditApiKeys.values()]
      .filter((key) => key.account_id === accountId)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  return rows.map((key) => ({
    key_id: key.key_id,
    label: key.label || "AgentRouter client",
    created_at: key.created_at,
    revoked_at: key.revoked_at || null,
    status: key.revoked_at ? "revoked" : "active"
  }));
}

export function creditApiKeyFromRequest(req) {
  const headers = req?.headers || {};
  const direct = headerValue(headers, "x-agentrouter-api-key") || headerValue(headers, "x-api-key");
  if (direct) return String(direct).trim();
  const authorization = String(headerValue(headers, "authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export async function authenticateCreditRequest(store, req) {
  const rawKey = creditApiKeyFromRequest(req);
  if (!rawKey) return null;
  const keyHash = hashApiKey(rawKey);
  let key = store.creditApiKeys.get(keyHash) || null;
  if (!key && persistenceEnabled()) key = await readPersistentCreditApiKeyByHash(keyHash);
  if (!key || key.revoked_at) return null;
  store.creditApiKeys.set(keyHash, key);
  return {
    account: {
      account_id: key.account_id,
      owner_key: key.owner_key || null,
      user_profile: key.user_profile || {}
    },
    key: {
      key_id: key.key_id,
      label: key.label || null,
      created_at: key.created_at || null
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

function creditAmountError(message) {
  return creditError(message, 400, "INVALID_CREDIT_AMOUNT");
}

function creditError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
