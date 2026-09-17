import test from "node:test";
import assert from "node:assert/strict";
import { addonOpsResourcesSummary } from "../src/duneDb.js";

function resourceDb({ legacyKindColumn }) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push(String(sql));
      if (String(sql).includes("to_regclass")) {
        return { rows: [{ exists: params[0] === "dune.resourcefield_state" }] };
      }
      if (String(sql).includes("information_schema.columns")) {
        return { rows: ["field_id", "map", "dimension_index", "spawn_time", "value_remaining", ...(legacyKindColumn ? ["field_kind_id"] : [])]
          .map((column_name) => ({ column_name })) };
      }
      if (String(sql).includes("group by map")) return { rows: [] };
      return { rows: [{ total_fields: 0, total_value: 0 }] };
    }
  };
}

test("resource summary keeps the legacy spice-kind filter when the column exists", async () => {
  const db = resourceDb({ legacyKindColumn: true });
  await addonOpsResourcesSummary(db);
  const resourceQueries = db.queries.filter((sql) => sql.includes("from dune.resourcefield_state"));
  assert.equal(resourceQueries.length, 2);
  for (const sql of resourceQueries) assert.match(sql, /where field_kind_id = 1/);
});

test("resource summary supports the refactored resource table without field_kind_id", async () => {
  const db = resourceDb({ legacyKindColumn: false });
  await addonOpsResourcesSummary(db);
  const resourceQueries = db.queries.filter((sql) => sql.includes("from dune.resourcefield_state"));
  assert.equal(resourceQueries.length, 2);
  for (const sql of resourceQueries) assert.doesNotMatch(sql, /field_kind_id/);
});
