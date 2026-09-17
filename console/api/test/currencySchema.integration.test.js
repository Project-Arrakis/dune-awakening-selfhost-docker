import test from "node:test";
import assert from "node:assert/strict";
import { addCurrency, playerCurrency } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const CURRENT_CURRENCY_SCHEMA = `
  create schema dune;
  create type dune.virtualwallettype as enum ('Solaris', 'HouseCredit');
  create table dune.actors (
    id bigint primary key,
    class text not null,
    owner_account_id bigint
  );
  create table dune.player_state (
    id bigint primary key,
    player_pawn_id bigint not null,
    account_id bigint,
    player_controller_id bigint not null,
    online_status text not null
  );
  create table dune.player_virtual_currency_balances (
    player_controller_id bigint not null,
    currency_id dune.virtualwallettype not null,
    balance bigint not null,
    primary key (player_controller_id, currency_id)
  );
  create function dune.adjust_player_virtual_currency_balance(
    target_player bigint,
    target_currency dune.virtualwallettype,
    balance_delta bigint
  ) returns void language plpgsql as $$
  begin
    insert into dune.player_virtual_currency_balances (player_controller_id, currency_id, balance)
    values (target_player, target_currency, balance_delta)
    on conflict (player_controller_id, currency_id)
    do update set balance = dune.player_virtual_currency_balances.balance + excluded.balance;
  end
  $$;
`;

test("real PostgreSQL: current wallet enum reads and grants both supported currencies", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_currency_enum",
    unavailableLabel: "the currency enum integration test",
    createFailLabel: "the currency enum integration test"
  }, async (pool) => {
    await pool.query(CURRENT_CURRENCY_SCHEMA);
    await pool.query(`
      insert into dune.actors (id, class, owner_account_id)
      values (101, '/Game/Dune/PlayerCharacter', 201);
      insert into dune.player_state (id, player_pawn_id, account_id, player_controller_id, online_status)
      values (401, 101, 201, 301, 'Offline');
      insert into dune.player_virtual_currency_balances (player_controller_id, currency_id, balance)
      values (301, 'Solaris', 5000), (301, 'HouseCredit', 250);
    `);

    const db = pgTransactionalDb(pool);
    const before = await playerCurrency(db, 101);
    assert.deepEqual(before.rows, [
      { currency_id: 0, balance: "5000", label: "Solari Credit" },
      { currency_id: 1, balance: "250", label: "House Credit" }
    ]);

    const granted = await addCurrency(db, 101, { currencyId: 1, amount: 20 });
    assert.equal(granted.currencyId, 1);
    assert.equal(granted.balance.currency_id, "HouseCredit");
    assert.equal(granted.balance.balance, "270");
    assert.match(granted.message, /House Credit/);
  });
});
