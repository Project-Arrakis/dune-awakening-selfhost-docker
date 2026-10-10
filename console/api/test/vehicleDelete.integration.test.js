import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteVehicleCompletely,
  storedVehicleDeletePreflight,
  queueVehicleDelete,
  cancelQueuedVehicleDelete,
  listQueuedVehicleDeletes,
  flushVehicleDeletes,
  _resetRefillPartitionDwellForTests
} from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Like baseDelete.integration.test.js, this exercises real PostgreSQL rather
// than a mocked db: the guarantees that matter here -- the cascade actually
// removing every row, the transaction actually rolling back atomically, a
// real FOR UPDATE lock -- are exactly the kind a string-matched mock cannot
// prove. This is the load-bearing artifact for the whole feature: the
// starting question was "does this cascade safely at all", and this file is
// what keeps the answer true going forward.
//
// The schema below is transcribed from a real production dump
// (.claude/dune_backup.sql), not invented:
//   vehicles.id -> actors.id                                CASCADE (line 76467)
//   vehicle_modules.vehicle_id -> vehicles.id                CASCADE (line 76459)
//   inventories.vehicle_module_id -> vehicle_modules.id      CASCADE (line 75828)
//   backup_vehicles.vehicle_id -> vehicles.id                CASCADE (line 75459)
//   recovered_vehicles.vehicle_id -> vehicles.id             CASCADE (line 76348)
// Patch 1.5 stores lifecycle state inline on actors and removes the obsolete
// vehicle_id from overmap_players. The fixture follows that current schema.
// markers/player_markers are deliberately NOT FK-cascaded from actors,
// matching production -- only permission_actor_destroy clears them.
const VEHICLE_ID = 9201;
const MODULE_IDS = [9202, 9203];
const PLAYER_ID = 4;

const OTHER_VEHICLE_ID = 9301;
const OTHER_MODULE_ID = 9302;

const SCHEMA = `
  create schema dune;

  create type dune.actorstate as enum (
    'Default', 'Travel', 'VehicleBackup', 'AbortedAuthorityTransfer', 'VehicleRecovery', 'BaseBackup'
  );

  create table dune.actors (
    id bigint primary key,
    map text,
    partition_id bigint,
    owner_account_id bigint,
    state dune.actorstate not null default 'Default'
  );
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.world_partition (partition_id bigint primary key, map text, dimension_index integer default 0, server_id text);

  create table dune.vehicles (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null references dune.vehicles(id) on delete cascade
  );
  create table dune.inventories (
    id bigint primary key,
    vehicle_module_id bigint references dune.vehicle_modules(id) on delete cascade,
    max_item_count integer not null default 10
  );
  create table dune.items (
    id bigint generated always as identity primary key,
    inventory_id bigint not null references dune.inventories(id) on delete cascade,
    template_id text not null,
    stack_size integer not null default 1
  );
  -- As on the live schema: player_state is a view hiding non-Active characters,
  -- online_status is an enum, and character_id is NOT NULL.
  create type dune.playerconnectionstatus as enum ('Offline', 'LoggingOut', 'Online');
  create table dune.encrypted_player_state (
    id bigint primary key,
    account_id bigint not null,
    character_name text,
    online_status dune.playerconnectionstatus not null default 'Offline',
    character_state text not null default 'Active'
  );
  create view dune.player_state as
    select id, account_id, character_name, online_status
    from dune.encrypted_player_state where character_state = 'Active';
  create table dune.backup_vehicles (
    vehicle_id bigint not null unique references dune.vehicles(id) on delete cascade,
    character_id bigint not null unique references dune.encrypted_player_state(id) on update cascade on delete cascade
  );
  create type dune.recoveredvehiclereason as enum ('Normal', 'Migrated', 'RecoveredFromLostState');
  create table dune.recovered_vehicles (
    vehicle_id bigint not null unique references dune.vehicles(id) on delete cascade,
    character_id bigint not null references dune.encrypted_player_state(id) on update cascade on delete cascade,
    time_stored timestamptz not null default current_timestamp,
    reason dune.recoveredvehiclereason not null default 'Normal'
  );
  create table dune.overmap_players (
    player_id bigint primary key
  );

  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null references dune.actors(id) on delete cascade,
    rank smallint not null
  );
  -- Deliberately NOT FK-cascaded from actors, matching production: only
  -- permission_actor_destroy clears these.
  create table dune.markers (marker_hash_id bigint primary key);
  create table dune.player_markers (marker_hash_id bigint not null, player_id bigint not null);

  -- Transcribed verbatim from the shipped schema (.claude/dune_backup.sql
  -- lines 13231 and 5619), not reinvented.
  create function dune.permission_actor_destroy(in_actor_id bigint)
  returns void language plpgsql as $$
  begin
    delete from permission_actor_rank where permission_actor_id = in_actor_id;
    delete from permission_actor where actor_id = in_actor_id;
    delete from markers where marker_hash_id = in_actor_id;
    delete from player_markers where marker_hash_id = in_actor_id;
    perform pg_notify('permission_notify_channel', format('destroy#{"ActorId" : %s}', in_actor_id));
  end $$;

  create function dune.delete_actors(in_ids bigint[])
  returns void language plpgsql as $$
  begin
    delete from actors where id = any(in_ids);
  end $$;
`;

function seedVehicle(vehicleId, moduleIds, playerId, { claimed = true, withItems = true } = {}) {
  const moduleRows = moduleIds.map((id) => `
    insert into dune.vehicle_modules (id, vehicle_id) values (${id}, ${vehicleId});
    insert into dune.inventories (id, vehicle_module_id) values (${id} * 10, ${id});
    ${withItems ? `insert into dune.items (inventory_id, template_id, stack_size) values (${id} * 10, 'Spice', 12);` : ""}
  `).join("\n");
  return `
    insert into dune.actors (id, map, partition_id) values (${vehicleId}, 'HaggaBasin', 3);
    insert into dune.vehicles (id) values (${vehicleId});
    ${moduleRows}
    -- Each seeded vehicle gets its own holding character (same id), so the
    -- NOT NULL / UNIQUE character columns are satisfied.
    insert into dune.encrypted_player_state (id, account_id, character_name) values (${vehicleId}, ${vehicleId}, 'Holder ${vehicleId}');
    insert into dune.backup_vehicles (vehicle_id, character_id) values (${vehicleId}, ${vehicleId});
    insert into dune.recovered_vehicles (vehicle_id, character_id) values (${vehicleId}, ${vehicleId});
    insert into dune.overmap_players (player_id) values (${vehicleId} * 100);
    ${claimed ? `
      insert into dune.permission_actor (actor_id, actor_name) values (${vehicleId}, 'Test Vehicle ${vehicleId}');
      insert into dune.markers (marker_hash_id) values (${vehicleId});
      insert into dune.player_markers (marker_hash_id, player_id) values (${vehicleId}, ${playerId});
      insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${vehicleId}, ${playerId}, 1);
    ` : ""}
  `;
}

const SEED = `
  insert into dune.actors (id) values (${PLAYER_ID});
  ${seedVehicle(VEHICLE_ID, MODULE_IDS, PLAYER_ID)}
  ${seedVehicle(OTHER_VEHICLE_ID, [OTHER_MODULE_ID], PLAYER_ID)}
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

async function actorCount(pool, ids) {
  const result = await pool.query("select count(*)::int as n from dune.actors where id = any($1::bigint[])", [ids]);
  return result.rows[0].n;
}

async function tableCount(pool, table) {
  const result = await pool.query(`select count(*)::int as n from dune.${table}`);
  return result.rows[0].n;
}

test("real PostgreSQL: deleteVehicleCompletely cascades away the whole vehicle and nothing belonging to another", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);

    assert.equal(result.ok, true);
    assert.equal(result.actorId, String(VEHICLE_ID));
    assert.equal(result.deletedModuleCount, MODULE_IDS.length);

    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    assert.equal(await tableCount(pool, "vehicles"), 1, "the other vehicle must survive");
    assert.equal(await tableCount(pool, "vehicle_modules"), 1);
    assert.equal(await tableCount(pool, "inventories"), 1);
    assert.equal(await tableCount(pool, "items"), 1);
    assert.equal(await tableCount(pool, "backup_vehicles"), 1);
    assert.equal(await tableCount(pool, "recovered_vehicles"), 1);
    assert.equal(await tableCount(pool, "permission_actor"), 1);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 1);

    // markers/player_markers do not cascade from actors in production -- only
    // permission_actor_destroy's explicit deletes clear them, keyed on the
    // vehicle's own actor id. This is the regression guard for the ordering
    // requirement: permission_actor_destroy must run before delete_actors.
    const markers = await pool.query("select marker_hash_id from dune.markers");
    assert.deepEqual(markers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_VEHICLE_ID]);
    const playerMarkers = await pool.query("select marker_hash_id from dune.player_markers");
    assert.deepEqual(playerMarkers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_VEHICLE_ID]);

    // Patch 1.5 overmap persistence no longer stores a vehicle id. Deleting a
    // vehicle must not disturb the player's independent overmap state row.
    const overmap = await pool.query("select player_id from dune.overmap_players where player_id = $1", [VEHICLE_ID * 100]);
    assert.equal(overmap.rowCount, 1);

    assert.equal(await actorCount(pool, [OTHER_VEHICLE_ID]), 1);
  });
});

test("real PostgreSQL: deleteVehicleCompletely rejects a vehicle id that does not exist", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, 424242), /was not found/);
    assert.equal(await actorCount(pool, [VEHICLE_ID, OTHER_VEHICLE_ID]), 2);
  });
});

// The primary use case, not an edge case: an unclaimed junk vehicle should
// be exactly as deletable as a claimed one. vehiclePermissionActor never
// joins through permission_actor (unlike setVehiclePermissions' path), so
// this must work without a claim -- add this so nobody "fixes" it into a
// guard later.
test("real PostgreSQL: deleteVehicleCompletely deletes an unclaimed vehicle cleanly", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete_unclaimed",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.actors (id) values (${PLAYER_ID});
      ${seedVehicle(VEHICLE_ID, MODULE_IDS, PLAYER_ID, { claimed: false })}
    `);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);
    assert.equal(result.ok, true);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
  });
});

// The refusal names the state with the label the Vehicles list shows for it,
// not the raw enum value.
for (const [state, label] of [["Travel", /is In Transit and cannot be deleted/], ["VehicleBackup", /is in Vehicle Backup and cannot be deleted/], ["VehicleRecovery", /is Stored for Recovery and cannot be deleted/]]) {
  test(`real PostgreSQL: deleteVehicleCompletely refuses a vehicle in ${state} state`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("update dune.actors set state = $2 where id = $1", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID), label);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "a blocked-state vehicle must not be touched");
    });
  });
}

for (const state of ["Travel", "VehicleBackup", "VehicleRecovery"]) {
  test(`real PostgreSQL: an explicit map-down delete allows a vehicle in ${state} state`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("update dune.actors set state = $2 where id = $1", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      const result = await deleteVehicleCompletely(db, VEHICLE_ID, { allowBlockedState: true });
      assert.equal(result.ok, true);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
}

for (const state of ["Default", "AbortedAuthorityTransfer", "BaseBackup"]) {
  test(`real PostgreSQL: deleteVehicleCompletely allows a vehicle in ${state} state`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("update dune.actors set state = $2 where id = $1", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      const result = await deleteVehicleCompletely(db, VEHICLE_ID);
      assert.equal(result.ok, true);
    });
  });
}

test("real PostgreSQL: a schema without lifecycle state deletes normally", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete_no_lifecycle_state",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    const schemaWithoutActorState = SCHEMA
      .replace(/,\n    state dune\.actorstate not null default 'Default'/, "");
    await pool.query(schemaWithoutActorState);
    await pool.query(SEED);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);
    assert.equal(result.ok, true);
  });
});

test("real PostgreSQL: a mid-transaction failure rolls back permission_actor_destroy's work too", async (t) => {
  await withDatabase(t, async (pool) => {
    // A synthetic FK, not a modeled production constraint (see
    // baseDelete.integration.test.js's identical pattern) -- a deliberate,
    // controlled trigger for a real failure so this proves db.transaction's
    // rollback guarantee rather than assuming it.
    await pool.query("create table dune.other_refs (id bigint primary key, referenced_actor_id bigint references dune.actors(id))");
    await pool.query("insert into dune.other_refs (id, referenced_actor_id) values (1, $1)", [VEHICLE_ID]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID));

    // If the rollback were partial, permission_actor_destroy's deletes
    // (which ran first) would have stuck even though delete_actors failed
    // after it.
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    assert.equal(await tableCount(pool, "permission_actor"), 2);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 2);
    const markers = await pool.query("select marker_hash_id from dune.markers where marker_hash_id = $1", [VEHICLE_ID]);
    assert.equal(markers.rows.length, 1);
  });
});

test("real PostgreSQL: the actor row is locked for update", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await db.transaction(async (tx) => {
      await tx.query("set local search_path to dune, public");
      const locked = await tx.query("select id from dune.actors where id = $1::bigint for update", [VEHICLE_ID]);
      assert.equal(locked.rowCount, 1);
    });
  });
});

// --- Pending delete queue ----------------------------------------------------

async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-vehicle-delete-queue-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("vehicle delete queue stores one entry per vehicle and cancel reports a missing one", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);

    queueVehicleDelete(repoRoot, { vehicleId: 482, map: "Survival_1", partitionId: 3 });
    queueVehicleDelete(repoRoot, { vehicleId: 517, map: "Overmap", partitionId: 9 });
    queueVehicleDelete(repoRoot, { vehicleId: 482, map: "Survival_1", partitionId: 3 });

    const pending = listQueuedVehicleDeletes(repoRoot);
    assert.deepEqual(pending.map((entry) => entry.vehicleId), [517, 482]);

    const result = cancelQueuedVehicleDelete(repoRoot, 482);
    assert.equal(result.pending, 1);
    assert.deepEqual(listQueuedVehicleDeletes(repoRoot).map((entry) => entry.vehicleId), [517]);
    assert.throws(() => cancelQueuedVehicleDelete(repoRoot, 482), /has no queued delete/);
  });
});

test("real PostgreSQL: flush applies a delete once its partition is confirmed down", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const result = await flushVehicleDeletes(db, repoRoot);

      assert.deepEqual(result.flushed.map((entry) => ({ vehicleId: entry.vehicleId, ok: entry.ok })), [{ vehicleId: VEHICLE_ID, ok: true }]);
      assert.equal(result.pending, 0);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: background flush retains a Travel-state vehicle without burning attempts", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("update dune.actors set state = 'Travel' where id = $1", [VEHICLE_ID]);
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      for (let round = 0; round < 4; round += 1) {
        const result = await flushVehicleDeletes(db, repoRoot, {
          now: () => 1_000_000 + round * 120_000,
          onBeforeApply: () => { backupCalls += 1; }
        });
        assert.equal(result.flushed[0].ok, false);
        assert.equal(result.flushed[0].attempts, 0);
        assert.equal(result.flushed[0].dropped, false);
        assert.match(result.flushed[0].error, /is In Transit and cannot be deleted/);
      }
      assert.equal(backupCalls, 0, "a predictably blocked retry must not create a database backup");
      assert.equal(listQueuedVehicleDeletes(repoRoot)[0].attempts, 0);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    });
  });
});

test("real PostgreSQL: explicit map-down flush deletes a Travel-state vehicle", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("update dune.actors set state = 'Travel' where id = $1", [VEHICLE_ID]);
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const result = await flushVehicleDeletes(db, repoRoot, { allowBlockedStates: true });
      assert.equal(result.flushed[0].ok, true);
      assert.equal(result.pending, 0);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

// Measured against a real database: the poller sets nextRetryAt = now + 60s on
// every failed attempt, so a blocked entry sits inside a backoff window for ~55
// of every 60 seconds. Honouring that window on the map-down pass meant the one
// moment allowBlockedStates could ever apply was skipped most of the time --
// upstream's fix was defeated in practice by a pre-existing skip.
test("real PostgreSQL: the map-down pass applies an entry the poller just backed off", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("update dune.actors set state = 'Travel' where id = $1", [VEHICLE_ID]);
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      // Poller attempt: refused, and it stamps a retry window on the entry.
      const blocked = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 });
      assert.equal(blocked.flushed[0].ok, false);
      assert.ok(listQueuedVehicleDeletes(repoRoot)[0].nextRetryAt > 1_000_000);

      // Map-down hook lands inside that window, as it usually will.
      const hook = await flushVehicleDeletes(db, repoRoot, {
        now: () => 1_000_001, allowBlockedStates: true, ignoreRetryBackoff: true
      });
      assert.equal(hook.flushed[0].ok, true);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: the background poller still honours its own backoff", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("update dune.actors set state = 'Travel' where id = $1", [VEHICLE_ID]);
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 });
      // No ignoreRetryBackoff: the entry is skipped entirely, so nothing is
      // reported for it at all.
      const second = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_001 });
      assert.deepEqual(second.flushed, []);
      assert.equal(second.pending, 1);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    });
  });
});

test("real PostgreSQL: flush leaves a delete queued while its map is still live", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', 'srv-1')");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const stillLive = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 });
      assert.deepEqual(stillLive.flushed, []);
      assert.equal(stillLive.pending, 1);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "a live-map vehicle must not be deleted");

      const afterDwell = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 + 30_000 });
      assert.equal(afterDwell.flushed[0]?.ok, true);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: an explicitly stopped assigned partition bypasses only the disconnect dwell", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', 'srv-stopped')");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const result = await flushVehicleDeletes(db, repoRoot, {
        now: () => 1_000_000,
        trustedDownPartitionIds: new Set([3])
      });

      assert.equal(result.flushed[0]?.ok, true);
      assert.equal(result.pending, 0);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: trusted stop metadata never overrides a live game connection", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', 'srv-live')");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      const live = await pool.connect();
      try {
        await live.query("set application_name = 'DuneSandbox - srv-live'");
        const result = await flushVehicleDeletes(pgTransactionalDb(pool), repoRoot, {
          now: () => 1_000_000,
          trustedDownPartitionIds: new Set([3])
        });
        assert.deepEqual(result.flushed, []);
        assert.equal(result.pending, 1);
        assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
      } finally {
        live.release();
      }
    });
  });
});

test("real PostgreSQL: flush treats a vehicle already gone as success, not a retryable failure", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      // Stands in for the vehicle already being gone (e.g. the game's own
      // Coriolis-storm cleanup) while the delete sits queued.
      const db = pgTransactionalDb(pool);
      await db.transaction(async (tx) => {
        await tx.query("set local search_path to dune, public");
        await tx.query("select dune.delete_actors($1::bigint[])", [[VEHICLE_ID]]);
      });

      const result = await flushVehicleDeletes(db, repoRoot);

      assert.equal(result.flushed[0].ok, true);
      assert.equal(result.flushed[0].alreadyGone, true);
      assert.equal(result.flushed[0].attempts, undefined, "a vehicle already gone must not burn an attempt");
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
    });
  });
});

test("real PostgreSQL: flush drops an entry after three genuine failures and expires one older than the age limit", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      const queuedAt = Date.parse(listQueuedVehicleDeletes(repoRoot)[0].queuedAt);

      const real = pgTransactionalDb(pool);
      const failingDb = { query: real.query, transaction: async () => { throw new Error("simulated permanent failure"); } };

      let round = 0;
      const step = () => flushVehicleDeletes(failingDb, repoRoot, { now: () => 1_000_000 + (round++) * 120_000 });

      const first = await step();
      assert.equal(first.flushed[0].ok, false);
      assert.equal(first.flushed[0].attempts, 1);
      assert.equal(first.flushed[0].dropped, false);

      const second = await step();
      assert.equal(second.flushed[0].attempts, 2);

      const third = await step();
      assert.equal(third.flushed[0].attempts, 3);
      assert.equal(third.flushed[0].dropped, true);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);

      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      const requeuedAt = Date.parse(listQueuedVehicleDeletes(repoRoot)[0].queuedAt);
      const expired = await flushVehicleDeletes(failingDb, repoRoot, { now: () => requeuedAt + 7 * 24 * 3600_000 });
      assert.equal(expired.flushed[0].expired, true);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
      assert.ok(queuedAt <= requeuedAt);
    });
  });
});

test("real PostgreSQL: a failed safety backup aborts the whole flush pass, leaving every entry queued", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      queueVehicleDelete(repoRoot, { vehicleId: OTHER_VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      const result = await flushVehicleDeletes(db, repoRoot, {
        onBeforeApply: () => { backupCalls += 1; throw new Error("backup destination is full"); }
      });

      assert.equal(backupCalls, 1, "one failed backup must abort the pass, not be retried per vehicle");
      assert.equal(result.backupFailed, true);
      assert.deepEqual(result.flushed, []);
      assert.equal(listQueuedVehicleDeletes(repoRoot).length, 2, "neither vehicle may be deleted without its safety backup");
      assert.equal(await actorCount(pool, [VEHICLE_ID, OTHER_VEHICLE_ID]), 2);
    });
  });
});

// ---- Stored for Recovery override (DELETE /api/vehicles/{id}/stored) -------

const OWNER_CHARACTER_ID = 71;
const OWNER_ACCOUNT_ID = 7100;

// Puts VEHICLE_ID into recovery the way the game leaves it: state flipped,
// roster destroyed, owner recorded only on the recovery row.
async function storeForRecovery(pool, { online = "Offline", altOnline = null } = {}) {
  const insertCharacter = "insert into dune.encrypted_player_state (id, account_id, character_name, online_status) values ($1, $2, $3, $4::dune.playerconnectionstatus)";
  await pool.query(insertCharacter, [OWNER_CHARACTER_ID, OWNER_ACCOUNT_ID, "Gurney", online]);
  if (altOnline) await pool.query(insertCharacter, [OWNER_CHARACTER_ID + 1, OWNER_ACCOUNT_ID, "Gurney Alt", altOnline]);
  await pool.query("select dune.permission_actor_destroy($1)", [VEHICLE_ID]);
  await pool.query("update dune.actors set state = 'VehicleRecovery', partition_id = null where id = $1", [VEHICLE_ID]);
  await pool.query("update dune.recovered_vehicles set character_id = $2, reason = 'RecoveredFromLostState' where vehicle_id = $1",
    [VEHICLE_ID, OWNER_CHARACTER_ID]);
}

test("real PostgreSQL: the stored override deletes a recovered vehicle whose owner is offline", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID, { storedRecoveryOnly: true });
    assert.equal(result.ok, true);
    assert.equal(result.storedOwner, "Gurney");
    assert.equal(result.storedReason, "RecoveredFromLostState");
    assert.match(result.storedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    const left = await pool.query("select count(*)::int as n from dune.recovered_vehicles where vehicle_id = $1", [VEHICLE_ID]);
    assert.equal(left.rows[0].n, 0, "the recovery record must go with the vehicle");
    assert.equal(await actorCount(pool, [OTHER_VEHICLE_ID]), 1, "no other vehicle is touched");
  });
});

for (const status of ["Online", "LoggingOut"]) {
  test(`real PostgreSQL: the stored override refuses while the owner is ${status}`, async (t) => {
    await withDatabase(t, async (pool) => {
      await storeForRecovery(pool, { online: status });
      const db = pgTransactionalDb(pool);
      await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID, { storedRecoveryOnly: true }),
        /Gurney is online\. A stored vehicle can only be deleted while its owner is offline\./);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    });
  });
}

// Any character on the account can restore the vehicle in-game, so any of
// them being online blocks the delete -- not just the one on the record.
test("real PostgreSQL: the stored override refuses while another character on the owning account is online", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool, { altOnline: "Online" });
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID, { storedRecoveryOnly: true }), /is online/);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
  });
});

for (const [state, message] of [
  ["Default", /is not Stored for Recovery\. Use Delete Vehicle instead\./],
  ["Travel", /is In Transit and cannot be deleted/],
  ["VehicleBackup", /is in Vehicle Backup and cannot be deleted/]
]) {
  test(`real PostgreSQL: the stored override refuses a ${state} vehicle`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("update dune.actors set state = $2 where id = $1", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID, { storedRecoveryOnly: true }), message);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    });
  });
}

// Issue #1134: the queued/map-down path (allowBlockedState) used to skip the
// owner-online check, so a vehicle that became Stored for Recovery after it was
// queued was destroyed while its owner was logged in.
for (const [label, opts] of [["owner", { online: "Online" }], ["another character on the owning account", { altOnline: "Online" }]]) {
  test(`real PostgreSQL: a map-down delete refuses a recovered vehicle while the ${label} is online`, async (t) => {
    await withDatabase(t, async (pool) => {
      await storeForRecovery(pool, opts);
      const db = pgTransactionalDb(pool);
      await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID, { allowBlockedState: true }), /is online\./);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "the vehicle must survive");
    });
  });
}

test("real PostgreSQL: a map-down delete still deletes a recovered vehicle whose owner is offline", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID, { allowBlockedState: true });
    assert.equal(result.ok, true);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
  });
});

test("real PostgreSQL: map-down flush keeps a queued delete whose vehicle was stored while its owner is online", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      await storeForRecovery(pool, { online: "Online" });

      const db = pgTransactionalDb(pool);
      const result = await flushVehicleDeletes(db, repoRoot, { allowBlockedStates: true, ignoreRetryBackoff: true });
      assert.equal(result.flushed[0].ok, false);
      assert.equal(result.flushed[0].dropped, false);
      assert.equal(result.flushed[0].attempts, 0, "an online owner is temporary and must not burn attempts");
      assert.doesNotMatch(result.flushed[0].error, /Gurney/, "the owner's name is players:read data");
      assert.equal(listQueuedVehicleDeletes(repoRoot)[0].lastError.includes("Gurney"), false);
      assert.equal(result.pending, 1);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "the vehicle must survive");
    });
  });
});

test("real PostgreSQL: the ordinary delete still refuses a recovered vehicle with an offline owner", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID), /is Stored for Recovery and cannot be deleted/);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
  });
});

// The preflight is what the route runs before the safety backup, so it has to
// refuse exactly what the delete would refuse -- and touch nothing.
test("real PostgreSQL: the stored-delete preflight passes for a recovered vehicle with an offline owner", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    await storedVehicleDeletePreflight(pgTransactionalDb(pool), VEHICLE_ID);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "the preflight must not delete anything");
  });
});

test("real PostgreSQL: the stored-delete preflight refuses everything the delete refuses", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => storedVehicleDeletePreflight(db, 424242), /That vehicle was not found/);
    await assert.rejects(() => storedVehicleDeletePreflight(db, VEHICLE_ID), /is not Stored for Recovery\. Use Delete Vehicle instead\./);
    await pool.query("update dune.actors set state = 'VehicleBackup' where id = $1", [VEHICLE_ID]);
    await assert.rejects(() => storedVehicleDeletePreflight(db, VEHICLE_ID), /is in Vehicle Backup and cannot be deleted/);
    await pool.query("update dune.actors set state = 'Default' where id = $1", [VEHICLE_ID]);
    await storeForRecovery(pool, { online: "Online" });
    await assert.rejects(() => storedVehicleDeletePreflight(db, VEHICLE_ID), /Gurney is online\./);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
  });
});

// A recovery record whose character was deleted has nobody left to restore
// it, so it reads as offline and stays deletable.
test("real PostgreSQL: the stored override deletes a recovered vehicle whose owning character is gone", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("update dune.actors set state = 'VehicleRecovery', partition_id = null where id = $1", [VEHICLE_ID]);
    // The seeded holder is deleted in-game: the row stays, the view hides it.
    await pool.query("update dune.encrypted_player_state set character_state = 'Deleted', online_status = 'Online' where id = $1", [VEHICLE_ID]);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID, { storedRecoveryOnly: true });
    assert.equal(result.storedOwner, "");
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
  });
});

// The FOR SHARE lock makes the delete wait for a login already in flight and
// then see it, instead of reading the pre-login snapshot.
test("real PostgreSQL: the stored override waits for an in-flight login and then refuses", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    const login = await pool.connect();
    try {
      await login.query("begin");
      await login.query("update dune.encrypted_player_state set online_status = 'Online' where id = $1", [OWNER_CHARACTER_ID]);

      let settled = false;
      const attempt = deleteVehicleCompletely(pgTransactionalDb(pool), VEHICLE_ID, { storedRecoveryOnly: true })
        .then(() => ({ deleted: true }), (error) => ({ error }))
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(settled, false, "the delete must wait on the owner's character row, not read past it");

      await login.query("commit");
      const outcome = await attempt;
      assert.equal(outcome.deleted, undefined, "the delete went ahead while its owner was logging in");
      assert.match(outcome.error.message, /Gurney is online\./);
      assert.equal(outcome.error.code, "stored_owner_online");
    } finally {
      await login.query("rollback").catch(() => {});
      login.release();
    }
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
  });
});

// A login that rolls back does not block the delete for good.
test("real PostgreSQL: the stored override proceeds once a blocking session rolls back", async (t) => {
  await withDatabase(t, async (pool) => {
    await storeForRecovery(pool);
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("update dune.encrypted_player_state set online_status = 'Online' where id = $1", [OWNER_CHARACTER_ID]);
      const attempt = deleteVehicleCompletely(pgTransactionalDb(pool), VEHICLE_ID, { storedRecoveryOnly: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query("rollback");
      const result = await attempt;
      assert.equal(result.ok, true);
    } finally {
      other.release();
    }
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
  });
});
