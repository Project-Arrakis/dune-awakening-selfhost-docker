import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_INTERVAL_MS = 10000;
const SNAPSHOT_BASENAME = "death-snapshot.json";

function snapshotFile(repoRoot) {
  return resolve(repoRoot, "runtime/generated", SNAPSHOT_BASENAME);
}

function loadSnapshot(repoRoot) {
  const file = snapshotFile(repoRoot);
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      if (raw) return new Map(JSON.parse(raw));
    }
  } catch { /* corrupted snapshot — start fresh */ }
  return new Map();
}

function saveSnapshot(repoRoot, states) {
  const file = snapshotFile(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  const data = JSON.stringify([...states]);
  writeFileSync(file, data, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

async function queryCurrentStates(db) {
  const result = await db.query(`
    select player_controller_id::text as id, coalesce(life_state::text, 'Alive') as state
    from dune.player_state`);
  return new Map((result.rows || []).map(r => [String(r.id), String(r.state)]));
}

function ensureTableSQL() {
  return `
    create table if not exists dune.player_death_log (
      id bigint generated always as identity,
      player_controller_id bigint not null,
      death_time timestamptz not null default now(),
      death_cause text not null,
      primary key (id)
    );
    create index if not exists idx_player_death_log_time
      on dune.player_death_log (death_time);
    create index if not exists idx_player_death_log_player
      on dune.player_death_log (player_controller_id);`;
}

async function ensureTable(db) {
  try { await db.query(ensureTableSQL()); } catch { /* table may already exist */ }
}

function detectTransitions(previous, current) {
  const deaths = [];
  if (!previous.size) return deaths;
  for (const [id, newState] of current) {
    if (!newState.startsWith("Dead")) continue;
    const oldState = previous.get(id);
    if (oldState === "Alive") {
      deaths.push({ player_controller_id: id, death_cause: newState });
    }
  }
  return deaths;
}

async function insertDeath(db, death) {
  await db.query(
    "insert into dune.player_death_log (player_controller_id, death_cause) values ($1, $2)",
    [Number(death.player_controller_id), death.death_cause]
  );
}

const INIT_SQL = ensureTableSQL();

export function createDeathPoller(config) {
  let snapshot = new Map();
  let running = false;
  let started = false;
  let pollerDb = null;

  async function tick() {
    if (running || !pollerDb) return;
    running = true;
    try {
      const current = await queryCurrentStates(pollerDb);
      const deaths = detectTransitions(snapshot, current);
      for (const d of deaths) {
        await insertDeath(pollerDb, d).catch(() => { });
      }
      saveSnapshot(config.repoRoot, current);
      snapshot = current;
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/connect|database|relation|container|ECONNREFUSED|ECONNRESET|terminated|does not exist/i.test(msg)) {
        console.error(`Death poller tick failed: ${msg}`);
      }
    } finally {
      running = false;
    }
  }

  async function init(db, repoRoot) {
    if (started) return;
    started = true;
    pollerDb = db;
    await ensureTable(db);
    snapshot = loadSnapshot(repoRoot);
  }

  return {
    init,
    tick,
    get enabled() { return process.env.DUNE_DEATH_POLLER_ENABLED === "true"; },
    get intervalMs() { return Number(process.env.ADMIN_DEATH_POLL_INTERVAL_MS || DEFAULT_INTERVAL_MS); },
    get initSQL() { return INIT_SQL; }
  };
}

export { detectTransitions };
