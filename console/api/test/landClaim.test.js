import assert from "node:assert/strict";
import test from "node:test";
import { getBaseLandClaim, updateBaseLandClaim } from "../src/duneDb.js";

function fixture({ segments = [{ x: 1, y: 0, row_count: 1 }], verticalLevel = 1 } = {}) {
  const calls = [];
  let currentSegments = segments.map((segment) => ({ ...segment }));
  let currentVertical = verticalLevel;
  const query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.includes("information_schema.columns")) {
      const columns = values[1] === "totems"
        ? ["id", "landclaim_vertical_level", "landclaim_original_global_yaw_rotation"]
        : ["totem_id", "grid_location_x", "grid_location_y"];
      return { rows: columns.map((column_name) => ({ column_name })), rowCount: columns.length };
    }
    if (text.includes("select t.id::text as totem_id")) {
      return { rows: [{ totem_id: "459", map: "HaggaBasin", partition_id: 1, vertical_level: currentVertical, yaw: 90 }], rowCount: 1 };
    }
    if (text.includes("from dune.landclaim_segments") && text.includes("group by")) {
      return { rows: currentSegments, rowCount: currentSegments.length };
    }
    if (text.includes("insert into dune.landclaim_segments")) {
      values[1].forEach((x, index) => currentSegments.push({ x: Number(x), y: Number(values[2][index]), row_count: 1 }));
      return { rows: [], rowCount: values[1].length };
    }
    if (text.includes("update dune.totems")) {
      currentVertical = Number(values[1]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    db: { query, transaction: async (fn) => fn({ query }) }
  };
}

test("getBaseLandClaim resolves the displayed base ID to its totem and local grid", async () => {
  const { db } = fixture({
    segments: [{ x: -1, y: 0, row_count: 1 }, { x: -1, y: -1, row_count: 1 }],
    verticalLevel: 2
  });
  const result = await getBaseLandClaim(db, 31573);
  assert.equal(result.baseId, 31573);
  assert.equal(result.totemId, "459");
  assert.equal(result.yaw, 90);
  assert.equal(result.verticalLevel, 2);
  assert.equal(result.maxVerticalLevel, 5);
  assert.deepEqual(result.segments.map(({ x, y }) => [x, y]), [[-1, 0], [-1, -1]]);
});

test("updateBaseLandClaim atomically adds connected cells and raises the vertical level", async () => {
  const { db, calls } = fixture();
  const result = await updateBaseLandClaim(db, 31573, {
    addSegments: [{ x: 2, y: 0 }, { x: 2, y: 1 }],
    verticalLevel: 5
  });
  assert.equal(result.added, 2);
  assert.equal(result.verticalChanged, true);
  assert.equal(result.verticalLevel, 5);
  assert.deepEqual(result.segments.map(({ x, y }) => [x, y]), [[1, 0], [2, 0], [2, 1]]);
  const insert = calls.find((call) => call.text.includes("insert into dune.landclaim_segments"));
  assert.deepEqual(insert.values, ["459", [2, 2], [0, 1]]);
  assert.ok(calls.some((call) => call.text.includes("for update of t")), "the totem must be locked before validating and writing");
});

test("updateBaseLandClaim rejects disconnected, duplicate, origin, and excessive vertical changes", async () => {
  const disconnected = fixture();
  await assert.rejects(
    () => updateBaseLandClaim(disconnected.db, 31573, { addSegments: [{ x: 8, y: 8 }], verticalLevel: 1 }),
    /disconnected/
  );
  assert.equal(disconnected.calls.some((call) => call.text.includes("insert into dune.landclaim_segments")), false);

  await assert.rejects(
    () => updateBaseLandClaim(fixture().db, 31573, { addSegments: [{ x: 1, y: 0 }], verticalLevel: 1 }),
    /already occupied/
  );
  await assert.rejects(
    () => updateBaseLandClaim(fixture().db, 31573, { addSegments: [{ x: 0, y: 0 }], verticalLevel: 1 }),
    /already occupies/
  );
  await assert.rejects(
    () => updateBaseLandClaim(fixture().db, 31573, { addSegments: [], verticalLevel: 6 }),
    /between 0 and 5/
  );
  await assert.rejects(
    () => updateBaseLandClaim(fixture({ verticalLevel: 3 }).db, 31573, { addSegments: [], verticalLevel: 2 }),
    /expansion-only/
  );
  await assert.rejects(
    () => updateBaseLandClaim(fixture({ verticalLevel: 3 }).db, 31573, { addSegments: [], verticalLevel: 3 }),
    /already matches/
  );
});

test("updateBaseLandClaim refuses a claim that already contains duplicate coordinate rows", async () => {
  const { db } = fixture({ segments: [{ x: 1, y: 0, row_count: 2 }] });
  await assert.rejects(
    () => updateBaseLandClaim(db, 31573, { addSegments: [{ x: 2, y: 0 }], verticalLevel: 1 }),
    /duplicate database rows/
  );
});
