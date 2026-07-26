import assert from "node:assert/strict";
import test from "node:test";
import { discordPlayerLink, linkAdditionalAccount, getLinkedPlayer, discordPlayerUnlink } from "../src/duneDb.js";

// FINDING-LINK-6 self-review finding: the single-link flow
// (console.discord_player_links) and the multi-account flow
// (console.discord_account_links) each only enforced "one Discord user per
// character" WITHIN their own table. Before otherTableLinkConflict() was
// added, a character already linked to one Discord user via one flow
// could be silently claimed by a DIFFERENT Discord user via the other
// flow, breaking the invariant both flows' documentation claims to
// enforce ("a character still belongs to exactly one Discord user, never
// shared"). Directly reproduced both directions of this gap before fixing
// it. These tests exercise the real duneDb.js functions (not the provider
// layer) against a single mock db that models BOTH tables together,
// proving the cross-table check now closes both directions.
function createCrossTableDb() {
  const state = { singleLink: null, accounts: [] };
  const player = { player_controller_id: "42", character_name: "Chani", player_pawn_id: "84", online_status: "Online" };
  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      // discordPlayerLink(): own-table conflict check
      if (text.includes("from console.discord_player_links") && text.includes("for update")) {
        const conflict = state.singleLink && state.singleLink.playerControllerId === values[0] && state.singleLink.discordUserId !== values[1];
        return { rows: conflict ? [{ discord_user_id: state.singleLink.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      if (text.includes("insert into console.discord_player_links")) {
        state.singleLink = { discordUserId: values[0], playerControllerId: values[1] };
        return { rows: [], rowCount: 1 };
      }
      // getLinkedPlayer()/discordPlayerUnlink(): plain existence check,
      // no join, no "dpl" alias -- must be checked BEFORE the aliased
      // "dpl" join query below, since this text is a strict subset of it.
      if (text.includes("select 1 from console.discord_player_links where discord_user_id = $1")) {
        const exists = Boolean(state.singleLink && state.singleLink.discordUserId === values[0]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.includes("delete from console.discord_player_links where discord_user_id = $1")) {
        if (state.singleLink && state.singleLink.discordUserId === values[0]) state.singleLink = null;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from console.discord_player_links dpl")) {
        if (!state.singleLink || state.singleLink.discordUserId !== values[0]) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            discord_user_id: state.singleLink.discordUserId,
            player_controller_id: state.singleLink.playerControllerId,
            character_name: player.character_name,
            player_pawn_id: player.player_pawn_id,
            online_status: player.online_status
          }],
          rowCount: 1
        };
      }

      // getLinkedPlayer()'s multi-account fallback: the DEFAULT account
      // only, joined to player_state. MUST be checked BEFORE the
      // listLinkedAccounts matcher below -- both real query strings
      // contain "from console.discord_account_links dal", so matching on
      // that substring alone (as the original listLinkedAccounts matcher
      // did) would silently intercept THIS query too and ignore its
      // "is_default = true" filter entirely, returning every account
      // instead of just the default one. Caught by a real failing test
      // (2026-07-26) before this ordering bug shipped -- confirmed via
      // direct comparison against duneDb.js's actual getLinkedPlayer()
      // query text, not assumed.
      if (text.includes("from console.discord_account_links")
        && text.includes("join dune.player_state")
        && text.includes("is_default = true")) {
        const account = state.accounts.find((a) => a.discordUserId === values[0] && a.isDefault);
        if (!account) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            discord_user_id: account.discordUserId,
            player_controller_id: account.playerControllerId,
            character_name: player.character_name,
            player_pawn_id: player.player_pawn_id,
            online_status: player.online_status
          }],
          rowCount: 1
        };
      }

      // listLinkedAccounts (used internally by linkAdditionalAccount's return)
      if (text.includes("from console.discord_account_links dal")) {
        const rows = state.accounts.filter((a) => a.discordUserId === values[0]).map((a) => ({
          discord_user_id: a.discordUserId,
          player_controller_id: a.playerControllerId,
          is_default: a.isDefault,
          character_name: player.character_name,
          player_pawn_id: player.player_pawn_id,
          online_status: player.online_status
        }));
        return { rows, rowCount: rows.length };
      }

      // discordPlayerUnlink()'s default-account lookup (no join, just the
      // playerControllerId) -- distinct from the joined query above.
      if (text.includes("select player_controller_id from console.discord_account_links")
        && text.includes("is_default = true")) {
        const account = state.accounts.find((a) => a.discordUserId === values[0] && a.isDefault);
        return account ? { rows: [{ player_controller_id: account.playerControllerId }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      // linkAdditionalAccount(): own-table conflict check
      if (text.includes("from console.discord_account_links") && text.includes("for update")) {
        const conflict = state.accounts.find((a) => a.playerControllerId === values[0] && a.discordUserId !== values[1]);
        return { rows: conflict ? [{ discord_user_id: conflict.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      if (text.includes("select 1 from console.discord_account_links") && text.includes("player_controller_id = $2")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.includes("select 1 from console.discord_account_links where discord_user_id = $1 limit 1")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.includes("insert into console.discord_account_links")) {
        state.accounts.push({ discordUserId: values[0], playerControllerId: values[1], isDefault: Boolean(values[2]) });
        return { rows: [], rowCount: 1 };
      }
      // unlinkAdditionalAccount(): existing-row lookup (is_default check)
      if (text.includes("select is_default from console.discord_account_links")) {
        const account = state.accounts.find((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return account ? { rows: [{ is_default: account.isDefault }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("delete from console.discord_account_links")
        && text.includes("player_controller_id = $2")
        && !text.includes("for update")) {
        const before = state.accounts.length;
        state.accounts = state.accounts.filter((a) => !(a.discordUserId === values[0] && a.playerControllerId === values[1]));
        return { rows: [], rowCount: before - state.accounts.length };
      }
      if (text.includes("update console.discord_account_links") && text.includes("set is_default = true")) {
        const remaining = state.accounts.filter((a) => a.discordUserId === values[0]).sort((a, b) => a.linkedAt - b.linkedAt);
        if (remaining.length) remaining[0].isDefault = true;
        return { rows: [], rowCount: remaining.length ? 1 : 0 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

test("a character linked via the single-link flow cannot be claimed by a different Discord user via the multi-account flow", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");
  assert.deepEqual(db.state.singleLink, { discordUserId: "discord-A", playerControllerId: "42" });

  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-B", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.equal(db.state.accounts.length, 0, "the multi-account table must not gain a row for a character already owned elsewhere");
});

test("a character linked via the multi-account flow cannot be claimed by a different Discord user via the single-link flow", async () => {
  const db = createCrossTableDb();
  await linkAdditionalAccount(db, "discord-A", "42");
  assert.equal(db.state.accounts.length, 1);

  await assert.rejects(
    () => discordPlayerLink(db, "discord-B", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.equal(db.state.singleLink, null, "the single-link table must not gain a row for a character already owned elsewhere");
});

test("the SAME Discord user linking the SAME character through both flows is not blocked by the cross-table check", async () => {
  // The cross-table check only rejects a DIFFERENT discordUserId; the same
  // user re-affirming ownership of their own character through the other
  // flow is not the scenario this fix targets and must keep working.
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");
  const accounts = await linkAdditionalAccount(db, "discord-A", "42");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].player_controller_id, "42");
});

test("a different character (no conflict) can still be linked normally through either flow after a cross-table check", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");

  // discord-B links a DIFFERENT character (43) via the multi-account flow —
  // must succeed, since there is no actual conflict for controller 43.
  const accounts = await linkAdditionalAccount(db, "discord-B", "43");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].player_controller_id, "43");
});

// ─── getLinkedPlayer() / discordPlayerUnlink(): cross-table read fix ──────
//
// Real bug (found via a live end-to-end test, 2026-07-26): getLinkedPlayer()
// previously checked ONLY console.discord_player_links. A user linked
// exclusively via console.discord_account_links (every Steam-link via
// FINDING-LINK-7, and every FINDING-LINK-6 multi-account link) was
// therefore ALWAYS reported as "not linked" by whoami/players-me/
// players-inventory/players-storage/players-find/guilds-storage/
// guilds-find -- despite a genuinely successful link. Confirmed live: a
// real Steam-link success wrote a real row into discord_account_links,
// and the very next /dune data inventory call failed with 403 not_linked.

test("getLinkedPlayer returns the single-link table's row when one exists, even if a multi-account row also exists", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");
  db.state.accounts.push({ discordUserId: "discord-A", playerControllerId: "43", isDefault: true });

  const linked = await getLinkedPlayer(db, "discord-A");
  assert.equal(linked.player_controller_id, "42", "single-link table takes precedence, matching the fix's documented order");
});

test("getLinkedPlayer falls back to the multi-account DEFAULT when no single-link row exists (the real bug case)", async () => {
  const db = createCrossTableDb();
  await linkAdditionalAccount(db, "discord-A", "42");

  const linked = await getLinkedPlayer(db, "discord-A");
  assert.ok(linked, "must find the player via the multi-account table's default account");
  assert.equal(linked.player_controller_id, "42");
  assert.equal(linked.discord_user_id, "discord-A");
});

test("getLinkedPlayer returns null for a Discord user with no link in either table", async () => {
  const db = createCrossTableDb();
  const linked = await getLinkedPlayer(db, "discord-nobody");
  assert.equal(linked, null);
});

test("getLinkedPlayer ignores a NON-default multi-account row -- only the default counts", async () => {
  const db = createCrossTableDb();
  db.state.accounts.push({ discordUserId: "discord-A", playerControllerId: "42", isDefault: false });

  const linked = await getLinkedPlayer(db, "discord-A");
  assert.equal(linked, null, "a non-default account must not be treated as the user's linked player");
});

test("discordPlayerUnlink deletes from the single-link table when that's where the player is linked", async () => {
  const db = createCrossTableDb();
  await discordPlayerLink(db, "discord-A", "42");

  const removed = await discordPlayerUnlink(db, "discord-A");
  assert.equal(removed, true);
  assert.equal(db.state.singleLink, null);
});

test("discordPlayerUnlink deletes the DEFAULT multi-account row when no single-link row exists (the real bug case)", async () => {
  const db = createCrossTableDb();
  await linkAdditionalAccount(db, "discord-A", "42");
  assert.equal(db.state.accounts.length, 1);

  const removed = await discordPlayerUnlink(db, "discord-A");
  assert.equal(removed, true, "must report success, and must actually remove the row -- not a silent no-op");
  assert.equal(db.state.accounts.length, 0, "the real multi-account row must actually be deleted, not left intact");
});

test("discordPlayerUnlink promotes the next-oldest account to default after removing the multi-account default (reuses unlinkAdditionalAccount's own behavior)", async () => {
  const db = createCrossTableDb();
  await linkAdditionalAccount(db, "discord-A", "42");
  db.state.accounts[0].linkedAt = 1;
  await linkAdditionalAccount(db, "discord-A", "43");
  db.state.accounts[1].linkedAt = 2;

  await discordPlayerUnlink(db, "discord-A");
  assert.equal(db.state.accounts.length, 1);
  assert.equal(db.state.accounts[0].playerControllerId, "43");
  assert.equal(db.state.accounts[0].isDefault, true, "the remaining account must be promoted to default");
});

test("discordPlayerUnlink returns false for a Discord user with no link in either table (no silent success)", async () => {
  const db = createCrossTableDb();
  const removed = await discordPlayerUnlink(db, "discord-nobody");
  assert.equal(removed, false);
});
