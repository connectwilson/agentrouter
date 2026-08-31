import crypto from "node:crypto";

let poolPromise = null;
let schemaReady = false;

export function persistenceEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export async function persistenceReadiness() {
  if (!persistenceEnabled()) {
    const required = persistentRegistryRequired();
    return {
      ok: !required,
      checks: { database: { ok: !required, configured: false, ...(required ? { error: "DATABASE_URL is required in hosted runtime." } : {}) } }
    };
  }
  try {
    const pool = await getPool();
    await pool.query("select 1");
    return { ok: true, checks: { database: { ok: true, configured: true } } };
  } catch (error) {
    return { ok: false, checks: { database: { ok: false, configured: true, error: error.message } } };
  }
}

export async function claimPersistentBrowserHandoff(handoffId, expiresAt) {
  if (!persistenceEnabled()) return true;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_browser_handoff_claims where expires_at < now()");
  const result = await pool.query(
    `insert into adn_browser_handoff_claims (handoff_id, expires_at, consumed_at)
     values ($1, $2::timestamptz, now())
     on conflict (handoff_id) do nothing
     returning handoff_id`,
    [String(handoffId || ""), String(expiresAt || "")]
  );
  return result.rowCount === 1;
}

export function persistentRegistryRequired() {
  return process.env.ADN_REQUIRE_PERSISTENT_REGISTRY === "true" || Boolean(process.env.RENDER);
}

export function providerSecretPassphraseConfigured() {
  return Boolean(process.env.ADN_PROVIDER_SECRET_PASSPHRASE);
}

export function assertPersistentProviderStorageReady({ requiresSecret = false } = {}) {
  if (persistentRegistryRequired() && !persistenceEnabled()) {
    const error = new Error("Persistent registry is required for hosted Provider Studio publishing. Configure DATABASE_URL instead of storing provider services in runtime memory.");
    error.statusCode = 503;
    error.code = "PERSISTENT_REGISTRY_REQUIRED";
    throw error;
  }
  if ((persistentRegistryRequired() || persistenceEnabled()) && requiresSecret && !providerSecretPassphraseConfigured()) {
    const error = new Error("ADN_PROVIDER_SECRET_PASSPHRASE is required to persist provider credentials. It is a platform encryption key, not a provider API key.");
    error.statusCode = 503;
    error.code = "PROVIDER_SECRET_PASSPHRASE_REQUIRED";
    throw error;
  }
}

export async function writePersistentProviderConfig(config) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_provider_configs (service_id, config, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (service_id)
     do update set config = excluded.config, updated_at = now()`,
    [config.manifest.service_id, JSON.stringify(config)]
  );
  return true;
}

export async function readPersistentProviderConfig(serviceId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select config from adn_provider_configs where service_id = $1",
    [serviceId]
  );
  return result.rows[0]?.config || null;
}

export async function deletePersistentProviderConfig(serviceId) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_provider_configs where service_id = $1", [serviceId]);
  return true;
}

export async function listPersistentProviderConfigs() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select config from adn_provider_configs order by updated_at asc, service_id asc"
  );
  return result.rows.map((row) => row.config);
}

export async function writePersistentServiceEvent({ eventType, serviceId, requestId, event }) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  const idempotencyKey = serviceEventIdempotencyKey({ eventType, serviceId, requestId, event });
  await pool.query(
    `insert into adn_service_events (event_type, service_id, request_id, event, idempotency_key, created_at)
     values ($1, $2, $3, $4::jsonb, $5, coalesce(($4::jsonb->>'created_at')::timestamptz, now()))
     on conflict (idempotency_key) where idempotency_key is not null do nothing`,
    [eventType, serviceId || null, requestId || null, JSON.stringify(event), idempotencyKey]
  );
  return true;
}

export function serviceEventIdempotencyKey({ eventType, serviceId, requestId, event }) {
  const idempotentTypes = new Set([
    "consumer_feedback",
    "consumer_feedback_anchor",
    "consumer_feedback_erc8004_client",
    "feedback_grant",
    "issued_quote",
    "quote_feedback",
    "erc8004_platform_identity",
    "erc8004_vendor_identity",
    "erc8004_agent_import"
  ]);
  if (!idempotentTypes.has(eventType) || !requestId) return null;
  return crypto.createHash("sha256").update(JSON.stringify([
    eventType,
    serviceId || "",
    requestId,
    event?.consumer_id
      || event?.actor_key
      || (eventType === "erc8004_agent_import" ? event?.verified_at || event?.imported_at : "")
  ])).digest("hex");
}

export async function listPersistentServiceEvents({ limit = 10000 } = {}) {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select event_type, service_id, request_id, event, created_at
     from adn_service_events
     order by created_at asc, event_id asc
     limit $1`,
    [Math.max(1, Math.min(100000, Number(limit) || 10000))]
  );
  return result.rows.map((row) => ({
    event_type: row.event_type,
    service_id: row.service_id,
    request_id: row.request_id,
    event: row.event,
    created_at: row.created_at
  }));
}

export async function deletePersistentProviderSecret(secretRef) {
  if (!persistenceEnabled() || !secretRef) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_provider_secrets where secret_ref = $1", [secretRef]);
  return true;
}

export async function writePersistentProviderSecret(secretRef, encrypted) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_provider_secrets (secret_ref, encrypted, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (secret_ref)
     do update set encrypted = excluded.encrypted, updated_at = now()`,
    [secretRef, JSON.stringify(encrypted)]
  );
  return true;
}

export async function readPersistentProviderSecret(secretRef) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select encrypted from adn_provider_secrets where secret_ref = $1",
    [secretRef]
  );
  return result.rows[0]?.encrypted || null;
}

export async function writePersistentSocialConnection(connection) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_social_connections (connection_id, owner_key, connection, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (connection_id)
     do update set owner_key = excluded.owner_key, connection = excluded.connection, updated_at = now()`,
    [connection.connection_id, connection.owner_key, JSON.stringify(connection)]
  );
  return true;
}

export async function listPersistentSocialConnections() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query("select connection from adn_social_connections order by updated_at asc");
  return result.rows.map((row) => row.connection);
}

export async function writePersistentPublicApiCandidates(candidates) {
  if (!persistenceEnabled()) return false;
  if (!candidates.length) return true;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_public_api_catalog (candidate_id, candidate, updated_at)
     select item->>'candidate_id', item, now()
     from jsonb_array_elements($1::jsonb) as item
     where nullif(item->>'candidate_id', '') is not null
     on conflict (candidate_id)
     do update set candidate = excluded.candidate, updated_at = now()`,
    [JSON.stringify(candidates)]
  );
  return true;
}

export async function listPersistentPublicApiCandidates() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select candidate from adn_public_api_catalog order by updated_at asc, candidate_id asc"
  );
  return result.rows.map((row) => row.candidate);
}

export async function writePersistentPublicApiPipelineRun(run) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_public_api_pipeline_runs (run_id, run, created_at)
     values ($1, $2::jsonb, coalesce(($2::jsonb->>'created_at')::timestamptz, now()))
     on conflict (run_id) do nothing`,
    [run.run_id, JSON.stringify(run)]
  );
  return true;
}

export async function listPersistentPublicApiPipelineRuns({ limit = 100 } = {}) {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select run from adn_public_api_pipeline_runs
     order by created_at desc
     limit $1`,
    [Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  return result.rows.map((row) => row.run);
}

export async function deletePersistentSocialConnection(connectionId, ownerKey) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_social_connections where connection_id = $1 and owner_key = $2", [connectionId, ownerKey]);
  return true;
}

export async function upsertPersistentCreditAccount(account) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `insert into adn_credit_accounts (account_id, owner_key, user_profile, settings, deposit_address, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, now())
     on conflict (owner_key)
     do update set
       user_profile = excluded.user_profile,
       settings = excluded.settings,
       -- Once bound, a deposit address is never cleared by a later write that
       -- happens not to carry one.
       deposit_address = coalesce(excluded.deposit_address, adn_credit_accounts.deposit_address),
       updated_at = now()
     returning account_id, owner_key, user_profile, settings, deposit_address, created_at, updated_at`,
    [
      account.account_id,
      account.owner_key,
      JSON.stringify(account.user_profile || {}),
      JSON.stringify(account.settings || {}),
      account.deposit_address || null
    ]
  );
  return result.rows[0] || null;
}

export async function readPersistentCreditAccountByDepositAddress(depositAddress) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select account_id, owner_key, user_profile, settings, deposit_address, created_at, updated_at
     from adn_credit_accounts
     where deposit_address = $1`,
    [String(depositAddress || "").toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function readPersistentCreditAccountByOwner(ownerKey) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select account_id, owner_key, user_profile, settings, deposit_address, created_at, updated_at
     from adn_credit_accounts
     where owner_key = $1`,
    [ownerKey]
  );
  return result.rows[0] || null;
}

export async function writePersistentCreditApiKey(keyRecord) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `insert into adn_credit_api_keys (key_id, account_id, key_hash, label, auth_method, client_name, key_prefix, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning key_id, account_id, key_hash, label, auth_method, client_name, key_prefix, last_used_at, created_at, revoked_at`,
    [keyRecord.key_id, keyRecord.account_id, keyRecord.key_hash, keyRecord.label || null, keyRecord.auth_method || "api_key", keyRecord.client_name || null, keyRecord.key_prefix || null]
  );
  return result.rows[0] || null;
}

// Throttled by the caller: a write on every request would cost more than the
// information is worth.
export async function touchPersistentCreditApiKey(keyId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(`update adn_credit_api_keys set last_used_at = now() where key_id = $1`, [keyId]);
  return true;
}

export async function readPersistentCreditApiKeyByHash(keyHash) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select k.key_id, k.account_id, k.key_hash, k.label, k.auth_method, k.client_name, k.created_at, k.revoked_at,
            a.owner_key, a.user_profile
     from adn_credit_api_keys k
     join adn_credit_accounts a on a.account_id = k.account_id
     where k.key_hash = $1 and k.revoked_at is null`,
    [keyHash]
  );
  return result.rows[0] || null;
}

export async function listPersistentCreditApiKeys(accountId, { limit = 100 } = {}) {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select key_id, account_id, label, auth_method, client_name, key_prefix, last_used_at, created_at, revoked_at
     from adn_credit_api_keys
     where account_id = $1
     order by created_at desc
     limit $2`,
    [accountId, Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  return result.rows;
}

export async function revokePersistentCreditApiKey(accountId, keyId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_credit_api_keys
     set revoked_at = coalesce(revoked_at, now())
     where account_id = $1 and key_id = $2
     returning key_id, account_id, label, auth_method, client_name, created_at, revoked_at`,
    [accountId, keyId]
  );
  return result.rows[0] || null;
}

export async function listPersistentCreditLedger(accountId, { limit = 100 } = {}) {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select entry_id, account_id, delta_atomic, balance_after_atomic, currency, kind,
            service_id, request_id, metadata, created_at
     from adn_credit_ledger
     where account_id = $1
     order by created_at desc
     limit $2`,
    [accountId, Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  return result.rows;
}

export async function persistentCreditBalance(accountId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select coalesce(sum(delta_atomic), 0)::bigint as balance_atomic from adn_credit_ledger where account_id = $1",
    [accountId]
  );
  return Number(result.rows[0]?.balance_atomic || 0);
}

export async function writePersistentCreditLedgerEntry({ entryId, accountId, deltaAtomic, currency = "credits", kind, serviceId = null, requestId = null, metadata = {}, requireSufficientBalance = false }) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const account = await client.query("select account_id from adn_credit_accounts where account_id = $1 for update", [accountId]);
    if (!account.rows.length) {
      const error = new Error("Credit account not found.");
      error.statusCode = 404;
      error.code = "CREDIT_ACCOUNT_NOT_FOUND";
      throw error;
    }
    const existing = await client.query(
      `select entry_id, account_id, delta_atomic, balance_after_atomic, currency, kind,
              service_id, request_id, metadata, created_at
       from adn_credit_ledger where entry_id = $1`,
      [entryId]
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0];
    }
    const balanceResult = await client.query(
      "select coalesce(sum(delta_atomic), 0)::bigint as balance_atomic from adn_credit_ledger where account_id = $1",
      [accountId]
    );
    const balanceBefore = Number(balanceResult.rows[0]?.balance_atomic || 0);
    const balanceAfter = balanceBefore + Number(deltaAtomic);
    if (requireSufficientBalance && balanceAfter < 0) {
      const error = new Error("Insufficient credits.");
      error.statusCode = 402;
      error.code = "INSUFFICIENT_CREDITS";
      error.balance_atomic = balanceBefore;
      error.required_atomic = Math.abs(Number(deltaAtomic));
      throw error;
    }
    const inserted = await client.query(
      `insert into adn_credit_ledger
       (entry_id, account_id, delta_atomic, balance_after_atomic, currency, kind, service_id, request_id, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
       returning entry_id, account_id, delta_atomic, balance_after_atomic, currency, kind, service_id, request_id, metadata, created_at`,
      [entryId, accountId, Number(deltaAtomic), balanceAfter, currency, kind, serviceId, requestId, JSON.stringify(metadata || {})]
    );
    await client.query("commit");
    return inserted.rows[0] || null;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = import("pg").then(({ Pool }) => new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    }));
  }
  return poolPromise;
}

async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.query(`
    create table if not exists adn_provider_configs (
      service_id text primary key,
      config jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_provider_secrets (
      secret_ref text primary key,
      encrypted jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_social_connections (
      connection_id text primary key,
      owner_key text not null,
      connection jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists adn_social_connections_owner_idx on adn_social_connections(owner_key, updated_at desc);
    create table if not exists adn_service_events (
      event_id bigserial primary key,
      event_type text not null,
      service_id text,
      request_id text,
      event jsonb not null,
      idempotency_key text,
      created_at timestamptz not null default now()
    );
    alter table adn_service_events add column if not exists idempotency_key text;
    create unique index if not exists adn_service_events_idempotency_idx on adn_service_events(idempotency_key) where idempotency_key is not null;
    create index if not exists adn_service_events_service_idx on adn_service_events(service_id);
    create index if not exists adn_service_events_type_idx on adn_service_events(event_type);
    create index if not exists adn_service_events_request_idx on adn_service_events(request_id);
    create table if not exists adn_browser_handoff_claims (
      handoff_id text primary key,
      expires_at timestamptz not null,
      consumed_at timestamptz not null default now()
    );
    create index if not exists adn_browser_handoff_claims_expiry_idx on adn_browser_handoff_claims(expires_at);
    create table if not exists adn_credit_accounts (
      account_id text primary key,
      owner_key text not null unique,
      user_profile jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_credit_api_keys (
      key_id text primary key,
      account_id text not null references adn_credit_accounts(account_id),
      key_hash text not null unique,
      label text,
      auth_method text not null default 'api_key',
      client_name text,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );
    alter table adn_credit_api_keys add column if not exists auth_method text not null default 'api_key';
    alter table adn_credit_api_keys add column if not exists client_name text;
    -- Enough of the key to recognise which one a row is, never enough to use.
    alter table adn_credit_api_keys add column if not exists key_prefix text;
    alter table adn_credit_api_keys add column if not exists last_used_at timestamptz;
    alter table adn_credit_accounts add column if not exists settings jsonb not null default '{}'::jsonb;
    -- The sending address of a crypto deposit binds to the account that first
    -- claimed from it. Unique so two accounts can never claim the same wallet,
    -- which is what stops a deposit being credited to whoever saw it first.
    alter table adn_credit_accounts add column if not exists deposit_address text;
    create unique index if not exists adn_credit_accounts_deposit_address_idx
      on adn_credit_accounts (deposit_address) where deposit_address is not null;
    create table if not exists adn_credit_ledger (
      entry_id text primary key,
      account_id text not null references adn_credit_accounts(account_id),
      delta_atomic bigint not null,
      balance_after_atomic bigint not null,
      currency text not null default 'credits',
      kind text not null,
      service_id text,
      request_id text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists adn_public_api_catalog (
      candidate_id text primary key,
      candidate jsonb not null,
      updated_at timestamptz not null default now()
    );
    create index if not exists adn_public_api_catalog_status_idx on adn_public_api_catalog((candidate->>'status'));
    create table if not exists adn_public_api_pipeline_runs (
      run_id text primary key,
      run jsonb not null,
      created_at timestamptz not null default now()
    );
    create index if not exists adn_public_api_pipeline_runs_created_idx on adn_public_api_pipeline_runs(created_at desc);
    create index if not exists adn_credit_ledger_account_idx on adn_credit_ledger(account_id, created_at desc);
    create index if not exists adn_credit_api_keys_hash_idx on adn_credit_api_keys(key_hash);
  `);
  schemaReady = true;
}
