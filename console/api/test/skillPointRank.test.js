import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { rankFromSkillPoints } from "../src/duneDb.js";

const CATALOG = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../runtime/data/admin-skill-modules.json"), "utf8")
);
const byId = new Map(CATALOG.map((row) => [row.id, row]));

// ModuleData.SkillPointsSpent is the cumulative point COST, not the rank: a
// rank-2 Attribute stores 4 and a rank-3 stores 8. Treating it as a rank made a
// rank-2 attribute display as 3/3 (the old Math.min clamp hid it).
test("resolves a rank from the cumulative point cost", () => {
  const attribute = byId.get("Skills.Attribute.WeirdingWay1");   // 1, 4, 8
  assert.deepEqual([0, 1, 4, 8].map((p) => rankFromSkillPoints(p, attribute)), [0, 1, 2, 3]);

  const ability = byId.get("Skills.Ability.WeirdingStep");        // 2, 5, 9
  assert.deepEqual([0, 2, 5, 9].map((p) => rankFromSkillPoints(p, ability)), [0, 1, 2, 3]);

  const firstAbility = byId.get("Skills.Ability.Hypersprint");    // 1, 3, 6
  assert.deepEqual([0, 1, 3, 6].map((p) => rankFromSkillPoints(p, firstAbility)), [0, 1, 2, 3]);
});

test("never reports a rank above the module's maxLevel", () => {
  for (const row of CATALOG) {
    const top = Array.isArray(row.pointLadder) ? row.pointLadder.at(-1) : row.maxLevel;
    assert.ok(rankFromSkillPoints(top, row) <= row.maxLevel, row.id);
    assert.equal(rankFromSkillPoints(0, row), 0, row.id);
  }
});

test("falls back to the old clamp when a module has no ladder", () => {
  const noLadder = { maxLevel: 3 };
  assert.deepEqual([0, 2, 5, 9].map((p) => rankFromSkillPoints(p, noLadder)), [0, 2, 3, 3]);
});

// An id absent from the catalog has neither a ladder nor a maxLevel. Reporting the
// raw cost as the rank would surface a 1-rank skill as "9" -- worse than the bug
// this function exists to fix.
test("does not turn a raw point cost into a rank for an uncatalogued module", () => {
  assert.deepEqual([0, 2, 5, 9].map((p) => rankFromSkillPoints(p, {})), [0, 1, 1, 1]);
  assert.equal(rankFromSkillPoints(9, undefined), 1);
});

// The catalog is a near-mirror of the game's DT_TrainingModules, with one deliberate
// omission: Skills.Attribute.Explorer6. It is a real row in that table and appears in
// live ModuleData (1 of 8 dune2 characters, at 0 points), but it shares grid cell
// X=3,Y=1 in the Planetologist/Explorer block with Explorer1, so the tree draws a
// single node and it can never be bought. The two differ only in BuffClass -- Explorer1
// grants GE_BP_Skill_UnlockSinkchartsAndFoWRadius, Explorer6 only
// GE_BP_Skill_UnlockFoWRadius -- and the game gives both the same DisplayName,
// "Cartographer", so catalogueing it would need a made-up name to keep
// resolve_skill_module's exact-name path unambiguous. Nothing is lost by leaving it
// out: playerSkillModules() drops rows with skill_points_spent <= 0, and it can never
// exceed 0. If a catalog-vs-game audit reports Explorer6 missing, that is expected.
test("every catalog entry carries a ladder", () => {
  const without = CATALOG.filter((row) => !Array.isArray(row.pointLadder)).map((row) => row.id);
  assert.deepEqual(without, []);
});

// admin-tools.sh resolve_skill_module falls back to an exact *name* match when the
// argument is not an id, and errors out if two rows share one -- so a duplicate name
// would break `dune admin skill-module <name>` for both rows. This guards that.
test("no two modules in a category share a display name", () => {
  const seen = new Map();
  const clashes = [];
  for (const row of CATALOG) {
    const key = JSON.stringify([row.category, row.name.toLowerCase()]);
    if (seen.has(key)) clashes.push(`${seen.get(key)} vs ${row.id} (${row.name})`);
    else seen.set(key, row.id);
  }
  assert.deepEqual(clashes, []);
});

// A null CurveTable pointer makes FScalableFloat return its flat Value, even though
// RowName still names a curve row -- reading the curve instead would price these at 1.
test("prices the null-curve-table modules from their flat Value", () => {
  for (const id of ["Skills.Attribute.Explorer5", "Skills.Ability.ControlSpace"]) {
    assert.deepEqual(byId.get(id).pointLadder, [2], id);
  }
});

// The ladder is generated from the game's own SkillCosts curves, so its length
// must track maxLevel; a hand-edit to one without the other would silently
// mis-rank every player holding that module.
test("every ladder has exactly maxLevel entries and strictly increases", () => {
  for (const row of CATALOG) {
    if (!Array.isArray(row.pointLadder)) continue;
    assert.equal(row.pointLadder.length, row.maxLevel, `${row.id} ladder length`);
    for (let i = 1; i < row.pointLadder.length; i += 1) {
      assert.ok(row.pointLadder[i] > row.pointLadder[i - 1], `${row.id} ladder must increase`);
    }
  }
});
