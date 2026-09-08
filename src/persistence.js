import crypto from "node:crypto";

let poolPromise = null;
let schemaReady = false;
let schemaPromise = null;
const PERSISTENCE_SCHEMA_LOCK_ID = 674312916;

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

export async function createPersistentDeviceAuthorization(record) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_device_authorizations where expires_at_ms < $1", [Date.now()]);
  const result = await pool.query(
    `insert into adn_device_authorizations (
       device_code_hash, user_code_hash, client_name, status,
       account_id, owner_key, created_at_ms, expires_at_ms,
       approved_at_ms, consumed_at_ms, last_poll_at_ms, poll_interval_ms
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict do nothing
     returning *`,
    deviceAuthorizationValues(record)
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function readPersistentDeviceAuthorizationByDeviceHash(deviceCodeHash) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select * from adn_device_authorizations where device_code_hash = $1",
    [String(deviceCodeHash || "")]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function readPersistentDeviceAuthorizationByUserHash(userCodeHash) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select * from adn_device_authorizations where user_code_hash = $1",
    [String(userCodeHash || "")]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function approvePersistentDeviceAuthorization(userCodeHash, { accountId, ownerKey, now }) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_device_authorizations
     set status = case when status = 'pending' then 'approved' else status end,
         account_id = case when status = 'pending' then $2 else account_id end,
         owner_key = case when status = 'pending' then $3 else owner_key end,
         approved_at_ms = case when status = 'pending' then $4 else approved_at_ms end
     where user_code_hash = $1
       and expires_at_ms > $4
       and status in ('pending', 'approved')
     returning *`,
    [String(userCodeHash || ""), String(accountId || ""), String(ownerKey || ""), Number(now)]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function updatePersistentDeviceAuthorizationPoll(deviceCodeHash, { lastPollAt, pollIntervalMs }) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_device_authorizations
     set last_poll_at_ms = $2, poll_interval_ms = $3
     where device_code_hash = $1 and status in ('pending', 'approved', 'issuing')
     returning *`,
    [String(deviceCodeHash || ""), Number(lastPollAt), Number(pollIntervalMs)]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function claimPersistentDeviceAuthorization(deviceCodeHash, now) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_device_authorizations
     set status = 'issuing'
     where device_code_hash = $1 and status = 'approved' and expires_at_ms > $2
     returning *`,
    [String(deviceCodeHash || ""), Number(now)]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function completePersistentDeviceAuthorization(deviceCodeHash, now) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_device_authorizations
     set status = 'consumed', consumed_at_ms = $2
     where device_code_hash = $1 and status = 'issuing'
     returning *`,
    [String(deviceCodeHash || ""), Number(now)]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function releasePersistentDeviceAuthorization(deviceCodeHash) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_device_authorizations
     set status = 'approved'
     where device_code_hash = $1 and status = 'issuing'
     returning *`,
    [String(deviceCodeHash || "")]
  );
  return normalizeDeviceAuthorizationRow(result.rows[0]);
}

export async function readPersistentRemoteMcpSession(sessionIdHash) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select session_id_hash, state_opaque, expires_at_ms from adn_remote_mcp_sessions where session_id_hash = $1",
    [String(sessionIdHash || "")]
  );
  const row = result.rows[0];
  return row ? {
    session_id_hash: row.session_id_hash,
    state_opaque: row.state_opaque,
    expires_at: Number(row.expires_at_ms)
  } : null;
}

export async function writePersistentRemoteMcpSession(record) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_remote_mcp_sessions where expires_at_ms < $1", [Date.now()]);
  const result = await pool.query(
    `insert into adn_remote_mcp_sessions (session_id_hash, state_opaque, expires_at_ms, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (session_id_hash)
     do update set state_opaque = excluded.state_opaque,
                   expires_at_ms = excluded.expires_at_ms,
                   updated_at = now()
     returning session_id_hash, state_opaque, expires_at_ms`,
    [String(record.session_id_hash || ""), JSON.stringify(record.state_opaque || {}), Number(record.expires_at)]
  );
  const row = result.rows[0];
  return row ? {
    session_id_hash: row.session_id_hash,
    state_opaque: row.state_opaque,
    expires_at: Number(row.expires_at_ms)
  } : null;
}

export async function deletePersistentRemoteMcpSession(sessionIdHash) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "delete from adn_remote_mcp_sessions where session_id_hash = $1",
    [String(sessionIdHash || "")]
  );
  return result.rowCount > 0;
}

// Settlement transactions are permanent value transfers, so their replay
// claims deliberately do not expire. The composite key preserves chain
// separation while the INSERT ... ON CONFLICT boundary makes the claim atomic
// across every server process sharing the database.
export async function claimPersistentSettlementTransaction({ chainId, txHash, serviceId = null, payer = null } = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `insert into adn_settlement_tx_claims (chain_id, tx_hash, service_id, payer, consumed_at)
     values ($1, $2, $3, $4, now())
     on conflict (chain_id, tx_hash) do nothing
     returning tx_hash`,
    [String(chainId || ""), String(txHash || "").toLowerCase(), serviceId, payer]
  );
  return result.rowCount === 1;
}

// Direct ERC-8004 hires can call an external Agent with side effects that
// AgentRouter cannot roll back. Claiming the caller-scoped idempotency key in
// Postgres before the network call therefore favors at-most-once execution:
// after an ambiguous crash, another instance reports the unresolved claim
// instead of silently calling the Agent again.
export async function claimPersistentErc8004Hire({
  claim_key: claimKey,
  request_hash: requestHash,
  request_id: requestId,
  service_id: serviceId
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const inserted = await pool.query(
    `insert into adn_erc8004_hire_requests
       (claim_key, request_hash, request_id, service_id, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'in_progress', now(), now())
     on conflict (claim_key) do nothing
     returning *`,
    [String(claimKey || ""), String(requestHash || ""), String(requestId || ""), String(serviceId || "")]
  );
  if (inserted.rowCount === 1) {
    return { claimed: true, record: normalizePersistentErc8004Hire(inserted.rows[0]) };
  }
  const existing = await pool.query(
    "select * from adn_erc8004_hire_requests where claim_key = $1",
    [String(claimKey || "")]
  );
  const record = await reconcilePersistentErc8004HireCompletion(pool, existing.rows[0]);
  return { claimed: false, record: normalizePersistentErc8004Hire(record) };
}

async function reconcilePersistentErc8004HireCompletion(pool, row) {
  if (!row || row.status === "completed") return row;
  const completion = await pool.query(
    `select event
     from adn_service_events
     where event_type = 'erc8004_hire_completion'
       and service_id = $1
       and request_id = $2
       and event->>'claim_key' = $3
       and event->>'request_hash' = $4
     order by created_at desc
     limit 1`,
    [row.service_id, row.request_id, row.claim_key, row.request_hash]
  );
  const response = completion.rows[0]?.event?.response_bundle;
  if (!response || typeof response !== "object") return row;
  const reconciled = await pool.query(
    `update adn_erc8004_hire_requests
     set status = 'completed', response = $3::jsonb, error = null, updated_at = now()
     where claim_key = $1 and request_hash = $2 and status <> 'completed'
     returning *`,
    [row.claim_key, row.request_hash, JSON.stringify(response)]
  );
  return reconciled.rows[0] || row;
}

export async function completePersistentErc8004Hire({
  claim_key: claimKey,
  request_hash: requestHash,
  response
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_erc8004_hire_requests
     set status = 'completed', response = $3::jsonb, error = null, updated_at = now()
     where claim_key = $1 and request_hash = $2 and status = 'in_progress'
     returning *`,
    [String(claimKey || ""), String(requestHash || ""), JSON.stringify(response || {})]
  );
  return normalizePersistentErc8004Hire(result.rows[0]);
}

export async function failPersistentErc8004Hire({
  claim_key: claimKey,
  request_hash: requestHash,
  error
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_erc8004_hire_requests
     set status = 'failed', error = $3, updated_at = now()
     where claim_key = $1 and request_hash = $2 and status = 'in_progress'
     returning *`,
    [String(claimKey || ""), String(requestHash || ""), String(error || "").slice(0, 2000)]
  );
  return normalizePersistentErc8004Hire(result.rows[0]);
}

function normalizePersistentErc8004Hire(row) {
  if (!row) return null;
  return {
    claim_key: row.claim_key,
    request_hash: row.request_hash,
    request_id: row.request_id,
    service_id: row.service_id,
    status: row.status,
    response: row.response || null,
    error: row.error || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// Evidence anchoring uses one platform EOA from every web instance. The
// outbox makes the evidence durable before that EOA signs anything, while the
// nonce state allocates one nonce atomically across all instances. Only call
// data hashes and transaction metadata are stored here: never a private key,
// signature, or raw signed transaction.
export async function enqueuePersistentAnchorJob(job = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `insert into adn_anchor_outbox
       (job_id, chain_id, anchor_address, contract_address, function_name,
        request_id, call_args, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', now(), now())
     on conflict (job_id) do update set job_id = excluded.job_id
     returning *`,
    [
      String(job.job_id || ""),
      String(job.chain_id || ""),
      String(job.anchor_address || "").toLowerCase(),
      String(job.contract_address || "").toLowerCase(),
      String(job.function_name || ""),
      job.request_id ? String(job.request_id) : null,
      JSON.stringify(job.call_args || [])
    ]
  );
  return normalizePersistentAnchorJob(result.rows[0]);
}

export async function readPersistentAnchorJob(jobId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query("select * from adn_anchor_outbox where job_id = $1", [String(jobId || "")]);
  return normalizePersistentAnchorJob(result.rows[0]);
}

// Bounded primary-key lookup for the public evidence read model. No job is
// claimed, retried or broadcast by this read path.
export async function readPersistentAnchorJobs(jobIds = []) {
  const ids = [...new Set(jobIds)].filter(id => /^anchor_[0-9a-f]{64}$/.test(String(id)));
  if (!ids.length || !persistenceEnabled()) return [];
  if (ids.length > 200) throw new Error("Too many anchor jobs in one lookup.");
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query("select * from adn_anchor_outbox where job_id = any($1::text[])", [ids]);
  return result.rows.map(normalizePersistentAnchorJob);
}

export async function claimPersistentAnchorJob({ jobId, workerId, leaseMs = 30_000 } = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const leaseSeconds = Math.max(5, Math.min(300, Math.ceil(Number(leaseMs || 30_000) / 1000)));
  const result = await pool.query(
    `update adn_anchor_outbox
     set status = 'processing', lease_owner = $2,
         lease_expires_at = now() + ($3::text || ' seconds')::interval,
         attempts = attempts + 1, updated_at = now()
     where job_id = $1
       and status in ('pending', 'processing', 'submitted')
       and next_attempt_at <= now()
       and (lease_expires_at is null or lease_expires_at <= now())
     returning *`,
    [String(jobId || ""), String(workerId || ""), String(leaseSeconds)]
  );
  return normalizePersistentAnchorJob(result.rows[0]);
}

export async function reservePersistentAnchorJobNonce({
  jobId,
  workerId,
  chainId,
  anchorAddress,
  pendingNonce
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(
      "select * from adn_anchor_outbox where job_id = $1 for update",
      [String(jobId || "")]
    );
    const job = locked.rows[0];
    if (!job || job.lease_owner !== String(workerId || "")) {
      const error = new Error("Evidence anchor outbox lease was lost before nonce reservation.");
      error.code = "ANCHOR_OUTBOX_LEASE_LOST";
      throw error;
    }
    if (job.reserved_nonce !== null && job.reserved_nonce !== undefined) {
      await client.query("commit");
      return normalizePersistentAnchorJob(job);
    }
    const allocation = await client.query(
      `insert into adn_anchor_nonce_state (chain_id, anchor_address, next_nonce, updated_at)
       values ($1, $2, $3::numeric + 1, now())
       on conflict (chain_id, anchor_address)
       do update set
         next_nonce = greatest(adn_anchor_nonce_state.next_nonce, $3::numeric) + 1,
         updated_at = now()
       returning next_nonce - 1 as allocated_nonce`,
      [String(chainId || ""), String(anchorAddress || "").toLowerCase(), String(pendingNonce ?? "")]
    );
    const reservedNonce = String(allocation.rows[0].allocated_nonce);
    const updated = await client.query(
      `update adn_anchor_outbox
       set reserved_nonce = $2::numeric, updated_at = now()
       where job_id = $1
       returning *`,
      [String(jobId || ""), reservedNonce]
    );
    await client.query("commit");
    return normalizePersistentAnchorJob(updated.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function markPersistentAnchorSubmitted({ jobId, workerId, txHash } = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_anchor_outbox
     set status = 'submitted', tx_hash = $3, last_error = null, updated_at = now()
     where job_id = $1 and lease_owner = $2
     returning *`,
    [String(jobId || ""), String(workerId || ""), String(txHash || "").toLowerCase()]
  );
  return normalizePersistentAnchorJob(result.rows[0]);
}

export async function markPersistentAnchorAnchored({ jobId, workerId, blockNumber } = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_anchor_outbox
     set status = 'anchored', block_number = $3::numeric, last_error = null,
         lease_owner = null, lease_expires_at = null, updated_at = now()
     where job_id = $1 and lease_owner = $2
     returning *`,
    [String(jobId || ""), String(workerId || ""), String(blockNumber ?? "0")]
  );
  return normalizePersistentAnchorJob(result.rows[0]);
}

export async function markPersistentAnchorRetry({ jobId, workerId, error, txHash = null, retryAt = new Date().toISOString() } = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `update adn_anchor_outbox
     set status = 'pending', last_error = $3, next_attempt_at = $4::timestamptz,
         tx_hash = coalesce(tx_hash, $5),
         lease_owner = null, lease_expires_at = null, updated_at = now()
     where job_id = $1 and lease_owner = $2
     returning *`,
    [
      String(jobId || ""),
      String(workerId || ""),
      String(error || "").slice(0, 2000),
      String(retryAt),
      txHash ? String(txHash).toLowerCase() : null
    ]
  );
  return normalizePersistentAnchorJob(result.rows[0]);
}

function normalizePersistentAnchorJob(row) {
  if (!row) return null;
  return {
    ...row,
    chain_id: String(row.chain_id),
    reserved_nonce: row.reserved_nonce === null || row.reserved_nonce === undefined ? null : String(row.reserved_nonce),
    block_number: row.block_number === null || row.block_number === undefined ? null : String(row.block_number),
    attempts: Number(row.attempts || 0)
  };
}

export function persistentRegistryRequired() {
  return process.env.ADN_REQUIRE_PERSISTENT_REGISTRY === "true" || Boolean(process.env.RENDER);
}

export function providerSecretPassphraseConfigured() {
  return Boolean(process.env.ADN_PROVIDER_SECRET_PASSPHRASE);
}

export async function claimPersistentProviderId({ providerId, ownerKey }) {
  if (!persistenceEnabled()) return null;
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedOwnerKey = String(ownerKey || "").trim();
  if (!normalizedProviderId || !normalizedOwnerKey) {
    const error = new Error("providerId and ownerKey are required to claim a provider ID.");
    error.statusCode = 422;
    error.code = "INVALID_PROVIDER_CLAIM";
    throw error;
  }

  const pool = await getPool();
  await ensureSchema(pool);
  const inserted = await pool.query(
    `insert into adn_provider_claims (provider_id, owner_key, claimed_at)
     values ($1, $2, now())
     on conflict do nothing
     returning provider_id, owner_key, claimed_at`,
    [normalizedProviderId, normalizedOwnerKey]
  );
  if (inserted.rows[0]) return normalizePersistentProviderClaim(inserted.rows[0], "claimed");

  // Run this as a second statement. When INSERT waited on a concurrent winner,
  // the new statement receives a fresh READ COMMITTED snapshot and can see it.
  const existing = await pool.query(
    "select provider_id, owner_key, claimed_at from adn_provider_claims where provider_id = $1",
    [normalizedProviderId]
  );
  if (!existing.rows[0]) {
    const error = new Error("The durable provider claim could not be confirmed.");
    error.code = "PROVIDER_CLAIM_NOT_CONFIRMED";
    throw error;
  }
  return normalizePersistentProviderClaim(
    existing.rows[0],
    existing.rows[0].owner_key === normalizedOwnerKey ? "owned" : "conflict"
  );
}

export async function claimPersistentServiceRegistration({
  serviceId,
  providerId,
  ownerKey,
  leaseMs = 5 * 60 * 1000
}) {
  if (!persistenceEnabled()) return null;
  const normalizedServiceId = String(serviceId || "").trim();
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedOwnerKey = String(ownerKey || "").trim();
  if (!normalizedServiceId || !normalizedProviderId || !normalizedOwnerKey) {
    const error = new Error("serviceId, providerId, and ownerKey are required to claim a service registration.");
    error.statusCode = 422;
    error.code = "INVALID_SERVICE_REGISTRATION_CLAIM";
    throw error;
  }

  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  const claimToken = crypto.randomBytes(32).toString("base64url");
  const claimTokenHash = hashOpaqueValue(claimToken);
  const normalizedLeaseMs = Math.max(5_000, Math.min(15 * 60 * 1000, Number(leaseMs) || 5 * 60 * 1000));
  try {
    await client.query("begin");
    // Pending reservations are leases, not permanent namespace ownership. A
    // crashed publisher therefore cannot squat service/provider IDs forever.
    await client.query(
      "delete from adn_service_claims where claim_state = 'pending' and lease_expires_at <= now()"
    );
    await client.query(
      `delete from adn_provider_claims p
       where p.claim_state = 'pending'
         and not exists (select 1 from adn_service_claims s where s.provider_id = p.provider_id)`
    );
    const insertedProvider = await client.query(
      `insert into adn_provider_claims (provider_id, owner_key, claim_state, claimed_at)
       values ($1, $2, 'pending', now())
       on conflict do nothing
       returning provider_id, owner_key, claim_state, claimed_at`,
      [normalizedProviderId, normalizedOwnerKey]
    );
    const providerRow = insertedProvider.rows[0] || (await client.query(
      "select provider_id, owner_key, claim_state, claimed_at from adn_provider_claims where provider_id = $1",
      [normalizedProviderId]
    )).rows[0];
    if (!providerRow) {
      const error = new Error("The provider ownership claim could not be confirmed.");
      error.code = "PROVIDER_CLAIM_NOT_CONFIRMED";
      throw error;
    }
    if (String(providerRow.owner_key) !== normalizedOwnerKey) {
      await client.query("rollback");
      return {
        status: "provider_conflict",
        provider_id: normalizedProviderId,
        service_id: normalizedServiceId
      };
    }

    const insertedService = await client.query(
      `insert into adn_service_claims (
         service_id, provider_id, owner_key, claim_state,
         claim_token_hash, lease_expires_at, claimed_at
       )
       values ($1, $2, $3, 'pending', $4, now() + ($5::text || ' milliseconds')::interval, now())
       on conflict (service_id) do nothing
       returning service_id, provider_id, owner_key, claim_state, lease_expires_at, claimed_at`,
      [normalizedServiceId, normalizedProviderId, normalizedOwnerKey, claimTokenHash, String(normalizedLeaseMs)]
    );
    let serviceRow = insertedService.rows[0];
    if (!serviceRow) {
      const existing = (await client.query(
        `select service_id, provider_id, owner_key, claim_state, lease_expires_at, claimed_at
         from adn_service_claims where service_id = $1 for update`,
        [normalizedServiceId]
      )).rows[0];
      // A live same-owner reservation already has an in-flight publisher. Do
      // not rotate its token: that would make the first publisher's finalize
      // fail and can strand one instance in failed bootstrap readiness.
      serviceRow = existing;
    }
    if (!serviceRow) {
      const error = new Error("The durable service registration claim could not be confirmed.");
      error.code = "SERVICE_CLAIM_NOT_CONFIRMED";
      throw error;
    }
    const sameRegistration = String(serviceRow.provider_id) === normalizedProviderId
      && String(serviceRow.owner_key) === normalizedOwnerKey;
    if (!sameRegistration) {
      await client.query("rollback");
      return {
        status: "service_conflict",
        service_id: normalizedServiceId,
        provider_id: normalizedProviderId
      };
    }

    await client.query("commit");
    const normalized = normalizePersistentServiceClaim(
      serviceRow,
      serviceRow.claim_state === "active" ? "owned" : insertedService.rows[0] ? "claimed" : "pending",
      Boolean(insertedProvider.rows[0])
    );
    return serviceRow.claim_state === "pending" && insertedService.rows[0]
      ? { ...normalized, claim_token: claimToken }
      : normalized;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizePersistentServiceRegistration({
  serviceId,
  providerId,
  ownerKey,
  claimToken,
  config = null,
  manifest = null
}) {
  if (!persistenceEnabled()) return null;
  const normalizedServiceId = String(serviceId || "").trim();
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedOwnerKey = String(ownerKey || "").trim();
  if (!normalizedServiceId || !normalizedProviderId || !normalizedOwnerKey || !claimToken) {
    const error = new Error("A complete pending registration claim is required before finalization.");
    error.statusCode = 422;
    error.code = "INVALID_SERVICE_REGISTRATION_FINALIZE";
    throw error;
  }
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claimed = await client.query(
      `update adn_service_claims
       set claim_state = 'active', claim_token_hash = null, lease_expires_at = null
       where service_id = $1 and provider_id = $2 and owner_key = $3
         and claim_state = 'pending' and claim_token_hash = $4 and lease_expires_at > now()
       returning service_id, provider_id, owner_key, claim_state, claimed_at`,
      [normalizedServiceId, normalizedProviderId, normalizedOwnerKey, hashOpaqueValue(claimToken)]
    );
    const serviceRow = claimed.rows[0];
    if (!serviceRow) {
      const error = new Error("The pending registration lease expired or was replaced before finalization.");
      error.statusCode = 409;
      error.code = "REGISTRATION_LEASE_LOST";
      throw error;
    }
    await client.query(
      `update adn_provider_claims set claim_state = 'active'
       where provider_id = $1 and owner_key = $2`,
      [normalizedProviderId, normalizedOwnerKey]
    );
    await persistRegistrationDocuments(client, normalizedServiceId, { config, manifest });
    await client.query("commit");
    return normalizePersistentServiceClaim(serviceRow, "published", false);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function readPersistentServiceRegistrationClaim({ serviceId } = {}) {
  if (!persistenceEnabled()) return null;
  const normalizedServiceId = String(serviceId || "").trim();
  if (!normalizedServiceId) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select service_id, provider_id, owner_key, claim_state, lease_expires_at, claimed_at
     from adn_service_claims where service_id = $1`,
    [normalizedServiceId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return normalizePersistentServiceClaim(row, row.claim_state === "active" ? "owned" : "pending", false);
}

export async function waitForPersistentServiceRegistrationActivation({
  serviceId,
  timeoutMs = 5_000,
  pollMs = 50
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const normalizedPollMs = Math.max(10, Math.min(500, Number(pollMs) || 50));
  let claim = null;
  do {
    claim = await readPersistentServiceRegistrationClaim({ serviceId });
    if (claim?.claim_state === "active") return claim;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, normalizedPollMs));
  } while (true);
  return claim;
}

export async function rewritePersistentServiceRegistration({
  serviceId,
  providerId,
  ownerKey,
  config = null,
  manifest = null
} = {}) {
  if (!persistenceEnabled()) return null;
  const normalizedServiceId = String(serviceId || "").trim();
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedOwnerKey = String(ownerKey || "").trim();
  if (!normalizedServiceId || !normalizedProviderId || !normalizedOwnerKey) {
    const error = new Error("An active service registration is required before rewriting durable documents.");
    error.statusCode = 422;
    error.code = "INVALID_SERVICE_REGISTRATION_REWRITE";
    throw error;
  }
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(
      `select service_id, provider_id, owner_key, claim_state, claimed_at
       from adn_service_claims
       where service_id = $1 and provider_id = $2 and owner_key = $3 and claim_state = 'active'
       for update`,
      [normalizedServiceId, normalizedProviderId, normalizedOwnerKey]
    );
    if (!locked.rows[0]) {
      const error = new Error("The active durable service registration could not be confirmed for rewrite.");
      error.statusCode = 409;
      error.code = "REGISTRATION_NOT_ACTIVE";
      throw error;
    }
    await persistRegistrationDocuments(client, normalizedServiceId, { config, manifest });
    await client.query("commit");
    return normalizePersistentServiceClaim(locked.rows[0], "owned", false);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function persistRegistrationDocuments(client, serviceId, { config, manifest } = {}) {
  if (config) {
    const safeConfig = minimalPersistentRegistrationDocument(config);
    await client.query(
      `insert into adn_provider_configs (service_id, config, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (service_id)
       do update set config = excluded.config, updated_at = now()`,
      [serviceId, JSON.stringify(safeConfig)]
    );
  }
  if (manifest) {
    const safeManifest = minimalPersistentRegistrationDocument(manifest);
    await client.query(
      `insert into adn_registered_services (service_id, manifest, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (service_id)
       do update set manifest = excluded.manifest, updated_at = now()`,
      [serviceId, JSON.stringify(safeManifest)]
    );
  }
}

export async function releasePersistentServiceRegistration({ serviceId, providerId, ownerKey, claimToken }) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const released = await client.query(
      `delete from adn_service_claims
       where service_id = $1 and provider_id = $2 and owner_key = $3
         and claim_state = 'pending' and claim_token_hash = $4
       returning service_id, provider_id, owner_key`,
      [String(serviceId || ""), String(providerId || ""), String(ownerKey || ""), hashOpaqueValue(claimToken)]
    );
    if (released.rowCount) {
      await client.query(
        `delete from adn_provider_claims p
         where p.provider_id = $1 and p.owner_key = $2 and p.claim_state = 'pending'
           and not exists (select 1 from adn_service_claims s where s.provider_id = p.provider_id)`,
        [String(providerId || ""), String(ownerKey || "")]
      );
    }
    await client.query("commit");
    return { status: released.rowCount ? "released" : "not_released", service_id: String(serviceId || "") };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listPersistentProviderClaims() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select provider_id, owner_key, claim_state, claimed_at from adn_provider_claims where claim_state = 'active' order by claimed_at asc, provider_id asc"
  );
  return result.rows.map((row) => normalizePersistentProviderClaim(row, "owned"));
}

export async function listPersistentServiceRegistrationClaims() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select service_id, provider_id, owner_key, claimed_at
     from adn_service_claims
     where claim_state = 'active'
     order by claimed_at asc, service_id asc`
  );
  return result.rows.map((row) => normalizePersistentServiceClaim(row, "owned", false));
}

export async function listPersistentRegisteredServices() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select r.manifest
     from adn_registered_services r
     join adn_service_claims s on s.service_id = r.service_id
     where s.claim_state = 'active'
     order by s.claimed_at asc, r.service_id asc`
  );
  return result.rows.map((row) => minimalPersistentRegistrationDocument(row.manifest || {}));
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
  if (eventType === "routing_feedback") {
    return claimPersistentRoutingFeedback({ serviceId, requestId, event });
  }
  const pool = await getPool();
  await ensureSchema(pool);
  const idempotencyKey = serviceEventIdempotencyKey({ eventType, serviceId, requestId, event });
  await pool.query(
    `with write_lock as materialized (
       select pg_advisory_xact_lock(674312915)
     )
     insert into adn_service_events (event_type, service_id, request_id, event, idempotency_key, created_at)
     select $1, $2, $3, $4::jsonb, $5, coalesce(($4::jsonb->>'created_at')::timestamptz, now())
     from write_lock
     on conflict (idempotency_key) where idempotency_key is not null do nothing`,
    [eventType, serviceId || null, requestId || null, JSON.stringify(event), idempotencyKey]
  );
  return true;
}

/**
 * Commit a related set of service events as one durable unit. Local browser
 * executions use this for the route observation and its feedback grant: a
 * grant without its observation cannot be measured, while an observation
 * without its grant can never receive a label.
 */
export async function writePersistentServiceEventsAtomically(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(674312915)");
    for (const entry of entries) {
      const eventType = String(entry?.eventType || "").trim();
      const serviceId = entry?.serviceId || null;
      const requestId = entry?.requestId || null;
      const event = entry?.event;
      if (!eventType || !event || typeof event !== "object") {
        const error = new Error("An atomic service-event bundle contains an invalid entry.");
        error.statusCode = 422;
        error.code = "INVALID_SERVICE_EVENT_BUNDLE";
        throw error;
      }
      if (eventType === "routing_feedback") {
        const error = new Error("Routing feedback must use its actor-owned durable claim path.");
        error.statusCode = 422;
        error.code = "INVALID_SERVICE_EVENT_BUNDLE";
        throw error;
      }
      const idempotencyKey = serviceEventIdempotencyKey({
        eventType,
        serviceId,
        requestId,
        event
      });
      const conflictClause = eventType === "route_observation"
        ? `do update set
             service_id = excluded.service_id,
             request_id = excluded.request_id,
             event = excluded.event`
        : "do nothing";
      await client.query(
        `insert into adn_service_events (event_type, service_id, request_id, event, idempotency_key, created_at)
         values ($1, $2, $3, $4::jsonb, $5, coalesce(($4::jsonb->>'created_at')::timestamptz, now()))
         on conflict (idempotency_key) where idempotency_key is not null ${conflictClause}`,
        [eventType, serviceId, requestId, JSON.stringify(event), idempotencyKey]
      );
    }
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function claimPersistentRoutingFeedback({ serviceId, requestId, event } = {}) {
  if (!persistenceEnabled()) return null;
  const idempotencyKey = serviceEventIdempotencyKey({
    eventType: "routing_feedback",
    serviceId,
    requestId,
    event
  });
  if (!idempotencyKey) {
    const error = new Error("Routing feedback requires an observation and authenticated actor.");
    error.statusCode = 422;
    error.code = "INVALID_ROUTING_FEEDBACK_IDENTITY";
    throw error;
  }
  const pool = await getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(674312915)");
    const previous = await client.query(
      `select event from adn_service_events
       where event_type = 'routing_feedback'
         and event->>'observation_id' = $1
         and coalesce(event->>'actor_key', event->>'consumer_id', '') = $2
       order by event_id asc
       limit 1`,
      [String(event?.observation_id || ""), String(event?.actor_key || event?.consumer_id || "")]
    );
    let status = previous.rows[0] ? "existing" : "created";
    let canonical = previous.rows[0]?.event || null;
    if (!canonical) {
      const inserted = await client.query(
        `insert into adn_service_events (event_type, service_id, request_id, event, idempotency_key, created_at)
         values ('routing_feedback', $1, $2, $3::jsonb, $4, coalesce(($3::jsonb->>'created_at')::timestamptz, now()))
         on conflict (idempotency_key) where idempotency_key is not null do nothing
         returning event`,
        [serviceId || null, requestId || null, JSON.stringify(event), idempotencyKey]
      );
      canonical = inserted.rows[0]?.event || null;
      if (!canonical) {
        status = "existing";
        const existing = await client.query(
          `select event from adn_service_events
           where idempotency_key = $1 and event_type = 'routing_feedback'
           limit 1`,
          [idempotencyKey]
        );
        canonical = existing.rows[0]?.event || null;
      }
    }
    if (!canonical) {
      const error = new Error("The canonical routing feedback row could not be read after its durable claim.");
      error.code = "ROUTING_FEEDBACK_CANONICAL_MISSING";
      throw error;
    }
    await client.query("commit");
    return { status, event: canonical, idempotency_key: idempotencyKey };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function serviceEventIdempotencyKey({ eventType, serviceId, requestId, event }) {
  const idempotentTypes = new Set([
    "consumer_feedback",
    "consumer_feedback_anchor",
    "consumer_feedback_erc8004_client",
    "feedback_grant",
    "invocation_feedback_grant",
    "erc8004_hire_invocation",
    "erc8004_hire_completion",
    "issued_quote",
    "quote_feedback",
    "route_observation",
    "routing_feedback",
    "erc8004_platform_identity",
    "erc8004_vendor_identity",
    "erc8004_agent_import"
  ]);
  if (!idempotentTypes.has(eventType) || !requestId) return null;
  let eventIdentity = event?.consumer_id
    || event?.actor_key
    || (eventType === "erc8004_agent_import" ? event?.verified_at || event?.imported_at : "");
  if (eventType === "routing_feedback") {
    const observationId = String(event?.observation_id || "").trim();
    const actorKey = String(event?.actor_key || event?.consumer_id || "").trim();
    if (!observationId || !actorKey) return null;
    return crypto.createHash("sha256").update(JSON.stringify([
      eventType,
      { actor_key: actorKey, observation_id: observationId }
    ])).digest("hex");
  }
  if (eventType === "route_observation") {
    const observationId = String(event?.observation_id || "").trim();
    if (!observationId) return null;
    return crypto.createHash("sha256").update(JSON.stringify([
      eventType,
      { observation_id: observationId }
    ])).digest("hex");
  }
  return crypto.createHash("sha256").update(JSON.stringify([
    eventType,
    serviceId || "",
    requestId,
    eventIdentity
  ])).digest("hex");
}

export async function listPersistentServiceEvents({
  limit = 1000,
  maxEvents = 1_000_000,
  afterCreatedAt = null,
  afterEventId = null,
  query = null
} = {}) {
  const injectedQuery = typeof query === "function";
  if (!injectedQuery && !persistenceEnabled()) return [];

  let runQuery = query;
  if (!injectedQuery) {
    const pool = await getPool();
    await ensureSchema(pool);
    runQuery = pool.query.bind(pool);
  }

  const pageSize = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const eventLimit = Math.max(1, Math.min(5_000_000, Number(maxEvents) || 1_000_000));
  const rows = [];
  const seenCursors = new Set();
  const incrementalByEventId = afterEventId !== null && String(afterEventId).trim() !== "";
  let cursorCreatedAt = afterCreatedAt || null;
  let cursorEventId = afterEventId || null;

  for (let page = 0; page <= Math.ceil(eventLimit / pageSize); page += 1) {
    const requestedPageSize = Math.min(pageSize, eventLimit - rows.length + 1);
    const result = incrementalByEventId
      ? await runQuery(
        `select event_id, event_type, service_id, request_id, event, created_at,
                created_at::text as created_at_cursor
         from adn_service_events
         where event_id > $1::bigint
         order by event_id asc
         limit $2`,
        [String(cursorEventId), requestedPageSize]
      )
      : await runQuery(
        `select event_id, event_type, service_id, request_id, event, created_at,
                created_at::text as created_at_cursor
         from adn_service_events
         where ($1::timestamptz is null
            or created_at > $1::timestamptz
            or (created_at = $1::timestamptz and event_id > $2::bigint))
         order by created_at asc, event_id asc
         limit $3`,
        [cursorCreatedAt, cursorEventId, requestedPageSize]
      );
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    if (pageRows.length === 0) break;
    if (rows.length + pageRows.length > eventLimit) {
      const error = new Error(`Persistent service-event hydration exceeded the safe ${eventLimit}-event limit.`);
      error.code = "PERSISTENT_EVENT_HYDRATION_LIMIT_EXCEEDED";
      throw error;
    }

    const last = pageRows.at(-1);
    const nextCreatedAt = String(last?.created_at_cursor || last?.created_at || "");
    const nextEventId = String(last?.event_id || "");
    const cursorKey = incrementalByEventId ? nextEventId : `${nextCreatedAt}\u0000${nextEventId}`;
    if ((!incrementalByEventId && !nextCreatedAt) || !nextEventId || seenCursors.has(cursorKey)) {
      const error = new Error("Persistent service-event hydration cursor made no progress and was stalled.");
      error.code = "PERSISTENT_EVENT_HYDRATION_CURSOR_STALLED";
      throw error;
    }
    seenCursors.add(cursorKey);
    rows.push(...pageRows);
    cursorCreatedAt = nextCreatedAt;
    cursorEventId = nextEventId;
    if (pageRows.length < requestedPageSize) break;
  }

  return rows.map((row) => ({
    event_id: String(row.event_id),
    event_type: row.event_type,
    service_id: row.service_id,
    request_id: row.request_id,
    event: row.event,
    created_at: row.created_at,
    created_at_cursor: String(row.created_at_cursor || row.created_at || "")
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

export async function claimPersistentPublicApiCandidateLease({
  candidateId,
  leaseOwner,
  leaseMs = 10 * 60 * 1000
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const boundedLeaseMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(leaseMs) || 10 * 60 * 1000));
  const claimed = await pool.query(
    `update adn_public_api_catalog
     set lease_owner = $2,
         lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
     where candidate_id = $1
       and (lease_owner is null or lease_expires_at is null or lease_expires_at <= now())
       and candidate->>'catalog_presence' is distinct from 'removed'
       and (
         candidate->>'status' in ('queued', 'retryable_failure')
         or (
           candidate->>'status' = 'validated_ready'
           and candidate#>>'{promotion,ok}' = 'false'
         )
       )
     returning candidate, lease_owner, lease_expires_at`,
    [String(candidateId || ""), String(leaseOwner || ""), boundedLeaseMs]
  );
  if (claimed.rows[0]) return { claimed: true, ...claimed.rows[0] };
  const current = await pool.query(
    `select candidate, lease_owner, lease_expires_at
     from adn_public_api_catalog
     where candidate_id = $1`,
    [String(candidateId || "")]
  );
  return { claimed: false, ...(current.rows[0] || { candidate: null, lease_owner: null, lease_expires_at: null }) };
}

export async function completePersistentPublicApiCandidateLease({
  candidate,
  leaseOwner
} = {}) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const candidateId = String(candidate?.candidate_id || "");
  const completed = await pool.query(
    `update adn_public_api_catalog
     set candidate = $3::jsonb,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = now()
     where candidate_id = $1
       and lease_owner = $2
       and lease_expires_at > now()
     returning candidate, lease_owner, lease_expires_at`,
    [candidateId, String(leaseOwner || ""), JSON.stringify(candidate || {})]
  );
  if (completed.rows[0]) return { completed: true, ...completed.rows[0] };
  const current = await pool.query(
    `select candidate, lease_owner, lease_expires_at
     from adn_public_api_catalog
     where candidate_id = $1`,
    [candidateId]
  );
  return { completed: false, ...(current.rows[0] || { candidate: null, lease_owner: null, lease_expires_at: null }) };
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

// Call only after request processing has quiesced (for example during
// graceful shutdown or isolated integration-test teardown). Resetting both
// handles lets a later process lifecycle establish a fresh schema/pool.
export async function closePersistence() {
  const pendingSchema = schemaPromise;
  if (pendingSchema) await pendingSchema.catch(() => {});
  const pendingPool = poolPromise;
  poolPromise = null;
  schemaReady = false;
  schemaPromise = null;
  if (!pendingPool) return false;
  const pool = await pendingPool;
  await pool.end();
  return true;
}

function normalizePersistentProviderClaim(row, status) {
  if (!row) return null;
  const claimedAt = row.claimed_at instanceof Date
    ? row.claimed_at.toISOString()
    : String(row.claimed_at || new Date().toISOString());
  return {
    status,
    provider_id: String(row.provider_id || ""),
    owner_key: String(row.owner_key || ""),
    claim_state: String(row.claim_state || "active"),
    claimed_at: claimedAt
  };
}

function normalizePersistentServiceClaim(row, status, providerClaimed) {
  if (!row) return null;
  const claimedAt = row.claimed_at instanceof Date
    ? row.claimed_at.toISOString()
    : String(row.claimed_at || new Date().toISOString());
  return {
    status,
    service_id: String(row.service_id || ""),
    provider_id: String(row.provider_id || ""),
    owner_key: String(row.owner_key || ""),
    claim_state: String(row.claim_state || "active"),
    provider_claimed: Boolean(providerClaimed),
    lease_expires_at: row.lease_expires_at instanceof Date
      ? row.lease_expires_at.toISOString()
      : row.lease_expires_at ? String(row.lease_expires_at) : null,
    claimed_at: claimedAt
  };
}

function hashOpaqueValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function minimalPersistentRegistrationDocument(document = {}) {
  const next = structuredClone(document || {});
  const manifest = next.manifest && typeof next.manifest === "object" ? next.manifest : next;
  const ownerKey = String(manifest?.registration?.owner?.user_key || "").trim();
  if (manifest?.registration?.owner) {
    manifest.registration.owner = ownerKey ? { user_key: ownerKey } : undefined;
    if (!ownerKey) delete manifest.registration.owner;
  }
  return next;
}

function deviceAuthorizationValues(record = {}) {
  return [
    String(record.device_code_hash || ""),
    String(record.user_code_hash || ""),
    String(record.client_name || "AI agent"),
    String(record.status || "pending"),
    record.account_id ? String(record.account_id) : null,
    record.owner_key ? String(record.owner_key) : null,
    Number(record.created_at || 0),
    Number(record.expires_at || 0),
    record.approved_at == null ? null : Number(record.approved_at),
    record.consumed_at == null ? null : Number(record.consumed_at),
    Number(record.last_poll_at || 0),
    Number(record.poll_interval_ms || 0)
  ];
}

function normalizeDeviceAuthorizationRow(row) {
  if (!row) return null;
  return {
    device_code_hash: row.device_code_hash,
    user_code_hash: row.user_code_hash,
    client_name: row.client_name,
    status: row.status,
    account_id: row.account_id || null,
    owner_key: row.owner_key || null,
    created_at: Number(row.created_at_ms),
    expires_at: Number(row.expires_at_ms),
    approved_at: row.approved_at_ms == null ? null : Number(row.approved_at_ms),
    consumed_at: row.consumed_at_ms == null ? null : Number(row.consumed_at_ms),
    last_poll_at: Number(row.last_poll_at_ms || 0),
    poll_interval_ms: Number(row.poll_interval_ms || 0)
  };
}

async function ensureSchema(pool) {
  return ensurePersistenceSchema(pool);
}

export async function ensurePersistenceSchema(pool, {
  migrate = runPersistenceSchemaMigration
} = {}) {
  if (schemaReady) return true;
  if (!schemaPromise) {
    let pending;
    pending = Promise.resolve()
      .then(() => migrate(pool))
      .then(() => {
        schemaReady = true;
        return true;
      })
      .catch((error) => {
        if (schemaPromise === pending) schemaPromise = null;
        throw error;
      });
    schemaPromise = pending;
  }
  return schemaPromise;
}

export async function runPersistenceSchemaMigration(pool, {
  applySchema = applyPersistenceSchema
} = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [PERSISTENCE_SCHEMA_LOCK_ID]);
    await applySchema(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyPersistenceSchema(client) {
  await client.query(`
    create table if not exists adn_provider_configs (
      service_id text primary key,
      config jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_provider_claims (
      provider_id text primary key,
      owner_key text not null,
      claim_state text not null default 'active',
      claimed_at timestamptz not null default now()
    );
    alter table adn_provider_claims add column if not exists claim_state text not null default 'active';
    create unique index if not exists adn_provider_claims_owner_idx
      on adn_provider_claims(provider_id, owner_key);
    create table if not exists adn_service_claims (
      service_id text primary key,
      provider_id text not null,
      owner_key text not null,
      claim_state text not null default 'active',
      claim_token_hash text,
      lease_expires_at timestamptz,
      claimed_at timestamptz not null default now(),
      foreign key (provider_id, owner_key)
        references adn_provider_claims(provider_id, owner_key)
    );
    alter table adn_service_claims add column if not exists claim_state text not null default 'active';
    alter table adn_service_claims add column if not exists claim_token_hash text;
    alter table adn_service_claims add column if not exists lease_expires_at timestamptz;
    create index if not exists adn_service_claims_provider_idx
      on adn_service_claims(provider_id, claimed_at asc);
    create index if not exists adn_service_claims_pending_lease_idx
      on adn_service_claims(lease_expires_at) where claim_state = 'pending';
    create table if not exists adn_registered_services (
      service_id text primary key references adn_service_claims(service_id) on delete cascade,
      manifest jsonb not null,
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
    create index if not exists adn_service_events_hydration_idx on adn_service_events(created_at, event_id);
    create index if not exists adn_service_events_routing_feedback_identity_idx
      on adn_service_events ((event->>'observation_id'), (coalesce(event->>'actor_key', event->>'consumer_id', '')), event_id)
      where event_type = 'routing_feedback';
    create table if not exists adn_browser_handoff_claims (
      handoff_id text primary key,
      expires_at timestamptz not null,
      consumed_at timestamptz not null default now()
    );
    create index if not exists adn_browser_handoff_claims_expiry_idx on adn_browser_handoff_claims(expires_at);
    create table if not exists adn_device_authorizations (
      device_code_hash text primary key,
      user_code_hash text not null unique,
      client_name text not null,
      status text not null,
      account_id text,
      owner_key text,
      created_at_ms bigint not null,
      expires_at_ms bigint not null,
      approved_at_ms bigint,
      consumed_at_ms bigint,
      last_poll_at_ms bigint not null default 0,
      poll_interval_ms bigint not null
    );
    create index if not exists adn_device_authorizations_expiry_idx on adn_device_authorizations(expires_at_ms);
    create table if not exists adn_remote_mcp_sessions (
      session_id_hash text primary key,
      state_opaque jsonb not null,
      expires_at_ms bigint not null,
      updated_at timestamptz not null default now()
    );
    create index if not exists adn_remote_mcp_sessions_expiry_idx on adn_remote_mcp_sessions(expires_at_ms);
    create table if not exists adn_settlement_tx_claims (
      chain_id text not null,
      tx_hash text not null,
      service_id text,
      payer text,
      consumed_at timestamptz not null default now(),
      primary key (chain_id, tx_hash)
    );
    create index if not exists adn_settlement_tx_claims_consumed_idx on adn_settlement_tx_claims(consumed_at desc);
    create table if not exists adn_erc8004_hire_requests (
      claim_key text primary key,
      request_hash text not null,
      request_id text not null,
      service_id text not null,
      status text not null,
      response jsonb,
      error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists adn_erc8004_hire_requests_status_idx on adn_erc8004_hire_requests(status, updated_at desc);
    create table if not exists adn_anchor_nonce_state (
      chain_id text not null,
      anchor_address text not null,
      next_nonce numeric(78, 0) not null,
      updated_at timestamptz not null default now(),
      primary key (chain_id, anchor_address)
    );
    create table if not exists adn_anchor_outbox (
      job_id text primary key,
      chain_id text not null,
      anchor_address text not null,
      contract_address text not null,
      function_name text not null,
      request_id text,
      call_args jsonb not null,
      status text not null default 'pending',
      reserved_nonce numeric(78, 0),
      tx_hash text,
      block_number numeric(78, 0),
      attempts integer not null default 0,
      last_error text,
      next_attempt_at timestamptz not null default now(),
      lease_owner text,
      lease_expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists adn_anchor_outbox_pending_idx
      on adn_anchor_outbox(status, next_attempt_at, lease_expires_at);
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
      lease_owner text,
      lease_expires_at timestamptz,
      updated_at timestamptz not null default now()
    );
    alter table adn_public_api_catalog add column if not exists lease_owner text;
    alter table adn_public_api_catalog add column if not exists lease_expires_at timestamptz;
    create index if not exists adn_public_api_catalog_status_idx on adn_public_api_catalog((candidate->>'status'));
    create index if not exists adn_public_api_catalog_lease_idx on adn_public_api_catalog(lease_expires_at) where lease_owner is not null;
    create table if not exists adn_public_api_pipeline_runs (
      run_id text primary key,
      run jsonb not null,
      created_at timestamptz not null default now()
    );
    create index if not exists adn_public_api_pipeline_runs_created_idx on adn_public_api_pipeline_runs(created_at desc);
    create index if not exists adn_credit_ledger_account_idx on adn_credit_ledger(account_id, created_at desc);
    create index if not exists adn_credit_api_keys_hash_idx on adn_credit_api_keys(key_hash);
  `);
}
