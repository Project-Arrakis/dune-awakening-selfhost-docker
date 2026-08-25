import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { liveMapPois, liveMapResourceFields } from "../src/duneDb.js";
import { pgConnectionConfig, pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const { Pool } = pg;

// Exactly the grants docs/console/live-map-resource-role.md documents as the
// one-time provisioning step -- run for real here so this test regresses if
// that SQL is ever incomplete again. The bug this test exists to catch:
// every other test in this file queries through pgTransactionalDb(pool),
// the full-privilege test-admin connection -- which never hits a permission
// boundary at all, so it could not have caught (and did not catch) that the
// originally-shipped provisioning SQL was missing GRANT USAGE ON SCHEMA and
// two of the four tables these functions actually need, both confirmed only
// by running against a real, genuinely-restricted role on dune-dev.
async function withRestrictedMapPool(pool, database, run) {
  const roleName = `test_map_readonly_${Math.random().toString(36).slice(2, 10)}`;
  const password = "test-password";
  await pool.query(`create role "${roleName}" login password '${password}'`);
  await pool.query(`grant usage on schema dune to "${roleName}"`);
  await pool.query(`grant select on dune.markers, dune.resourcefield_state, dune.map_names, dune.world_partition to "${roleName}"`);
  const restrictedPool = new Pool({ ...pgConnectionConfig(database), user: roleName, password, max: 2 });
  try {
    await run(pgTransactionalDb(restrictedPool));
  } finally {
    await restrictedPool.end().catch(() => {});
    await pool.query(`drop role if exists "${roleName}"`).catch(() => {});
  }
}

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

test("real PostgreSQL: liveMapResourceFields decodes field_id via the real, verified packing and resolves partition_id via dimension_index, translating the display map name to the service name world_partition actually uses", async (t) => {
  await withDatabase(t, async (mapPool, pool) => {
    // world_partition uses the SERVICE name ("DeepDesert_1"); resourcefield_state
    // uses the DISPLAY name ("DeepDesert") -- confirmed live against dune-dev.
    // Using the display name for both here (as an earlier version of this test
    // did) would have masked the exact join bug found on that live deployment.
    await pool.query(`insert into dune.world_partition (partition_id, map, dimension_index) values (8, 'DeepDesert_1', 2), (11, 'DeepDesert_1', 5)`);
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
    await pool.query(`insert into dune.world_partition (partition_id, map, dimension_index) values (8, 'DeepDesert_1', 2)`);
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

test("real PostgreSQL: both sources work end-to-end through a role granted EXACTLY what docs/console/live-map-resource-role.md documents, no more", async (t) => {
  await withDatabase(t, async (_adminMapPool, pool, database) => {
    await pool.query(`insert into dune.map_names (map_name_id, map_name) values (7, 'DeepDesert')`);
    await pool.query(`insert into dune.markers (map_name_id, area_id, long_range, marker) values (7, 12, true, row('Cave', 1, 2, 3)::dune.marker_data)`);
    await pool.query(`insert into dune.world_partition (partition_id, map, dimension_index) values (8, 'DeepDesert_1', 2)`);
    await pool.query(`insert into dune.resourcefield_state (field_id, map, dimension_index, field_kind_id) values ($1, 'DeepDesert', 2, 1)`, [encodeFieldId(10, 20, 30).toString()]);

    await withRestrictedMapPool(pool, database, async (restrictedPool) => {
      const pois = await liveMapPois(restrictedPool, "DeepDesert");
      assert.equal(pois.capabilities.pois, true, `POIs must work through the exact documented grant set, got: ${pois.reason}`);
      assert.equal(pois.count, 1);

      const resources = await liveMapResourceFields(restrictedPool, "DeepDesert");
      assert.equal(resources.capabilities.resourceFields, true, `Resource fields must work through the exact documented grant set, got: ${resources.reason}`);
      assert.equal(resources.count, 1);
      assert.equal(resources.rows[0].partition_id, 8);
    });
  });
});
