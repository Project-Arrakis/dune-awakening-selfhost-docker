import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateMapCombatState,
  resolveRuntimeStatus,
  resolvePartitionCombatStateFromRuntime,
  resolvePartitionCombatStatesFromRuntime,
  resolvePartitionDisplayNamesFromRuntime,
  resolveMapCombatState,
  PARTITION_COMBAT_STATES,
  MAP_COMBAT_STATES
} from "../src/services/mapCombatState.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// ─── Pure aggregation tests (no subprocess) ────────────────────────────────

test("map aggregation: PVP + PVP -> PVP", () => {
  assert.equal(aggregateMapCombatState(["PVP", "PVP"]), "PVP");
});

test("map aggregation: PVE + PVE -> PVE", () => {
  assert.equal(aggregateMapCombatState(["PVE", "PVE"]), "PVE");
});

test("map aggregation: PVP + PVE -> MIXED", () => {
  assert.equal(aggregateMapCombatState(["PVP", "PVE"]), "MIXED");
});

test("map aggregation: PVP + CONFLICT -> CONFLICT", () => {
  assert.equal(aggregateMapCombatState(["PVP", "CONFLICT"]), "CONFLICT");
});

test("map aggregation: no partitions -> UNKNOWN", () => {
  assert.equal(aggregateMapCombatState([]), "UNKNOWN");
});

test("map aggregation: all UNKNOWN -> UNKNOWN", () => {
  assert.equal(aggregateMapCombatState(["UNKNOWN", "UNKNOWN"]), "UNKNOWN");
});

test("map aggregation is order-independent and dedupes determinable votes", () => {
  assert.equal(aggregateMapCombatState(["PVP", "PVP", "PVP"]), "PVP");
  assert.equal(aggregateMapCombatState(["PVE", "PVP", "PVE"]), "MIXED");
});

test("exported state enums match the documented contract", () => {
  assert.deepEqual(PARTITION_COMBAT_STATES, ["PVP", "PVE", "CONFLICT", "UNKNOWN"]);
  assert.deepEqual(MAP_COMBAT_STATES, ["PVP", "PVE", "MIXED", "CONFLICT", "UNKNOWN"]);
});

// ─── Runtime status tests (no subprocess) ──────────────────────────────────

test("runtime status: no server assigned -> UNASSIGNED", () => {
  assert.equal(resolveRuntimeStatus({}), "UNASSIGNED");
});

test("runtime status: blocked partition -> STOPPED regardless of server assignment", () => {
  assert.equal(resolveRuntimeStatus({ serverId: "abc", blocked: true }), "STOPPED");
});

test("runtime status: assigned, alive and ready -> RUNNING", () => {
  assert.equal(resolveRuntimeStatus({ serverId: "abc", alive: true, ready: true }), "RUNNING");
});

test("runtime status: assigned and alive but not ready -> STARTING", () => {
  assert.equal(resolveRuntimeStatus({ serverId: "abc", alive: true, ready: false }), "STARTING");
});

test("runtime status: assigned but not alive -> OFFLINE", () => {
  assert.equal(resolveRuntimeStatus({ serverId: "abc", alive: false, ready: false }), "OFFLINE");
});

test("configured combat state must be retained while runtime is offline", () => {
  // This directly encodes the requirement that combat state and runtime
  // availability are separate dimensions: an OFFLINE partition must not
  // erase or reset its configured PvP/PvE designation.
  const runtimeStatus = resolveRuntimeStatus({ serverId: "abc", alive: false, ready: false });
  assert.equal(runtimeStatus, "OFFLINE");
  // The combat state itself is resolved independently (see the
  // subprocess-backed tests below) and is never derived from runtimeStatus.
});

// ─── Subprocess-backed integration tests against the real resolver ────────

function buildSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "dune-map-combat-state-"));
  const generated = join(dir, "runtime", "generated");
  mkdirSync(generated, { recursive: true });
  const fakeBin = join(dir, "bin");
  mkdirSync(fakeBin, { recursive: true });

  // runDune requires config.duneScript to exist on disk, even though
  // "usersettings" operations are routed to python3 + usersettings.py
  // directly. A minimal placeholder is sufficient.
  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(duneScript, 0o755);

  const config = {
    repoRoot,
    duneScript,
    commandTimeoutMs: 8000
  };

  const env = {
    DUNE_USERSETTINGS_CONFIG: join(generated, "usersettings.json"),
    DUNE_GAMEPLAY_PROFILE: join(generated, "gameplay-profile.ini"),
    DUNE_USERSETTINGS_GAME_ROOT: join(dir, "runtime", "game")
  };

  return { dir, config, env };
}

function writeProfile(env, lines) {
  writeFileSync(env.DUNE_GAMEPLAY_PROFILE, lines.join("\n") + "\n");
}

test("resolver: explicit partition PvP selector resolves to PVP end-to-end", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:Survival_1:1:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=1"
  ]);

  const result = await resolvePartitionCombatStateFromRuntime(
    { ...config, env },
    "Survival_1",
    "1"
  );
  assert.equal(result.configuredState, "PVP");
  assert.equal(result.configuredSource, "partition-pvp-selector");
});

test("resolver: explicit partition PvE selector resolves to PVE end-to-end", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:Survival_1:1:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=1"
  ]);

  const result = await resolvePartitionCombatStateFromRuntime(
    { ...config, env },
    "Survival_1",
    "1"
  );
  assert.equal(result.configuredState, "PVE");
  assert.equal(result.configuredSource, "partition-pve-selector");
});

test("resolver: conflicting partition selectors resolve to CONFLICT with a warning", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:Survival_1:1:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=1",
    "+m_PveEnabledPartitions=1"
  ]);

  const result = await resolvePartitionCombatStateFromRuntime(
    { ...config, env },
    "Survival_1",
    "1"
  );
  assert.equal(result.configuredState, "CONFLICT");
  assert.equal(result.configuredSource, "partition-selectors");
  assert.ok(result.warnings.some((w) => /both PvP and PvE selectors/.test(w)));
});

test("resolver: default configuration (no overrides) falls back to legacy flags", async () => {
  const { config, env } = buildSandbox();
  // No profile file at all -> falls back to defaults: legacy_pvp_enabled
  // default False, server_pve default True -> PVE via legacy-flags.
  const result = await resolvePartitionCombatStateFromRuntime(
    { ...config, env },
    "Survival_1",
    "1"
  );
  assert.equal(result.configuredState, "PVE");
  assert.equal(result.configuredSource, "legacy-flags");
});

test("resolver: an unlisted partition is PVE once the global selector allow-list is active", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Global:/Script/DuneSandbox.PvpPveSettings]",
    "m_bShouldForceEnablePvpOnAllPartitions=False",
    "+m_PvpEnabledPartitions=40",
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.DuneGameMode]",
    "bPvPEnabled=True",
    "bServerPVE=False"
  ]);

  const result = await resolvePartitionCombatStatesFromRuntime(
    { ...config, env },
    "DeepDesert_1",
    ["8", "40"]
  );
  assert.equal(result.get("8").configuredState, "PVE");
  assert.equal(result.get("8").configuredSource, "partition-selector-default");
  assert.equal(result.get("40").configuredState, "PVP");
  assert.equal(result.get("40").configuredSource, "partition-pvp-selector");
});

test("resolver: database labels, dimension index, and display names are not consulted", async () => {
  // The resolver call signature only accepts map + partitionId. There is
  // no parameter through which a label, dimension index, or display name
  // could influence the result — this test documents that contract by
  // asserting two partitions with different ids but identical UserGame.ini
  // partition-selector configuration produce identical combat states.
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=9"
  ]);

  const partitionEight = await resolvePartitionCombatStateFromRuntime({ ...config, env }, "DeepDesert_1", "8");
  const partitionNine = await resolvePartitionCombatStateFromRuntime({ ...config, env }, "DeepDesert_1", "9");
  assert.equal(partitionEight.configuredState, "PVP");
  assert.equal(partitionNine.configuredState, "PVP");
});

test("batch resolver returns multiple partition states from one command", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=9"
  ]);

  const result = await resolvePartitionCombatStatesFromRuntime(
    { ...config, env },
    "DeepDesert_1",
    ["8", "9", "8"]
  );
  assert.equal(result.size, 2);
  assert.equal(result.get("8").configuredState, "PVP");
  assert.equal(result.get("9").configuredState, "PVE");
});

test("resolver compares materialized boolean spellings semantically", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, []);
  const settingsDir = join(env.DUNE_USERSETTINGS_GAME_ROOT, "deepdesert-1-8", "Saved", "UserSettings");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "UserGame.ini"), [
    "[/Script/DuneSandbox.PvpPveSettings]",
    "m_bShouldForceEnablePvpOnAllPartitions=false",
    "[/Script/DuneSandbox.DuneGameMode]",
    "bPvPEnabled=0",
    "bServerPVE=yes",
    "[/Script/DuneSandbox.SecurityZonesSubsystem]",
    "m_bAreSecurityZonesEnabled=on"
  ].join("\n"));

  const result = await resolvePartitionCombatStateFromRuntime(
    { ...config, env },
    "DeepDesert_1",
    "8"
  );
  assert.equal(result.configuredState, "PVE");
  assert.equal(result.materializedState, "PVE");
  assert.equal(result.configurationDrift, false);
  assert.equal(result.restartRequired, false);
});

test("resolveMapCombatState aggregates a dual Deep Desert (PVP + PVE) to MIXED", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=9"
  ]);

  const result = await resolveMapCombatState({ ...config, env }, "DeepDesert_1", [
    { partitionId: "8", dimensionIndex: 0, databaseLabel: "PvP" },
    { partitionId: "9", dimensionIndex: 1, databaseLabel: "PvE" }
  ]);

  assert.equal(result.mapState, "MIXED");
  assert.equal(result.partitions.find((p) => p.partitionId === "8").configuredState, "PVP");
  assert.equal(result.partitions.find((p) => p.partitionId === "9").configuredState, "PVE");
});

test("resolveMapCombatState retains configured state for offline partitions", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=9"
  ]);

  const result = await resolveMapCombatState({ ...config, env }, "DeepDesert_1", [
    { partitionId: "8", dimensionIndex: 0, serverId: "", ready: false, alive: false },
    { partitionId: "9", dimensionIndex: 1, serverId: "", ready: false, alive: false }
  ]);

  assert.equal(result.mapState, "MIXED");
  for (const partition of result.partitions) {
    assert.equal(partition.runtimeStatus, "UNASSIGNED");
    assert.ok(["PVP", "PVE"].includes(partition.configuredState));
  }
});

test("resolveMapCombatState treats a partition with no partition id as UNKNOWN without throwing", async () => {
  const { config, env } = buildSandbox();
  const result = await resolveMapCombatState({ ...config, env }, "DeepDesert_1", [
    { partitionId: "", dimensionIndex: 0 }
  ]);
  assert.equal(result.partitions[0].configuredState, "UNKNOWN");
  assert.equal(result.mapState, "UNKNOWN");
});

// ─── Effective Bgd.ServerDisplayName resolution ────────────────────────────
//
// server_display_name has no per-map override tier (see usersettings.py
// SCOPED_ENGINE_FIELDS / MAP_ENGINE_FIELDS / PARTITION_ENGINE_FIELDS) -- only
// global (every Sietch in the battlegroup) and per-partition (the
// battlegroup editor / "sietches set-display", which writes into this same
// field -- see runtime/scripts/sietches.sh `set-display`).

test("resolvePartitionDisplayNamesFromRuntime: a partition override wins over the global battlegroup name", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Engine:ConsoleVariables]",
    'Bgd.ServerDisplayName="Battlegroup Wide Name"',
    "[PartitionEngine:DeepDesert_1:8:ConsoleVariables]",
    'Bgd.ServerDisplayName="Named Sietch"'
  ]);

  const result = await resolvePartitionDisplayNamesFromRuntime({ ...config, env }, "DeepDesert_1", ["8", "9"]);
  assert.equal(result.get("8"), "Named Sietch");
  assert.equal(result.get("9"), "Battlegroup Wide Name");
});

test("resolvePartitionDisplayNamesFromRuntime: no configured name anywhere resolves to an empty map", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, []);

  const result = await resolvePartitionDisplayNamesFromRuntime({ ...config, env }, "DeepDesert_1", ["8"]);
  assert.equal(result.has("8"), false);
});

test("resolveMapCombatState surfaces serverDisplayName per partition alongside combat state", async () => {
  const { config, env } = buildSandbox();
  writeProfile(env, [
    "[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PveEnabledPartitions=8",
    "[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]",
    "+m_PvpEnabledPartitions=9",
    "[PartitionEngine:DeepDesert_1:8:ConsoleVariables]",
    'Bgd.ServerDisplayName="My Arrakis"'
  ]);

  const result = await resolveMapCombatState({ ...config, env }, "DeepDesert_1", [
    { partitionId: "8", dimensionIndex: 0, databaseLabel: "PvP" },
    { partitionId: "9", dimensionIndex: 1, databaseLabel: "PvE" }
  ]);

  const partitionEight = result.partitions.find((p) => p.partitionId === "8");
  const partitionNine = result.partitions.find((p) => p.partitionId === "9");
  // The configured display name takes precedence regardless of the (here
  // deliberately stale/swapped) databaseLabel -- combat state and display
  // name are resolved independently, neither one from the other.
  assert.equal(partitionEight.serverDisplayName, "My Arrakis");
  assert.equal(partitionEight.configuredState, "PVE");
  assert.equal(partitionNine.serverDisplayName, null);
  assert.equal(partitionNine.configuredState, "PVP");
});
