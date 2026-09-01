import assert from "node:assert/strict";
import test from "node:test";
import { linkPlayerProvider, verifyPlayerLinkProvider, resetVerifyRateLimiterForTests } from "../src/integrations/discord/linkProvider.js";
import { discordPlayerLink } from "../src/duneDb.js";
import { createLoginRateLimiter } from "../src/rateLimit.js";

test.beforeEach(() => {
  resetVerifyRateLimiterForTests();
});

// secondPlayer: a distinct fixture character, added 2026-07-27 alongside
// the phase-one 1:1 gate, so a test can exercise "Discord user already
// linked to Chani attempts to link a DIFFERENT character" -- every
// pre-existing test in this file only ever needs the single default
// fixture (Chani), so resolvePlayerByName()'s mock below still resolves
// to state.player by default and only switches to secondPlayer when the
// search name actually matches it, preserving every existing test's
// behavior unchanged.
const secondPlayer = {
  player_controller_id: "43",
  player_pawn_id: "85",
  character_name: "Paul",
  online_status: "Online",
  funcom_id: "Paul#5678",
  fls_id: "A5C0DE5E12A00043",
  hasSteam: false
};

function createLinkDb(playerOverrides = {}) {
  const state = {
    pending: null,
    link: null,
    player: {
      player_controller_id: "42",
      player_pawn_id: "84",
      character_name: "Chani",
      online_status: "Online",
      funcom_id: "Chani#1234",
      fls_id: "A5C0DE5E12A00042",
      // hasSteam: false by default -- this test file exercises the
      // whisper-only flow exclusively and never populates a Steam ID for
      // any fixture character. Set hasSteam: true via playerOverrides to
      // exercise the Steam-linked short-circuit in linkPlayerProvider().
      hasSteam: false,
      ...playerOverrides
    }
  };
  const db = {
    state,
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      // Issue #245 fix: discordPlayerLink() now takes a per-character
      // advisory lock as the very first statement in its transaction (see
      // duneDb.js's pg_advisory_xact_lock() call) -- inert no-op here,
      // this single in-process mock has no real concurrency to guard
      // against. Must be checked first since it really is the first query
      // issued.
      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        const searchName = String(values[0] || "").toLowerCase();
        if (searchName === secondPlayer.character_name.toLowerCase()) {
          return { rows: [secondPlayer], rowCount: 1 };
        }
        return { rows: [state.player], rowCount: 1 };
      }
      // characterHasSteamId() -- queries dune.accounts joined to
      // dune.player_state, filtering on platform_name = 'steam' and a
      // non-empty platform_id.
      if (text.includes("from dune.accounts ac") && text.includes("platform_name")) {
        return state.player.hasSteam
          ? { rows: [{ "?column?": 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("discord_user_id = $1 and code = $2")) {
        const matches = state.pending?.discordUserId === values[0] && state.pending?.code === values[1];
        if (matches) state.pending = null;
        return { rows: [], rowCount: matches ? 1 : 0 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("expires_at > now()")) {
        const matches = state.pending?.code === values[0] && state.pending?.discordUserId === values[1];
        const row = matches ? {
          discord_user_id: state.pending.discordUserId,
          player_controller_id: state.pending.playerControllerId,
          character_name: state.pending.characterName
        } : null;
        if (matches) state.pending = null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("delete from console.discord_pending_links") && text.includes("discord_user_id = $1")) {
        if (state.pending?.discordUserId === values[0]) state.pending = null;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("insert into console.discord_pending_links")) {
        state.pending = {
          code: values[0],
          discordUserId: values[1],
          playerControllerId: values[2],
          characterName: values[3]
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from console.discord_player_links") && text.includes("for update")) {
        const conflict = state.link && state.link.playerControllerId === values[0] && state.link.discordUserId !== values[1];
        return { rows: conflict ? [{ discord_user_id: state.link.discordUserId }] : [], rowCount: conflict ? 1 : 0 };
      }
      // FINDING-LINK-6 cross-table check (otherTableLinkConflict()):
      // discordPlayerLink() also checks console.discord_account_links for a
      // conflicting owner. This test file only exercises the single-link
      // flow and never populates discord_account_links, so this always
      // reports no conflict.
      if (text.includes("from console.discord_account_links") && text.includes("for update")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("insert into console.discord_player_links")) {
        state.link = { discordUserId: values[0], playerControllerId: values[1] };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("from console.discord_player_links dpl")) {
        if (!state.link || state.link.discordUserId !== values[0]) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            discord_user_id: state.link.discordUserId,
            player_controller_id: state.link.playerControllerId,
            character_name: state.player.character_name,
            player_pawn_id: state.player.player_pawn_id,
            online_status: state.player.online_status
          }],
          rowCount: 1
        };
      }
      // FIX (2026-07-27, per explicit operator direction -- phase-one
      // strict 1:1 gate): linkPlayerProvider() now calls getLinkedPlayer()
      // (duneDb.js) at the top of the function to check for an existing
      // link before proceeding. getLinkedPlayer() checks
      // discord_player_links FIRST (the "dpl" branch immediately above,
      // already correct and unchanged), then falls back to this
      // multi-account query (dal alias, is_default = true) if no
      // single-link row exists. This test file only exercises the
      // single-link flow and never populates discord_account_links, so
      // this always reports no multi-account row -- the phase-one gate's
      // actual multi-account-side behavior is proven separately in
      // discordCrossLinkInvariant.test.js and
      // discordMultiAccountLinkProvider.test.js.
      if (text.includes("from console.discord_account_links dal") && text.includes("is_default = true")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  };
  return db;
}

const persona = { funcomId: "CarePackage#0001", hexFlsId: "A5C0DE5E12A00001" };

test("link challenge is delivered only in game and is not exposed by the API", async () => {
  const db = createLinkDb();
  let whisper = null;
  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async (_config, fields) => { whisper = fields; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal("code" in result, false);
  assert.doesNotMatch(result.message, /MENTAT-[A-Z0-9]+/);
  assert.match(whisper.message, /Discord verification code is: MENTAT-[A-Z0-9]+/);
  assert.equal(whisper.recipientFuncomId, "Chani#1234");
});

test("a different Discord user cannot consume another user's challenge", async () => {
  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending.code;

  const rejected = await verifyPlayerLinkProvider(db, { discordUserId: "discord-2", code });
  assert.equal(rejected.ok, false);
  assert.equal(db.state.pending.code, code);

  const accepted = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code });
  assert.equal(accepted.ok, true);
  assert.equal(db.state.pending, null);
  assert.deepEqual(db.state.link, { discordUserId: "discord-1", playerControllerId: "42" });
});

// FINDING-LINK-3 (docs/security/discord-player-link-hardening.md): repeated
// wrong-code guesses against one discordUserId must be throttled and
// eventually locked out, rather than allowed indefinitely.
test("repeated wrong-code verification attempts for one discordUserId are rate limited", async () => {
  let currentTime = 1000;
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 3,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  // Three wrong guesses consume the allowance...
  for (let i = 0; i < 3; i += 1) {
    const attempt = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "MENTAT-WRONG" });
    assert.equal(attempt.ok, false);
  }

  // ...and the fourth is rejected before it ever reaches the database,
  // even though the real pending code is still valid and unexpired.
  const realCode = db.state.pending.code;
  await assert.rejects(
    () => verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: realCode }),
    (error) => error.code === "verify_rate_limited" && error.statusCode === 429
  );
  assert.ok(db.state.pending, "the real pending link must survive a rate-limited attempt, not be consumed");

  // After the block window elapses, a correct guess succeeds again.
  currentTime += 60001;
  const recovered = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: realCode });
  assert.equal(recovered.ok, true);
});

test("rate limiting is scoped per discordUserId — one user's lockout does not block another", async () => {
  let currentTime = 1000;
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000,
    now: () => currentTime
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });

  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "MENTAT-WRONG" });
  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "MENTAT-WRONG" });
  await assert.rejects(
    () => verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "MENTAT-WRONG" }),
    (error) => error.code === "verify_rate_limited"
  );

  // A different discordUserId with no pending link of their own is still
  // allowed to attempt verification (and correctly gets a normal
  // "invalid or expired" business result, not a 429).
  const other = await verifyPlayerLinkProvider(db, { discordUserId: "discord-2", code: "MENTAT-WRONG" });
  assert.equal(other.ok, false);
  assert.match(other.error, /Invalid or expired/i);
});

test("a successful verification clears the rate-limit lockout for that discordUserId", async () => {
  resetVerifyRateLimiterForTests(createLoginRateLimiter({
    maxAttempts: 2,
    globalMaxAttempts: 99,
    windowMs: 60000,
    blockMs: 60000
  }));

  const db = createLinkDb();
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
  const code = db.state.pending.code;

  await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: "MENTAT-WRONG" });
  const accepted = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code });
  assert.equal(accepted.ok, true);

  // Re-link and verify again immediately — the earlier successful
  // verification should have reset this discordUserId's failure count,
  // not left it one attempt away from lockout.
  await unlinkAndRelink(db);
  const secondCode = db.state.pending.code;
  const secondAttempt = await verifyPlayerLinkProvider(db, { discordUserId: "discord-1", code: secondCode });
  assert.equal(secondAttempt.ok, true);
});

async function unlinkAndRelink(db) {
  db.state.link = null;
  db.state.pending = null;
  await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => {}
  });
}

test("failed whisper delivery removes the unusable pending challenge", async () => {
  const db = createLinkDb();
  await assert.rejects(() => linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { throw new Error("RMQ unavailable"); }
  }), /could not be delivered/);
  assert.equal(db.state.pending, null);
});

test("offline characters cannot start ownership verification", async () => {
  const db = createLinkDb({ online_status: "Offline" });
  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be online/);
  assert.equal(db.state.pending, null);
});

test("linking never removes a character's existing Discord owner", async () => {
  const db = createLinkDb();
  db.state.link = { discordUserId: "discord-owner", playerControllerId: "42" };
  await assert.rejects(
    () => discordPlayerLink(db, "discord-attacker", "42"),
    (error) => error.code === "character_already_linked" && error.statusCode === 409
  );
  assert.deepEqual(db.state.link, { discordUserId: "discord-owner", playerControllerId: "42" });
});

// FIX (2026-07-27, per explicit operator direction): phase one is a
// strict 1:1 relationship -- one Discord user may link exactly one
// character, globally, until they unlink it. /dune player link
// (linkPlayerProvider(), the real whisper-flow entry point every player
// actually uses) must reject a second, different character with a
// clear, in-lore error rather than silently overwriting the existing
// link (the legacy single-link table's prior "on conflict ... do
// update" behavior).
test("linking a second, different character via /dune player link is rejected when the Discord user already has one linked (phase-one 1:1 gate)", async () => {
  const db = createLinkDb();
  db.state.link = { discordUserId: "discord-1", playerControllerId: "42" };

  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Paul" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { throw new Error("must not attempt to send a whisper for a rejected link"); }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Chani/, "the error should name the character the user is already linked to");
  assert.match(result.error, /Landsraad/i, "the error should use the requested in-lore phrasing");
  assert.equal(db.state.pending, null, "no pending verification code should be created for a rejected link");
});

// FIX (2026-07-27, found via a real live report): re-running /dune
// player link for the SAME already-linked character previously fell
// through all the way to the whisper/Steam-link logic, sending a real
// in-game whisper (or, for a Steam-linked character, offering a "Link
// via Steam" button that sends the user through a full external OAuth
// round-trip) for a link that would just be rejected at the very end
// anyway. Real operator question that surfaced this: "why send the
// player a link button when we already can determine that they are
// already linked?" Now short-circuits immediately with a clean,
// friendly re-affirmation -- no whisper, no external round-trip, no
// wasted round-trip through Steam OAuth just to be told no.
test("re-running /dune player link for the SAME already-linked character short-circuits immediately -- no whisper is sent, no Steam-link round-trip is offered", async () => {
  const db = createLinkDb();
  db.state.link = { discordUserId: "discord-1", playerControllerId: "42" };
  let whisperSent = false;

  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" }, {
    ensurePersona: async () => persona,
    publishWhisper: async () => { whisperSent = true; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyLinked, true);
  assert.equal(result.characterName, "Chani");
  assert.equal("hasSteam" in result, false, "must not offer the Steam-link button for a character the user already has linked");
  assert.equal(whisperSent, false, "must not send an in-game whisper for a re-link the request will just be a no-op success for");
  assert.equal(db.state.pending, null, "no pending verification code should be created for an already-linked re-link");
});

test("re-running /dune player link for the SAME already-linked character short-circuits even when the character is Steam-linked (would otherwise offer a pointless Steam-link button)", async () => {
  const db = createLinkDb({ hasSteam: true });
  db.state.link = { discordUserId: "discord-1", playerControllerId: "42" };

  const result = await linkPlayerProvider(db, {}, { discordUserId: "discord-1", characterName: "Chani" });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyLinked, true);
  assert.equal("hasSteam" in result, false, "must short-circuit BEFORE the hasSteam check, not offer Steam-link and then reject at the end");
});
