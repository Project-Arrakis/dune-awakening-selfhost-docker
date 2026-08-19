import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBuybackEligibility, refreshBuybackLog } from "../src/addonJobs.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const PLAN = {
  price_multiplier: 1,
  rows: [
    {
      template_id: "KnownItem",
      display_name: "Known Item",
      kind: "resource",
      stack_size: 10,
      price: 100,
      category_mask: 1,
      category_depth: 1,
      quality_level: 0,
      listings: 1
    }
  ]
};

function temporaryRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-market-classify-"));
  mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
  writeFileSync(join(repoRoot, "runtime/data/market-seed-plan.json"), `${JSON.stringify(PLAN)}\n`);
  return repoRoot;
}

test("real PostgreSQL runs Probe followed by Refresh Log across eligible and skipped listings", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_market_classify",
    unavailableLabel: "the Market Bot classification test",
    createFailLabel: "the Market Bot classification test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.actors (
        id bigint primary key,
        class text not null
      );
      create table dune.items (
        id bigint primary key,
        quality_level bigint,
        stack_size bigint
      );
      create table dune.dune_exchange_orders (
        id bigint primary key,
        exchange_id bigint not null,
        owner_id bigint not null,
        template_id text,
        quality_level bigint,
        item_price bigint,
        item_id bigint,
        is_npc_order boolean
      );
      create table dune.dune_exchange_sell_orders (
        order_id bigint primary key,
        initial_stack_size bigint
      );

      insert into dune.actors values (999, 'Revy');
      insert into dune.items values
        (1002, 0, 1),
        (1010, 0, 1),
        (1020, 0, 1);
      insert into dune.dune_exchange_orders values
        (2, 77, 2002, 'KnownItem', 0, 20, 1002, false),
        (10, 77, 2010, 'KnownItem', 0, 200, 1010, false),
        (20, 77, 2020, 'UnknownItem', 0, 5, 1020, false);
      insert into dune.dune_exchange_sell_orders values
        (2, 10),
        (10, 10),
        (20, 10);
    `);

    const repoRoot = temporaryRepo();
    try {
      const db = pgTransactionalDb(pool);
      const settings = {
        exchangeId: "77",
        priceMultiplier: 1,
        buybackPercent: 100,
        buybackPriceBasis: "seeded",
        maxBuys: 10
      };

      const probe = await probeBuybackEligibility({ repoRoot, mockMode: false }, db, settings);
      assert.equal(probe.playerListings, 3);
      assert.equal(probe.eligible, 1);
      assert.equal(probe.aboveThreshold, 1);
      assert.equal(probe.unknownTemplate, 1);

      const refreshed = await refreshBuybackLog({ repoRoot, mockMode: false }, db, settings);
      assert.deepEqual(
        refreshed.entries.map((entry) => [entry.orderId, entry.resultCode]),
        [["2", 0], ["10", 1], ["20", 2]]
      );
      assert.equal(refreshed.batches.length, 1);
      assert.equal(refreshed.batches[0].source, "Dry-run classify");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
