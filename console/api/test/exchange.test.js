import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { listExchangeItems, listExchangeListings, exchangeStats, exchangeInternals } from "../src/services/exchange.js";

// Aggregated rows arrive from Postgres with bigint columns as strings; mirror that.
const AGG_ROWS = [
  { template_id: "T6_Augment_Acuracy1", quality_level: "0", lowest_price: "12000", total_stock: "2", npc_stock: "0", listing_count: "1" },
  { template_id: "PartialStabilizationBelt", quality_level: "0", lowest_price: "45084", total_stock: "4", npc_stock: "0", listing_count: "4" },
  { template_id: "OrnithopterTransportLocomotion_6", quality_level: "0", lowest_price: "49000", total_stock: "8", npc_stock: "8", listing_count: "8" }
];

// A fake db that answers to_regclass probes as "present" and routes the data
// query by SQL shape. lastSql captures the aggregation/listings SQL so tests can
// assert the owner/blacklist predicates that a fake db would otherwise ignore.
function fakeDb(dataRows, capture = {}) {
  return {
    query: async (sql, params) => {
      if (/to_regclass/.test(sql)) return { rows: [{ exists: true }] };
      capture.sql = sql;
      capture.params = params;
      return { rows: dataRows };
    }
  };
}

function unsupportedDb() {
  return { query: async (sql) => (/to_regclass/.test(sql) ? { rows: [{ exists: false }] } : { rows: [] }) };
}

beforeEach(() => {
  exchangeInternals.clearCache();
});

test("aggregated items enrich, sort by name, and paginate with filtered/unfiltered totals", async () => {
  const result = await listExchangeItems(fakeDb(AGG_ROWS), { owner: "player", pageSize: 2, sortColumn: "display_name", sortDirection: "asc" });
  assert.equal(result.capabilities.exchange, true);
  assert.equal(result.totalItems, 3); // unfiltered group count
  assert.equal(result.totalCount, 3); // no search term
  assert.equal(result.rows.length, 2); // page slice
  // The known augment id resolves to a friendly catalog name; unknown ids fall back
  // to the template id. Sorted ascending by display name.
  const names = result.rows.map((r) => r.display_name);
  assert.ok(names.every((n) => typeof n === "string" && n.length));
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names);
});

test("tier parses from a T<n>_ prefix and is null otherwise", async () => {
  const result = await listExchangeItems(fakeDb(AGG_ROWS), { owner: "all", pageSize: 50 });
  const byId = Object.fromEntries(result.rows.map((r) => [r.template_id, r]));
  assert.equal(byId["T6_Augment_Acuracy1"].tier, 6);
  assert.equal(byId["PartialStabilizationBelt"].tier, null);
});

test("returns distinct sorted category options and filters rows by category", async () => {
  const listed = await listExchangeItems(fakeDb(AGG_ROWS), { owner: "all", pageSize: 50 });
  assert.ok(Array.isArray(listed.categories));
  // deduped + sorted, no blanks
  assert.deepEqual([...new Set(listed.categories)], listed.categories);
  assert.deepEqual([...listed.categories].sort((a, b) => a.localeCompare(b)), listed.categories);
  assert.ok(listed.categories.every((c) => c));

  if (listed.categories.length) {
    exchangeInternals.clearCache();
    const cat = listed.categories[0];
    const only = await listExchangeItems(fakeDb(AGG_ROWS), { owner: "all", category: cat, pageSize: 50 });
    assert.ok(only.rows.length >= 1);
    assert.ok(only.rows.every((row) => row.category === cat));
    assert.equal(only.totalItems, listed.totalItems); // totalItems stays unfiltered
    assert.ok(only.totalCount <= listed.totalCount);
  }
});

test("search matches display_name / category / template_id", async () => {
  exchangeInternals.clearCache();
  const byTemplate = await listExchangeItems(fakeDb(AGG_ROWS), { owner: "all", q: "OrnithopterTransport" });
  assert.equal(byTemplate.totalCount, 1);
  assert.equal(byTemplate.rows[0].template_id, "OrnithopterTransportLocomotion_6");
});

test("owner filter maps to the documented SQL predicate", async () => {
  const player = {};
  await listExchangeItems(fakeDb(AGG_ROWS, player), { owner: "player" });
  assert.match(player.sql, /not \(o\.is_npc_order or o\.owner_id = any/);

  exchangeInternals.clearCache();
  const bot = {};
  await listExchangeItems(fakeDb(AGG_ROWS, bot), { owner: "bot" });
  assert.match(bot.sql, /o\.is_npc_order or o\.owner_id = any/);

  exchangeInternals.clearCache();
  const all = {};
  await listExchangeItems(fakeDb(AGG_ROWS, all), { owner: "all" });
  // blacklist predicate is always present, on every owner value
  assert.match(all.sql, /o\.owner_id <> all/);
});

// Regression: owner="all" must not pass a parameter it never references, or
// Postgres fails with "could not determine data type of parameter $N". A fake db
// ignores param types, so assert the invariant directly on the generated SQL.
function assertEveryParamReferenced(capture) {
  const referenced = new Set([...capture.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const maxReferenced = referenced.size ? Math.max(...referenced) : 0;
  assert.ok(maxReferenced <= capture.params.length, `SQL references $${maxReferenced} but only ${capture.params.length} params were passed`);
  for (let i = 1; i <= capture.params.length; i += 1) {
    assert.ok(referenced.has(i), `param $${i} is passed but never referenced in the SQL`);
  }
}

test("owner=all passes no unreferenced parameters (items + listings)", async () => {
  const items = {};
  await listExchangeItems(fakeDb(AGG_ROWS, items), { owner: "all", botOwnerIds: ["75"], blacklist: ["9"] });
  assertEveryParamReferenced(items);

  exchangeInternals.clearCache();
  const listings = {};
  await listExchangeListings(fakeDb([], listings), { templateId: "Belt", owner: "all", botOwnerIds: ["75"], blacklist: ["9"] });
  assertEveryParamReferenced(listings);

  // And with an owner value that does reference the bot param, plus a quality filter.
  const withQuality = {};
  await listExchangeListings(fakeDb([], withQuality), { templateId: "Belt", quality: 5, owner: "bot", botOwnerIds: ["75"] });
  assertEveryParamReferenced(withQuality);
});

test("an unknown owner value falls back to the default (all)", async () => {
  const capture = {};
  await listExchangeItems(fakeDb(AGG_ROWS, capture), { owner: "bogus" });
  assert.match(capture.sql, /where true and o\.owner_id <> all/);
});

test("includeNpcBroker=false drops the in-game broker from the bot predicate", async () => {
  // Assert on the WHERE predicate specifically — the SELECT always references
  // is_npc_order for the npc_stock column, independent of the owner filter.
  const withBroker = {};
  await listExchangeItems(fakeDb(AGG_ROWS, withBroker), { owner: "bot", includeNpcBroker: true });
  assert.match(withBroker.sql, /where \(o\.is_npc_order or o\.owner_id = any/);

  exchangeInternals.clearCache();
  const without = {};
  await listExchangeItems(fakeDb(AGG_ROWS, without), { owner: "bot", includeNpcBroker: false });
  assert.match(without.sql, /where \(false or o\.owner_id = any/);
});

test("a listing from the in-game broker is reclassified as player when the broker is excluded", async () => {
  const rows = [{ order_id: "1", template_id: "Belt", is_npc_order: true, owner_id: "75", owner_name: "Revy", item_price: "44000", stock: "1", quality: "0" }];
  const included = await listExchangeListings(fakeDb(rows), { templateId: "Belt", owner: "all", includeNpcBroker: true });
  assert.equal(included.rows[0].owner_type, "bot");
  const excluded = await listExchangeListings(fakeDb(rows), { templateId: "Belt", owner: "all", includeNpcBroker: false });
  assert.equal(excluded.rows[0].owner_type, "player");
});

test("items returns the unsupported shape when a required table is missing", async () => {
  const result = await listExchangeItems(unsupportedDb(), {});
  assert.equal(result.capabilities.exchange, false);
  assert.equal(result.totalCount, 0);
  assert.equal(result.rows.length, 0);
  assert.match(result.reason, /Missing required table/);
});

test("listings flag bot vs player and pass through the resolved seller name", async () => {
  const rows = [
    { order_id: "1", template_id: "Belt", is_npc_order: true, owner_id: "75", owner_name: "Revy", item_price: "44000", stock: "1", quality: "0" },
    { order_id: "2", template_id: "Belt", is_npc_order: false, owner_id: "9929", owner_name: "Halfmoondee", item_price: "45084", stock: "1", quality: "0" },
    { order_id: "3", template_id: "Belt", is_npc_order: false, owner_id: "555", owner_name: "BotAcct", item_price: "50000", stock: "2", quality: "0" }
  ];
  const result = await listExchangeListings(fakeDb(rows), { templateId: "Belt", owner: "all", botOwnerIds: ["555"] });
  const byId = Object.fromEntries(result.rows.map((r) => [r.order_id, r]));
  assert.equal(byId["1"].owner_type, "bot");            // is_npc_order
  assert.equal(byId["1"].owner_name, "Revy");
  assert.equal(byId["2"].owner_type, "player");         // real player
  assert.equal(byId["3"].owner_type, "bot");            // configured bot owner id
  assert.equal(byId["2"].price, 45084);
});

test("listings reject a missing or malformed template id", async () => {
  await assert.rejects(() => listExchangeListings(fakeDb([]), { templateId: "" }), /valid item template id/);
  await assert.rejects(() => listExchangeListings(fakeDb([]), { templateId: "bad\nid" }), /valid item template id/);
});

test("stats returns totals and the supported flag", async () => {
  const rows = [{ total_listings: "5746", bot_listings: "5742", player_listings: "4", unique_items: "1429" }];
  const result = await exchangeStats(fakeDb(rows), {});
  assert.equal(result.capabilities.exchange, true);
  assert.equal(result.totalListings, 5746);
  assert.equal(result.botListings, 5742);
  assert.equal(result.playerListings, 4);
  assert.equal(result.uniqueItems, 1429);
});

test("internal helpers: coerceIdList validates, dedupes, and caps", () => {
  assert.deepEqual(exchangeInternals.coerceIdList(["75", "75", "abc", "9929"]), ["75", "9929"]);
  assert.throws(() => exchangeInternals.coerceIdList(["abc"], { throwOnInvalid: true }), /Invalid owner id/);
  assert.equal(exchangeInternals.parseTier("T6_Augment_Acuracy1"), 6);
  assert.equal(exchangeInternals.parseTier("PartialStabilizationBelt"), null);
});
