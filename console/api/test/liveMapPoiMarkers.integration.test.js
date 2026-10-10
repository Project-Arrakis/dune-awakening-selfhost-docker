import test from "node:test";
import assert from "node:assert/strict";
import { liveMapPoiMarkers } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real schema pulled from dune2's live database, as of the Steam release
// diffed in issue #963. A prior Funcom schema exposed a single composite
// `marker` column (marker_type, x, y, z, payload_type combined); that
// release split it into a top-level `marker_type` text column, a `position`
// composite (named `vector`, but a plain 3-field double-precision composite
// type -- not the pgvector extension), and a `payload_type` column, with no
// successor to the old combined column at all.
const SCHEMA = `
  create schema dune;
  create type dune.vector as (
    x double precision,
    y double precision,
    z double precision
  );
  create table dune.markers (
    marker_hash_id integer primary key,
    dimension_index integer not null,
    marker_type text not null,
    position dune.vector not null,
    payload_type text not null,
    area_id smallint,
    area_radius real,
    long_range boolean,
    payload jsonb,
    map_name_id smallint not null
  );
  create table dune.map_names (
    map_name_id smallint primary key,
    map_name text not null
  );
`;

test("real PostgreSQL: liveMapPoiMarkers filters by category pattern, excludes NoIcon, filters by map", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_poi_markers",
    unavailableLabel: "the POI markers integration test",
    createFailLabel: "the POI markers integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.map_names (map_name_id, map_name) values (11, 'HaggaBasin'), (7, 'DeepDesert');
      insert into dune.markers (marker_hash_id, dimension_index, marker_type, position, payload_type, map_name_id) values
        (1, -1, 'RhyolitePickup', (87101, -15285, 2474)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (2, -1, 'AzuriteOre', (86702, -15439, 2480)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (3, -1, 'ScrapMetalWreckage', (88805, -21053, 2622)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (4, -1, 'NoIcon', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (5, -1, 'AzurateOre', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 7),
        -- Confirmed live false positive under the old substring patterns
        -- ("%ore%" matched the "kore" inside this name) -- the suffix-only
        -- patterns must exclude it since it doesn't end in Ore/Pickup/Rock.
        (6, -1, 'HarkoRecustomization', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11);
    `);

    const db = pgTransactionalDb(pool);
    const result = await liveMapPoiMarkers(db, "HaggaBasin", "ore");

    assert.equal(result.capabilities.ore, true);
    // Both RhyolitePickup (matches %Pickup) and AzuriteOre (matches %Ore)
    // are real ore-category hits -- ScrapMetalWreckage, NoIcon,
    // HarkoRecustomization (substring-only false positive), and the
    // DeepDesert row are correctly excluded.
    assert.equal(result.rows.length, 2);
    const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.equal(byId["1"].marker_type, "RhyolitePickup");
    assert.equal(byId["2"].marker_type, "AzuriteOre");
    assert.equal(byId["2"].x, 86702);
    assert.equal(byId["2"].y, -15439);
    assert.equal(byId["2"].map, "HaggaBasin");
  });
});

test("real PostgreSQL: Fortress/House Representative/Trainer are their own categories, no longer under poi", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_poi_markers_split",
    unavailableLabel: "the POI category split integration test",
    createFailLabel: "the POI category split integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.map_names (map_name_id, map_name) values (11, 'HaggaBasin');
      insert into dune.markers (marker_hash_id, dimension_index, marker_type, position, payload_type, map_name_id) values
        (1, -1, 'AtreidesFortress', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (2, -1, 'HarkonnenFortress', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (3, -1, 'HouseRepresentativeArgosaz', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (4, -1, 'TrainerBeneGesserit', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11),
        (5, -1, 'Cave', (1, 2, 3)::dune.vector, 'EMarkerPayloadType::Default', 11);
    `);

    const db = pgTransactionalDb(pool);
    const [fortress, houseRep, trainer, poi] = await Promise.all([
      liveMapPoiMarkers(db, "HaggaBasin", "fortress"),
      liveMapPoiMarkers(db, "HaggaBasin", "house_representative"),
      liveMapPoiMarkers(db, "HaggaBasin", "trainer"),
      liveMapPoiMarkers(db, "HaggaBasin", "poi")
    ]);
    assert.deepEqual(fortress.rows.map((r) => r.marker_type).sort(), ["AtreidesFortress", "HarkonnenFortress"]);
    assert.deepEqual(houseRep.rows.map((r) => r.marker_type), ["HouseRepresentativeArgosaz"]);
    assert.deepEqual(trainer.rows.map((r) => r.marker_type), ["TrainerBeneGesserit"]);
    // "poi" (the general catch-most category) only gets Cave -- confirms
    // the three split-out categories no longer double up inside it.
    assert.deepEqual(poi.rows.map((r) => r.marker_type), ["Cave"]);
  });
});

test("real PostgreSQL: liveMapPoiMarkers throws on an unknown category", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_poi_markers_unknown",
    unavailableLabel: "the POI markers unknown-category test",
    createFailLabel: "the POI markers unknown-category test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => liveMapPoiMarkers(db, "HaggaBasin", "not_a_real_category"));
  });
});
