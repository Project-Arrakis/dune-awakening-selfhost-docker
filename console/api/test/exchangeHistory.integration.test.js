import test from "node:test";
import assert from "node:assert/strict";
import { ensureExchangeHistory, exchangeHistoryInternals, listExchangeTransactions } from "../src/services/exchangeHistory.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const SCHEMA = `
  create schema dune;
  create table dune.actors (
    id bigint primary key,
    owner_account_id bigint,
    class text
  );
  create table dune.player_state (
    account_id bigint primary key,
    character_name text
  );
  create table dune.dune_exchange_orders (
    id bigint primary key,
    exchange_id bigint not null,
    owner_id bigint not null references dune.actors(id),
    template_id text not null,
    item_price bigint not null,
    quality_level bigint not null default 0,
    durability_cur real not null default 1,
    durability_max real not null default 1,
    is_npc_order boolean not null default false
  );
  create table dune.dune_exchange_fulfilled_orders (
    order_id bigint not null references dune.dune_exchange_orders(id) on delete cascade,
    completion_type integer not null,
    stack_size bigint not null check (stack_size > 0),
    source_order_id bigint references dune.dune_exchange_orders(id) on delete set null,
    original_order_id bigint
  );
  insert into dune.actors values (100, 1000, 'Player'), (200, 2000, 'Player');
  insert into dune.player_state values (1000, 'Seller One'), (2000, 'Buyer Two');
  insert into dune.dune_exchange_orders
    (id, exchange_id, owner_id, template_id, item_price, quality_level, durability_cur, durability_max, is_npc_order)
  values
    (10, 77, 100, 'SpiceResidue', 100, 2, 0.75, 1, false),
    (20, 77, 100, 'SpiceResidue', 100, 2, 0.75, 1, false),
    (21, 77, 200, 'WaterBottle', 50, 0, 1, 1, false);
`;

test("real PostgreSQL records inserts and only the positive delta of partial-sale updates", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_exchange_history",
    unavailableLabel: "the Exchange transaction-history test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    const db = pgTransactionalDb(pool);
    exchangeHistoryInternals.resetMigrationState(db);

    const capability = await ensureExchangeHistory(db, { force: true, env: {} });
    assert.deepEqual(capability, { supported: true, retentionDays: 0 });
    await ensureExchangeHistory(db, { force: true, env: {} });
    const triggers = await pool.query(`
      select count(*)::int as count from pg_trigger
      where tgrelid = 'dune.dune_exchange_fulfilled_orders'::regclass
        and tgname = 'console_market_history_capture' and not tgisinternal`);
    assert.equal(triggers.rows[0].count, 1, "reconciliation must remain idempotent");

    await pool.query(`
      insert into dune.dune_exchange_fulfilled_orders
        (order_id, source_order_id, original_order_id, completion_type, stack_size)
      values (20, 10, 10, 4, 3)`);
    await pool.query(`update dune.dune_exchange_fulfilled_orders set stack_size = 8 where order_id = 20`);
    await pool.query(`update dune.dune_exchange_fulfilled_orders set stack_size = 7 where order_id = 20`);

    const captured = await pool.query(`
      select event_kind, stack_size::text, cumulative_stack_size::text,
             owner_id::text, source_owner_id::text, original_owner_id::text
      from console_market_history.transactions
      order by id`);
    assert.deepEqual(captured.rows, [
      { event_kind: "insert", stack_size: "3", cumulative_stack_size: "3", owner_id: "100", source_owner_id: "100", original_owner_id: "100" },
      { event_kind: "update", stack_size: "5", cumulative_stack_size: "8", owner_id: "100", source_owner_id: "100", original_owner_id: "100" }
    ]);

    const result = await listExchangeTransactions(db, {
      hours: 0,
      botOwnerIds: ["100"],
      blacklist: [],
      repoRoot: ""
    });
    assert.equal(result.totalCount, 2);
    assert.ok(result.summary.firstCapturedAt);
    assert.deepEqual({ ...result.summary, firstCapturedAt: null }, {
      events: 2, units: "8", solari: "800",
      playerEvents: 0, botEvents: 2, npcEvents: 0,
      firstCapturedAt: null
    });
    assert.deepEqual(result.rows.map((row) => [row.units, row.partyType, row.ownerName]), [
      ["5", "bot", "Seller One"],
      ["3", "bot", "Seller One"]
    ]);
    const hidden = await listExchangeTransactions(db, { hours: 0, botOwnerIds: [], blacklist: ["100"] });
    assert.equal(hidden.totalCount, 0, "a blacklisted participant must hide the captured event");
  });
});

test("real PostgreSQL recorder failure never rejects the game-owned fulfilled-order insert", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_exchange_history_isolation",
    unavailableLabel: "the Exchange transaction-history isolation test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    const db = pgTransactionalDb(pool);
    exchangeHistoryInternals.resetMigrationState(db);
    await ensureExchangeHistory(db, { force: true, env: {} });

    // Simulate custom-schema damage after the trigger was installed. The
    // recorder emits a warning and returns NEW; it must not roll back gameplay.
    await pool.query(`drop table console_market_history.transactions`);
    await assert.doesNotReject(() => pool.query(`
      insert into dune.dune_exchange_fulfilled_orders
        (order_id, completion_type, stack_size)
      values (21, 9, 1)`));
    const fulfilled = await pool.query(`select count(*)::int as count from dune.dune_exchange_fulfilled_orders`);
    assert.equal(fulfilled.rows[0].count, 1);
  });
});

test("market history retention is opt-in and bounded", () => {
  assert.equal(exchangeHistoryInternals.retentionDays({}), 0);
  assert.equal(exchangeHistoryInternals.retentionDays({ ADMIN_MARKET_HISTORY_RETENTION_DAYS: "180" }), 180);
  assert.equal(exchangeHistoryInternals.retentionDays({ ADMIN_MARKET_HISTORY_RETENTION_DAYS: "6" }), 0);
  assert.equal(exchangeHistoryInternals.retentionDays({ ADMIN_MARKET_HISTORY_RETENTION_DAYS: "-1" }), 0);
  assert.equal(exchangeHistoryInternals.retentionDays({ ADMIN_MARKET_HISTORY_RETENTION_DAYS: "99999" }), 0);
});
