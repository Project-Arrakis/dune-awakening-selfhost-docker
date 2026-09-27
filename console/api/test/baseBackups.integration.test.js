import test from "node:test";
import assert from "node:assert/strict";
import { exportBaseBackup, importBaseBackup, BaseBackupError, BaseBackupTimeoutError } from "../src/baseBackups.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";
import {
  BASE_BACKUP_SCHEMA, TRANSFER_HELPER_STUBS, BASE_BACKUP_SEED, SOURCE, TARGET, BIG_INT_TEXT
} from "../test-support/baseBackupFixture.js";

// Real PostgreSQL: the guarantees under test are the database's -- foreign
// keys, 0-based array bounds, composite types, jsonb number handling -- so a
// string-matched fake db could not show them. The character-transfer helpers
// are stand-ins (see test-support/baseBackupFixture.js).

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_base_backup_xfer",
    unavailableLabel: "the base-backup export/import integration test"
  }, async (pool) => {
    await pool.query(BASE_BACKUP_SCHEMA);
    await pool.query(TRANSFER_HELPER_STUBS);
    await pool.query(BASE_BACKUP_SEED);
    return run(pool, pgTransactionalDb(pool));
  });
}

async function exportText(db) {
  const { text } = await exportBaseBackup(db, SOURCE.backup, { gameBuild: "2036754", consoleVersion: "test" });
  return text;
}

async function linkedActors(pool, backupId) {
  const result = await pool.query(`
    select a.id, a.class, a.partition_id, a.state, a.transform::text as transform, p.building_type
    from dune.base_backup_linked_actors l
    join dune.actors a on a.id = l.actor_id
    left join dune.placeables p on p.id = a.id
    where l.id = $1 order by a.class`, [backupId]);
  return result.rows;
}

test("real PostgreSQL: a base backup export carries the whole backup, version info and array bounds", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    // The 64-bit value is still exact in the file: it never became a JS number.
    assert.ok(text.includes(BIG_INT_TEXT), "64-bit item stat must survive export verbatim");
    const file = JSON.parse(text);
    assert.equal(file.format, "dune-base-backup");
    assert.equal(file.version, 1);
    assert.equal(file.source.name, "Test Base");
    assert.equal(file.source.ownerName, "Owner");
    assert.deepEqual(file.source.counts, { pieces: 3, placeables: 2, items: 2 });
    assert.equal(file.game.build, "2036754");
    assert.equal(file.game.appliedPatchesCount, 2);
    const checksum = (await pool.query("select md5('PATCH-1,PATCH-2') as md5")).rows[0].md5;
    assert.equal(file.game.patchesChecksum, checksum);
    // Non-default array bounds travel per row; 1-based rows carry none.
    const bounds = (kind) => file.entries.filter((e) => e.kind === kind).map((e) => e.data.__lb || null);
    assert.deepEqual(bounds("BuildingInstance"), [{ transform: 0 }, { transform: 0 }, { transform: 0 }]);
    assert.deepEqual(bounds("Totem"), [{ landclaim_original_global_location: 0 }]);
    assert.deepEqual(bounds("Sinkchart"), [{ marker_hash_ids: 0 }]);
    assert.deepEqual(bounds("BuildingBlueprintPentashield"), [{ scale: 0 }]);
    assert.deepEqual(bounds("BuildingBlueprintInstance").sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)), [{ transform: 0 }, null]);
    assert.equal("arrayLowerBounds" in file, false);
    // A reference outside the base on an allowlisted path is exported as @0.
    const sinkItem = file.entries.find((e) => e.kind === "itm" && e.data.template_id === "Sinkchart_Item");
    assert.equal(sinkItem.data.stats.FSinkchartsStats[1].CreatorPlayerId, "!!act@0");

    const byKind = {};
    for (const entry of file.entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    assert.deepEqual(byKind, {
      act: 4, // 3 base actors + the owner placeholder
      fgl: 3, PermissionActor: 1, inv: 1, itm: 2, ActorInventory: 1, Building: 1,
      BuildingInstance: 3, Placeable: 2, Totem: 1, BaseBackup: 1, BaseBackupLinkedActor: 3,
      LandclaimSegment: 2, Sinkchart: 1, bbp: 1, BuildingBlueprintInstance: 2, BuildingBlueprintPentashield: 1
    });
    const placeholder = file.entries.find((entry) => entry.id === file.ownerPlaceholderTransferId);
    assert.deepEqual(placeholder, { id: file.ownerPlaceholderTransferId, kind: "act", data: {} });
    for (const entry of file.entries.filter((e) => e.kind === "act")) {
      assert.equal("partition_id" in entry.data, false, "partition_id is never exported");
    }
    // The unrelated claimed actor is not in the file.
    assert.equal(file.entries.filter((e) => e.kind === "PermissionActor").length, 1);
    // Blueprint creator is stripped: it only means something on the source.
    assert.equal("player_id" in file.entries.find((e) => e.kind === "bbp").data, false);
  });
});

test("real PostgreSQL: importing a base backup recreates it exactly for the receiving player", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    const result = await importBaseBackup(db, TARGET.pawn, Buffer.from(text), { serverBuild: "2036754" });
    assert.equal(result.ok, true);
    assert.equal(result.version.mismatch, false);
    assert.equal(result.playerControllerId, TARGET.controller);
    assert.deepEqual(result.counts, { actors: 3, pieces: 3, placeables: 2, items: 2 });
    const backupId = result.backupId;
    assert.notEqual(backupId, SOURCE.backup);

    const backup = (await pool.query("select * from dune.base_backups where id = $1", [backupId])).rows[0];
    assert.equal(Number(backup.player_id), TARGET.controller);
    assert.equal(backup.base_backup_name, "Test Base");
    assert.equal(Number(backup.last_edited_by_player_id), TARGET.controller);

    const sourceActors = await linkedActors(pool, SOURCE.backup);
    const newActors = await linkedActors(pool, backupId);
    assert.equal(newActors.length, 3);
    for (const [index, actor] of newActors.entries()) {
      const source = sourceActors[index];
      assert.ok(Number(actor.id) >= 5000, "imported actors get fresh ids");
      assert.equal(actor.partition_id, null, "imported actors belong to no partition until redeployed");
      assert.equal(actor.state, source.state);
      assert.equal(actor.class, source.class);
      assert.equal(actor.transform, source.transform, "actor location and rotation are exact");
    }
    const newIds = Object.fromEntries(newActors.map((a) => [a.class, Number(a.id)]));
    const newTotem = newIds.BP_Totem_Small_C;
    const newBuilding = newIds.BP_DuneBuildingBase_C;
    const newChest = newIds.BP_StorageContainer_C;

    // Building pieces: identical values AND the game's 0-based bounds.
    const pieces = await pool.query(`
      select n.instance_id, array_lower(n.transform, 1) as lower, n.transform = s.transform as same,
             n.last_placed_by_player_id, n.owner_entity_id
      from dune.building_instances n
      join dune.building_instances s on s.building_id = $2 and s.instance_id = n.instance_id
      where n.building_id = $1 order by n.instance_id`, [newBuilding, SOURCE.building]);
    assert.equal(pieces.rows.length, 3);
    for (const piece of pieces.rows) {
      assert.equal(piece.lower, 0, "building piece transform must stay 0-based");
      assert.equal(piece.same, true, "building piece transform values are exact");
    }
    assert.deepEqual(pieces.rows.map((p) => Number(p.last_placed_by_player_id)), [TARGET.controller, TARGET.controller, 0]);
    const totemEntity = (await pool.query(
      "select entity_id from dune.actor_fgl_entities where actor_id = $1 and slot_name = 'Actor'", [newTotem])).rows[0].entity_id;
    for (const piece of pieces.rows) assert.equal(String(piece.owner_entity_id), String(totemEntity));

    const totem = (await pool.query(`
      select array_lower(n.landclaim_original_global_location, 1) as lower,
             n.landclaim_original_global_location = s.landclaim_original_global_location as same,
             float4send(n.landclaim_original_global_yaw_rotation) = float4send(s.landclaim_original_global_yaw_rotation) as yaw_exact
      from dune.totems n, dune.totems s where n.id = $1 and s.id = $2`, [newTotem, SOURCE.totem])).rows[0];
    assert.deepEqual(totem, { lower: 0, same: true, yaw_exact: true });
    assert.equal((await pool.query("select count(*)::int as n from dune.landclaim_segments where totem_id = $1", [newTotem])).rows[0].n, 2);

    // Embedded references follow the new ids; "!!act#0" stays a null reference.
    const chestEntity = (await pool.query(`
      select f.components from dune.fgl_entities f join dune.actor_fgl_entities a on a.entity_id = f.entity_id
      where a.actor_id = $1`, [newChest])).rows[0].components;
    assert.equal(chestEntity.FPlaceableComponent[1].m_Chest, `!!act#${newChest}`);
    assert.equal(chestEntity.FPlaceableComponent[1].m_None, "!!act#0");

    // Storage: items, the 64-bit stat exact, sinkchart and stored blueprint.
    const items = await pool.query(`
      select it.id, it.template_id, it.stats ->> 'Big' as big, it.stats ->> 'Ref' as ref
      from dune.items it join dune.inventories inv on inv.id = it.inventory_id
      where inv.actor_id = $1 order by it.position_index`, [newChest]);
    assert.equal(items.rows.length, 2);
    assert.equal(items.rows[0].big, BIG_INT_TEXT, "64-bit item stat must be exact after import");
    assert.equal(items.rows[0].ref, `!!act#${newChest}`);
    const creator = (await pool.query("select stats #>> '{FSinkchartsStats,1,CreatorPlayerId}' as v from dune.items where id = $1", [items.rows[0].id])).rows[0].v;
    assert.equal(creator, "!!act#0", "a reference that stayed on the source server becomes a null reference");
    const sinkchart = (await pool.query(`
      select array_lower(n.marker_hash_ids, 1) as lower, n.marker_hash_ids = s.marker_hash_ids as same
      from dune.sinkcharts n, dune.sinkcharts s where n.item_id = $1 and s.item_id = 800`, [items.rows[0].id])).rows[0];
    assert.deepEqual(sinkchart, { lower: 0, same: true });
    const blueprint = (await pool.query("select * from dune.building_blueprints where item_id = $1", [items.rows[1].id])).rows[0];
    assert.equal(blueprint.player_id, null);
    // Each row keeps its own bounds, even where one blueprint mixes them.
    const blueprintArrays = (await pool.query(`
      select (select array_agg(array_lower(transform, 1) order by instance_id) from dune.building_blueprint_instances where building_blueprint_id = $1) as inst_lowers,
             (select array_lower(scale, 1) from dune.building_blueprint_pentashields where building_blueprint_id = $1) as scale_lower,
             (select pg_typeof(scale)::text from dune.building_blueprint_pentashields where building_blueprint_id = $1) as scale_type`,
      [blueprint.id])).rows[0];
    assert.deepEqual(blueprintArrays, { inst_lowers: [0, 1], scale_lower: 0, scale_type: "smallint[]" });

    // Raw player ids point at the receiving player.
    const chestPermission = (await pool.query("select * from dune.permission_actor where actor_id = $1", [newChest])).rows[0];
    assert.equal(Number(chestPermission.edited_by_player_id), TARGET.controller);
    const placeables = await pool.query("select last_placed_by_player_id from dune.placeables where id = any($1::bigint[])", [[newTotem, newChest]]);
    for (const row of placeables.rows) assert.equal(Number(row.last_placed_by_player_id), TARGET.controller);

    // The source backup is untouched.
    assert.equal((await linkedActors(pool, SOURCE.backup)).length, 3);
    assert.equal(Number((await pool.query("select player_id from dune.base_backups where id = 1")).rows[0].player_id), SOURCE.controller);
  });
});

test("real PostgreSQL: importing the same file twice creates two independent backups", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    const first = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
    const second = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
    assert.notEqual(first.backupId, second.backupId);
    const firstIds = (await linkedActors(pool, first.backupId)).map((a) => a.id);
    const secondIds = (await linkedActors(pool, second.backupId)).map((a) => a.id);
    assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
    await pool.query("delete from dune.base_backups where id = $1", [first.backupId]);
    assert.equal((await linkedActors(pool, second.backupId)).length, 3);
  });
});

test("real PostgreSQL: an import that hits the statement timeout reports the step and rolls back", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    await pool.query(`
      alter function dune._character_transfer_data_table_load(jsonb) rename to _stub_load_real;
      create function dune._character_transfer_data_table_load(entries jsonb) returns void language plpgsql as $$
      begin perform pg_sleep(2); perform dune._stub_load_real(entries); end $$;`);
    const before = (await pool.query("select (select count(*) from dune.base_backups)::int as backups, (select count(*) from dune.actors)::int as actors")).rows[0];
    const previous = process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
    process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = "200";
    try {
      await assert.rejects(
        importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" }),
        (error) => {
          assert.ok(error instanceof BaseBackupTimeoutError);
          assert.equal(error.statusCode, 504);
          assert.equal(error.code, "timeout");
          assert.equal(error.details.operation, "import");
          assert.equal(error.details.step, "loading the file");
          assert.equal(error.details.timeoutKind, "server_timeout");
          assert.equal(error.details.limitMs, 200);
          assert.match(error.message, /timed out after .* while loading the file \(limit 200ms\)\. Nothing was changed/);
          return true;
        });
    } finally {
      if (previous === undefined) delete process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
      else process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = previous;
    }
    const after = (await pool.query("select (select count(*) from dune.base_backups)::int as backups, (select count(*) from dune.actors)::int as actors")).rows[0];
    assert.deepEqual(after, before);
  });
});

test("real PostgreSQL: a file from another game version is refused unless the override is set", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = (await exportText(db)).replace(/"patchesChecksum": "[0-9a-f]+"/, '"patchesChecksum": "0000"');
    await assert.rejects(importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" }), (error) => {
      assert.ok(error instanceof BaseBackupError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "version_mismatch");
      assert.equal(error.details.file.patchesChecksum, "0000");
      return true;
    });
    assert.equal((await pool.query("select count(*)::int as n from dune.base_backups")).rows[0].n, 1);
    const result = await importBaseBackup(db, TARGET.pawn, text, { allowVersionMismatch: true, serverBuild: "2036754" });
    assert.equal(result.version.mismatch, true);
    assert.match(result.warning, /version mismatch/);
  });
});

test("real PostgreSQL: an imported base never lands in a map partition, whatever the file says", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const file = JSON.parse(await exportText(db));
    for (const entry of file.entries) {
      if (entry.kind === "act" && entry.id !== file.ownerPlaceholderTransferId) {
        entry.data.partition_id = 12345;
        entry.data.state = "Default";
      }
    }
    const result = await importBaseBackup(db, TARGET.pawn, JSON.stringify(file), { serverBuild: "2036754" });
    const actors = await pool.query(`
      select a.partition_id, a.state from dune.actors a
      join dune.base_backup_linked_actors l on l.actor_id = a.id where l.id = $1`, [result.backupId]);
    assert.equal(actors.rows.length, 3);
    for (const actor of actors.rows) assert.deepEqual(actor, { partition_id: null, state: "BaseBackup" });
  });
});

test("real PostgreSQL: a file that hangs rows off the receiving player is refused before anything is written", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const file = JSON.parse(await exportText(db));
    file.entries.find((entry) => entry.kind === "inv").data.actor_id = file.ownerPlaceholderTransferId;
    const before = (await pool.query("select (select count(*) from dune.inventories)::int as inv, (select count(*) from dune.base_backups)::int as bb")).rows[0];
    await assert.rejects(importBaseBackup(db, TARGET.pawn, JSON.stringify(file), { serverBuild: "2036754" }), (error) => {
      assert.ok(error instanceof BaseBackupError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_file");
      assert.match(error.message, /inv \d+ actor_id at the receiving player/);
      return true;
    });
    const after = (await pool.query("select (select count(*) from dune.inventories)::int as inv, (select count(*) from dune.base_backups)::int as bb")).rows[0];
    assert.deepEqual(after, before);
  });
});
