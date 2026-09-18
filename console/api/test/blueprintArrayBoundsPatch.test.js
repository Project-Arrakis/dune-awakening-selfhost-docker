import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const patchSql = readFileSync(new URL("../../../runtime/sql/patch-blueprint-array-bounds.sql", import.meta.url), "utf8");

test("blueprint array-bound repair is wired after successful database migration", () => {
  const updater = readFileSync(new URL("../../../runtime/scripts/update-db.sh", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../../runtime/scripts/patch-blueprint-array-bounds.sh", import.meta.url), "utf8");

  assert.match(updater, /runtime\/scripts\/patch-blueprint-array-bounds[.]sh/);
  assert.match(wrapper, /-v ON_ERROR_STOP=1/);
  assert.match(wrapper, /-f - < "\$patch_sql"/);
  assert.match(patchSql, /array_lower\(transform, 1\) = 1/);
  assert.match(patchSql, /array_lower\(scale, 1\) = 1/);
});

test("real PostgreSQL: blueprint repair converts legacy arrays and preserves values", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_blueprint_array_bounds",
    unavailableLabel: "the blueprint array-bound integration test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.building_blueprint_instances (id integer primary key, transform real[] not null);
      create table dune.building_blueprint_placeables (id integer primary key, transform real[] not null);
      create table dune.building_blueprint_pentashields (id integer primary key, scale smallint[] not null);

      insert into dune.building_blueprint_instances values
        (1, '{1,2,3,4}'),
        (2, '[0:3]={5,6,7,8}');
      insert into dune.building_blueprint_placeables values
        (1, '{10,20,30,40,50,60}'),
        (2, '[0:5]={70,80,90,100,110,120}');
      insert into dune.building_blueprint_pentashields values
        (1, '{2,4,6}'),
        (2, '[0:2]={8,10,12}');
    `);

    await pool.query(patchSql);
    await pool.query(patchSql);

    const instances = await pool.query(`
      select id, array_lower(transform, 1) as lower_bound, transform[0] as first, transform[3] as last
      from dune.building_blueprint_instances order by id
    `);
    assert.deepEqual(instances.rows, [
      { id: 1, lower_bound: 0, first: 1, last: 4 },
      { id: 2, lower_bound: 0, first: 5, last: 8 }
    ]);

    const placeables = await pool.query(`
      select id, array_lower(transform, 1) as lower_bound, transform[0] as first, transform[5] as last
      from dune.building_blueprint_placeables order by id
    `);
    assert.deepEqual(placeables.rows, [
      { id: 1, lower_bound: 0, first: 10, last: 60 },
      { id: 2, lower_bound: 0, first: 70, last: 120 }
    ]);

    const shields = await pool.query(`
      select id, array_lower(scale, 1) as lower_bound, scale[0] as first, scale[2] as last
      from dune.building_blueprint_pentashields order by id
    `);
    assert.deepEqual(shields.rows, [
      { id: 1, lower_bound: 0, first: 2, last: 6 },
      { id: 2, lower_bound: 0, first: 8, last: 12 }
    ]);
  });
});
