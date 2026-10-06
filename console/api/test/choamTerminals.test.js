import test from "node:test";
import assert from "node:assert/strict";
import { CHOAM_TRADE_CENTERS, choamTerminalInternals, derivePlacementFromPlayer, evaluatePlacementBounds, setChoamTerminalPosition, choamTerminalOverview, evaluateCaptureFreshness, clearChoamTerminalPosition } from "../src/services/choamTerminals.js";

test("CHOAM trade-center catalog contains the four Hagga Basin trade centers", () => {
  assert.deepEqual(CHOAM_TRADE_CENTERS.map((entry) => entry.key), ["griffins-reach", "the-crossroads", "pinnacle-station", "the-anvil"]);
});

test("every CHOAM trade center has a complete verified transform", () => {
  for (const center of CHOAM_TRADE_CENTERS) {
    assert.deepEqual(Object.keys(center.transform), ["x", "y", "z", "qx", "qy", "qz", "qw"]);
    assert.ok(Object.values(center.transform).every(Number.isFinite));
  }
});

test("terminal configuration uses the real game class and exchange access point", () => {
  assert.equal(choamTerminalInternals.terminalClass, "/Game/Dune/Systems/DuneExchange/BP_DuneChoamExchangeTerminal.BP_DuneChoamExchangeTerminal_C");
  assert.equal(choamTerminalInternals.terminalProperties.DEAccessPointComponent.m_ExchangeName.Name, "HarkoVillage_EX");
  assert.equal(choamTerminalInternals.terminalProperties.DEAccessPointComponent.m_AccessPointName.Name, "HarkoVillage_AP");
});

// The placement rules below were derived by measuring real in-game placements,
// not by reading the Blueprint -- a static read of the player capsule gave
// `ground = player_z - 95`, which was wrong by the full 95 and inverted the
// diagnosis (terminals read as floating when they were buried). The four
// regression cases lock the captured-position -> shipped-constant relationship
// so that a future refactor cannot quietly reintroduce an offset error.

test("a captured player position drops by the blueprint mesh offset", () => {
  const placement = derivePlacementFromPlayer("the-anvil", { x: 1, y: 2, z: 1000, yaw: 0 });
  assert.equal(placement.z, 1000 - choamTerminalInternals.meshBaseOffset);
  assert.equal(placement.x, 1);
  assert.equal(placement.y, 2);
});

test("terminal yaw trails player facing by the local-axis offset and wraps", () => {
  assert.equal(derivePlacementFromPlayer("the-anvil", { x: 0, y: 0, z: 0, yaw: 180 }).yaw, 90);
  assert.equal(derivePlacementFromPlayer("the-anvil", { x: 0, y: 0, z: 0, yaw: 0 }).yaw, 270);
  assert.equal(derivePlacementFromPlayer("the-anvil", { x: 0, y: 0, z: 0, yaw: 45 }).yaw, 315);
  assert.equal(derivePlacementFromPlayer("the-anvil", { x: 0, y: 0, z: 0, yaw: 720 + 90 }).yaw, 0);
});

test("each shipped constant is reproduced by the position it was captured from", () => {
  const captures = [
    { key: "griffins-reach", z: 8569.15 + 15, yaw: 288.02 + 90 },
    { key: "the-crossroads", z: 7406.37 + 15, yaw: 80.37 + 90 },
    { key: "pinnacle-station", z: 12072.19 + 15, yaw: 173.40 + 90 },
    { key: "the-anvil", z: 13551.53 + 15, yaw: 289.26 + 90 }
  ];
  for (const capture of captures) {
    const shipped = CHOAM_TRADE_CENTERS.find((entry) => entry.key === capture.key);
    const placement = derivePlacementFromPlayer(capture.key, { x: shipped.transform.x, y: shipped.transform.y, z: capture.z, yaw: capture.yaw });
    assert.ok(Math.abs(placement.z - shipped.transform.z) < 0.005, `${capture.key} z ${placement.z} vs ${shipped.transform.z}`);
    const quaternion = choamTerminalInternals.yawToQuaternion(placement.yaw);
    assert.ok(Math.abs(quaternion.qz - shipped.transform.qz) < 1e-4, `${capture.key} qz`);
    assert.ok(Math.abs(quaternion.qw - shipped.transform.qw) < 1e-4, `${capture.key} qw`);
  }
});

test("yaw survives a quaternion round trip, including the negative-w half", () => {
  for (const yaw of [0, 45, 90, 173.4, 180, 270, 288.02, 289.26, 359.9]) {
    const quaternion = choamTerminalInternals.yawToQuaternion(yaw);
    assert.ok(Math.abs(choamTerminalInternals.quaternionYawDegrees(quaternion) - yaw) < 1e-9, `yaw ${yaw}`);
  }
  // Griffin's Reach and The Anvil both ship a negative qw; q and -q are the
  // same rotation, so the round trip has to hold for that half too.
  assert.ok(CHOAM_TRADE_CENTERS.some((entry) => entry.transform.qw < 0));
  for (const center of CHOAM_TRADE_CENTERS) {
    const yaw = choamTerminalInternals.quaternionYawDegrees(center.transform);
    const quaternion = choamTerminalInternals.yawToQuaternion(yaw);
    assert.ok(Math.abs(choamTerminalInternals.quaternionYawDegrees(quaternion) - yaw) < 1e-9, center.key);
  }
});

test("non-numeric capture input is rejected rather than coerced", () => {
  assert.throws(() => derivePlacementFromPlayer("the-anvil", { x: "nope", y: 0, z: 0, yaw: 0 }), /X must be a number/);
  assert.throws(() => derivePlacementFromPlayer("the-anvil", { x: 0, y: 0, z: 0, yaw: null }), /Facing must be a number/);
  assert.throws(() => derivePlacementFromPlayer("not-a-post", { x: 0, y: 0, z: 0, yaw: 0 }), /valid Hagga Basin trade post/);
});

const ANVIL = CHOAM_TRADE_CENTERS.find((entry) => entry.key === "the-anvil").transform;

test("bounds accept a nudge inside the trade post and reject a hike outside it", () => {
  const near = evaluatePlacementBounds("the-anvil", { x: ANVIL.x + 1000, y: ANVIL.y, z: ANVIL.z });
  assert.equal(near.withinBound, true);
  assert.ok(Math.abs(near.distanceUu - 1000) < 1e-6);

  const far = evaluatePlacementBounds("the-anvil", { x: ANVIL.x + near.limits.radiusUu + 1, y: ANVIL.y, z: ANVIL.z });
  assert.equal(far.withinBound, false);
});

test("bounds reject a position that is in range horizontally but far above or below", () => {
  const limits = evaluatePlacementBounds("the-anvil", ANVIL).limits;
  const high = evaluatePlacementBounds("the-anvil", { x: ANVIL.x, y: ANVIL.y, z: ANVIL.z + limits.verticalUu + 1 });
  assert.equal(high.withinBound, false);
  assert.ok(Math.abs(high.distanceUu) < 1e-6);
  const low = evaluatePlacementBounds("the-anvil", { x: ANVIL.x, y: ANVIL.y, z: ANVIL.z - limits.verticalUu - 1 });
  assert.equal(low.withinBound, false);
});

test("an out-of-bounds save is refused before any write is attempted", async () => {
  const db = { transaction: async () => { throw new Error("the transaction must not be reached"); } };
  await assert.rejects(
    () => setChoamTerminalPosition(db, { tradeCenterKey: "the-anvil", x: ANVIL.x + 5_000_000, y: ANVIL.y, z: ANVIL.z, yaw: 0 }),
    /must stay within/
  );
});

// A stub rather than a live database: these assert the override wiring, which
// is pure branching over query results. The install path itself is covered by
// the integration suite.
function stubDb(overrideRows) {
  return {
    query: async (sql) => {
      if (sql.includes("dune.admin_choam_terminal_positions")) {
        return sql.includes("to_regclass") ? { rows: [{ exists: true }] } : { rows: overrideRows };
      }
      if (sql.includes("to_regclass('dune.admin_choam_terminals')")) return { rows: [{ exists: true }] };
      if (sql.includes("to_regclass('dune.actors')")) return { rows: [{ actors: true, inventories: true, world_partition: true }] };
      if (sql.includes("dune.world_partition")) return { rows: [{ partition_id: "1", dimension_index: 0, label: "Sietch 1" }] };
      if (sql.includes("dune.admin_choam_terminals t")) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    }
  };
}

test("overview reports shipped defaults when nothing is overridden", async () => {
  const overview = await choamTerminalOverview(stubDb([]));
  assert.equal(overview.supported, true);
  assert.ok(overview.tradeCenters.every((entry) => entry.custom === false));
  assert.deepEqual(overview.tradeCenters.find((entry) => entry.key === "the-anvil").transform, ANVIL);
  assert.equal(overview.positionLimits.radiusUu, choamTerminalInternals.positionRadiusUu);
});

test("overview applies a stored override over the shipped default", async () => {
  const overview = await choamTerminalOverview(stubDb([
    { trade_center_key: "the-anvil", x: 11, y: 22, z: 33, qz: 0.5, qw: 0.5, source_player_id: "6", updated_at: "2026-09-20T00:00:00Z" }
  ]));
  const anvil = overview.tradeCenters.find((entry) => entry.key === "the-anvil");
  assert.equal(anvil.custom, true);
  assert.deepEqual(anvil.transform, { x: 11, y: 22, z: 33, qx: 0, qy: 0, qz: 0.5, qw: 0.5 });
  assert.equal(anvil.updatedAt, "2026-09-20T00:00:00Z");
  // Untouched posts must keep shipping their defaults.
  assert.equal(overview.tradeCenters.find((entry) => entry.key === "the-crossroads").custom, false);
});

// Freshness is decided by the game's row heartbeat, not by sampling.
//
// Measured on dune2: `serial` advances roughly every 60s and rewrites the row
// with the live position even when the character has not moved (7767 -> 7768
// with byte-identical coordinates). So an advanced serial proves the row was
// written recently; an unchanged position across that tick proves the
// character was stationary for the whole interval. Sampling could never
// establish the first of those, which is why an earlier attempt reported a
// stale coordinate as settled.

const STILL = { serial: "100", x: 10, y: 20, z: 30, yaw: 90 };

test("the first read only establishes a baseline, it is never accepted", () => {
  const result = evaluateCaptureFreshness(null, STILL);
  assert.equal(result.ready, false);
  assert.equal(result.state, "waiting");
  assert.equal(result.serial, "100");
});

test("an unchanged serial keeps waiting, however many times it is polled", () => {
  for (let poll = 0; poll < 5; poll += 1) {
    const result = evaluateCaptureFreshness(STILL, { ...STILL });
    assert.equal(result.ready, false);
    assert.equal(result.state, "waiting");
  }
});

test("a stale row is never accepted just because it stopped changing", () => {
  // The exact failure that made an earlier design report a stale coordinate as
  // settled: the row is identical because nothing has been flushed yet.
  const stale = { ...STILL };
  assert.equal(evaluateCaptureFreshness(STILL, stale).ready, false);
});

test("the heartbeat firing with an unchanged position is accepted", () => {
  const result = evaluateCaptureFreshness(STILL, { ...STILL, serial: "101" });
  assert.equal(result.ready, true);
  assert.equal(result.state, "ready");
  assert.equal(result.movedUu, 0);
});

test("the heartbeat firing with a changed position means still moving", () => {
  const result = evaluateCaptureFreshness(STILL, { ...STILL, serial: "101", x: 310 });
  assert.equal(result.ready, false);
  assert.equal(result.state, "moving");
  assert.ok(Math.abs(result.movedUu - 300) < 1e-9);
});

test("turning on the spot across a heartbeat is not accepted", () => {
  const result = evaluateCaptureFreshness(STILL, { ...STILL, serial: "101", yaw: 91 });
  assert.equal(result.ready, false);
  assert.equal(result.state, "moving");
});

test("position equality is exact - a millimetre counts as movement", () => {
  const result = evaluateCaptureFreshness(STILL, { ...STILL, serial: "101", z: 30.001 });
  assert.equal(result.ready, false);
});

test("an unreadable position is reported rather than treated as ready", () => {
  const result = evaluateCaptureFreshness(STILL, null);
  assert.equal(result.ready, false);
  assert.equal(result.state, "unavailable");
});

test("every trade center carries its shipped default alongside any override", async () => {
  const overview = await choamTerminalOverview(stubDb([
    { trade_center_key: "the-anvil", x: 11, y: 22, z: 33, qz: 0.5, qw: 0.5, source_player_id: null, updated_at: "" }
  ]));
  const anvil = overview.tradeCenters.find((entry) => entry.key === "the-anvil");
  assert.deepEqual(anvil.transform, { x: 11, y: 22, z: 33, qx: 0, qy: 0, qz: 0.5, qw: 0.5 });
  // The default must survive the override, or the client would measure the
  // bound from the override and let it drift post by post.
  assert.deepEqual(anvil.defaultTransform, ANVIL);
  const crossroads = overview.tradeCenters.find((entry) => entry.key === "the-crossroads");
  assert.deepEqual(crossroads.defaultTransform, crossroads.transform);
});

// Repositioning an installed terminal must remove and reinstall inside one
// transaction. Anything else can leave a trade post with no terminal at all if
// the install half fails.
test("applyNow repositions inside a single transaction", async () => {
  const calls = [];
  const tx = {
    query: async (sql) => {
      calls.push(sql.trim().split("\n")[0].slice(0, 42));
      if (sql.includes("to_regclass('dune.admin_choam_terminal_positions')")) return { rows: [{ exists: true }] };
      if (sql.includes("to_regclass('dune.admin_choam_terminals')")) return { rows: [{ exists: true }] };
      if (sql.includes("from dune.admin_choam_terminal_positions")) return { rows: [] };
      if (sql.includes("count(*)::int as installed")) return { rows: [{ installed: 2 }] };
      if (sql.includes("select actor_id::text")) return { rows: [{ actor_id: "1" }, { actor_id: "2" }] };
      if (sql.includes("dune.world_partition")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    }
  };
  let transactions = 0;
  const db = { transaction: async (fn) => { transactions += 1; return fn(tx); } };

  // activeSietches returns nothing here, so the install half throws -- which is
  // exactly the case that must not commit a half-done move.
  await assert.rejects(
    () => setChoamTerminalPosition(db, { tradeCenterKey: "the-anvil", x: ANVIL.x, y: ANVIL.y, z: ANVIL.z, yaw: 0, applyNow: true }),
    /No active Hagga Basin sietches/
  );
  assert.equal(transactions, 1, "remove and install must share one transaction");
  assert.ok(calls.some((sql) => sql.includes("delete from dune.actors")), "the remove half should have run before the failure");
});

test("without applyNow the caller is told a reinstall is still needed", async () => {
  const tx = {
    query: async (sql) => {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (sql.includes("count(*)::int as installed")) return { rows: [{ installed: 2 }] };
      if (sql.includes("from dune.admin_choam_terminal_positions")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    }
  };
  const db = { transaction: async (fn) => fn(tx) };
  const result = await setChoamTerminalPosition(db, { tradeCenterKey: "the-anvil", x: ANVIL.x, y: ANVIL.y, z: ANVIL.z, yaw: 0 });
  assert.equal(result.reinstallRequired, true);
  assert.equal(result.moved, null);
});

// The table is created lazily by the first save, which holds the advisory lock
// while doing so. Probing for it before taking that lock leaves a window where
// a clear reports "not customised" for a post that just became customised.
test("clearing a position probes for the table only after taking the lock", async () => {
  const order = [];
  const tx = {
    query: async (sql) => {
      if (sql.includes("pg_advisory_xact_lock")) { order.push("lock"); return { rows: [] }; }
      if (sql.includes("to_regclass('dune.admin_choam_terminal_positions')")) { order.push("probe"); return { rows: [{ exists: true }] }; }
      if (sql.includes("delete from dune.admin_choam_terminal_positions")) { order.push("delete"); return { rows: [], rowCount: 1 }; }
      if (sql.includes("to_regclass('dune.admin_choam_terminals')")) return { rows: [{ exists: true }] };
      if (sql.includes("count(*)::int as installed")) return { rows: [{ installed: 0 }] };
      return { rows: [], rowCount: 0 };
    }
  };
  const db = {
    query: async () => { throw new Error("must not probe on the pool, outside the lock"); },
    transaction: async (fn) => fn(tx)
  };
  const result = await clearChoamTerminalPosition(db, { tradeCenterKey: "the-anvil" });
  assert.equal(result.cleared, 1);
  assert.deepEqual(order.slice(0, 2), ["lock", "probe"]);
});
