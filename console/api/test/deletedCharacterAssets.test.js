import test from "node:test";
import assert from "node:assert/strict";
import { listDeletedCharacterAssets } from "../src/duneDb.js";

const REQUIRED_TABLES = [
  "dune.encrypted_player_state", "dune.account_removal_log", "dune.player_respawn_locations",
  "dune.permission_actor", "dune.permission_actor_rank", "dune.actors", "dune.player_state",
  "dune.buildings", "dune.building_instances", "dune.actor_fgl_entities", "dune.vehicles"
];
const OPTIONAL_TABLES = [
  "dune.world_partition", "dune.base_backup_linked_actors", "dune.accounts",
  "dune.placeables", "dune.vehicle_modules"
];

function createDb({
  baseRows = [],
  vehicleRows = [],
  characterRows = [],
  missingRequiredTable = "",
  missingOptionalTables = new Set(),
  missingDecrypt = false
} = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });

      // Capability probes: to_regclass for tables
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "");
        const isRequired = REQUIRED_TABLES.includes(table);
        const isOptional = OPTIONAL_TABLES.includes(table);
        const missing = missingRequiredTable === table || missingOptionalTables.has(table);
        const exists = (isRequired || isOptional) && !missing;
        return { rows: [{ exists }] };
      }

      // Capability probes: to_regprocedure for functions
      if (text.includes("to_regprocedure")) {
        const signature = String(values[0] || "");
        const exists = signature === "dune.decrypt_user_data(bytea)" && !missingDecrypt;
        return { rows: [{ exists }] };
      }

      // Data query for orphan bases
      if (text.includes("orphan_bases")) {
        return { rows: baseRows };
      }

      // Data query for orphan vehicles
      if (text.includes("orphan_vehicles")) {
        return { rows: vehicleRows };
      }

      // Data query for deleted characters
      if (text.includes("encrypted_player_state eps") && text.includes("character_state::text = 'Deleted'")) {
        return { rows: characterRows };
      }

      return { rows: [] };
    }
  };
  return db;
}

function baseQueryCall(db) {
  return db.calls.find((call) => call.text.includes("orphan_bases"));
}

function vehicleQueryCall(db) {
  return db.calls.find((call) => call.text.includes("orphan_vehicles"));
}

function characterQueryCall(db) {
  return db.calls.find((call) => call.text.includes("encrypted_player_state eps") && call.text.includes("character_state::text = 'Deleted'"));
}

test("attributes orphaned assets to the deleted character that held them", async () => {
  const db = createDb({
    baseRows: [
      {
        asset_id: 101,
        actor_id: "actor-base-1",
        name: "Base A",
        asset_type: "Base",
        map: "DeepDesert",
        partition_id: 1,
        x: 100.5,
        y: 200.5,
        z: 300.5,
        partition_label: "Zone 1",
        piece_count: 5,
        placeable_count: 3,
        module_count: null,
        attributed_group: "BaseTotem",
        attributed_character_id: "37"
      }
    ],
    vehicleRows: [
      {
        asset_id: 201,
        actor_id: "actor-vehicle-1",
        name: "Vehicle A",
        asset_type: "Ornithopter",
        map: "DeepDesert",
        partition_id: 2,
        x: 400.5,
        y: 500.5,
        z: 600.5,
        partition_label: "Zone 2",
        piece_count: null,
        placeable_count: null,
        module_count: 2,
        attributed_group: "Vehicle",
        attributed_character_id: "37"
      }
    ],
    characterRows: [
      {
        character_state_id: "37",
        account_id: "account-1",
        character_name: "kitty",
        deleted_at: "2026-09-15T10:00:00Z",
        last_avatar_activity: "2026-09-14T15:00:00Z",
        last_login_time: "2026-09-14T14:00:00Z",
        controller_id: "controller-37",
        pawn_id: "pawn-37",
        fls_id: "fls-37",
        removal_reason: "manual",
        removal_event_time: "2026-09-15T10:00:00Z",
        replacement_character_name: ""
      }
    ]
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.characters.length, 1);
  assert.equal(result.characters[0].characterName, "kitty");
  assert.equal(result.characters[0].bases.length, 1);
  assert.equal(result.characters[0].vehicles.length, 1);
  assert.equal(result.characters[0].bases[0].matchedBy, "Base totem");
  assert.equal(result.characters[0].vehicles[0].matchedBy, "Respawn point");
});

test("lists assets with no respawn record as unattributed", async () => {
  const db = createDb({
    vehicleRows: [
      {
        asset_id: 202,
        actor_id: "actor-vehicle-2",
        name: "Vehicle B",
        asset_type: "Transport",
        map: "HaggaBasin",
        partition_id: 3,
        x: 700.5,
        y: 800.5,
        z: 900.5,
        partition_label: "Zone 3",
        piece_count: null,
        placeable_count: null,
        module_count: 1,
        attributed_group: null,
        attributed_character_id: null
      }
    ]
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.unattributed.vehicles.length, 1);
  assert.equal(result.unattributed.vehicles[0].matchedBy, "");
  assert.equal(result.characters.length, 0);
});

test("falls back to unattributed when the attributed character is not in the character list", async () => {
  const db = createDb({
    baseRows: [
      {
        asset_id: 102,
        actor_id: "actor-base-2",
        name: "Base B",
        asset_type: "Base",
        map: "DeepDesert",
        partition_id: 4,
        x: 150.5,
        y: 250.5,
        z: 350.5,
        partition_label: "Zone 4",
        piece_count: 2,
        placeable_count: 1,
        module_count: null,
        attributed_group: "BaseTotem",
        attributed_character_id: "999"  // Character not in character list
      }
    ]
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.characters.length, 0);
  assert.equal(result.unattributed.bases.length, 1);
  assert.equal(result.unattributed.bases[0].characterStateId, "999");
  // Total assets = 1, should be in unattributed
  const totalAssets = result.characters.reduce((sum, char) => sum + char.bases.length + char.vehicles.length, 0)
    + result.unattributed.bases.length
    + result.unattributed.vehicles.length;
  assert.equal(totalAssets, 1);
});

test("omits deleted characters that hold no assets but counts them", async () => {
  const db = createDb({
    baseRows: [
      {
        asset_id: 103,
        actor_id: "actor-base-3",
        name: "Base C",
        asset_type: "Base",
        map: "DeepDesert",
        partition_id: 5,
        x: 200.5,
        y: 300.5,
        z: 400.5,
        partition_label: "Zone 5",
        piece_count: 1,
        placeable_count: 0,
        module_count: null,
        attributed_group: "BaseTotem",
        attributed_character_id: "50"
      }
    ],
    characterRows: [
      {
        character_state_id: "50",
        account_id: "account-2",
        character_name: "alice",
        deleted_at: "2026-09-14T10:00:00Z",
        last_avatar_activity: null,
        last_login_time: null,
        controller_id: "controller-50",
        pawn_id: "pawn-50",
        fls_id: "fls-50",
        removal_reason: "manual",
        removal_event_time: "2026-09-14T10:00:00Z",
        replacement_character_name: ""
      },
      {
        character_state_id: "51",
        account_id: "account-3",
        character_name: "bob",
        deleted_at: "2026-09-13T10:00:00Z",
        last_avatar_activity: null,
        last_login_time: null,
        controller_id: "controller-51",
        pawn_id: "pawn-51",
        fls_id: "fls-51",
        removal_reason: "manual",
        removal_event_time: "2026-09-13T10:00:00Z",
        replacement_character_name: ""
      }
    ]
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.characters.length, 1);
  assert.equal(result.characters[0].characterName, "alice");
  assert.equal(result.totals.deletedCharacters, 2);
  assert.equal(result.totals.deletedCharactersWithoutAssets, 1);
});

test("reports unsupported when a required table is missing", async () => {
  const db = createDb({
    missingRequiredTable: "dune.player_respawn_locations"
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.capabilities.deletedCharacters, false);
  assert.equal(result.characters.length, 0);
  assert.match(result.reason, /dune\.player_respawn_locations/);
});

test("reports unsupported when decrypt_user_data is missing", async () => {
  const db = createDb({
    missingDecrypt: true
  });

  const result = await listDeletedCharacterAssets(db);

  assert.equal(result.capabilities.deletedCharacters, false);
  assert.match(result.reason, /decrypt_user_data/);
});

test("degrades optional relations", async () => {
  const db = createDb({
    missingOptionalTables: new Set([
      "dune.world_partition",
      "dune.accounts",
      "dune.placeables",
      "dune.vehicle_modules"
    ]),
    baseRows: [
      {
        asset_id: 104,
        actor_id: "actor-base-4",
        name: "Base D",
        asset_type: "Base",
        map: "DeepDesert",
        partition_id: 6,
        x: 250.5,
        y: 350.5,
        z: 450.5,
        partition_label: "",
        piece_count: 3,
        placeable_count: null,
        module_count: null,
        attributed_group: null,
        attributed_character_id: null
      }
    ]
  });

  const result = await listDeletedCharacterAssets(db);

  // The call should still succeed
  assert.equal(result.capabilities.deletedCharacters, true);
  // But optional capabilities should be degraded
  assert.equal(result.capabilities.partitionLabels, false);
  assert.equal(result.capabilities.flsIds, false);
  assert.equal(result.capabilities.placeableCounts, false);
  assert.equal(result.capabilities.moduleCounts, false);
});

test("attributes only from asset-bearing respawn groups, never world spawn points", async () => {
  const db = createDb({});
  await listDeletedCharacterAssets(db);

  // The group allowlist is the feature's core safety property: Checkpoint,
  // CheckpointSafe and PlayerStart are shared world spawn points, and matching
  // on them would attribute map furniture to whichever character last used it.
  // It reaches the query as a bind parameter, so assert the parameter itself --
  // asserting the SQL text would pass even if the array were wrong.
  for (const call of [baseQueryCall(db), vehicleQueryCall(db)]) {
    assert.ok(call, "expected both asset queries to run");
    assert.ok(call.text.includes(`rl."group" = any($1::text[])`),
      "attribution must filter on the respawn group");
    assert.deepEqual(call.values[0], ["BaseTotem", "Vehicle", "RespawnBeacon"]);
    for (const worldGroup of ["Checkpoint", "CheckpointSafe", "PlayerStart"]) {
      assert.ok(!call.values[0].includes(worldGroup),
        `${worldGroup} is a world spawn point and must never attribute an asset`);
    }
  }
});

test("labels every allowed respawn group, so an unlabelled group cannot ship", async () => {
  const db = createDb({
    vehicleRows: [
      { asset_id: 1, actor_id: "a1", name: "V1", asset_type: "Sandbike", map: "HaggaBasin", partition_id: 1, x: 0, y: 0, z: 0, partition_label: "", piece_count: null, placeable_count: null, module_count: 2, attributed_group: "Vehicle", attributed_character_id: "1" },
      { asset_id: 2, actor_id: "a2", name: "V2", asset_type: "Buggy", map: "HaggaBasin", partition_id: 1, x: 0, y: 0, z: 0, partition_label: "", piece_count: null, placeable_count: null, module_count: 2, attributed_group: "RespawnBeacon", attributed_character_id: "1" }
    ],
    baseRows: [
      { asset_id: 3, actor_id: "a3", name: "B1", asset_type: "Sub-Fief", map: "HaggaBasin", partition_id: 1, x: 0, y: 0, z: 0, partition_label: "", piece_count: 1, placeable_count: 1, module_count: null, attributed_group: "BaseTotem", attributed_character_id: "1" }
    ],
    characterRows: [
      { character_state_id: "1", account_id: "9", character_name: "Holder", deleted_at: null, last_avatar_activity: null, last_login_time: null, controller_id: "", pawn_id: "", fls_id: "fls-9", removal_reason: "", removal_event_time: null, replacement_character_name: "" }
    ]
  });
  const result = await listDeletedCharacterAssets(db);
  const character = result.characters[0];
  const labels = [...character.bases, ...character.vehicles].map((asset) => asset.matchedBy);
  assert.deepEqual(labels.sort(), ["Base totem", "Respawn beacon", "Respawn point"]);
  assert.ok(!labels.includes(""), "every allowed group must resolve to a human label");
});

test("reports truncation when a cap is hit instead of silently dropping rows", async () => {
  const oneVehicle = (id) => ({
    asset_id: id, actor_id: `a${id}`, name: `V${id}`, asset_type: "Sandbike", map: "HaggaBasin",
    partition_id: 1, x: 0, y: 0, z: 0, partition_label: "", piece_count: null,
    placeable_count: null, module_count: 1, attributed_group: null, attributed_character_id: null
  });

  // The query asks for cap + 1 rows precisely so a full page proves there is
  // more behind it. Returning cap + 1 must set the flag and return only cap.
  const over = createDb({ vehicleRows: Array.from({ length: 2001 }, (_, i) => oneVehicle(i + 1)) });
  const overResult = await listDeletedCharacterAssets(over);
  assert.equal(overResult.truncated, true);
  assert.equal(overResult.unattributed.vehicles.length, 2000);
  assert.equal(overResult.totals.orphanedVehicles, 2000);

  const exact = createDb({ vehicleRows: Array.from({ length: 2000 }, (_, i) => oneVehicle(i + 1)) });
  const exactResult = await listDeletedCharacterAssets(exact);
  assert.equal(exactResult.truncated, false, "a full page that is not over the cap is not truncated");
  assert.equal(exactResult.unattributed.vehicles.length, 2000);
});

test("resolves the deleted timestamp to a real instant, not a naive local value", async () => {
  const db = createDb({});
  await listDeletedCharacterAssets(db);
  const text = characterQueryCall(db).text;

  // encrypted_player_state.last_character_state_change is `timestamp WITHOUT
  // time zone`. Selecting it raw makes node-postgres parse it in the Node
  // process's own zone, so deletedAt drifted by the container offset and
  // disagreed with the timestamptz fields beside it in the same payload.
  assert.ok(text.includes("at time zone current_setting('TimeZone')"),
    "deleted_at must be anchored to the database TimeZone");
  assert.ok(!/\beps\.last_character_state_change as deleted_at/.test(text),
    "deleted_at must not be selected as a naive timestamp");

  // The removal-log correlation compares against the same anchored instant on
  // both sides of the window, rather than letting Postgres convert implicitly.
  assert.ok(!/between eps\.last_character_state_change/.test(text),
    "the removal-log window must compare anchored instants, not the naive column");
});

test("states supported on the unsupported path and emits no stray rows key", async () => {
  const db = createDb({ missingRequiredTable: "dune.player_respawn_locations" });
  const result = await listDeletedCharacterAssets(db);

  // `supported` must be usable as a check rather than undefined on exactly the
  // path a caller would test it on, and this shape has no `rows` concept.
  assert.equal(result.supported, false);
  assert.equal(result.capabilities.deletedCharacters, false);
  assert.ok(!Object.hasOwn(result, "rows"), "must not leak the list-shaped rows key");
  assert.match(result.reason, /dune\.player_respawn_locations/);
});

test("reports whether the picked-up-base exclusion could run", async () => {
  const withTable = await listDeletedCharacterAssets(createDb({}));
  assert.equal(withTable.capabilities.baseBackupExclusion, true);

  // Without dune.base_backup_linked_actors the exclusion silently does not run,
  // so a base picked up for backup could surface as an orphan. Say so.
  const without = await listDeletedCharacterAssets(createDb({
    missingOptionalTables: new Set(["dune.base_backup_linked_actors"])
  }));
  assert.equal(without.capabilities.deletedCharacters, true);
  assert.equal(without.capabilities.baseBackupExclusion, false);
});
