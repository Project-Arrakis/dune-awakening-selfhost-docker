// Behavioral tests for addonOpsResourcesSummary() — the Spice Melange
// tab's real data source, separated by Deep Desert / Hagga Basin and by
// instance/sietch (dune.world_partition, keyed by dimension_index), each
// annotated with a REAL, config-resolved PvP/PvE state.
//
// Uses the same real sandbox pattern as mapCombatState.test.js (a real
// temp UserGame.ini profile + the actual resolvePartitionCombatStateFromRuntime
// subprocess call) combined with a mocked `db` for the SQL half — this
// exercises the real PvP/PvE resolution path end-to-end, not a
// hand-built mock of its output, while keeping the database side fast
// and deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addonOpsResourcesSummary } from "../src/duneDb.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function buildSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "dune-resources-summary-"));
  const generated = join(dir, "runtime", "generated");
  mkdirSync(generated, { recursive: true });

  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(duneScript, 0o755);

  const config = {
    repoRoot,
    duneScript,
    commandTimeoutMs: 8000,
    env: {
      DUNE_USERSETTINGS_CONFIG: join(generated, "usersettings.json"),
      DUNE_GAMEPLAY_PROFILE: join(generated, "gameplay-profile.ini"),
      DUNE_USERSETTINGS_GAME_ROOT: join(dir, "runtime", "game")
    }
  };

  return { dir, config };
}

function writeProfile(config, lines) {
  writeFileSync(config.env.DUNE_GAMEPLAY_PROFILE, lines.join("\n") + "\n");
}

// Builds a mock `db` covering exactly the queries addonOpsResourcesSummary
// issues: to_regclass (table existence), dune.world_partition (via
// mapCombatPartitionRows), dune.resourcefield_state (per-dimension
// totals), dune.spicefield_types (per-dimension, per-size counts).
function mockDb({
  tables = new Set(["resourcefield_state", "world_partition", "farm_state", "spicefield_types"]),
  worldPartitionRows = {},
  resourceTotalsRows = {},
  spicefieldTypeRows = {}
} = {}) {
  return {
    async query(text, values = []) {
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "").split(".").pop();
        return { rows: [{ exists: tables.has(table) }] };
      }
      if (text.includes("from dune.world_partition")) {
        const map = values[0];
        return { rows: worldPartitionRows[map] || [] };
      }
      if (text.includes("from dune.resourcefield_state") && text.includes("group by dimension_index")) {
        const map = values[0];
        return { rows: resourceTotalsRows[map] || [] };
      }
      if (text.includes("from dune.spicefield_types")) {
        const map = values[0];
        return { rows: spicefieldTypeRows[map] || [] };
      }
      return { rows: [] };
    }
  };
}

// ── 1. Multiple Deep Desert instances, both PvP and PvE ──

test("multiple Deep Desert instances with both PvP and PvE report correctly, separately", async () => {
  const { config } = buildSandbox();
  writeProfile(config, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=9"
  ]);

  const db = mockDb({
    worldPartitionRows: {
      DeepDesert_1: [
        { partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true },
        { partition_id: "9", map: "DeepDesert_1", dimension_index: 1, database_label: "DeepDesert_1_label", server_id: "s2", blocked: false, alive: true, ready: true }
      ]
    },
    resourceTotalsRows: {
      DeepDesert: [
        { dimension_index: 0, active_fields: 19, remaining_spice: 130000 },
        { dimension_index: 1, active_fields: 7, remaining_spice: 40000 }
      ]
    },
    spicefieldTypeRows: {
      DeepDesert: [
        { dimension_index: 0, field_type: "Small", active_fields: 10 },
        { dimension_index: 0, field_type: "Medium", active_fields: 8 },
        { dimension_index: 0, field_type: "Large", active_fields: 1 },
        { dimension_index: 1, field_type: "Small", active_fields: 7 }
      ]
    }
  });

  const result = await addonOpsResourcesSummary(db, config);
  const dd = result.deepDesert;

  assert.equal(dd.instances.length, 2);
  assert.equal(dd.instances[0].dimensionIndex, 0);
  assert.equal(dd.instances[0].combatState, "PVP");
  assert.equal(dd.instances[0].name, "DeepDesert_0");
  assert.equal(dd.instances[1].dimensionIndex, 1);
  assert.equal(dd.instances[1].combatState, "PVE");

  assert.equal(dd.summary.pvpInstances, 1);
  assert.equal(dd.summary.pveInstances, 1);
  assert.equal(dd.summary.totalActiveFields, 26);
  assert.equal(dd.summary.totalRemainingSpice, 170000);

  // Dimension 0 has Small/Medium/Large rows; dimension 1 reports only
  // what it actually has (Small) -- 0 is shown for sizes with no active
  // fields on THAT instance, not omitted (see test further below).
  assert.equal(dd.instances[0].sizes.length, 3);
  assert.equal(dd.instances[0].sizes.find((s) => s.size === "Small").activeFields, 10);
  assert.equal(dd.instances[0].sizes.find((s) => s.size === "Medium").activeFields, 8);
  assert.equal(dd.instances[0].sizes.find((s) => s.size === "Large").activeFields, 1);
  // Per-size remaining spice has no real source in this schema -- must
  // be null, never a guessed/apportioned number.
  assert.equal(dd.instances[0].sizes.find((s) => s.size === "Small").remainingSpice, null);
});

// ── 2. One active Deep Desert instance ──

test("a single active Deep Desert instance reports correctly", async () => {
  const { config } = buildSandbox();
  writeProfile(config, ["[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]", "+m_PvpEnabledPartitions=8"]);

  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 5, remaining_spice: 25000 }] }
  });

  const result = await addonOpsResourcesSummary(db, config);
  assert.equal(result.deepDesert.instances.length, 1);
  assert.equal(result.deepDesert.summary.totalActiveFields, 5);
});

// ── 3. No Deep Desert instances running (valid empty state, not an error) ──

test("no Deep Desert world_partition rows at all is a valid, successful empty state", async () => {
  const { config } = buildSandbox();
  const db = mockDb({ worldPartitionRows: { DeepDesert_1: [] } });

  const result = await addonOpsResourcesSummary(db, config);
  assert.deepEqual(result.deepDesert.instances, []);
  assert.deepEqual(result.deepDesert.summary, { totalActiveFields: 0, totalRemainingSpice: 0, pvpInstances: 0, pveInstances: 0, bySize: [] });
});

// ── 4-6. Zero small / medium / large fields on a reporting instance ──

test("a reporting instance with zero active Small fields shows Small: 0, not omitted", async () => {
  const { config } = buildSandbox();
  writeProfile(config, ["[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]", "+m_PveEnabledPartitions=8"]);

  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 9, remaining_spice: 95000 }] },
    spicefieldTypeRows: { DeepDesert: [{ dimension_index: 0, field_type: "Medium", active_fields: 8 }, { dimension_index: 0, field_type: "Large", active_fields: 1 }] }
  });

  const result = await addonOpsResourcesSummary(db, config);
  const small = result.deepDesert.instances[0].sizes.find((s) => s.size === "Small");
  assert.ok(small, "Small row must be present even with 0 active fields for this instance");
  assert.equal(small.activeFields, 0);
});

test("a reporting instance with zero active Medium fields shows Medium: 0, not omitted", async () => {
  const { config } = buildSandbox();
  writeProfile(config, ["[Partition:DeepDesert_1:8:/Script/DuneSandbox.PveEnabledPartitions]", "+m_PveEnabledPartitions=8"]);
  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 11, remaining_spice: 45000 }] },
    spicefieldTypeRows: { DeepDesert: [{ dimension_index: 0, field_type: "Small", active_fields: 10 }, { dimension_index: 0, field_type: "Large", active_fields: 1 }] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  const medium = result.deepDesert.instances[0].sizes.find((s) => s.size === "Medium");
  assert.ok(medium);
  assert.equal(medium.activeFields, 0);
});

test("a reporting instance with zero active Large fields shows Large: 0, not omitted", async () => {
  const { config } = buildSandbox();
  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 18, remaining_spice: 120000 }] },
    spicefieldTypeRows: { DeepDesert: [{ dimension_index: 0, field_type: "Small", active_fields: 10 }, { dimension_index: 0, field_type: "Medium", active_fields: 8 }] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  const large = result.deepDesert.instances[0].sizes.find((s) => s.size === "Large");
  assert.ok(large);
  assert.equal(large.activeFields, 0);
});

// ── 7. A Deep Desert instance with valid zero remaining spice ──

test("a reporting instance with genuinely zero remaining spice shows 0, not '-' or missing", async () => {
  const { config } = buildSandbox();
  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 0, remaining_spice: 0 }] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  assert.equal(result.deepDesert.instances[0].remainingSpice, 0);
  assert.notEqual(result.deepDesert.instances[0].remainingSpice, null);
});

// ── 8-9. Multiple Hagga Basin sietches, mixed PvP/PvE ──

test("multiple Hagga Basin sietches with both PvP and PvE designations report correctly", async () => {
  const { config } = buildSandbox();
  writeProfile(config, [
    "[Partition:Survival_1:1:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=1",
    "[Partition:Survival_1:2:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=2"
  ]);

  const db = mockDb({
    worldPartitionRows: {
      Survival_1: [
        { partition_id: "1", map: "Survival_1", dimension_index: 0, database_label: "Sietch Abbir", server_id: "s1", blocked: false, alive: true, ready: true },
        { partition_id: "2", map: "Survival_1", dimension_index: 1, database_label: "Sietch Tabr", server_id: "s2", blocked: false, alive: true, ready: true }
      ]
    },
    resourceTotalsRows: {
      HaggaBasin: [
        { dimension_index: 0, active_fields: 10, remaining_spice: 35000 },
        { dimension_index: 1, active_fields: 6, remaining_spice: 22000 }
      ]
    },
    spicefieldTypeRows: {
      HaggaBasin: [
        { dimension_index: 0, field_type: "Small", active_fields: 10 },
        { dimension_index: 1, field_type: "Small", active_fields: 6 }
      ]
    }
  });

  const result = await addonOpsResourcesSummary(db, config);
  const hb = result.haggaBasin;
  assert.equal(hb.instances.length, 2);
  assert.equal(hb.instances.find((i) => i.name === "Sietch Abbir").combatState, "PVP");
  assert.equal(hb.instances.find((i) => i.name === "Sietch Tabr").combatState, "PVE");
  assert.equal(hb.summary.pvpInstances, 1);
  assert.equal(hb.summary.pveInstances, 1);
});

// ── 10. No Hagga Basin records ──

test("no Hagga Basin world_partition rows at all is a valid, successful empty state", async () => {
  const { config } = buildSandbox();
  const db = mockDb({ worldPartitionRows: { Survival_1: [] } });
  const result = await addonOpsResourcesSummary(db, config);
  assert.deepEqual(result.haggaBasin.instances, []);
  assert.deepEqual(result.haggaBasin.summary, { totalActiveFields: 0, totalRemainingSpice: 0, pvpInstances: 0, pveInstances: 0, bySize: [] });
});

// ── 11-13. API/DB failure, unauthorized, malformed — handled by the
// existing tableExists/try-catch schema-adaptive pattern; these are
// exercised at the provider/route level (opsProvider.test.js,
// discordAdapter.test.js) which wrap this function — verifying here that
// a query rejection surfaces as a thrown error rather than a silently
// fabricated empty/success result, so callers can distinguish "no data"
// from "the request actually failed".

test("a database query failure propagates as a real error, not a silently fabricated empty result", async () => {
  const { config } = buildSandbox();
  const db = {
    async query(text, values) {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.world_partition")) throw new Error("connection reset");
      return { rows: [] };
    }
  };
  await assert.rejects(() => addonOpsResourcesSummary(db, config), /connection reset/);
});

// ── 14. Incomplete instance record (missing label) ──

test("an instance with no database label falls back to a stable, non-fabricated name instead of inventing one", async () => {
  const { config } = buildSandbox();
  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: null, server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 3, remaining_spice: 9000 }] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  assert.equal(result.deepDesert.instances[0].name, "DeepDesert 0", "must use a stable '<map> <dimension>' fallback, never an invented name");
});

// ── 15. Active Deep Desert data followed by a successful empty refresh ──
// (state-transition behavior belongs to the addon's own rendering layer,
// not this Core function, which is stateless per call — verified here
// only that two independent calls each return the correct state for
// their own input, proving there is no server-side caching/staleness
// that would prevent the addon from correctly clearing stale data.)

test("consecutive calls independently reflect active-then-empty Deep Desert state (no server-side staleness)", async () => {
  const { config } = buildSandbox();
  const activeDb = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 5, remaining_spice: 20000 }] }
  });
  const emptyDb = mockDb({ worldPartitionRows: { DeepDesert_1: [] } });

  const active = await addonOpsResourcesSummary(activeDb, config);
  assert.equal(active.deepDesert.instances.length, 1);

  const empty = await addonOpsResourcesSummary(emptyDb, config);
  assert.equal(empty.deepDesert.instances.length, 0);
});

// ── 16. Empty Deep Desert data followed by an active refresh ──

test("consecutive calls independently reflect empty-then-active Deep Desert state", async () => {
  const { config } = buildSandbox();
  const emptyDb = mockDb({ worldPartitionRows: { DeepDesert_1: [] } });
  const activeDb = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 5, remaining_spice: 20000 }] }
  });

  const empty = await addonOpsResourcesSummary(emptyDb, config);
  assert.equal(empty.deepDesert.instances.length, 0);

  const active = await addonOpsResourcesSummary(activeDb, config);
  assert.equal(active.deepDesert.instances.length, 1);
});

// ── 17. Number formatting for large spice values ──
// (Formatting with locale-appropriate thousands separators is a
// presentation concern for the addon's rendering layer, not this Core
// function, which must return exact, unformatted numeric values for the
// addon to format. Verified here only that large values pass through as
// real numbers, not strings or truncated/rounded approximations.)

test("large remaining-spice values pass through as exact numbers, not truncated or stringified", async () => {
  const { config } = buildSandbox();
  const db = mockDb({
    worldPartitionRows: { DeepDesert_1: [{ partition_id: "8", map: "DeepDesert_1", dimension_index: 0, database_label: "DeepDesert_0", server_id: "s1", blocked: false, alive: true, ready: true }] },
    resourceTotalsRows: { DeepDesert: [{ dimension_index: 0, active_fields: 999, remaining_spice: 987654321 }] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  assert.strictEqual(result.deepDesert.instances[0].remainingSpice, 987654321);
  assert.equal(typeof result.deepDesert.instances[0].remainingSpice, "number");
});

// ── 18. Natural sorting of Deep Desert instance identifiers ──

test("Deep Desert instances are sorted naturally by dimensionIndex, not alphabetically by label", async () => {
  const { config } = buildSandbox();
  const db = mockDb({
    worldPartitionRows: {
      DeepDesert_1: [
        { partition_id: "10", map: "DeepDesert_1", dimension_index: 10, database_label: "Zebra", server_id: "s1", blocked: false, alive: true, ready: true },
        { partition_id: "2", map: "DeepDesert_1", dimension_index: 2, database_label: "Alpha", server_id: "s2", blocked: false, alive: true, ready: true }
      ]
    },
    resourceTotalsRows: { DeepDesert: [] }
  });
  const result = await addonOpsResourcesSummary(db, config);
  assert.deepEqual(result.deepDesert.instances.map((i) => i.dimensionIndex), [2, 10], "numeric dimensionIndex order (2 then 10), not string-sorted (10 before 2) or alphabetical by label");
});

// (Alphabetical sorting of Hagga Basin sietches by name, and responsive
// narrow-layout rendering, are addon-side (frontend) presentation
// concerns — covered in the addon repository's own test suite, not here.)
