import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const patchSql = readFileSync(new URL("../../../runtime/sql/patch-coriolis-base-backup-preservation.sql", import.meta.url), "utf8");

test("Coriolis compatibility patch is wired after every successful database update", () => {
  const updater = readFileSync(new URL("../../../runtime/scripts/update-db.sh", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../../runtime/scripts/patch-coriolis-base-backups.sh", import.meta.url), "utf8");

  assert.equal((updater.match(/finish_database_update/g) || []).length, 4,
    "the helper definition and all three updater success paths must remain wired");
  assert.match(updater, /runtime\/scripts\/patch-coriolis-base-backups[.]sh/);
  assert.match(wrapper, /-v ON_ERROR_STOP=1/);
  assert.match(wrapper, /-f - < "\$patch_sql"/);
  assert.match(patchSql, /pg_advisory_xact_lock/);
  assert.match(patchSql, /Funcom function shape is not recognized; no change was made/);
});

const FIXTURE_SCHEMA = `
  create schema dune;
  create type dune.serverinfo as (map text);
  create table dune.actors (
    id bigint primary key,
    owner_account_id bigint,
    on_target_server boolean not null default true
  );
  create table dune.actor_state (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    state text not null
  );
  create function dune.server_info_match(in_actor dune.actors, in_server_info dune.serverinfo)
  returns boolean language sql immutable as 'select in_actor.on_target_server';
  set search_path to dune, public;
  create function dune.delete_actors_and_respawns_on_server(
    in_server_info dune.serverinfo,
    in_vehicle_classes_spawned_on_map text[],
    in_allow_vehicle_recovery boolean
  ) returns void language plpgsql as $fixture$
  begin
    with actors_to_delete as (
      select a.id
      from actors a
      left join actor_state s on a.id = s.actor_id
      where owner_account_id is null
        and s.state is distinct from 'Travel'
        and s.state is distinct from 'VehicleBackup'
        and s.state is distinct from 'VehicleRecovery'
        and server_info_match(a, in_server_info)
    )
    delete from actors a
    where a.id = any(select id from actors_to_delete);
  end
  $fixture$;
  reset search_path;
`;

test("real PostgreSQL: Coriolis cleanup preserves BaseBackup actors after an idempotent patch", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_coriolis_base_backup",
    unavailableLabel: "the Coriolis base-backup patch integration test"
  }, async (pool) => {
    await pool.query(FIXTURE_SCHEMA);

    const before = await pool.query(`
      select pg_get_functiondef(
        'dune.delete_actors_and_respawns_on_server(dune.serverinfo,text[],boolean)'::regprocedure
      ) as definition`);
    assert.doesNotMatch(before.rows[0].definition, /IS DISTINCT FROM 'BaseBackup'/i,
      "the fixture must reproduce Funcom's vulnerable predicate before patching");

    await pool.query(patchSql);
    const first = await pool.query(`
      select pg_get_functiondef(
        'dune.delete_actors_and_respawns_on_server(dune.serverinfo,text[],boolean)'::regprocedure
      ) as definition`);
    assert.equal((first.rows[0].definition.match(/IS DISTINCT FROM 'BaseBackup'/gi) || []).length, 1);

    await pool.query(patchSql);
    const second = await pool.query(`
      select pg_get_functiondef(
        'dune.delete_actors_and_respawns_on_server(dune.serverinfo,text[],boolean)'::regprocedure
      ) as definition`);
    assert.equal(second.rows[0].definition, first.rows[0].definition,
      "reapplying the compatibility patch must be byte-for-byte idempotent");

    await pool.query(`
      set search_path to dune, public;
      insert into dune.actors (id, owner_account_id) values
        (1, null), (2, null), (3, null), (4, 99), (5, null);
      insert into dune.actor_state (actor_id, state) values
        (1, 'BaseBackup'),
        (2, 'VehicleBackup'),
        (3, 'Ordinary'),
        (4, 'Ordinary'),
        (5, 'Travel');
      select dune.delete_actors_and_respawns_on_server(
        row('DeepDesert')::dune.serverinfo,
        null,
        true
      );
      reset search_path;
    `);
    const remaining = await pool.query("select id::int from dune.actors order by id");
    assert.deepEqual(remaining.rows.map((row) => row.id), [1, 2, 4, 5],
      "BaseBackup, existing protected states, and owned actors survive while an ordinary ownerless actor is removed");

    await pool.query(`
      set search_path to dune, public;
      create or replace function dune.delete_actors_and_respawns_on_server(
        in_server_info dune.serverinfo,
        in_vehicle_classes_spawned_on_map text[],
        in_allow_vehicle_recovery boolean
      ) returns void language plpgsql as $changed$
      begin
        delete from actors a
        where owner_account_id is null
          and server_info_match(a, in_server_info);
      end
      $changed$;
      reset search_path;
    `);
    await assert.rejects(pool.query(patchSql), /Funcom function shape is not recognized/,
      "an unknown future Funcom definition must fail closed instead of being rewritten blindly");
    const rejected = await pool.query(`
      select pg_get_functiondef(
        'dune.delete_actors_and_respawns_on_server(dune.serverinfo,text[],boolean)'::regprocedure
      ) as definition`);
    assert.doesNotMatch(rejected.rows[0].definition, /BaseBackup/i,
      "shape rejection must leave the unknown function untouched");
  });
});
