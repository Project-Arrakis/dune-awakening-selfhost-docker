import test from "node:test";
import assert from "node:assert/strict";
import { liveMapPois, liveMapResourceFields } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Matches services/resourceFieldId.js's verified decode exactly (inverse of
// it), so seeded field_id values round-trip through the real decode this
// test also exercises indirectly via liveMapResourceFields.
function encodeFieldId(x, y, z) {
  const mask = (1n << 21n) - 1n;
  const enc = (v) => BigInt(v) & mask;
  return enc(x) | (enc(y) << 21n) | (enc(z) << 42n);
}

const SCHEMA = `
  create schema dune;

  create type dune.marker_data as (
    marker_type text,
    x double precision,
    y double precision,
    z double precision
  );

  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.markers (
    map_name_id smallint not null references dune.map_names(map_name_id),
    area_id integer not null default 0,
    long_range boolean not null default false,
    marker dune.marker_data
  );

  create table dune.world_partition (
    partition_id integer not null,
    map text,
    dimension_index integer,
    label text,
    server_id text,
    blocked boolean not null default false
  );

  create table dune.resourcefield_state (
    field_id bigint not null,
    map text not null,
    dimension_index integer not null,
    spawn_time timestamptz,
    value_remaining bigint,
    field_kind_id smallint not null
  );
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_live_map",
    unavailableLabel: "the Live Map POI/resource-field integration test"
  }, async (pool, database) => {
    await pool.query(SCHEMA);
    return run(pgTransactionalDb(pool), pool, database);
  });
}

test("real PostgreSQL: liveMapPois decodes long_range markers via the real dune.markers composite column, filtered by map", async (t) => {
  await withDatabase(t, async (mapPool, pool) => {
    await pool.query(`insert into dune.map_names (map_name_id, map_name) values (7, 'DeepDesert'), (3, 'HaggaBasin')`);
    await pool.query(`
      insert into dune.markers (map_name_id, area_id, long_range, marker) values
        (7, 12, true, row('Cave', -100.5, 200.25, 50)::dune.marker_data),
        (7, 12, true, row('Ecolab', 300, -400, 60)::dune.marker_data),
        (7, 9, false, row('TitaniumOre', 10, 20, 5)::dune.marker_data),
        (3, 1, true, row('Shipwreck', 1, 2, 3)::dune.marker_data)
    `);

    const result = await liveMapPois(mapPool, "DeepDesert");
    assert.equal(result.capabilities.pois, true);
    assert.equal(result.count, 2, "only the two DeepDesert long_range=true rows -- Hagga's Shipwreck and the non-long_range TitaniumOre must both be excluded");
    assert.equal(result.rows.length, 2);

    const cave = result.rows.find((row) => row.name === "Cave");
    assert.ok(cave, "long_range POI must be present");
    assert.equal(cave.type, "poi");
    assert.equal(cave.map, "DeepDesert");
    assert.equal(cave.partition_id, 0, "POIs are global to the map, not partition-scoped -- see #462's Architect-hat finding");
    assert.equal(cave.x, -100.5);
    assert.equal(cave.y, 200.25);

    assert.ok(!result.rows.some((row) => row.name === "TitaniumOre"), "long_range=false rows must never appear as POIs");
    assert.ok(!result.rows.some((row) => row.name === "Shipwreck"), "a different map's markers must not leak in when a map filter is given");
  });
});

test("real PostgreSQL: liveMapPois reports a genuinely empty result as healthy, not an error (post-storm scenario, see #470)", async (t) => {
  await withDatabase(t, async (mapPool) => {
    const result = await liveMapPois(mapPool, "DeepDesert");
    assert.equal(result.capabilities.pois, true);
    assert.equal(result.count, 0);
    assert.equal(result.reason, undefined);
    assert.ok(result.lastPolledAt, "a successful poll must stamp lastPolledAt even when it finds nothing");
  });
});

test("real PostgreSQL: liveMapPois degrades to unsupported, not a crash, when the read-only pool isn't provisioned", async () => {
  const result = await liveMapPois(null, "DeepDesert");
  assert.equal(result.capabilities.pois, false);
  assert.match(result.reason, /not provisioned/);
  assert.equal(result.rows.length, 0);
});

test("real PostgreSQL: liveMapResourceFields decodes field_id via the real, verified packing and resolves partition_id via dimension_index", async (t) => {
  await withDatabase(t, async (mapPool, pool) => {
    await pool.query(`insert into dune.world_partition (partition_id, map, dimension_index) values (8, 'DeepDesert', 2), (11, 'DeepDesert', 5)`);
    // The real, documented example from dune-resource-scanner's
    // findings/2026-08-24-field-id-21bit/README.md: both DD Large-spice rows
    // decode to (-812800, -1016000, -4144).
    const largeSpiceFieldId = encodeFieldId(-812800, -1016000, -4144);
    const flourSandFieldId = encodeFieldId(1000, 2000, 300);
    await pool.query(`
      insert into dune.resourcefield_state (field_id, map, dimension_index, value_remaining, field_kind_id) values
        ($1, 'DeepDesert', 2, 2500000, 1),
        ($2, 'DeepDesert', 5, null, 0)
    `, [largeSpiceFieldId.toString(), flourSandFieldId.toString()]);

    const result = await liveMapResourceFields(mapPool, "DeepDesert");
    assert.equal(result.capabilities.resourceFields, true);
    assert.equal(result.count, 2);

    const spice = result.rows.find((row) => row.name === "Spice");
    assert.ok(spice, "field_kind_id=1 must decode to name Spice");
    assert.equal(spice.x, -812800);
    assert.equal(spice.y, -1016000);
    assert.equal(spice.z, -4144);
    assert.equal(spice.partition_id, 8, "dimension_index 2 must resolve to world_partition's partition_id 8, not be used as partition_id directly");

    const flourSand = result.rows.find((row) => row.name === "Flour Sand");
    assert.ok(flourSand, "field_kind_id=0 must decode to name Flour Sand");
    assert.equal(flourSand.partition_id, 11);
  });
});

test("real PostgreSQL: liveMapResourceFields handles a real burst without error (matching the observed ~2,000-row discovery event)", async (t) => {
  await withDatabase(t, async (mapPool, pool) => {
    await pool.query(`insert into dune.world_partition (partition_id, map, dimension_index) values (8, 'DeepDesert', 2)`);
    const values = [];
    const params = [];
    for (let i = 0; i < 2000; i++) {
      const fieldId = encodeFieldId(i, -i, 0);
      params.push(fieldId.toString(), "DeepDesert", 2, i % 2);
      const base = params.length;
      values.push(`($${base - 3}, $${base - 2}, $${base - 1}, $${base})`);
    }
    await pool.query(`insert into dune.resourcefield_state (field_id, map, dimension_index, field_kind_id) values ${values.join(", ")}`, params);

    const start = Date.now();
    const result = await liveMapResourceFields(mapPool, "DeepDesert");
    assert.equal(result.count, 2000);
    assert.ok(Date.now() - start < 15000, "a 2,000-row poll must complete well within the query timeout");
  });
});

test("real PostgreSQL: liveMapPois warns and reports unsupported, rather than guessing, when an expected column is missing (schema drift, see #474)", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_live_map_drift",
    unavailableLabel: "the Live Map schema-drift integration test"
  }, async (pool) => {
    // A deliberately wrong schema: dune.markers exists, but without long_range.
    await pool.query(`
      create schema dune;
      create table dune.map_names (map_name_id smallint primary key, map_name text not null);
      create table dune.markers (map_name_id smallint, area_id integer);
    `);
    const mapPool = pgTransactionalDb(pool);
    const result = await liveMapPois(mapPool, "DeepDesert");
    assert.equal(result.capabilities.pois, false);
    assert.match(result.reason, /long_range/);
  });
});
