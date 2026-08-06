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
    // Best-effort: catches any connection the pool's own end() missed.
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database]
    ).catch(() => {});
    await withDdlLock(admin, () => admin.query(`drop database if exists "${database}"`).catch(() => {}));
    await admin.end().catch(() => {});
  }
}
