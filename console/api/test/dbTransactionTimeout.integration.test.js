import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.js";
import { withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

test("real PostgreSQL: a transaction timeout override does not loosen other queries or server cancellation", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_transaction_timeout",
    unavailableLabel: "transaction timeout regression"
  }, async (_pool, database) => {
    const keys = ["DUNE_DB_NAME", "ADMIN_DATABASE_URL", "ADMIN_DB_QUERY_TIMEOUT_MS", "ADMIN_DB_STATEMENT_TIMEOUT_MS"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.DUNE_DB_NAME = database;
    if (process.env.ADMIN_DATABASE_URL) {
      const url = new URL(process.env.ADMIN_DATABASE_URL);
      url.pathname = `/${database}`;
      process.env.ADMIN_DATABASE_URL = url.toString();
    }
    process.env.ADMIN_DB_QUERY_TIMEOUT_MS = "100";
    process.env.ADMIN_DB_STATEMENT_TIMEOUT_MS = "2000";
    const db = createDb({ repoRoot: process.cwd() });
    try {
      await db.transaction(async (tx) => {
        const result = await tx.query("select pg_sleep($1), 42 as answer", [0.3]);
        assert.equal(result.rows[0].answer, 42);
      }, { queryTimeoutMs: 1000 });
      await assert.rejects(db.transaction((tx) => tx.query("select pg_sleep(0.3)")), /timeout/i);
      await assert.rejects(db.query("select pg_sleep(0.3)"), /timeout/i);
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query("set local statement_timeout = '100ms'");
        await tx.query("select pg_sleep(0.3)");
      }, { queryTimeoutMs: 1000 }), /statement timeout/i);
      assert.equal((await db.query("select 1 as ready")).rows[0].ready, 1);
    } finally {
      await db.close();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
