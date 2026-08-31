import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { Pool } from "pg";
import { createConfigHash, createManifestHash, prepareProviderConfigForPersistence } from "../src/provider-config.js";

import {
  claimPersistentAnchorJob,
  claimPersistentPublicApiCandidateLease,
  claimPersistentServiceRegistration,
  claimPersistentSettlementTransaction,
  closePersistence,
  completePersistentPublicApiCandidateLease,
  enqueuePersistentAnchorJob,
  finalizePersistentServiceRegistration,
  reservePersistentAnchorJobNonce,
  writePersistentPublicApiCandidates
} from "../src/persistence.js";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

test("CI isolates TEST_DATABASE_URL from the full npm test job", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const [verifyJob, postgresJob = ""] = workflow.split(/^  postgres-persistence:/m);
  assert.doesNotMatch(verifyJob, /(?:TEST_)?DATABASE_URL/);
  assert.match(postgresJob, /TEST_DATABASE_URL:/);
  assert.match(postgresJob, /node --test test\/postgres-persistence-integration\.test\.js/);
  assert.doesNotMatch(postgresJob, /run:\s*npm test/);
});

test("real Postgres enforces persistence safety boundaries", {
  skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  await runPostgresAssertions(testDatabaseUrl);
});

test("independent processes serialize first-run schema creation on real Postgres", {
  skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  const schemaName = `adn_schema_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const pool = new Pool({ connectionString: testDatabaseUrl, ssl: false, allowExitOnIdle: true });
  await pool.query(`create schema "${schemaName}"`);
  try {
    const persistenceUrl = new URL("../src/persistence.js", import.meta.url).href;
    const childScript = `
      import { Pool } from "pg";
      import { ensurePersistenceSchema } from ${JSON.stringify(persistenceUrl)};
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
      try { await ensurePersistenceSchema(pool); } finally { await pool.end(); }
    `;
    await Promise.all(Array.from({ length: 3 }, () => runNodeProcess(childScript, {
      ...process.env,
      TEST_DATABASE_URL: testDatabaseUrl,
      PGOPTIONS: `-c search_path=${schemaName}`
    })));

    const created = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name in ('adn_provider_claims', 'adn_registered_services')
       order by table_name`,
      [schemaName]
    );
    assert.deepEqual(created.rows.map((row) => row.table_name), ["adn_provider_claims", "adn_registered_services"]);
  } finally {
    await pool.query(`drop schema if exists "${schemaName}" cascade`);
    await pool.end();
  }
});

async function runPostgresAssertions(databaseUrl) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required in the integration worker");
  const uniquePrefix = `pg_ci_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDatabaseSsl = process.env.DATABASE_SSL;
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_SSL = "false";

  const inspectionPool = new Pool({ connectionString: databaseUrl, ssl: false, allowExitOnIdle: true });
  const cleanup = {
    providerIds: [],
    serviceIds: [],
    settlementServiceIds: [],
    candidateIds: [],
    anchorJobs: [],
    nonceKeys: []
  };
  let schemaPrimed = false;

  try {
    // Prime schema creation once before concurrency assertions so they test
    // data-boundary races rather than concurrent DDL.
    const schemaProbeId = `${uniquePrefix}_schema_probe`;
    cleanup.candidateIds.push(schemaProbeId);
    await writePersistentPublicApiCandidates([{
      candidate_id: schemaProbeId,
      status: "removed",
      catalog_presence: "removed"
    }]);
    schemaPrimed = true;

    await assertAtomicRegistrationClaims({ inspectionPool, cleanup, uniquePrefix });
    await assertSettlementReplayBoundary({ inspectionPool, cleanup, uniquePrefix });
    await assertPublicApiLeaseFencing({ inspectionPool, cleanup, uniquePrefix });
    await assertConcurrentAnchorNonces({ cleanup, uniquePrefix });
  } finally {
    try {
      if (schemaPrimed) await cleanupRows(inspectionPool, cleanup);
    } finally {
      try {
        await closePersistence();
      } finally {
        await inspectionPool.end();
        restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
        restoreEnvironment("DATABASE_SSL", previousDatabaseSsl);
      }
    }
  }
}

async function assertAtomicRegistrationClaims({ inspectionPool, cleanup, uniquePrefix }) {
  const sharedServiceId = `${uniquePrefix}_shared_service`;
  const aliceProviderId = `${uniquePrefix}_alice_provider`;
  const bobProviderId = `${uniquePrefix}_bob_provider`;
  cleanup.serviceIds.push(sharedServiceId);
  cleanup.providerIds.push(aliceProviderId, bobProviderId);

  const claims = await Promise.all([
    claimPersistentServiceRegistration({
      serviceId: sharedServiceId,
      providerId: aliceProviderId,
      ownerKey: `${uniquePrefix}:alice`
    }),
    claimPersistentServiceRegistration({
      serviceId: sharedServiceId,
      providerId: bobProviderId,
      ownerKey: `${uniquePrefix}:bob`
    })
  ]);

  assert.deepEqual(claims.map((claim) => claim.status).sort(), ["claimed", "service_conflict"]);
  const winner = claims.find((claim) => claim.status === "claimed");
  const rows = await inspectionPool.query(
    "select service_id, provider_id, owner_key from adn_service_claims where service_id = $1",
    [sharedServiceId]
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].provider_id, winner.provider_id);
  assert.equal(rows.rows[0].owner_key, winner.owner_key);

  assert.ok(winner.claim_token, "the winning reservation must return an opaque finalization token");
  const preparedConfig = await prepareProviderConfigForPersistence({
    provider_config_version: "adn_provider_config_v1",
    version: "1.0.0",
    source: { type: "static_json", data: { ok: true } },
    manifest: {
      service_id: winner.service_id,
      provider: { provider_id: winner.provider_id },
      registration: {
        owner: {
          user_key: winner.owner_key,
          email: "must-not-persist@example.test",
          name: "Must Not Persist"
        }
      }
    }
  });
  const finalized = await finalizePersistentServiceRegistration({
    serviceId: winner.service_id,
    providerId: winner.provider_id,
    ownerKey: winner.owner_key,
    claimToken: winner.claim_token,
    config: preparedConfig,
    manifest: preparedConfig.manifest
  });
  assert.equal(finalized.status, "published");
  assert.equal(finalized.claim_state, "active");

  const finalizedRows = await inspectionPool.query(
    `select s.claim_state as service_state, p.claim_state as provider_state, r.manifest, c.config
     from adn_service_claims s
     join adn_provider_claims p on p.provider_id = s.provider_id
     join adn_registered_services r on r.service_id = s.service_id
     join adn_provider_configs c on c.service_id = s.service_id
     where s.service_id = $1`,
    [winner.service_id]
  );
  assert.equal(finalizedRows.rowCount, 1);
  assert.equal(finalizedRows.rows[0].service_state, "active");
  assert.equal(finalizedRows.rows[0].provider_state, "active");
  assert.deepEqual(finalizedRows.rows[0].manifest.registration.owner, { user_key: winner.owner_key });
  assert.deepEqual(finalizedRows.rows[0].config.manifest.registration.owner, { user_key: winner.owner_key });
  assert.equal(finalizedRows.rows[0].manifest.integrity.manifest_hash, createManifestHash(finalizedRows.rows[0].manifest));
  assert.equal(finalizedRows.rows[0].manifest.integrity.config_hash, createConfigHash(finalizedRows.rows[0].config));

  const sameOwnerServiceId = `${uniquePrefix}_same_owner_pending`;
  const sameOwnerProviderId = `${uniquePrefix}_same_owner_provider`;
  const sameOwnerKey = `${uniquePrefix}:same-owner`;
  cleanup.serviceIds.push(sameOwnerServiceId);
  cleanup.providerIds.push(sameOwnerProviderId);
  const sameOwnerRace = await Promise.all([
    claimPersistentServiceRegistration({
      serviceId: sameOwnerServiceId,
      providerId: sameOwnerProviderId,
      ownerKey: sameOwnerKey
    }),
    claimPersistentServiceRegistration({
      serviceId: sameOwnerServiceId,
      providerId: sameOwnerProviderId,
      ownerKey: sameOwnerKey
    })
  ]);
  assert.deepEqual(sameOwnerRace.map((claim) => claim.status).sort(), ["claimed", "pending"]);
  assert.equal(sameOwnerRace.filter((claim) => claim.claim_token).length, 1, "a live pending token must have one publisher");

  const providerRows = await inspectionPool.query(
    "select provider_id, owner_key from adn_provider_claims where provider_id = any($1::text[])",
    [[aliceProviderId, bobProviderId]]
  );
  assert.equal(providerRows.rowCount, 1, "the losing service transaction must not strand a provider claim");
  assert.equal(providerRows.rows[0].provider_id, winner.provider_id);

  const sharedProviderId = `${uniquePrefix}_shared_provider`;
  const aliceServiceId = `${uniquePrefix}_provider_service_alice`;
  const bobServiceId = `${uniquePrefix}_provider_service_bob`;
  cleanup.providerIds.push(sharedProviderId);
  cleanup.serviceIds.push(aliceServiceId, bobServiceId);
  const providerRace = await Promise.all([
    claimPersistentServiceRegistration({
      serviceId: aliceServiceId,
      providerId: sharedProviderId,
      ownerKey: `${uniquePrefix}:provider-alice`
    }),
    claimPersistentServiceRegistration({
      serviceId: bobServiceId,
      providerId: sharedProviderId,
      ownerKey: `${uniquePrefix}:provider-bob`
    })
  ]);
  assert.deepEqual(providerRace.map((claim) => claim.status).sort(), ["claimed", "provider_conflict"]);
  const providerServiceRows = await inspectionPool.query(
    "select service_id, owner_key from adn_service_claims where service_id = any($1::text[])",
    [[aliceServiceId, bobServiceId]]
  );
  assert.equal(providerServiceRows.rowCount, 1, "a provider conflict must not leave the losing service_id claimed");

  const leaseServiceId = `${uniquePrefix}_lease_recovery_service`;
  const leaseProviderId = `${uniquePrefix}_lease_recovery_provider`;
  cleanup.serviceIds.push(leaseServiceId);
  cleanup.providerIds.push(leaseProviderId);
  const pending = await claimPersistentServiceRegistration({
    serviceId: leaseServiceId,
    providerId: leaseProviderId,
    ownerKey: `${uniquePrefix}:lease-alice`,
    leaseMs: 60_000
  });
  assert.equal(pending.claim_state, "pending");
  const blocked = await claimPersistentServiceRegistration({
    serviceId: leaseServiceId,
    providerId: leaseProviderId,
    ownerKey: `${uniquePrefix}:lease-bob`,
    leaseMs: 60_000
  });
  assert.equal(blocked.status, "provider_conflict");
  await inspectionPool.query(
    "update adn_service_claims set lease_expires_at = now() - interval '1 second' where service_id = $1",
    [leaseServiceId]
  );
  const recovered = await claimPersistentServiceRegistration({
    serviceId: leaseServiceId,
    providerId: leaseProviderId,
    ownerKey: `${uniquePrefix}:lease-bob`,
    leaseMs: 60_000
  });
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.owner_key, `${uniquePrefix}:lease-bob`);

  const publishedConflict = await claimPersistentServiceRegistration({
    serviceId: winner.service_id,
    providerId: winner.provider_id,
    ownerKey: `${uniquePrefix}:published-takeover`,
    leaseMs: 1
  });
  assert.equal(publishedConflict.status, "provider_conflict", "an active claim must never expire");
}

async function assertSettlementReplayBoundary({ inspectionPool, cleanup, uniquePrefix }) {
  const serviceId = `${uniquePrefix}_settlement_service`;
  const primaryChainId = "eip155:56";
  const secondaryChainId = "eip155:97";
  const txHash = `0x${crypto.createHash("sha256").update(`${uniquePrefix}:settlement`).digest("hex")}`;
  cleanup.settlementServiceIds.push(serviceId);

  const outcomes = await Promise.all(Array.from({ length: 16 }, () =>
    claimPersistentSettlementTransaction({
      chainId: primaryChainId,
      txHash,
      serviceId,
      payer: `0x${"1".repeat(40)}`
    })
  ));
  assert.equal(outcomes.filter(Boolean).length, 1);

  assert.equal(await claimPersistentSettlementTransaction({
    chainId: secondaryChainId,
    txHash,
    serviceId,
    payer: `0x${"1".repeat(40)}`
  }), true, "the same transaction hash on another chain is a distinct replay boundary");
  assert.equal(await claimPersistentSettlementTransaction({
    chainId: secondaryChainId,
    txHash,
    serviceId,
    payer: `0x${"1".repeat(40)}`
  }), false);

  const stored = await inspectionPool.query(
    "select chain_id from adn_settlement_tx_claims where tx_hash = $1 and service_id = $2 order by chain_id",
    [txHash, serviceId]
  );
  assert.deepEqual(stored.rows.map((row) => row.chain_id), [primaryChainId, secondaryChainId]);
}

async function assertPublicApiLeaseFencing({ inspectionPool, cleanup, uniquePrefix }) {
  const candidateId = `${uniquePrefix}_candidate`;
  const firstOwner = `${uniquePrefix}_lease_a`;
  const secondOwner = `${uniquePrefix}_lease_b`;
  cleanup.candidateIds.push(candidateId);

  await writePersistentPublicApiCandidates([{
    candidate_id: candidateId,
    status: "queued",
    catalog_presence: "active",
    promotion: { ok: false }
  }]);
  const firstLease = await claimPersistentPublicApiCandidateLease({ candidateId, leaseOwner: firstOwner, leaseMs: 60_000 });
  assert.equal(firstLease.claimed, true);

  await inspectionPool.query(
    "update adn_public_api_catalog set lease_expires_at = now() - interval '1 second' where candidate_id = $1",
    [candidateId]
  );
  const takeover = await claimPersistentPublicApiCandidateLease({ candidateId, leaseOwner: secondOwner, leaseMs: 60_000 });
  assert.equal(takeover.claimed, true);

  const staleCompletion = await completePersistentPublicApiCandidateLease({
    leaseOwner: firstOwner,
    candidate: { candidate_id: candidateId, status: "published_by_stale_owner", catalog_presence: "active" }
  });
  assert.equal(staleCompletion.completed, false);
  assert.equal(staleCompletion.lease_owner, secondOwner);
  assert.equal(staleCompletion.candidate.status, "queued");

  const winningCompletion = await completePersistentPublicApiCandidateLease({
    leaseOwner: secondOwner,
    candidate: { candidate_id: candidateId, status: "published", catalog_presence: "active" }
  });
  assert.equal(winningCompletion.completed, true);
  assert.equal(winningCompletion.candidate.status, "published");
}

async function assertConcurrentAnchorNonces({ cleanup, uniquePrefix }) {
  const chainId = "eip155:56";
  const anchorAddress = `0x${crypto.createHash("sha256").update(`${uniquePrefix}:anchor`).digest("hex").slice(0, 40)}`;
  const contractAddress = `0x${crypto.createHash("sha256").update(`${uniquePrefix}:contract`).digest("hex").slice(0, 40)}`;
  const jobs = ["a", "b"].map((suffix) => ({
    jobId: `${uniquePrefix}_anchor_${suffix}`,
    workerId: `${uniquePrefix}_worker_${suffix}`
  }));
  cleanup.anchorJobs.push(...jobs.map((job) => job.jobId));
  cleanup.nonceKeys.push({ chainId, anchorAddress });

  for (const job of jobs) {
    await enqueuePersistentAnchorJob({
      job_id: job.jobId,
      chain_id: chainId,
      anchor_address: anchorAddress,
      contract_address: contractAddress,
      function_name: "anchorEvidence",
      request_id: `${job.jobId}_request`,
      call_args: [`0x${"2".repeat(64)}`]
    });
    const claimed = await claimPersistentAnchorJob({ jobId: job.jobId, workerId: job.workerId, leaseMs: 60_000 });
    assert.equal(claimed.lease_owner, job.workerId);
  }

  const reserved = await Promise.all(jobs.map((job) => reservePersistentAnchorJobNonce({
    jobId: job.jobId,
    workerId: job.workerId,
    chainId,
    anchorAddress,
    pendingNonce: "41"
  })));
  assert.deepEqual(reserved.map((job) => job.reserved_nonce).sort((left, right) => Number(left) - Number(right)), ["41", "42"]);

  const replay = await reservePersistentAnchorJobNonce({
    jobId: jobs[0].jobId,
    workerId: jobs[0].workerId,
    chainId,
    anchorAddress,
    pendingNonce: "99"
  });
  assert.equal(replay.reserved_nonce, reserved[0].reserved_nonce, "retrying one job must reuse its reserved nonce");
}

async function cleanupRows(pool, cleanup) {
  if (cleanup.anchorJobs.length) {
    await pool.query("delete from adn_anchor_outbox where job_id = any($1::text[])", [cleanup.anchorJobs]);
  }
  for (const { chainId, anchorAddress } of cleanup.nonceKeys) {
    await pool.query(
      "delete from adn_anchor_nonce_state where chain_id = $1 and anchor_address = $2",
      [chainId, anchorAddress]
    );
  }
  if (cleanup.candidateIds.length) {
    await pool.query("delete from adn_public_api_catalog where candidate_id = any($1::text[])", [cleanup.candidateIds]);
  }
  if (cleanup.settlementServiceIds.length) {
    await pool.query("delete from adn_settlement_tx_claims where service_id = any($1::text[])", [cleanup.settlementServiceIds]);
  }
  if (cleanup.serviceIds.length) {
    await pool.query("delete from adn_provider_configs where service_id = any($1::text[])", [cleanup.serviceIds]);
    await pool.query("delete from adn_registered_services where service_id = any($1::text[])", [cleanup.serviceIds]);
    await pool.query("delete from adn_service_claims where service_id = any($1::text[])", [cleanup.serviceIds]);
  }
  if (cleanup.providerIds.length) {
    await pool.query("delete from adn_provider_claims where provider_id = any($1::text[])", [cleanup.providerIds]);
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function runNodeProcess(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`schema child failed (${signal || code}): ${stderr || stdout}`));
    });
  });
}
