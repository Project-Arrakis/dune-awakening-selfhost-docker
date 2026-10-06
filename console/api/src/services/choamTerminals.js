import { clampInt } from "../jsonStore.js";

const TERMINAL_CLASS = "/Game/Dune/Systems/DuneExchange/BP_DuneChoamExchangeTerminal.BP_DuneChoamExchangeTerminal_C";
const TERMINAL_PROPERTIES = {
  DEAccessPointComponent: {
    m_ExchangeName: { Name: "HarkoVillage_EX" },
    m_AccessPointName: { Name: "HarkoVillage_AP" },
    m_AutoAccessRange: 20000,
    m_bAllowLocalFulfillment: false
  }
};

export const CHOAM_TRADE_CENTERS = Object.freeze([
  { key: "griffins-reach", name: "Griffin's Reach", transform: { x: 22362.17092, y: 227322.55653, z: 8569.15, qx: 0, qy: 0, qz: 0.587675093782694, qw: -0.809097017759615 } },
  { key: "the-crossroads", name: "The Crossroads", transform: { x: -219168.952922, y: -163864.859739, z: 7406.37, qx: 0, qy: 0, qz: 0.645243922876868, qw: 0.763976622672756 } },
  { key: "pinnacle-station", name: "Pinnacle Station", transform: { x: -32508.744912, y: -312507.566723, z: 12072.19, qx: 0, qy: 0, qz: 0.998342907415711, qw: 0.057545105897411 } },
  { key: "the-anvil", name: "The Anvil", transform: { x: 192623.204276, y: 2451.055987, z: 13551.53, qx: 0, qy: 0, qz: 0.578820294915985, qw: -0.815455128252543 } }
]);

const DUPLICATE_RADIUS = 250;

// BP_DuneChoamExchangeTerminal_C parents its StaticMeshComponent to the actor
// root with RelativeLocation Z=+15, and the mesh pivot sits at its own base --
// so the visible base of the console lands at (actor root z + 15). A player
// pawn's persisted z is at ground level (NOT the capsule centre: the capsule
// half-height in the Blueprint does not describe the serialised transform),
// which makes the ground-flush root exactly (player z - 15). Measured in-game.
const MESH_BASE_OFFSET = 15;

// The console mesh's visual front is its local +Y, while a player pawn faces
// local +X. Both share one rotation convention (heading = 2*atan2(qz,qw) plus
// the local axis offset), so a terminal that should face the way a player is
// facing needs a yaw of (player yaw - 90).
const TERMINAL_FRONT_OFFSET = 90;

// Custom positions are bounded to the trade post rather than free placement:
// far enough to move a terminal off a step or around a wall, not far enough to
// drop one in open desert. Re-sitings during calibration moved 12.8-18.1 m.
const POSITION_RADIUS_UU = clampInt(process.env.CHOAM_POSITION_RADIUS_UU, 5000, 250, 100000);
const POSITION_VERTICAL_UU = clampInt(process.env.CHOAM_POSITION_VERTICAL_UU, 2000, 100, 100000);

function serviceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function defaultCenterForKey(value) {
  const key = String(value || "").trim().toLowerCase();
  const center = CHOAM_TRADE_CENTERS.find((entry) => entry.key === key);
  if (!center) throw serviceError("Choose a valid Hagga Basin trade post.");
  return center;
}

function normalizeDegrees(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

function yawToQuaternion(yawDegrees) {
  const radians = (normalizeDegrees(yawDegrees) * Math.PI) / 180;
  return { qx: 0, qy: 0, qz: Math.sin(radians / 2), qw: Math.cos(radians / 2) };
}

function quaternionYawDegrees(transform) {
  return normalizeDegrees((2 * Math.atan2(Number(transform?.qz) || 0, Number(transform?.qw) || 0) * 180) / Math.PI);
}

function finiteCoordinate(value, label) {
  // Number(null), Number("") and Number([]) are all 0, which would silently
  // place a terminal at the world origin instead of rejecting the input.
  if (value === null || value === undefined || value === "" || typeof value === "boolean" || Array.isArray(value)) {
    throw serviceError(`${label} must be a number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw serviceError(`${label} must be a number.`);
  return parsed;
}

// Pure and synchronous so the placement rules can be tested without a database.
export function derivePlacementFromPlayer(tradeCenterKey, position = {}) {
  defaultCenterForKey(tradeCenterKey);
  const x = finiteCoordinate(position.x, "X");
  const y = finiteCoordinate(position.y, "Y");
  const z = finiteCoordinate(position.z, "Z") - MESH_BASE_OFFSET;
  const yaw = normalizeDegrees(finiteCoordinate(position.yaw, "Facing") - TERMINAL_FRONT_OFFSET);
  return { x, y, z, yaw, ...evaluatePlacementBounds(tradeCenterKey, { x, y, z }) };
}

// Bounds are always measured against the SHIPPED default for the post, never
// against a previously saved override -- otherwise repeated small moves could
// walk a terminal arbitrarily far from its trade post.
export function evaluatePlacementBounds(tradeCenterKey, position = {}) {
  const base = defaultCenterForKey(tradeCenterKey).transform;
  const dx = finiteCoordinate(position.x, "X") - base.x;
  const dy = finiteCoordinate(position.y, "Y") - base.y;
  const distanceUu = Math.sqrt(dx * dx + dy * dy);
  const verticalUu = Math.abs(finiteCoordinate(position.z, "Z") - base.z);
  return {
    distanceUu,
    verticalUu,
    withinBound: distanceUu <= POSITION_RADIUS_UU && verticalUu <= POSITION_VERTICAL_UU,
    limits: { radiusUu: POSITION_RADIUS_UU, verticalUu: POSITION_VERTICAL_UU }
  };
}

// Decides whether a freshly-read player position can be trusted for placement.
//
// dune.actors lags live movement, so a position read on demand may be stale --
// and repeated reads inside that lag window return identical stale values, so
// sampling alone cannot detect it. What makes this decidable is `serial`: the
// game rewrites the row on a periodic heartbeat (~60s measured on dune2) even
// when the character has not moved. Once serial advances past the baseline,
// that row was written with the character's live position, so it is current by
// construction -- no window to guess at.
//
// Caller supplies the baseline captured when the operator pressed capture, and
// polls until this returns `ready`.
export function evaluateCaptureFreshness(baseline, current) {
  if (!current) return { ready: false, state: "unavailable" };
  const currentSerial = String(current.serial ?? "");
  if (!baseline || !baseline.serial) {
    // First read: establishes the baseline, never accepted on its own.
    return { ready: false, state: "waiting", serial: currentSerial };
  }
  if (currentSerial === String(baseline.serial)) {
    return { ready: false, state: "waiting", serial: currentSerial };
  }
  // The heartbeat fired. If the position it wrote matches the baseline, the
  // character was stationary across the whole interval.
  const moved = !samePosition(baseline, current);
  return {
    ready: !moved,
    state: moved ? "moving" : "ready",
    serial: currentSerial,
    movedUu: moved ? distanceBetween(baseline, current) : 0
  };
}

function samePosition(a, b) {
  return Number(a.x) === Number(b.x)
    && Number(a.y) === Number(b.y)
    && Number(a.z) === Number(b.z)
    && normalizeDegrees(a.yaw) === normalizeDegrees(b.yaw);
}

function distanceBetween(a, b) {
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const dz = Number(b.z) - Number(a.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function applyPositionOverride(center, row) {
  // defaultTransform travels with every entry so the client can recompute the
  // trade-post bound while the operator edits -- the bound is measured from the
  // shipped default, never from whatever override is currently saved.
  const base = { ...center, defaultTransform: center.transform };
  if (!row) return { ...base, custom: false };
  const transform = {
    x: Number(row.x), y: Number(row.y), z: Number(row.z),
    qx: 0, qy: 0, qz: Number(row.qz), qw: Number(row.qw)
  };
  return { ...base, custom: true, transform, updatedAt: row.updated_at || "" };
}

async function requiredTablesAvailable(db) {
  const result = await db.query(`
    select to_regclass('dune.actors') is not null as actors,
           to_regclass('dune.inventories') is not null as inventories,
           to_regclass('dune.world_partition') is not null as world_partition`);
  const row = result.rows[0] || {};
  return Boolean(row.actors && row.inventories && row.world_partition);
}

async function trackingTableAvailable(db) {
  const result = await db.query("select to_regclass('dune.admin_choam_terminals') is not null as exists");
  return Boolean(result.rows[0]?.exists);
}

async function positionTableAvailable(db) {
  const result = await db.query("select to_regclass('dune.admin_choam_terminal_positions') is not null as exists");
  return Boolean(result.rows[0]?.exists);
}

async function ensurePositionTable(tx) {
  await tx.query(`
    create table if not exists dune.admin_choam_terminal_positions (
      trade_center_key text primary key,
      x float8 not null,
      y float8 not null,
      z float8 not null,
      qz float8 not null,
      qw float8 not null,
      source_player_id bigint,
      updated_at timestamptz not null default now()
    )`);
}

const POSITION_COLUMNS = "trade_center_key, x, y, z, qz, qw, source_player_id::text as source_player_id, updated_at::text as updated_at";

async function loadPositionOverrides(db) {
  if (!(await positionTableAvailable(db))) return new Map();
  const result = await db.query(`select ${POSITION_COLUMNS} from dune.admin_choam_terminal_positions`);
  return new Map(result.rows.map((row) => [row.trade_center_key, row]));
}

async function loadPositionOverride(tx, key) {
  const result = await tx.query(`select ${POSITION_COLUMNS} from dune.admin_choam_terminal_positions where trade_center_key = $1`, [key]);
  return result.rows[0] || null;
}

async function ensureTrackingTable(tx) {
  await tx.query(`
    create table if not exists dune.admin_choam_terminals (
      trade_center_key text not null,
      trade_center_name text not null,
      dimension_index integer not null,
      partition_id bigint not null,
      actor_id bigint not null references dune.actors(id) on delete cascade,
      source_player_id bigint,
      created_at timestamptz not null default now(),
      primary key (trade_center_key, dimension_index),
      unique (actor_id)
    )`);
}

async function activeSietches(db) {
  const result = await db.query(`
    select partition_id::text,
           dimension_index::int,
           coalesce(nullif(label, ''), 'Sietch ' || (dimension_index + 1)::text) as label
    from dune.world_partition
    where map = 'Survival_1'
      and coalesce(blocked, false) = false
    order by dimension_index, partition_id`);
  return result.rows;
}

export async function choamTerminalOverview(db) {
  if (!(await requiredTablesAvailable(db))) {
    return { supported: false, reason: "CHOAM terminal placement is unavailable for this database schema.", tradeCenters: CHOAM_TRADE_CENTERS, sietches: [], placements: [] };
  }
  const [sietches, hasTracking, overrides] = await Promise.all([
    activeSietches(db),
    trackingTableAvailable(db),
    loadPositionOverrides(db)
  ]);
  const tradeCenters = CHOAM_TRADE_CENTERS.map((center) => applyPositionOverride(center, overrides.get(center.key)));
  let placements = [];
  if (hasTracking) {
    const result = await db.query(`
      select t.trade_center_key,
             t.trade_center_name,
             t.dimension_index::int,
             t.partition_id::text,
             t.actor_id::text,
             t.source_player_id::text,
             t.created_at::text,
             (a.id is not null) as actor_present
      from dune.admin_choam_terminals t
      left join dune.actors a on a.id = t.actor_id
      order by t.trade_center_name, t.dimension_index`);
    placements = result.rows;
  }
  return {
    supported: true,
    tradeCenters,
    sietches,
    placements,
    positionLimits: { radiusUu: POSITION_RADIUS_UU, verticalUu: POSITION_VERTICAL_UU }
  };
}

async function nearbyTerminal(tx, partitionId, dimensionIndex, transform) {
  const result = await tx.query(`
    select id::text
    from dune.actors
    where class = $1
      and map = 'HaggaBasin'
      and partition_id = $2::bigint
      and dimension_index = $3::integer
      and transform is not null
      and power(((transform).location).x - $4::float8, 2)
        + power(((transform).location).y - $5::float8, 2)
        + power(((transform).location).z - $6::float8, 2) <= $7::float8
    limit 1`, [TERMINAL_CLASS, partitionId, dimensionIndex, transform.x, transform.y, transform.z, DUPLICATE_RADIUS * DUPLICATE_RADIUS]);
  return result.rows[0]?.id || "";
}

export async function installChoamTerminals(db, { tradeCenterKey } = {}) {
  const baseCenter = defaultCenterForKey(tradeCenterKey);
  if (!(await requiredTablesAvailable(db))) throw serviceError("CHOAM terminal placement is unavailable for this database schema.", 409);
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    return installWithin(tx, baseCenter);
  });
}

// Body of an install, minus the transaction and lock, so that a reposition can
// remove and reinstall inside ONE transaction. If the install half throws, the
// remove half rolls back with it and the trade post keeps its old terminal
// rather than ending up with none.
async function installWithin(tx, baseCenter) {
  {
    await ensureTrackingTable(tx);
    await ensurePositionTable(tx);
    // Resolved inside the lock so a concurrent position save cannot install a
    // terminal at a transform that was already superseded.
    const center = applyPositionOverride(baseCenter, await loadPositionOverride(tx, baseCenter.key));
    const existingResult = await tx.query(`
      select t.dimension_index::int
      from dune.admin_choam_terminals t
      where t.trade_center_key = $1
      order by t.dimension_index`, [center.key]);
    const installedDimensions = new Set(existingResult.rows.map((row) => Number(row.dimension_index)));
    const transform = center.transform;
    const sietches = await activeSietches(tx);
    if (!sietches.length) throw serviceError("No active Hagga Basin sietches were found.", 409);
    const created = [];
    for (const sietch of sietches) {
      const dimensionIndex = Number(sietch.dimension_index);
      if (installedDimensions.has(dimensionIndex)) continue;
      const nearbyActorId = await nearbyTerminal(tx, sietch.partition_id, dimensionIndex, transform);
      if (nearbyActorId) {
        throw serviceError(`A CHOAM terminal already exists near this position in ${sietch.label}. Remove or move it before installing another.`, 409);
      }
      const actorResult = await tx.query(`
        insert into dune.actors
          (class, map, transform, partition_id, dimension_index, properties, serial)
        values
          ($1, 'HaggaBasin',
           ROW(ROW($2::float8,$3::float8,$4::float8)::dune.vector, ROW($5::float8,$6::float8,$7::float8,$8::float8)::dune.quaternion)::dune.transform,
           $9::bigint, $10::integer, $11::jsonb, 1)
        returning id::text`, [
        TERMINAL_CLASS,
        transform.x, transform.y, transform.z,
        transform.qx, transform.qy, transform.qz, transform.qw,
        sietch.partition_id, dimensionIndex, JSON.stringify(TERMINAL_PROPERTIES)
      ]);
      const terminalActorId = actorResult.rows[0]?.id;
      if (!terminalActorId) throw serviceError("The game database did not return the new terminal actor ID.", 500);
      await tx.query(`
        insert into dune.inventories (actor_id, inventory_type, max_item_count, max_item_volume)
        values ($1::bigint, 0, -1, 0)`, [terminalActorId]);
      await tx.query(`
        insert into dune.admin_choam_terminals
          (trade_center_key, trade_center_name, dimension_index, partition_id, actor_id)
        values ($1, $2, $3::integer, $4::bigint, $5::bigint)`, [
        center.key, center.name, dimensionIndex, sietch.partition_id, terminalActorId
      ]);
      created.push({ dimensionIndex, partitionId: sietch.partition_id, actorId: terminalActorId, label: sietch.label });
    }
    return {
      ok: true,
      tradeCenter: center,
      created,
      unchanged: sietches.length - created.length,
      position: { x: transform.x, y: transform.y, z: transform.z },
      restartRequired: created.length > 0
    };
  }
}

export async function removeChoamTerminals(db, { tradeCenterKey } = {}) {
  const center = defaultCenterForKey(tradeCenterKey);
  if (!(await trackingTableAvailable(db))) return { ok: true, tradeCenter: center, removed: 0, restartRequired: false };
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    return removeWithin(tx, center);
  });
}

async function removeWithin(tx, center) {
  {
    const result = await tx.query(`
      select actor_id::text
      from dune.admin_choam_terminals
      where trade_center_key = $1
      for update`, [center.key]);
    const ids = result.rows.map((row) => row.actor_id).filter(Boolean);
    if (ids.length) await tx.query("delete from dune.actors where id = any($1::bigint[])", [ids]);
    await tx.query("delete from dune.admin_choam_terminals where trade_center_key = $1", [center.key]);
    return { ok: true, tradeCenter: center, removed: ids.length, restartRequired: ids.length > 0 };
  }
}

export async function setChoamTerminalPosition(db, { tradeCenterKey, x, y, z, yaw, sourcePlayerId, applyNow = false } = {}) {
  const base = defaultCenterForKey(tradeCenterKey);
  const position = {
    x: finiteCoordinate(x, "X"),
    y: finiteCoordinate(y, "Y"),
    z: finiteCoordinate(z, "Z")
  };
  const bounds = evaluatePlacementBounds(base.key, position);
  if (!bounds.withinBound) {
    throw serviceError(
      `That position is ${Math.round(bounds.distanceUu / 100)} m from ${base.name}. Custom positions must stay within ${Math.round(bounds.limits.radiusUu / 100)} m horizontally and ${Math.round(bounds.limits.verticalUu / 100)} m vertically of the trade post.`
    );
  }
  const rotation = yawToQuaternion(finiteCoordinate(yaw, "Facing"));
  // Provenance only, and the column is a bigint -- an FLS account id or any
  // other non-numeric handle is recorded as null rather than failing the save.
  const rawPlayerId = String(sourcePlayerId ?? "").trim();
  const playerId = /^\d+$/.test(rawPlayerId) ? rawPlayerId : null;

  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    await ensurePositionTable(tx);
    await tx.query(`
      insert into dune.admin_choam_terminal_positions
        (trade_center_key, x, y, z, qz, qw, source_player_id, updated_at)
      values ($1, $2::float8, $3::float8, $4::float8, $5::float8, $6::float8, $7::bigint, now())
      on conflict (trade_center_key) do update set
        x = excluded.x, y = excluded.y, z = excluded.z,
        qz = excluded.qz, qw = excluded.qw,
        source_player_id = excluded.source_player_id,
        updated_at = now()`, [
      base.key, position.x, position.y, position.z, rotation.qz, rotation.qw, playerId
    ]);
    const installed = await installedCountForKey(tx, base.key);
    // Moving an installed terminal is a remove + install, never an in-place
    // UPDATE of dune.actors -- that path was never verified and this game
    // silently ignores some direct DML. Both halves run in THIS transaction, so
    // a failure cannot leave the trade post with no terminal at all.
    let moved = null;
    if (applyNow && installed > 0) {
      const removal = await removeWithin(tx, base);
      const install = await installWithin(tx, base);
      moved = { removed: removal.removed, created: install.created.length };
    }
    return {
      ok: true,
      tradeCenter: applyPositionOverride(base, await loadPositionOverride(tx, base.key)),
      ...bounds,
      yaw: normalizeDegrees(yaw),
      moved,
      restartRequired: Boolean(moved && moved.created > 0),
      reinstallRequired: installed > 0 && !moved
    };
  });
}

export async function clearChoamTerminalPosition(db, { tradeCenterKey } = {}) {
  const base = defaultCenterForKey(tradeCenterKey);
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    // Probed inside the lock, not before it: a concurrent first-ever save
    // creates this table while holding the same lock, so a probe on the pool
    // could miss a row that exists by the time the delete runs and wrongly
    // report the post as uncustomised.
    if (!(await positionTableAvailable(tx))) {
      return { ok: true, tradeCenter: { ...base, custom: false }, cleared: 0, reinstallRequired: false };
    }
    const result = await tx.query("delete from dune.admin_choam_terminal_positions where trade_center_key = $1", [base.key]);
    const installed = await installedCountForKey(tx, base.key);
    return {
      ok: true,
      tradeCenter: { ...base, custom: false },
      cleared: result.rowCount || 0,
      reinstallRequired: (result.rowCount || 0) > 0 && installed > 0
    };
  });
}

async function installedCountForKey(tx, key) {
  if (!(await trackingTableAvailable(tx))) return 0;
  const result = await tx.query(`
    select count(*)::int as installed
    from dune.admin_choam_terminals t
    join dune.actors a on a.id = t.actor_id
    where t.trade_center_key = $1`, [key]);
  return Number(result.rows[0]?.installed || 0);
}

export const choamTerminalInternals = Object.freeze({
  terminalClass: TERMINAL_CLASS,
  terminalProperties: TERMINAL_PROPERTIES,
  duplicateRadius: DUPLICATE_RADIUS,
  meshBaseOffset: MESH_BASE_OFFSET,
  terminalFrontOffset: TERMINAL_FRONT_OFFSET,
  positionRadiusUu: POSITION_RADIUS_UU,
  positionVerticalUu: POSITION_VERTICAL_UU,
  yawToQuaternion,
  quaternionYawDegrees,
  normalizeDegrees
});
