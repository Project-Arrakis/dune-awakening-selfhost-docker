import { randomBytes } from "node:crypto";
import pg from "pg";

const { Pool, Client } = pg;

// CREATE DATABASE / DROP DATABASE contend for the same cluster-wide catalog
// state. Confirmed via a live CI run: once a third Postgres-backed
// integration suite started running concurrently against the same server,
// Postgres's own log showed two unrelated, live backends killed with
// "FATAL: terminating connection due to administrator command" -- a real
// server-side race, not a client-side artifact, and not caused by any bug in
// the suites' own database-name scoping (each already uses a distinct,
// randomly-suffixed name). A single fixed advisory lock, held only around
// each test's own CREATE/DROP DATABASE calls -- never around the test body
// itself -- forces those two operations to interleave one at a time across
// every integration test file, while test bodies still run fully in
// parallel against their own isolated databases.
const DDL_LOCK_KEY = 847362910;

export function pgConnectionConfig(database = "dune") {
  if (process.env.ADMIN_DATABASE_URL) {
    const url = new URL(process.env.ADMIN_DATABASE_URL);
    url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return {
    host: process.env.DUNE_DB_HOST || process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.DUNE_DB_PORT || process.env.PGPORT || process.env.POSTGRES_PORT || 15432),
    database,
    user: process.env.DUNE_DB_USER || process.env.PGUSER || "dune",
    password: process.env.DUNE_DB_PASSWORD || process.env.PGPASSWORD || "dune",
    connectionTimeoutMillis: 3000
  };
}

export function pgTransactionalDb(pool) {
  return {
    query: (text, values = []) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (text, values = []) => client.query(text, values) });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

// pool.end() resolving does NOT mean every client has actually disconnected
// from the server. Traced into pg-pool's own source: a client already idle in
// the pool at the moment .end() is called takes a different internal path
// than a busy one -- it is spliced out of the pool's bookkeeping array
// SYNCHRONOUSLY, before its socket-level disconnect (the async Postgres
// Terminate message + TCP close) has actually completed, so .end()'s promise
// can resolve in under 1ms while the connection is still fully live on the
// server. Confirmed empirically against a real server: pg_stat_activity still
// listed the connection in 6 of 8 iterations immediately after .end()
// resolved. Calling pg_terminate_backend at that instant risks racing the
// connection's own in-flight, entirely normal disconnect -- which is exactly
// what the "terminating connection due to administrator command" errors seen
// in this suite turned out to be: our own best-effort cleanup killing a
// connection that was already on its way out, mid-query, from the KILLED
// connection's point of view. Polling for the natural disconnect first, and
// reaching for pg_terminate_backend only once that has genuinely run out,
// keeps the safety net for a truly stuck connection without risking it firing
// on an ordinary one.
async function waitUntilDisconnected(admin, database, { timeoutMs = 2000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      "select 1 from pg_stat_activity where datname = $1 and pid <> pg_backend_pid() limit 1",
      [database]);
    if (!rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function withDdlLock(admin, fn) {
  await admin.query("select pg_advisory_lock($1)", [DDL_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await admin.query("select pg_advisory_unlock($1)", [DDL_LOCK_KEY]).catch(() => {});
  }
}

// Runs `run(pool, database)` against a throwaway, isolated Postgres database.
// `admin` is a single dedicated Client (not a Pool) so the advisory lock it
// takes and releases is unambiguously scoped to one session throughout.
//
// namePrefix must be unique per call site -- it's the first line of defence
// against two suites ever colliding on a database name, independent of the
// lock this helper adds.
export async function withIsolatedDatabase(t, { namePrefix, unavailableLabel, createFailLabel }, run) {
  const label = unavailableLabel || "this integration test";
  const admin = new Client(pgConnectionConfig());
  const database = `${namePrefix}_${process.pid}_${randomBytes(4).toString("hex")}`;
  let pool;
  try {
    await admin.connect();
  } catch (error) {
    if (process.env.CI) throw new Error(`PostgreSQL is required for ${label}: ${error.message}`);
    t.skip(`PostgreSQL unavailable: ${error.message}`);
    return null;
  }
  try {
    await withDdlLock(admin, () => admin.query(`create database "${database}"`));
  } catch (error) {
    await admin.end().catch(() => {});
    if (process.env.CI) throw new Error(`PostgreSQL must allow an isolated database for ${createFailLabel || label}: ${error.message}`);
    t.skip(`PostgreSQL cannot create an isolated test database: ${error.message}`);
    return null;
  }
  try {
    pool = new Pool({ ...pgConnectionConfig(database), max: 4 });
    return await run(pool, database);
  } finally {
    await pool?.end().catch(() => {});
    // Give already-idle-at-end-time clients their grace period to finish
    // disconnecting on their own before ever reaching for
    // pg_terminate_backend -- see waitUntilDisconnected's comment. Only a
    // connection still listed after that genuine timeout is treated as
    // actually stuck.
    const clearedNaturally = await waitUntilDisconnected(admin, database).catch(() => false);
    if (!clearedNaturally) {
      // Best-effort: catches any connection that is genuinely stuck rather
      // than merely mid-disconnect.
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [database]
      ).catch(() => {});
      // pg_terminate_backend's SIGTERM is itself processed asynchronously by
      // the target backend -- DROP DATABASE right after can still fail with
      // "database is being accessed by other users" without this.
      await waitUntilDisconnected(admin, database, { timeoutMs: 1000 }).catch(() => {});
    }
    await withDdlLock(admin, () => admin.query(`drop database if exists "${database}"`).catch(() => {}));
    await admin.end().catch(() => {});
  }
}
