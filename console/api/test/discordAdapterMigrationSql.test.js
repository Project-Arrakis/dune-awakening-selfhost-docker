import assert from "node:assert/strict";
import test from "node:test";
import { migrateDiscordAdapterSchema } from "../src/duneDb.js";

// Core#1095: the stale-link cleanup at the end of migrateDiscordAdapterSchema() used an
// UNQUALIFIED `player_controller_id` inside `exists (select ... from dune.player_state ps ...)`.
// SQL name resolution binds that to ps.player_controller_id (bigint), not the outer link table's
// text column, so Postgres rejected the statement ("operator does not exist: text = bigint") and
// the whole adapter migration, which runs before every players/* and guilds/* route, failed.
// The adapter tests use stub databases, so nothing ever executed this SQL. This test records every
// statement the migration issues so that class of mistake is caught without a live database.

async function recordMigrationStatements() {
  const statements = [];
  const db = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [], rowCount: 0 };
    }
  };
  await migrateDiscordAdapterSchema(db);
  return statements;
}

test("migrateDiscordAdapterSchema issues the two stale-link cleanup statements", async () => {
  const statements = await recordMigrationStatements();
  const cleanups = statements.filter((s) => /from\s+dune\.player_state\s+ps/i.test(s));
  assert.equal(cleanups.length, 2, "expected one cleanup for discord_account_links and one for discord_player_links");
  assert.ok(cleanups.some((s) => /delete from console\.discord_account_links/i.test(s)));
  assert.ok(cleanups.some((s) => /delete from console\.discord_player_links/i.test(s)));
});

test("stale-link cleanups reference the OUTER table through an alias, never an unqualified player_controller_id", async () => {
  const statements = await recordMigrationStatements();
  for (const sql of statements.filter((s) => /from\s+dune\.player_state\s+ps/i.test(s))) {
    const alias = sql.match(/delete from console\.discord_[a-z_]+\s+(\w+)\s+where/i)?.[1];
    assert.ok(alias && alias.toLowerCase() !== "where", `outer table must be aliased: ${sql}`);
    // every comparison against ps.player_controller_id must be to a qualified outer column
    assert.match(sql, new RegExp(`ps\\.player_controller_id::text\\s*=\\s*${alias}\\.player_controller_id`, "i"),
      `the outer column must be qualified as ${alias}.player_controller_id: ${sql}`);
    assert.doesNotMatch(sql, /=\s*player_controller_id\b/i, `unqualified player_controller_id would bind to ps.player_controller_id (bigint): ${sql}`);
  }
});

test("no statement in the adapter migration compares ps.player_controller_id::text to a bare column name", async () => {
  const statements = await recordMigrationStatements();
  for (const sql of statements) {
    assert.doesNotMatch(sql, /::text\s*=\s*player_controller_id\b/i, `unqualified column after ::text = in: ${sql}`);
  }
});
