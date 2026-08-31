import test from "node:test";
import assert from "node:assert/strict";

import {
  closePersistence,
  ensurePersistenceSchema,
  runPersistenceSchemaMigration
} from "../src/persistence.js";

test.beforeEach(async () => {
  await closePersistence();
});

test.after(async () => {
  await closePersistence();
});

test("concurrent schema initialization in one process shares one migration", async () => {
  let releaseMigration;
  const migrationGate = new Promise((resolve) => { releaseMigration = resolve; });
  let migrationCalls = 0;
  const migrate = async () => {
    migrationCalls += 1;
    await migrationGate;
  };

  const first = ensurePersistenceSchema({}, { migrate });
  const second = ensurePersistenceSchema({}, { migrate });
  await Promise.resolve();

  assert.equal(migrationCalls, 1);
  releaseMigration();
  await Promise.all([first, second]);
  await ensurePersistenceSchema({}, { migrate });
  assert.equal(migrationCalls, 1, "a completed process must not repeat runtime DDL");
});

test("failed schema initialization clears the shared promise so a later call can retry", async () => {
  let migrationCalls = 0;
  const migrate = async () => {
    migrationCalls += 1;
    if (migrationCalls === 1) throw new Error("synthetic migration failure");
  };

  await assert.rejects(ensurePersistenceSchema({}, { migrate }), /synthetic migration failure/);
  await ensurePersistenceSchema({}, { migrate });
  assert.equal(migrationCalls, 2);
});

test("schema migration holds a transaction-scoped PostgreSQL advisory lock through DDL", async () => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql).trim(), params });
      return { rows: [], rowCount: 0 };
    },
    release() {
      releases += 1;
    }
  };
  const pool = { connect: async () => client };

  await runPersistenceSchemaMigration(pool, {
    applySchema: async (lockedClient) => {
      assert.equal(lockedClient, client);
      calls.push({ sql: "APPLY_SCHEMA" });
    }
  });

  assert.equal(calls[0].sql.toLowerCase(), "begin");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/i);
  assert.deepEqual(calls[1].params?.length, 1);
  assert.equal(calls[2].sql, "APPLY_SCHEMA");
  assert.equal(calls[3].sql.toLowerCase(), "commit");
  assert.equal(releases, 1);
});

test("schema migration rolls back and releases its client when DDL fails", async () => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(String(sql).trim().toLowerCase());
      return { rows: [], rowCount: 0 };
    },
    release() {
      releases += 1;
    }
  };

  await assert.rejects(
    runPersistenceSchemaMigration({ connect: async () => client }, {
      applySchema: async () => { throw new Error("ddl failed"); }
    }),
    /ddl failed/
  );

  assert.deepEqual(calls, ["begin", calls[1], "rollback"]);
  assert.match(calls[1], /pg_advisory_xact_lock/i);
  assert.equal(releases, 1);
});
