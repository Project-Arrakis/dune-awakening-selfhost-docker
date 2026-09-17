import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const patchSql = readFileSync(new URL("../../../runtime/sql/patch-vehicle-recovery-guard-schema.sql", import.meta.url), "utf8");

test("vehicle-recovery guard compatibility patch is wired after database migration", () => {
  const updater = readFileSync(new URL("../../../runtime/scripts/update-db.sh", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../../runtime/scripts/patch-vehicle-recovery-guard.sh", import.meta.url), "utf8");

  assert.match(updater, /runtime\/scripts\/patch-vehicle-recovery-guard[.]sh/);
  assert.match(wrapper, /-v ON_ERROR_STOP=1/);
  assert.match(wrapper, /-f - < "\$patch_sql"/);
  assert.match(patchSql, /to_regclass\('dune[.]actor_state'\)/);
  assert.match(patchSql, /to_jsonb\(old\) ->> 'state'/);
});

const LEGACY_FIXTURE = `
  create schema dune;
  create schema dune_runtime;
  create table dune.actors (
    id bigint primary key,
    map text,
    partition_id bigint,
    dimension_index integer
  );
  create table dune.actor_state (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    state text not null
  );
  create table dune_runtime.vehicle_recovery_guard (
    partition_id bigint primary key,
    ready_after timestamp with time zone not null
  );
  create function dune_runtime.guard_recovered_vehicle_restore()
  returns trigger language plpgsql security definer
  set search_path to dune, dune_runtime, pg_temp
  as $legacy$
  begin
    if not exists (
      select 1 from dune.actor_state ast
      where ast.actor_id = old.id and ast.state = 'VehicleRecovery'
    ) then
      return new;
    end if;
    if exists (
      select 1 from dune_runtime.vehicle_recovery_guard g
      where g.partition_id = new.partition_id and g.ready_after > clock_timestamp()
    ) then
      raise exception using errcode = '55000', message = 'legacy guard';
    end if;
    return new;
  end
  $legacy$;
  create trigger dune_runtime_guard_recovered_vehicle_restore
  before update of map, partition_id, dimension_index on dune.actors
  for each row execute function dune_runtime.guard_recovered_vehicle_restore();
`;

test("real PostgreSQL: vehicle-recovery guard works before and after actor-state migration", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_recovery_guard",
    unavailableLabel: "the vehicle-recovery guard integration test"
  }, async (pool) => {
    await pool.query(LEGACY_FIXTURE);
    await pool.query(`
      insert into dune.actors (id, map, partition_id, dimension_index)
      values (1, 'OldMap', 1, 0), (2, 'OldMap', 1, 0);
      insert into dune.actor_state (actor_id, state)
      values (1, 'VehicleRecovery'), (2, 'Default');
      insert into dune_runtime.vehicle_recovery_guard (partition_id, ready_after)
      values (2, clock_timestamp() + interval '10 minutes');
    `);

    await pool.query(patchSql);
    await assert.rejects(
      pool.query("update dune.actors set partition_id = 2 where id = 1"),
      /Vehicle recovery is waiting for map permissions/
    );
    await pool.query("update dune.actors set partition_id = 2 where id = 2");

    await pool.query(`
      alter table dune.actors add column state text not null default 'Default';
      update dune.actors set state = ast.state
      from dune.actor_state ast
      where dune.actors.id = ast.actor_id;
      drop table dune.actor_state;
      create or replace function dune_runtime.guard_recovered_vehicle_restore()
      returns trigger language plpgsql security definer
      set search_path to dune, dune_runtime, pg_temp
      as $stale$
      begin
        if not exists (
          select 1 from dune.actor_state ast
          where ast.actor_id = old.id and ast.state = 'VehicleRecovery'
        ) then
          return new;
        end if;
        return new;
      end
      $stale$;
    `);

    await assert.rejects(
      pool.query("update dune.actors set partition_id = 2 where id = 1"),
      /relation "dune[.]actor_state" does not exist/,
      "the fixture must reproduce the post-migration crash trigger before patching"
    );

    await pool.query(patchSql);
    await pool.query(patchSql);
    await assert.rejects(
      pool.query("update dune.actors set partition_id = 2 where id = 1"),
      /Vehicle recovery is waiting for map permissions/
    );
    await pool.query("update dune.actors set partition_id = 1 where id = 2");

    const rows = await pool.query("select id::int, partition_id::int from dune.actors order by id");
    assert.deepEqual(rows.rows, [
      { id: 1, partition_id: 1 },
      { id: 2, partition_id: 1 }
    ]);
  });
});
