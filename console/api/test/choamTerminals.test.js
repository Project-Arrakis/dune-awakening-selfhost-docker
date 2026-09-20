import test from "node:test";
import assert from "node:assert/strict";
import { CHOAM_TRADE_CENTERS, choamTerminalInternals, derivePlacementFromPlayer, evaluatePlacementBounds, setChoamTerminalPosition, choamTerminalOverview } from "../src/services/choamTerminals.js";

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
