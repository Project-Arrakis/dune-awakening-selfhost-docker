import test from "node:test";
import assert from "node:assert/strict";
import { repairVehicleDecay } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const SCHEMA = `
  create schema dune;

  create table dune.actors (
    id bigint primary key,
    class text,
    owner_account_id bigint
  );

  create table dune.player_state (
    id bigint primary key,
    account_id bigint,
    player_controller_id bigint,
    player_pawn_id bigint,
    online_status text
  );

  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null,
    template_id text not null,
    stats jsonb
  );
`;

function durability(current, decayed, max) {
  const values = { CurrentDurability: current, DecayedMaxDurability: decayed };
  if (max !== undefined) values.MaxDurability = max;
  return JSON.stringify({ FVehicleModuleDurabilityStats: [[], values] });
}

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "vehicle_decay_repair",
    unavailableLabel: "the vehicle decay repair integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.actors (id, class, owner_account_id) values
        (100, '/Game/PlayerCharacter', 10),
        (200, '/Game/Vehicle', 10),
        (201, '/Game/Vehicle', 10),
        (300, '/Game/Vehicle', 20);
      insert into dune.player_state
        (id, account_id, player_controller_id, player_pawn_id, online_status)
        values (1, 10, 110, 100, 'Offline');
    `);
    return run(pool);
  });
}

test("real PostgreSQL: vehicle red-bar repair infers missing maxima conservatively", async (t) => {
  await withDatabase(t, async (pool) => {
    const rows = [
      [1, 200, "Common", durability(30, 40)],
      [2, 201, "Common", durability(100, 100)],
      [3, 200, "Boundary", durability(50, 50)],
      [4, 201, "Boundary", durability(100, 100)],
      [5, 200, "SingleSample", durability(5, 10)],
      [6, 300, "Common", durability(1, 1)],
      [7, 200, "StoredMaximum", durability(50, 50, 200)],
      [8, 200, "ZeroStoredMaximum", durability(10, 20, 0)],
      [9, 201, "ZeroStoredMaximum", durability(100, 100)]
    ];
    for (const row of rows) {
      await pool.query(
        "insert into dune.vehicle_modules (id, vehicle_id, template_id, stats) values ($1, $2, $3, $4::jsonb)",
        row
      );
    }

    const result = await repairVehicleDecay(pgTransactionalDb(pool), 100, { thresholdPercent: 50 });

    assert.equal(result.scanned, 8);
    assert.equal(result.vehicles, 2);
    assert.equal(result.comparable, 7);
    assert.equal(result.missingMaximum, 1);
    assert.equal(result.repaired, 3);
    assert.equal(result.repairedVehicles, 1);

    const repaired = await pool.query(`
      select id,
             (stats->'FVehicleModuleDurabilityStats'->1->>'CurrentDurability')::numeric as current,
             (stats->'FVehicleModuleDurabilityStats'->1->>'DecayedMaxDurability')::numeric as decayed
      from dune.vehicle_modules
      order by id
    `);
    const values = new Map(repaired.rows.map((row) => [Number(row.id), {
      current: Number(row.current),
      decayed: Number(row.decayed)
    }]));

    assert.deepEqual(values.get(1), { current: 100, decayed: 100 });
    assert.deepEqual(values.get(7), { current: 200, decayed: 200 });
    assert.deepEqual(values.get(8), { current: 100, decayed: 100 });
    assert.deepEqual(values.get(3), { current: 50, decayed: 50 });
    assert.deepEqual(values.get(5), { current: 5, decayed: 10 });
    assert.deepEqual(values.get(6), { current: 1, decayed: 1 });
  });
});
