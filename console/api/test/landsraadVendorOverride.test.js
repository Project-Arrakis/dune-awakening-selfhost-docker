import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyLandsraadVendorOverride, landsraadVendorCatalog, revertLandsraadVendorOverride } from "../src/duneDb.js";
import { createLandsraadVendorOverrideReconciler, normalizeLandsraadVendorOverridePreset, readLandsraadVendorOverridePreset, saveLandsraadVendorOverridePreset } from "../src/services/landsraadVendorOverride.js";

const DECREE_IDS = {
  SpecialVendorActive_Vehicles: "8",
  SpecialVendorActive_Weapons: "9",
  SpecialVendorActive_Armor: "10",
  SpecialVendorActive_Utilities: "11"
};

// Mirrors this codebase's own fake-db convention (see
// applyLandsraadMilestonePreset's tests in db.test.js) -- a single `query`
// matched by SQL substring, shared between the outer db and every tx.query
// call, so the *real* applyLandsraadVendorOverride/revertLandsraadVendorOverride
// functions run unmodified (not a stub -- see the design doc §5's note on
// avoiding the tautology failure class this test file mirrors that
// precedent specifically to avoid).
function makeVendorOverrideDb({ decreeNames = Object.keys(DECREE_IDS), term, stateLastAppliedDecreeId = null, updateRowCount = 1 } = {}) {
  const calls = [];
  let writtenActiveDecreeId = term?.active_decree_id ?? null;
  const query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("select decree_name from dune.landsraad_decrees")) {
      return { rows: decreeNames.map((name) => ({ decree_name: name })) };
    }
    if (text.includes("select id::text as id, decree_name from dune.landsraad_decrees")) {
      return { rows: decreeNames.map((name) => ({ id: DECREE_IDS[name], decree_name: name })) };
    }
    if (text.includes("create schema if not exists console")) return { rows: [] };
    if (text.includes("create table if not exists console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("insert into console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("from console.landsraad_vendor_override_state where id = 1 for update")) {
      return { rows: [{ last_applied_decree_id: stateLastAppliedDecreeId }] };
    }
    if (text.includes("test_term,") && text.includes("from dune.landsraad_decree_term")) {
      return { rows: term ? [term] : [] };
    }
    if (text.includes("update dune.landsraad_decree_term") && text.includes("returning term_id::text as term_id, active_decree_id")) {
      if (!updateRowCount) return { rows: [], rowCount: 0 };
      writtenActiveDecreeId = values[0];
      return { rows: [{ term_id: term.term_id, active_decree_id: values[0] }], rowCount: updateRowCount };
    }
    if (text.includes("update console.landsraad_vendor_override_state")) return { rows: [] };
    if (text.includes("select active_decree_id::text as active_decree_id from dune.landsraad_decree_term")) {
      return { rows: [{ active_decree_id: writtenActiveDecreeId }] };
    }
    if (text.includes("select term_id::text as term_id\n      from dune.landsraad_decree_term")) {
      return { rows: term ? [{ term_id: term.term_id }] : [] };
    }
    if (text.includes("update dune.landsraad_decree_term") && text.includes("set active_decree_id = null")) {
      return { rows: term ? [{ term_id: term.term_id }] : [], rowCount: term ? 1 : 0 };
    }
    return { rows: [] };
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
