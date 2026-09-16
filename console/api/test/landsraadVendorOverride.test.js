import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyLandsraadVendorOverride, landsraadHouseFactionCatalog, landsraadVendorCatalog, revertLandsraadVendorOverride } from "../src/duneDb.js";
import { createLandsraadVendorOverrideReconciler, normalizeLandsraadVendorOverridePreset, readLandsraadVendorOverridePreset, saveLandsraadVendorOverridePreset } from "../src/services/landsraadVendorOverride.js";

const DECREE_IDS = {
  SpecialVendorActive_Vehicles: "8",
  SpecialVendorActive_Weapons: "9",
  SpecialVendorActive_Armor: "10",
  SpecialVendorActive_Utilities: "11"
};

const HOUSE_IDS = { Atreides: "1", Harkonnen: "2" };

// Mirrors this codebase's own fake-db convention (see
// applyLandsraadMilestonePreset's tests in db.test.js) -- a single `query`
// matched by SQL substring, shared between the outer db and every tx.query
// call, so the *real* applyLandsraadVendorOverride/revertLandsraadVendorOverride
// functions run unmodified (not a stub -- see the design doc §5's note on
// avoiding the tautology failure class this test file mirrors that
// precedent specifically to avoid). Extended for v2 (design doc §8) to also
// support faction resolution -- deliberately without a silent default that
// would mask a missing branch (design doc §9, QA/Test finding #11): every
// new v2 query shape below has its own explicit, narrow match.
const FULL_TERM_COLUMNS = ["term_id", "start_time", "end_time", "active_decree_id", "elected_decree_id", "winning_faction_id", "reigning_faction_id", "test_term", "last_processed_reveal_day"];

function makeVendorOverrideDb({ decreeNames = Object.keys(DECREE_IDS), houseNames = Object.keys(HOUSE_IDS), termColumns = FULL_TERM_COLUMNS, term, stateLastAppliedDecreeId = null, stateLastAppliedTermId, stateLastAppliedFactionId = null, updateRowCount = 1 } = {}) {
  const calls = [];
  let writtenActiveDecreeId = term?.active_decree_id ?? null;
  let writtenWinningFactionId = term?.winning_faction_id ?? null;
  const query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("select column_name") && text.includes("table_name = $2") && values[1] === "landsraad_decree_term") {
      return { rows: termColumns.map((column_name) => ({ column_name })) };
    }
    if (text.includes("select decree_name from dune.landsraad_decrees")) {
      return { rows: decreeNames.map((name) => ({ decree_name: name })) };
    }
    if (text.includes("select id::text as id, decree_name from dune.landsraad_decrees")) {
      return { rows: decreeNames.map((name) => ({ id: DECREE_IDS[name], decree_name: name })) };
    }
    if (text.includes("select id::text as id, name from dune.factions")) {
      return { rows: houseNames.map((name) => ({ id: HOUSE_IDS[name], name })) };
    }
    if (text.includes("select id::text as id from dune.factions where name = $1")) {
      const name = values[0];
      return { rows: houseNames.includes(name) ? [{ id: HOUSE_IDS[name] }] : [] };
    }
    if (text.includes("create schema if not exists console")) return { rows: [] };
    if (text.includes("create table if not exists console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("alter table console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("insert into console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("select last_applied_decree_id::text as last_applied_decree_id from console.landsraad_vendor_override_state")) {
      return { rows: [{ last_applied_decree_id: stateLastAppliedDecreeId }] };
    }
    if (text.includes("select last_applied_term_id::text as last_applied_term_id, last_applied_faction_id::text as last_applied_faction_id from console.landsraad_vendor_override_state")) {
      return { rows: [{
        last_applied_term_id: stateLastAppliedTermId === undefined ? (term?.term_id ?? null) : stateLastAppliedTermId,
        last_applied_faction_id: stateLastAppliedFactionId
      }] };
    }
    if (text.includes("test_term,") && text.includes("from dune.landsraad_decree_term")) {
      return { rows: term ? [term] : [] };
    }
    if (text.includes("update dune.landsraad_decree_term") && text.includes("returning term_id::text as term_id, active_decree_id")) {
      if (!updateRowCount) return { rows: [], rowCount: 0 };
      writtenActiveDecreeId = values[0];
      if (values.length > 2) writtenWinningFactionId = values[1];
      return { rows: [{ term_id: term.term_id, active_decree_id: values[0] }], rowCount: updateRowCount };
    }
    if (text.includes("update console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("select active_decree_id::text as active_decree_id, winning_faction_id::text as winning_faction_id from dune.landsraad_decree_term")) {
      return { rows: [{ active_decree_id: writtenActiveDecreeId, winning_faction_id: writtenWinningFactionId }] };
    }
    if (text.includes("select term_id::text as term_id\n      from dune.landsraad_decree_term")) {
      return { rows: term ? [{ term_id: term.term_id }] : [] };
    }
    if (text.includes("update dune.landsraad_decree_term") && text.includes("set active_decree_id = null")) {
      return { rows: term ? [{ term_id: term.term_id }] : [], rowCount: term ? 1 : 0 };
    }
    throw new Error(`unmocked query: ${text}`);
  };
  const db = { query, transaction: async (fn) => fn({ query }) };
  return { db, calls };
}

test("applyLandsraadVendorOverride applies the single selected vendor to an unresolved term", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db, calls } = makeVendorOverrideDb({ term });
  const result = await applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" });
  assert.equal(result.applied, true);
  assert.equal(result.termId, "73");
  assert.equal(result.decreeKey, "vehicles");
  assert.equal(result.decreeName, "SpecialVendorActive_Vehicles");
  assert.equal(result.confirmedActiveDecreeId, "8");
  assert.ok(calls.some((call) => String(call.text).includes("set active_decree_id = $1") && call.values[0] === "8"));
  assert.ok(calls.some((call) => String(call.text).includes("update console.landsraad_vendor_override_state")));
});

test("applyLandsraadVendorOverride rejects an empty vendorKeys array without starting a transaction", async () => {
  const db = { query: async () => ({ rows: [{ exists: true }] }), transaction: async () => assert.fail("must not open a transaction for invalid input") };
  await assert.rejects(() => applyLandsraadVendorOverride(db, { vendorKeys: [], mode: "fixed" }), /at least one/);
});

test("applyLandsraadVendorOverride rejects an unknown vendor key", async () => {
  const db = { query: async () => ({ rows: [{ exists: true }] }), transaction: async () => assert.fail("must not open a transaction for invalid input") };
  await assert.rejects(() => applyLandsraadVendorOverride(db, { vendorKeys: ["spice"], mode: "fixed" }), /not a supported/);
});

test("applyLandsraadVendorOverride fails loud when the install's decree catalog is missing an expected name", async () => {
  const { db } = makeVendorOverrideDb({ decreeNames: ["SpecialVendorActive_Weapons"] });
  await assert.rejects(
    () => applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" }),
    /does not include the expected vendor decrees \(SpecialVendorActive_Vehicles\)/
  );
});

test("applyLandsraadVendorOverride fails loud, not with a raw Postgres error, when the term table is missing an expected column", async () => {
  // landsraadOverview already treats these 4 columns as install-dependent
  // (termColumns.has(...) guards) -- caught in PR #911's own bot review:
  // without this check, an install missing them would hit a raw 42703
  // undefined_column error instead of this file's usual graceful message.
  const { db } = makeVendorOverrideDb({ termColumns: ["term_id", "start_time", "end_time", "test_term"] });
  await assert.rejects(
    () => applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" }),
    /requires active_decree_id\/elected_decree_id\/winning_faction_id\/reigning_faction_id/
  );
});

test("applyLandsraadVendorOverride skips a test term", async () => {
  const term = { term_id: "73", test_term: true, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db } = makeVendorOverrideDb({ term });
  const result = await applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" });
  assert.equal(result.applied, false);
  assert.match(result.reason, /test term/);
});

test("applyLandsraadVendorOverride never overwrites an already-resolved term unless explicitly allowed", async () => {
  const resolvedTerm = { term_id: "73", test_term: false, active_decree_id: "5", elected_decree_id: "5", winning_faction_id: "1", reigning_faction_id: "1" };
  const { db: reconcilerDb } = makeVendorOverrideDb({ term: resolvedTerm });
  const skipped = await applyLandsraadVendorOverride(reconcilerDb, { vendorKeys: ["vehicles"], mode: "fixed", allowOverrideResolvedTerm: false });
  assert.equal(skipped.applied, false);
  assert.match(skipped.reason, /already resolved/);

  const { db: manualDb } = makeVendorOverrideDb({ term: resolvedTerm });
  const overridden = await applyLandsraadVendorOverride(manualDb, { vendorKeys: ["vehicles"], mode: "fixed", allowOverrideResolvedTerm: true });
  assert.equal(overridden.applied, true);
});

test("applyLandsraadVendorOverride rotate mode advances to the next selected vendor and wraps", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db: fromWeapons } = makeVendorOverrideDb({ term, stateLastAppliedDecreeId: DECREE_IDS.SpecialVendorActive_Weapons });
  const wrapped = await applyLandsraadVendorOverride(fromWeapons, { vendorKeys: ["vehicles", "weapons"], mode: "rotate" });
  assert.equal(wrapped.decreeKey, "vehicles", "wraps back to the first key after the last-applied one");

  const { db: fromStale } = makeVendorOverrideDb({ term, stateLastAppliedDecreeId: DECREE_IDS.SpecialVendorActive_Armor });
  const fallback = await applyLandsraadVendorOverride(fromStale, { vendorKeys: ["vehicles", "weapons"], mode: "rotate" });
  assert.equal(fallback.decreeKey, "vehicles", "falls back to the first key when the last-applied id is no longer selected");
});

test("applyLandsraadVendorOverride reports the race guard when the term changed mid-apply", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db } = makeVendorOverrideDb({ term, updateRowCount: 0 });
  const result = await applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" });
  assert.equal(result.applied, false);
  assert.match(result.reason, /changed while/);
});

test("revertLandsraadVendorOverride clears the current term's decree columns", async () => {
  const term = { term_id: "73" };
  const { db, calls } = makeVendorOverrideDb({ term });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, true);
  assert.equal(result.termId, "73");
  assert.ok(calls.some((call) => String(call.text).includes("set active_decree_id = null")));
});

test("revertLandsraadVendorOverride is a no-op when there is no current term", async () => {
  const { db } = makeVendorOverrideDb({ term: undefined });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, false);
});

test("revertLandsraadVendorOverride refuses to clear a term this feature never applied to", async () => {
  const term = { term_id: "73" };
  const { db, calls } = makeVendorOverrideDb({ term, stateLastAppliedTermId: "72" });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, false);
  assert.match(result.reason, /was not set by the vendor override/);
  assert.ok(!calls.some((call) => String(call.text).includes("set active_decree_id = null")), "must never null out a term it never touched");
});

test("revertLandsraadVendorOverride is a no-op when this feature has never applied at all", async () => {
  const term = { term_id: "73" };
  const { db } = makeVendorOverrideDb({ term, stateLastAppliedTermId: null });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, false);
});

test("landsraadVendorCatalog reports only the vendor keys this install's decree catalog actually has", async () => {
  const { db } = makeVendorOverrideDb({ decreeNames: ["SpecialVendorActive_Vehicles", "SpecialVendorActive_Armor"] });
  const catalog = await landsraadVendorCatalog(db);
  assert.deepEqual(catalog.map((entry) => entry.key).sort(), ["armor", "vehicles"]);
});

test("landsraad vendor override presets validate and persist stable settings", () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-vendor-override-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  try {
    const saved = saveLandsraadVendorOverridePreset(config, { enabled: true, mode: "rotate", vendorKeys: ["vehicles", "armor"] });
    assert.deepEqual(saved.vendorKeys, ["vehicles", "armor"]);
    assert.equal(readLandsraadVendorOverridePreset(config).mode, "rotate");
    assert.throws(() => normalizeLandsraadVendorOverridePreset({ enabled: true, mode: "fixed", vendorKeys: ["spice"] }), /not a supported/);
    assert.throws(() => normalizeLandsraadVendorOverridePreset({ enabled: true, mode: "fixed", vendorKeys: ["vehicles", "vehicles"] }), /only be selected once/);
    assert.throws(() => normalizeLandsraadVendorOverridePreset({ enabled: "true", mode: "fixed", vendorKeys: ["vehicles"] }), /enabled or disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Mirrors landsraadMilestones.test.js's reconciler test shape -- a stub
// applyPreset, since this test validates the tick/term-change-detection
// wrapper logic, not the real write path (that's the fake-db tests above).
test("landsraad vendor override reconciler applies once per new term and never overrides an organic result", async () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-vendor-reconcile-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  const db = { query: async () => ({ rows: [{ term_id: "42" }] }) };
  let applyCount = 0;
  try {
    saveLandsraadVendorOverridePreset(config, { enabled: true, mode: "fixed", vendorKeys: ["vehicles"] });
    const reconciler = createLandsraadVendorOverrideReconciler(config, {
      getDb: () => db,
      intervalMs: 10_000,
      applyPreset: async (_db, options) => {
        applyCount += 1;
        assert.equal(options.allowOverrideResolvedTerm, false, "the reconciler must never allow overriding an organic result");
        return { ok: true, applied: true, termId: "42", decreeKey: "vehicles", decreeName: "SpecialVendorActive_Vehicles" };
      }
    });
    const first = await reconciler.tick(20_000);
    const second = await reconciler.tick(40_000);
    assert.equal(first.result.applied, true);
    assert.equal(second.reason, "already-applied");
    assert.equal(applyCount, 1);
    assert.equal(readLandsraadVendorOverridePreset(config).lastAppliedTermId, "42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- v2 (design doc §8): forcing winning_faction_id/reigning_faction_id --

test("applyLandsraadVendorOverride with a houseFaction also forces winning/reigning faction", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db, calls } = makeVendorOverrideDb({ term });
  const result = await applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed", houseFaction: "atreides" });
  assert.equal(result.applied, true);
  assert.equal(result.houseFactionKey, "atreides");
  assert.equal(result.houseFactionName, "Atreides");
  assert.equal(result.confirmedWinningFactionId, "1");
  const termUpdate = calls.find((call) => String(call.text).includes("returning term_id::text as term_id, active_decree_id"));
  assert.ok(String(termUpdate.text).includes("winning_faction_id = $2") && String(termUpdate.text).includes("reigning_faction_id = $2"));
  assert.deepEqual(termUpdate.values, ["8", "1", "73"]);
});

test("applyLandsraadVendorOverride is byte-identical when houseFaction is omitted -- no faction query, no faction SQL fragment", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db, calls } = makeVendorOverrideDb({ term });
  const result = await applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed" });
  assert.equal(result.applied, true);
  assert.equal(result.houseFactionKey, null);
  assert.equal(result.confirmedWinningFactionId, null);
  assert.ok(!calls.some((call) => String(call.text).includes("dune.factions")), "must never query dune.factions when houseFaction is omitted");
  const termUpdate = calls.find((call) => String(call.text).includes("returning term_id::text as term_id, active_decree_id"));
  assert.ok(!String(termUpdate.text).includes("winning_faction_id"), "must never reference winning_faction_id in the UPDATE when houseFaction is omitted");
  assert.deepEqual(termUpdate.values, ["8", "73"]);
});

test("applyLandsraadVendorOverride rejects an unknown house key without querying dune.factions", async () => {
  const term = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db, calls } = makeVendorOverrideDb({ term });
  await assert.rejects(() => applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed", houseFaction: "corrino" }), /not a supported Landsraad house/);
  assert.ok(!calls.some((call) => String(call.text).includes("dune.factions")), "an unrecognized house key must be rejected before ever querying dune.factions");
});

test("applyLandsraadVendorOverride fails loud when the install's faction catalog is missing the requested house", async () => {
  const { db } = makeVendorOverrideDb({ houseNames: ["Harkonnen"] });
  await assert.rejects(
    () => applyLandsraadVendorOverride(db, { vendorKeys: ["vehicles"], mode: "fixed", houseFaction: "atreides" }),
    /does not include "Atreides"/
  );
});

// Note: this exercises the alreadyResolved guard against the exact values a
// real prior houseFaction apply would leave behind (two independent
// applyLandsraadVendorOverride calls against two fake dbs, not one
// continuous db whose second read reflects the first write) -- it does NOT
// drive an actual createLandsraadVendorOverrideReconciler tick. See
// "landsraad vendor override reconciler applies once per new term..." above
// for reconciler-level coverage of the plain-decree case.
test("applyLandsraadVendorOverride's resolved-term guard correctly fires against the exact state its own prior houseFaction write would leave behind", async () => {
  const unresolvedTerm = { term_id: "73", test_term: false, active_decree_id: null, elected_decree_id: null, winning_faction_id: null, reigning_faction_id: null };
  const { db: firstDb } = makeVendorOverrideDb({ term: unresolvedTerm });
  const first = await applyLandsraadVendorOverride(firstDb, { vendorKeys: ["vehicles"], mode: "fixed", houseFaction: "atreides" });
  assert.equal(first.applied, true);

  // Simulate the next tick seeing the term this feature itself just resolved.
  const nowResolvedTerm = { term_id: "73", test_term: false, active_decree_id: "8", elected_decree_id: "8", winning_faction_id: "1", reigning_faction_id: "1" };
  const { db: secondDb } = makeVendorOverrideDb({ term: nowResolvedTerm });
  const second = await applyLandsraadVendorOverride(secondDb, { vendorKeys: ["vehicles"], mode: "fixed", houseFaction: "atreides", allowOverrideResolvedTerm: false });
  assert.equal(second.applied, false);
  assert.match(second.reason, /already resolved/);
});

test("revertLandsraadVendorOverride also clears winning/reigning faction when this feature set them", async () => {
  const term = { term_id: "73" };
  const { db, calls } = makeVendorOverrideDb({ term, stateLastAppliedFactionId: "1" });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, true);
  assert.equal(result.revertedFaction, true);
  const termUpdate = calls.find((call) => String(call.text).includes("set active_decree_id = null"));
  assert.ok(String(termUpdate.text).includes("winning_faction_id = null") && String(termUpdate.text).includes("reigning_faction_id = null"));
});

test("revertLandsraadVendorOverride leaves winning/reigning faction untouched when this feature only set the decree", async () => {
  const term = { term_id: "73" };
  const { db, calls } = makeVendorOverrideDb({ term, stateLastAppliedFactionId: null });
  const result = await revertLandsraadVendorOverride(db);
  assert.equal(result.applied, true);
  assert.equal(result.revertedFaction, false);
  const termUpdate = calls.find((call) => String(call.text).includes("set active_decree_id = null"));
  assert.ok(!String(termUpdate.text).includes("winning_faction_id"), "must not touch winning_faction_id when this feature never set it");
});

test("landsraadHouseFactionCatalog reports only the real Landsraad-eligible houses this install has, never None/Smuggler", async () => {
  const { db } = makeVendorOverrideDb();
  const catalog = await landsraadHouseFactionCatalog(db);
  assert.deepEqual(catalog.map((entry) => entry.key).sort(), ["atreides", "harkonnen"]);
  assert.ok(!catalog.some((entry) => entry.name === "None" || entry.name === "Smuggler"));
});

test("landsraad vendor override preset persists and validates houseFaction", () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-vendor-house-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  try {
    const saved = saveLandsraadVendorOverridePreset(config, { enabled: true, mode: "fixed", vendorKeys: ["vehicles"], houseFaction: "atreides" });
    assert.equal(saved.houseFaction, "atreides");
    assert.equal(readLandsraadVendorOverridePreset(config).houseFaction, "atreides");
    assert.throws(() => normalizeLandsraadVendorOverridePreset({ enabled: true, mode: "fixed", vendorKeys: ["vehicles"], houseFaction: "corrino" }), /not a supported Landsraad house/);
    const omitted = saveLandsraadVendorOverridePreset(config, { enabled: true, mode: "fixed", vendorKeys: ["vehicles"] });
    assert.equal(omitted.houseFaction, null, "omitting houseFaction must normalize to null, not undefined or a stale prior value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("landsraad vendor override reconciler passes the preset's houseFaction through to applyPreset", async () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-vendor-reconcile-house-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  const db = { query: async () => ({ rows: [{ term_id: "50" }] }) };
  try {
    saveLandsraadVendorOverridePreset(config, { enabled: true, mode: "fixed", vendorKeys: ["vehicles"], houseFaction: "harkonnen" });
    const reconciler = createLandsraadVendorOverrideReconciler(config, {
      getDb: () => db,
      intervalMs: 10_000,
      applyPreset: async (_db, options) => {
        assert.equal(options.houseFaction, "harkonnen");
        return { ok: true, applied: true, termId: "50", decreeKey: "vehicles", decreeName: "SpecialVendorActive_Vehicles", houseFactionKey: "harkonnen", houseFactionName: "Harkonnen" };
      }
    });
    const result = await reconciler.tick(20_000);
    assert.equal(result.result.applied, true);
    assert.match(readLandsraadVendorOverridePreset(config).lastResult, /Harkonnen winning/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
