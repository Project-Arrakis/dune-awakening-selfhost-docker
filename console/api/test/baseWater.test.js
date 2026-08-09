import test from "node:test";
import assert from "node:assert/strict";
import { baseWater } from "../src/duneDb.js";

// Every table the query touches, including fgl_entities inside the lateral.
// buildings/building_instances/actor_fgl_entities/actors overlap listBases's
// probe set; placeables and fgl_entities do not, which is why a schema can
// list bases fine and still be unable to answer this one.
const REQUIRED_TABLES = [
  "dune.buildings", "dune.building_instances", "dune.actor_fgl_entities",
  "dune.placeables", "dune.actors", "dune.fgl_entities"
];
const BASE_ID = 482;

function createDb({ rows = [], missingTable = "" } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "");
        return { rows: [{ exists: REQUIRED_TABLES.includes(table) && table !== missingTable }] };
      }
      return { rows };
    }
  };
}

function mainQuery(db) {
  return db.calls.find((call) => call.text.includes("requested_claims"));
}

// A capability response, not a throw. Before this, a missing table reached the
// route as a plain Error, so the 501 arm never fired and the tab rendered a
// redacted "relation ... does not exist" beside a Retry button that could only
// ever fail the same way.
test("baseWater reports unsupported when a required table is missing", async () => {
  for (const table of REQUIRED_TABLES) {
    const db = createDb({ missingTable: table });
    const result = await baseWater(db, BASE_ID);

    assert.equal(result.supported, false);
    assert.match(result.reason, new RegExp(table.replace(".", "\\.")));
    assert.equal(result.baseId, BASE_ID);
    // Still shaped like a real response, so the tab reads containers without
    // guarding it first.
    assert.deepEqual(result.containers, []);
    // The point of probing is to never run the query that would have raised.
    assert.equal(mainQuery(db), undefined);
  }
});

test("baseWater runs the query and reports supported when every table is present", async () => {
  const db = createDb({
    rows: [
      { water_type: "windtrap", container_count: 4, water_stored: 6000, blood_stored: null },
      { water_type: "waterCistern", container_count: 1, water_stored: 1250, blood_stored: null }
    ]
  });

  const result = await baseWater(db, BASE_ID);

  assert.equal(result.supported, true);
  assert.equal(result.baseId, BASE_ID);
  assert.ok(mainQuery(db), "the real query must still run on a supported schema");
  // WATER_TYPE_ORDER puts cisterns ahead of windtraps regardless of row order.
  assert.deepEqual(result.containers.map((entry) => entry.type), ["waterCistern", "windtrap"]);
  assert.equal(result.containers[0].stored, 1250);
});

test("baseWater rejects an invalid base id", async () => {
  const db = createDb();
  await assert.rejects(() => baseWater(db, 0));
  await assert.rejects(() => baseWater(db, "not-a-base"));
});
