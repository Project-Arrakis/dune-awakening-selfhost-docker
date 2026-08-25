import { resolve } from "node:path";
import pg from "pg";
import { redact } from "./redact.js";
import { readInlineOrFile, resolvePorts } from "./config.js";

const { Pool } = pg;

export function discoverDbConfig(env = process.env, repoRoot = process.cwd()) {
  if (env.ADMIN_DATABASE_URL) {
    return { connectionString: env.ADMIN_DATABASE_URL, source: "ADMIN_DATABASE_URL" };
  }
  return {
    host: env.DUNE_DB_HOST || env.PGHOST || "127.0.0.1",
    // Upstream review finding: this previously preferred
    // DUNE_DB_PORT/PGPORT over resolvePorts().postgres, while
    // resolvePorts() itself prefers POSTGRES_PORT over
    // DUNE_DB_PORT/PGPORT -- if an operator had more than one of these
    // set to different values (a real, reachable misconfiguration, not
    // hypothetical), status/preflight (which reads resolvePorts()
    // directly) could disagree with the actual database connection
    // (which read this function). Always delegate to resolvePorts()
    // instead of re-implementing the precedence chain here, so there is
    // exactly one place this logic can ever drift from itself. postgres
    // is env-var-only (not profile-file-backed), so repoRoot doesn't
    // affect this specific field today -- passed through explicitly
    // anyway so this doesn't silently rely on process.cwd()
    // coincidentally matching config.repoRoot the moment a
    // profile-backed field is ever added here.
    port: resolvePorts(env, repoRoot).postgres,
    database: env.DUNE_DB_NAME || env.PGDATABASE || "dune",
    user: env.DUNE_DB_USER || env.PGUSER || "dune",
    password: env.DUNE_DB_PASSWORD || env.PGPASSWORD || "dune",
    source: "RedBlink defaults"
  };
}

export function createDb(config) {
  const dbConfig = discoverDbConfig(process.env, config?.repoRoot);
  const pool = new Pool({
    ...dbConfig,
    max: Number(process.env.ADMIN_DB_POOL_SIZE || 5),
    connectionTimeoutMillis: Number(process.env.ADMIN_DB_CONNECT_TIMEOUT_MS || 3000),
    idleTimeoutMillis: Number(process.env.ADMIN_DB_IDLE_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.ADMIN_DB_QUERY_TIMEOUT_MS || 15000),
    statement_timeout: Number(process.env.ADMIN_DB_STATEMENT_TIMEOUT_MS || 15000)
  });
  pool.on("error", (error) => {
    console.warn(`Database connection interrupted: ${redactDbError(error)}`);
  });

  async function query(text, values = []) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      throw new Error(redactDbError(error));
    }
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tx = {
        config: publicDbConfig(dbConfig),
        query: (text, values = []) => client.query(text, values)
      };
      const result = await fn(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw new Error(redactDbError(error));
    } finally {
      client.release();
    }
  }

  return {
    config: publicDbConfig(dbConfig),
    query,
    transaction,
    close: () => pool.end()
  };
}

// A genuinely separate, more-restricted credential for the Live Map's
// POI/resource-field marker sources (see dune-awakening-selfhost-docker#468).
// Deliberately NOT derived from discoverDbConfig()/the admin pool's
// credentials -- returns null when unconfigured so callers degrade via the
// existing unsupportedMap() pattern (see duneDb.js) rather than ever
// falling back to the full-privilege admin connection, which would make
// the read-only design decision decorative. Provisioning this role (a
// one-time CREATE ROLE ... GRANT SELECT ON dune.markers,
// dune.resourcefield_state) is a real, documented operator/DBA step --
// not something this app can bootstrap itself.
export function discoverReadOnlyMapDbConfig(env = process.env, repoRoot = process.cwd()) {
  const secretsDir = resolve(repoRoot, "runtime/secrets");
  const password = readInlineOrFile(env.DUNE_MAP_DB_PASSWORD, resolve(secretsDir, "map-readonly-db-password.txt"));
  if (!password) return null;
  return {
    host: env.DUNE_DB_HOST || env.PGHOST || "127.0.0.1",
    port: resolvePorts(env, repoRoot).postgres,
    database: env.DUNE_DB_NAME || env.PGDATABASE || "dune",
    user: env.DUNE_MAP_DB_USER || "dune_map_readonly",
    password,
    source: "map read-only role"
  };
}

export function createReadOnlyMapPool(config) {
  const mapConfig = discoverReadOnlyMapDbConfig(process.env, config?.repoRoot);
  if (!mapConfig) return null;

  const pool = new Pool({
    ...mapConfig,
    max: Number(process.env.MAP_DB_POOL_SIZE || 2),
    connectionTimeoutMillis: Number(process.env.MAP_DB_CONNECT_TIMEOUT_MS || 3000),
    idleTimeoutMillis: Number(process.env.MAP_DB_IDLE_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.MAP_DB_QUERY_TIMEOUT_MS || 15000),
    statement_timeout: Number(process.env.MAP_DB_STATEMENT_TIMEOUT_MS || 15000)
  });
  pool.on("error", (error) => {
    console.warn(`Map read-only database connection interrupted: ${redactDbError(error)}`);
  });

  async function query(text, values = []) {
    // Defense in depth on top of the role's own DB-level read-only grant --
    // this pool must never execute a write, even one reachable only by a
    // future call site copy-pasted from an admin-pool query.
    if (!isReadOnlySql(text)) {
      throw new Error("Refusing to run a non-read-only query against the map read-only pool.");
    }
    try {
      return await pool.query(text, values);
    } catch (error) {
      throw new Error(redactDbError(error));
    }
  }

  return {
    config: publicDbConfig(mapConfig),
    query,
    close: () => pool.end()
  };
}

export function publicDbConfig(config) {
  if (config.connectionString) return { source: config.source, connectionString: "<redacted>" };
  return {
    source: config.source,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: "<redacted>"
  };
}

export function redactDbError(error) {
  return redact(String(error?.message || "Unexpected error.")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/password=[^&\s]+/gi, "password=<redacted>"));
}

export function assertIdentifier(value, label = "identifier") {
  const raw = String(value || "");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  throw new Error(`Invalid ${label}`);
}

export function quoteIdentifier(value) {
  return `"${assertIdentifier(value).replaceAll('"', '""')}"`;
}

export function quoteQualified(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function intParam(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}

// PostgreSQL bigint identifiers must stay as decimal strings. Converting one
// to Number first silently rounds values above Number.MAX_SAFE_INTEGER and can
// make a destructive request target a different row.
export function bigintParam(value, label, min = 1n, max = 9223372036854775807n) {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`Invalid ${label}`);
  const n = BigInt(raw);
  if (n < min || n > max) throw new Error(`Invalid ${label}`);
  return n.toString();
}

export function isReadOnlySql(query) {
  const stripped = String(query || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return /^(select|with|show|explain)\b/i.test(stripped) &&
    !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy\s+.*\s+from)\b/i.test(stripped);
}

function normalizeQueryResult(result) {
  if (!Array.isArray(result)) return result;
  return [...result].reverse().find((entry) => Array.isArray(entry?.fields) && entry.fields.length) ||
    [...result].reverse().find((entry) => Array.isArray(entry?.rows)) ||
    result[result.length - 1] ||
    { fields: [], rows: [], rowCount: 0, command: "" };
}

export function rowsResult(result) {
  const normalized = normalizeQueryResult(result);
  const fields = Array.isArray(normalized?.fields) ? normalized.fields : [];
  const rows = Array.isArray(normalized?.rows) ? normalized.rows : [];
  return {
    columns: fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
    rows,
    rowCount: normalized?.rowCount ?? rows.length,
    command: normalized?.command || ""
  };
}
