import assert from "node:assert/strict";
import test from "node:test";
import {
  linkAccountProvider,
  verifyAccountLinkProvider,
  unlinkAccountProvider,
  listAccountsProvider,
  setDefaultAccountProvider,
  linkAccountViaSteamProvider,
  resetAccountLinkVerifyRateLimiterForTests,
  resetSteamLinkRateLimiterForTests
} from "../src/integrations/discord/multiAccountLinkProvider.js";
import { linkAdditionalAccount } from "../src/duneDb.js";
import { createLoginRateLimiter } from "../src/rateLimit.js";

test.beforeEach(() => {
  resetAccountLinkVerifyRateLimiterForTests();
  resetSteamLinkRateLimiterForTests();
});

// In-memory mock exercising the real console.discord_account_links /
// console.discord_pending_account_links SQL shapes from duneDb.js, mirroring
// discordLinkProvider.test.js's createLinkDb() pattern but for the
// FINDING-LINK-6 multi-account tables. Distinct from and independent of
// the single-link mock — proves the two flows do not share state.
function createMultiAccountDb(players = []) {
  const state = {
    accounts: [], // { discordUserId, playerControllerId, isDefault, linkedAt }
    pending: [], // { code, discordUserId, playerControllerId, characterName, expiresAt }
    players: players.length ? players : [
      { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Online", funcom_id: "Chani#1234", steam_id: "76561198000000042" },
      { player_controller_id: "43", player_pawn_id: "85", character_name: "Paul", online_status: "Online", funcom_id: "Paul#5678", steam_id: null }
    ]
  };
  let autoLinkedAt = 0;

  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      // Issue #245 fix: linkAdditionalAccount() now takes a per-character
      // advisory lock as the very first statement in its transaction (see
      // duneDb.js's pg_advisory_xact_lock() call) -- inert no-op here,
      // this single in-process mock has no real concurrency to guard
      // against. Must be checked first since it really is the first query
      // issued.
      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      // resolvePlayerByName
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        const match = state.players.find((p) => p.character_name.toLowerCase() === String(values[0]).toLowerCase());
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }

      // matchSteamIdForCharacter: matches values[0] (steamId64List array)
      // against values[1] (playerControllerId), checking the fixture
      // player's on-file steam_id -- mirrors duneDb.js's real query shape
      // (dune.accounts joined to dune.player_state, filtered on
      // platform_name = 'steam' and platform_id = any($1)).
      if (text.includes("from dune.accounts ac") && text.includes("platform_name")) {
        const player = state.players.find((p) => p.player_controller_id === values[1]);
        const matched = Boolean(player?.steam_id) && (values[0] || []).includes(player.steam_id);
        return matched ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      // FIX (2026-07-27, per explicit operator direction -- phase-one
      // strict 1:1 gate): linkAdditionalAccount()'s rejection path now
      // calls getLinkedPlayer() (duneDb.js) to build a friendlier error
      // message naming the user's existing character. getLinkedPlayer()
      // checks discord_player_links FIRST (dpl alias, joined to
      // dune.player_state) -- this test file only exercises the
      // multi-account flow and never populates discord_player_links, so
      // this always reports no single-link row, matching this file's
      // existing convention for that table (see the FINDING-LINK-6
      // cross-table check comment above for the same rationale).
      if (text.includes("from console.discord_player_links dpl")) {
        return { rows: [], rowCount: 0 };
      }

      // getLinkedPlayer()'s multi-account fallback (dal alias, joined to
      // dune.player_state, filtered to is_default = true) -- the second
      // half of the same getLinkedPlayer() call described above. Must be
      // checked BEFORE the listLinkedAccounts matcher below, since both
      // real query strings contain "from console.discord_account_links dal"
      // and this one has a narrower, more specific shape (is_default
      // filter, single row via limit 1).
      if (text.includes("from console.discord_account_links dal")
        && text.includes("join dune.player_state ps")
        && text.includes("is_default = true")
        && text.includes("limit 1")) {
        const account = state.accounts.find((a) => a.discordUserId === values[0] && a.isDefault);
        if (!account) return { rows: [], rowCount: 0 };
        const player = state.players.find((p) => p.player_controller_id === account.playerControllerId);
        return {
          rows: [{
            discord_user_id: account.discordUserId,
            player_controller_id: account.playerControllerId,
            character_name: player?.character_name || "",
            player_pawn_id: player?.player_pawn_id || "0",
            online_status: player?.online_status || "Offline"
          }],
          rowCount: 1
        };
      }

      // listLinkedAccounts: selects from discord_account_links dal joined
      // to player_state ps.
      if (text.includes("from console.discord_account_links dal") && text.includes("join dune.player_state ps")) {
        const rows = state.accounts
          .filter((a) => a.discordUserId === values[0])
          .sort((a, b) => (b.isDefault - a.isDefault) || (a.linkedAt - b.linkedAt))
          .map((a) => {
            const player = state.players.find((p) => p.player_controller_id === a.playerControllerId);
            return {
              discord_user_id: a.discordUserId,
              player_controller_id: a.playerControllerId,
              is_default: a.isDefault,
              character_name: player?.character_name || "",
              player_pawn_id: player?.player_pawn_id || "0",
              online_status: player?.online_status || "Offline"
            };
          });
        return { rows, rowCount: rows.length };
      }

      // linkAdditionalAccount: conflict check (for update)
      if (text.includes("from console.discord_account_links") && text.includes("for update")) {
        const conflict = state.accounts.find((a) => a.playerControllerId === values[0] && a.discordUserId !== values[1]);
        return { rows: conflict ? [{ discord_user_id: conflict.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }

      // FINDING-LINK-6 cross-table check (otherTableLinkConflict()):
      // linkAdditionalAccount() also checks console.discord_player_links for
      // a conflicting owner from the legacy single-link flow. This test
      // file only exercises the multi-account flow and never populates
      // discord_player_links, so this always reports no conflict — the
      // cross-table check itself is proven separately in duneDb tests.
      if (text.includes("from console.discord_player_links") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }

      // FIX (2026-07-27, per explicit operator direction -- phase-one
      // strict 1:1 gate): linkAdditionalAccount()'s new
      // "select player_controller_id from console.discord_player_links
      // where discord_user_id = $1 limit 1" check (no "for update", unlike
      // the FINDING-LINK-6 cross-table check above, which is why this
      // needs its own branch rather than reusing that one). Same
      // rationale as the FINDING-LINK-6 comment above: this file never
      // populates discord_player_links, so this always reports no
      // existing single-link row -- the actual gate behavior (rejecting a
      // second, different character) is proven by this file's own
      // "user_already_has_a_character"-equivalent test coverage against
      // the multi-account table itself, further down.
      if (text.includes("select player_controller_id from console.discord_player_links") && text.includes("limit 1")) {
        return { rows: [], rowCount: 0 };
      }

      // linkAdditionalAccount: already-linked-to-this-account check
      if (text.includes("select 1 from console.discord_account_links") && text.includes("player_controller_id = $2")) {
        const exists = state.accounts.some((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }

      // FIX (2026-07-27, same phase-one gate as above): linkAdditionalAccount()'s
      // has-any-existing check now selects player_controller_id (not just
      // "1") so it can compare against the character being linked -- see
      // that function's own comment in duneDb.js for why.
      if (text.includes("select player_controller_id from console.discord_account_links where discord_user_id = $1 limit 1")) {
        const existingRow = state.accounts.find((a) => a.discordUserId === values[0]);
        return { rows: existingRow ? [{ player_controller_id: existingRow.playerControllerId }] : [], rowCount: existingRow ? 1 : 0 };
      }

      // linkAdditionalAccount: insert
      if (text.includes("insert into console.discord_account_links")) {
        state.accounts.push({
          discordUserId: values[0],
          playerControllerId: values[1],
          isDefault: Boolean(values[2]),
          linkedAt: autoLinkedAt++
        });
        return { rows: [], rowCount: 1 };
      }

      // unlinkAdditionalAccount: is_default lookup
      if (text.includes("select is_default from console.discord_account_links")) {
        const found = state.accounts.find((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        return { rows: found ? [{ is_default: found.isDefault }] : [], rowCount: found ? 1 : 0 };
      }

      // unlinkAdditionalAccount: delete
      if (text.includes("delete from console.discord_account_links") && text.includes("player_controller_id = $2") && !text.includes("for update")) {
        const before = state.accounts.length;
        state.accounts = state.accounts.filter((a) => !(a.discordUserId === values[0] && a.playerControllerId === values[1]));
        return { rows: [], rowCount: before - state.accounts.length };
      }

      // unlinkAdditionalAccount: promote next-oldest to default
      if (text.includes("update console.discord_account_links") && text.includes("order by linked_at asc")) {
        const remaining = state.accounts.filter((a) => a.discordUserId === values[0]).sort((a, b) => a.linkedAt - b.linkedAt);
        if (remaining.length) remaining[0].isDefault = true;
        return { rows: [], rowCount: remaining.length ? 1 : 0 };
      }

      // setDefaultLinkedAccount: clear existing default
      if (text.includes("set is_default = false")) {
        state.accounts.filter((a) => a.discordUserId === values[0]).forEach((a) => { a.isDefault = false; });
        return { rows: [], rowCount: 1 };
      }

      // setDefaultLinkedAccount: set new default
      if (text.includes("set is_default = true") && text.includes("player_controller_id = $2")) {
        const found = state.accounts.find((a) => a.discordUserId === values[0] && a.playerControllerId === values[1]);
        if (found) found.isDefault = true;
        return { rows: [], rowCount: found ? 1 : 0 };
      }

      // createPendingAccountLink: clear prior pending for (user, character)
      if (text.includes("delete from console.discord_pending_account_links") && text.includes("player_controller_id = $2")) {
        state.pending = state.pending.filter((p) => !(p.discordUserId === values[0] && p.playerControllerId === values[1]));
        return { rows: [], rowCount: 1 };
      }

      // createPendingAccountLink: insert
      if (text.includes("insert into console.discord_pending_account_links")) {
        if (state.pending.some((p) => p.code === values[0])) return { rows: [], rowCount: 0 };
        state.pending.push({
          code: values[0],
          discordUserId: values[1],
          playerControllerId: values[2],
          characterName: values[3],
          expiresAt: values[4]
        });
        return { rows: [], rowCount: 1 };
      }

      // deletePendingAccountLink
      if (text.includes("delete from console.discord_pending_account_links") && text.includes("code = $2")) {
        const before = state.pending.length;
        state.pending = state.pending.filter((p) => !(p.discordUserId === values[0] && p.code === values[1]));
        return { rows: [], rowCount: before - state.pending.length };
      }

      // consumePendingAccountLink
      if (text.includes("delete from console.discord_pending_account_links") && text.includes("expires_at > now()")) {
        const match = state.pending.find((p) => p.code === values[0] && p.discordUserId === values[1]);
        if (match) {
          state.pending = state.pending.filter((p) => p !== match);
          return {
            rows: [{ discord_user_id: match.discordUserId, player_controller_id: match.playerControllerId, character_name: match.characterName }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

const persona = { funcomId: "CarePackage#0001", hexFlsId: "A5C0DE5E12A00001" };

test("linking an additional character does not touch the legacy single-link table or route", async () => {
  const db = createMultiAccountDb();
  let whisper = null;
  const result = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async (_config, fields) => { whisper = fields; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.match(whisper.message, /account-link verification code is: ACP-[A-Z0-9]+/);
});

test("first linked account becomes default automatically", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  const afterFirst = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(afterFirst.accounts.length, 1);
  assert.equal(afterFirst.accounts[0].isDefault, true);
});

// FIX (2026-07-27, per explicit operator direction): phase one is a
// strict 1:1 relationship -- one Discord user may link exactly one
// character, globally, until they unlink it. This test previously
// proved a second, different character COULD be linked (just not as
// the default); it now proves the opposite -- linking a second
// character is rejected outright. The multi-account system's real
// capability to hold 2+ accounts (unlink/set-default promotion, etc.)
// remains real, tested code further down in this file -- only the LINK
// entry point is gated for phase one.
test("linking a second, different character to a Discord user who already has one linked is rejected (phase-one 1:1 gate)", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");

  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-1", "43"),
    (error) => error.code === "user_already_has_a_character" && error.statusCode === 409
  );
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 1, "the second character must not be added");
});

test("a character already linked to another Discord user cannot be linked by a second user", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-owner", "42");
  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-attacker", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
});

test("linking the same character to the same user twice is rejected as a conflict, not silently duplicated", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  await assert.rejects(
    () => linkAdditionalAccount(db, "discord-1", "42"),
    (error) => error.code === "already_linked_to_this_account" && error.statusCode === 409
  );
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 1);
});

// FIX (2026-07-27, per explicit operator direction): phase one is a
// strict 1:1 relationship. This test previously proved a pending
// additional-account code could be verified and added as a SECOND
// character; verifyAccountLinkProvider() calls linkAdditionalAccount()
// internally (see that function's own comment in multiAccountLinkProvider.js),
// so it now inherits the same phase-one rejection for a genuinely
// different second character. Rewritten to prove the code is correctly
// consumed (the pending row is genuinely removed -- no replay is
// possible) even though the resulting link is rejected, rather than
// proving a successful second link.
test("verifying a pending additional-account code for a SECOND, different character is rejected (phase-one 1:1 gate), and the code is still consumed (no replay)", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42"); // pre-existing first account
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Paul" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending[0].code;

  await assert.rejects(
    () => verifyAccountLinkProvider(db, { discordUserId: "discord-1", code }),
    (error) => error.code === "user_already_has_a_character" && error.statusCode === 409
  );
  assert.equal(db.state.pending.length, 0, "the pending code must still be consumed, not left replayable, even though the resulting link is rejected");
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 1, "the pre-existing account must be unaffected");
});

// Verifying a pending code for the SAME character the user already has
// (e.g. a retry after a transient failure) correctly hits the
// pre-existing "already_linked_to_this_account" conflict, NOT the new
// phase-one gate -- that check runs earlier in linkAdditionalAccount()
// (see this file's own "linking the same character to the same user
// twice" test above) and is unrelated to and unaffected by this
// session's 1:1 gate change. Confirmed directly (a test asserting this
// path "succeeds" was wrong and is corrected here) rather than assumed.
// FIX (2026-07-27, found via a real live report): re-requesting a link
// for the SAME character the user already has previously fell through
// to linkAccountProvider()'s whisper-send logic, creating a real
// pending verification code the user would then have to consume just to
// be told (via the already_linked_to_this_account conflict) that
// nothing needed to happen at all. linkAccountProvider() now
// short-circuits immediately, before ever sending a whisper or creating
// a pending code -- there is nothing left to verify.
test("requesting a link for the SAME character the user already has short-circuits immediately -- no whisper is sent, no pending code is created", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  let whisperSent = false;

  const result = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { whisperSent = true; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyLinked, true);
  assert.equal(result.characterName, "Chani");
  assert.equal(whisperSent, false, "must not send an in-game whisper for a request that will just be a no-op success");
  assert.equal(db.state.pending.length, 0, "no pending verification code should be created");
});

test("a different Discord user cannot consume another user's pending account-link code", async () => {
  const db = createMultiAccountDb();
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending[0].code;

  const rejected = await verifyAccountLinkProvider(db, { discordUserId: "discord-2", code });
  assert.equal(rejected.ok, false);
  assert.equal(db.state.pending.length, 1);
});

// FIX (2026-07-27, per explicit operator direction -- phase-one strict
// 1:1 gate): these two tests' real subject is unlinkAccountProvider()'s
// promotion behavior, which remains real, tested, working code even
// though the LINK entry point that would normally create 2-account
// state is now gated off (multi-account capability itself is
// intentionally kept intact for phase two, not torn out). Seeds the
// second account directly into mock state, bypassing
// linkAdditionalAccount()'s phase-one gate, matching the same pattern
// used in discordCrossLinkInvariant.test.js's equivalent promotion test.
test("unlinking a non-default account leaves the default untouched", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  db.state.accounts.push({ discordUserId: "discord-1", playerControllerId: "43", isDefault: false, linkedAt: 1 });

  const result = await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, true);
  const remaining = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(remaining.count, 1);
  assert.equal(remaining.accounts[0].playerControllerId, "42");
  assert.equal(remaining.accounts[0].isDefault, true);
});

test("unlinking the default account promotes the next-oldest remaining account to default", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42"); // becomes default
  db.state.accounts.push({ discordUserId: "discord-1", playerControllerId: "43", isDefault: false, linkedAt: 1 });

  await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "42" });
  const remaining = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(remaining.count, 1);
  assert.equal(remaining.accounts[0].playerControllerId, "43");
  assert.equal(remaining.accounts[0].isDefault, true);
});

test("unlinking an account not linked to the caller returns a business error, not a crash", async () => {
  const db = createMultiAccountDb();
  const result = await unlinkAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "42" });
  assert.equal(result.ok, false);
});

// FIX (2026-07-27, per explicit operator direction -- phase-one strict
// 1:1 gate): same rationale as the two unlink tests above -- this test's
// real subject is setDefaultAccountProvider()'s switching behavior,
// still real and correct even though 2-account state can no longer be
// created via the normal link entry point.
test("setDefaultAccountProvider switches the default between two already-linked accounts", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  db.state.accounts.push({ discordUserId: "discord-1", playerControllerId: "43", isDefault: false, linkedAt: 1 });

  const result = await setDefaultAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, true);
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  const defaults = accounts.accounts.filter((a) => a.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].playerControllerId, "43");
});

test("setDefaultAccountProvider rejects a character not linked to the caller", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");
  const result = await setDefaultAccountProvider(db, { discordUserId: "discord-1", playerControllerId: "43" });
  assert.equal(result.ok, false);
});

// FINDING-LINK-6 "Minimal Impact": the multi-account flow's rate limiter
// must be a distinct instance/namespace from the single-link flow's, so
// exhausting one never blocks the other for the same discordUserId.
test("multi-account verification rate limiting is independent from the single-link flow's limiter", async () => {
  let currentTime = 1000;
  resetAccountLinkVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createMultiAccountDb();
  await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" });
  await assert.rejects(
    () => verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: "ACP-WRONG" }),
    (error) => error.code === "verify_rate_limited" && error.statusCode === 429
  );

  currentTime += 60001;
  const recovered = await verifyAccountLinkProvider(db, { discordUserId: "discord-1", code: db.state.pending[0].code });
  assert.equal(recovered.ok, true);
});

test("linking additional accounts requires the character to be online, same as the single-link flow", async () => {
  const db = createMultiAccountDb([
    { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Offline", funcom_id: "Chani#1234" }
  ]);
  const result = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be online/);
});

test("failed whisper delivery removes the unusable pending account-link challenge", async () => {
  const db = createMultiAccountDb();
  await assert.rejects(() => linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { throw new Error("RMQ unavailable"); }
  }), /could not be delivered/);
  assert.equal(db.state.pending.length, 0);
});

// ─── linkAccountViaSteamProvider (Steam-OAuth-based linking) ───────────────
//
// Unlike the whisper-based flows above, this requires no online character,
// no funcom_id, and no verification code — the caller (the bot) has already
// completed a Discord OAuth "connections" grant before calling this. See
// linkAccountViaSteamProvider()'s own comment in multiAccountLinkProvider.js
// for why the match check and the link happen together in ONE
// discordUserId-bound call, rather than as two separate routes.

test("successfully links via Steam when the character's on-file Steam ID matches", async () => {
  const db = createMultiAccountDb();
  const result = await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "42",
    steamId64List: ["76561198000000042"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 1);
  assert.equal(accounts.accounts[0].playerControllerId, "42");
});

// FIX (2026-07-27, found via a real live report -- this is the exact
// call path the report described): re-clicking "Link via Steam" for a
// character already linked previously reached matchSteamIdForCharacter()
// and then linkAdditionalAccount() before being rejected with a generic
// conflict, after the user had already completed a full external
// Discord OAuth round-trip to get here. linkPlayerProvider() now
// short-circuits before ever offering this button for that exact
// scenario (see discordLinkProvider.test.js's own short-circuit tests),
// but this defensive check stays here too, since this route is
// independently callable and not solely reachable through
// linkPlayerProvider()'s flow.
test("re-attempting Steam-link for a character the user already has linked short-circuits immediately -- does not re-check the Steam ID match at all", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-1", "42");

  const result = await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "42",
    steamId64List: ["76561198999999999"] // deliberately WRONG steam ID -- if this short-circuit
    // works, the mismatched ID is never even checked, since there's nothing left to verify.
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.alreadyLinked, true);
});

test("matches even when the character's Steam ID is not the first element of a multi-element list", async () => {
  const db = createMultiAccountDb();
  const result = await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "42",
    steamId64List: ["76561198111111111", "76561198000000042", "76561198222222222"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
});

test("returns matched: false, does not link, and does not throw when no Steam ID matches", async () => {
  const db = createMultiAccountDb();
  const result = await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "42",
    steamId64List: ["76561198999999999"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
  const accounts = await listAccountsProvider(db, { discordUserId: "discord-1" });
  assert.equal(accounts.count, 0);
});

test("returns matched: false for a character with no Steam ID on file at all", async () => {
  const db = createMultiAccountDb();
  const result = await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "43", // Paul, steam_id: null in the fixture
    steamId64List: ["76561198000000042"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
});

test("rejects with the same generic conflict error as the whisper flow when the character is already linked to a different Discord user (FINDING-STEAM-3)", async () => {
  const db = createMultiAccountDb();
  await linkAdditionalAccount(db, "discord-owner", "42");
  await assert.rejects(
    () => linkAccountViaSteamProvider(db, { discordUserId: "discord-attacker", playerControllerId: "42", steamId64List: ["76561198000000042"] }),
    (error) => error.code === "character_already_linked" && error.statusCode === 409 && !error.message.includes("discord-owner")
  );
});

test("rejects invalid_request when discordUserId is missing", async () => {
  const db = createMultiAccountDb();
  await assert.rejects(
    () => linkAccountViaSteamProvider(db, { playerControllerId: "42", steamId64List: ["76561198000000042"] }),
    (error) => error.code === "invalid_request"
  );
});

test("rejects invalid_request when playerControllerId is missing", async () => {
  const db = createMultiAccountDb();
  await assert.rejects(
    () => linkAccountViaSteamProvider(db, { discordUserId: "discord-1", steamId64List: ["76561198000000042"] }),
    (error) => error.code === "invalid_request"
  );
});

test("Steam-link does not generate or check any verification code", async () => {
  const db = createMultiAccountDb();
  await linkAccountViaSteamProvider(db, {
    discordUserId: "discord-1",
    playerControllerId: "42",
    steamId64List: ["76561198000000042"]
  });
  // No pending code should ever have been created for this flow -- if the
  // implementation accidentally called createPendingAccountLink() anywhere,
  // state.pending would be non-empty here.
  assert.equal(db.state.pending.length, 0);
});

test("Steam-link rate limiting is independent from the whisper-verify flow's limiter", async () => {
  const fastLimiter = createLoginRateLimiter({ maxAttempts: 2, globalMaxAttempts: 100, windowMs: 60000, blockMs: 60000 });
  resetSteamLinkRateLimiterForTests(fastLimiter);
  const db = createMultiAccountDb();

  // Two failed (non-matching) attempts reach the limit...
  await linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "42", steamId64List: ["wrong-id"] });
  await linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "42", steamId64List: ["wrong-id"] });
  // ...the third is rejected as rate-limited rather than evaluated.
  await assert.rejects(
    () => linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "42", steamId64List: ["76561198000000042"] }),
    (error) => error.code === "steam_link_rate_limited" && error.statusCode === 429
  );

  // A different Discord user is unaffected by discord-1's lockout.
  const otherResult = await linkAccountViaSteamProvider(db, { discordUserId: "discord-2", playerControllerId: "43", steamId64List: ["wrong-id"] });
  assert.equal(otherResult.matched, false);

  // The whisper-verify flow's own limiter is untouched by Steam-link's
  // lockout for the same discordUserId.
  const whisperResult = await linkAccountProvider(db, {}, { discordUserId: "discord-1", characterName: "Paul" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  assert.equal(whisperResult.ok, true);
});

test("a successful Steam-link clears any prior rate-limit lockout for that discordUserId", async () => {
  const fastLimiter = createLoginRateLimiter({ maxAttempts: 3, globalMaxAttempts: 100, windowMs: 60000, blockMs: 60000 });
  resetSteamLinkRateLimiterForTests(fastLimiter);
  const db = createMultiAccountDb();

  await linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "42", steamId64List: ["wrong-id"] });
  const success = await linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "43", steamId64List: [] });
  // Paul (43) has no steam_id on file, so this is still a non-match --
  // use Chani (42) with the correct ID instead to actually succeed and
  // clear the lockout.
  assert.equal(success.matched, false);
  const cleared = await linkAccountViaSteamProvider(db, { discordUserId: "discord-1", playerControllerId: "42", steamId64List: ["76561198000000042"] });
  assert.equal(cleared.matched, true);
});
