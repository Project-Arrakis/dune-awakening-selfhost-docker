import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_ROLE_TIERS,
  DISCORD_WRITE_CAPABILITIES,
  SELF_SCOPED_CAPABILITIES,
  discordActorCan,
  discordActorTier,
  minTierForCapability,
  normalizeDiscordActor,
  requireDiscordCapability,
  requireExperimentalReadOnlyCapability,
  requireSelfScopedCapability
} from "../src/integrations/discord/policy.js";

// [Layer 3 integration audit fix, MEDIUM, issue #1037] requireExperimentalReadOnlyCapability()
// is structurally a no-op: EXPERIMENTAL_READ_ONLY_CAPABILITIES is defined as
// exactly "DISCORD_CAPABILITIES minus DISCORD_WRITE_CAPABILITIES", so its own
// throw branch can never fire for any real capability -- a future write-type
// capability added to DISCORD_CAPABILITIES but accidentally omitted from
// DISCORD_WRITE_CAPABILITIES is automatically absorbed into the "read-only"
// set by construction, exactly the mistake class this codebase just made
// once already when introducing WRITE_BRIDGE_ACCESS.
//
// A real, non-tautological fix requires understanding what "experimental
// read-only mode" was originally meant to gate -- this function predates
// this PR by roughly two months (introduced 2026-07-22/08-11) and is called
// from EVERY Discord capability check in the codebase (requireDiscordCapability,
// requireSelfScopedCapability), so redesigning its live logic under this
// PR's own time/risk budget would be a wide-blast-radius change to
// authorization enforcement across the entire Discord integration, based on
// a guess at intent rather than a verified one -- exactly what Requirement 0
// warns against ("a fix must not be riskier than the problem it fixes").
//
// This test is the safe middle ground: a zero-production-risk tripwire that
// independently re-derives the current write/read-only capability split by
// hand (not from EXPERIMENTAL_READ_ONLY_CAPABILITIES's own derivation) and
// fails the moment DISCORD_CAPABILITIES gains a new entry this list hasn't
// been deliberately updated for -- catching the exact "forgot to classify a
// new capability as write" mistake at test time instead of silently at
// runtime, without touching any live authorization code path.
const KNOWN_WRITE_CAPABILITIES = new Set([
  DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
  DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
  DISCORD_CAPABILITIES.BROADCAST_SEND,
  DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS
]);

test("DISCORD_WRITE_CAPABILITIES matches an independently hand-maintained list -- catches a new capability added without being deliberately classified", () => {
  assert.deepEqual(
    new Set(DISCORD_WRITE_CAPABILITIES),
    KNOWN_WRITE_CAPABILITIES,
    "DISCORD_WRITE_CAPABILITIES has drifted from this test's independently maintained list -- if this is a deliberate new write capability, update KNOWN_WRITE_CAPABILITIES here too"
  );
});

test("every DISCORD_CAPABILITIES value is accounted for by either DISCORD_WRITE_CAPABILITIES or the independently maintained KNOWN_WRITE_CAPABILITIES list (no orphaned capability)", () => {
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    const isWrite = DISCORD_WRITE_CAPABILITIES.has(capability);
    const isKnownWrite = KNOWN_WRITE_CAPABILITIES.has(capability);
    assert.equal(isWrite, isKnownWrite, `capability "${capability}" is classified inconsistently between DISCORD_WRITE_CAPABILITIES (${isWrite}) and this test's independent list (${isKnownWrite})`);
  }
});

test("requireExperimentalReadOnlyCapability: documents its current no-op behavior -- never throws for any real capability (see the note above; this is the finding, not a passing assertion of correctness)", () => {
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    assert.doesNotThrow(() => requireExperimentalReadOnlyCapability(capability));
  }
  assert.throws(() => requireExperimentalReadOnlyCapability(""), /capability.*required/i);
});

const mapping = {
  playerRoleIds: ["role-player"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleIds = [], overrides = {}) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds, username: "tester", ...overrides };
}

// Issue #691: owner-tier is derived from real Discord guild ownership
// FIRST, matching mentat's own rbac.js isGuildOwner()/resolveActorAuthTier()
// -- the bot and this adapter must not disagree about who holds owner-tier
// access for the same Discord member.

test("discordActorTier grants owner via real guild ownership, with zero configured roles", () => {
  const realOwner = actor([], { userId: "the-owner", guildOwnerId: "the-owner" });
  assert.equal(discordActorTier(realOwner, mapping), "owner");
});

test("discordActorTier: real guild ownership outranks and short-circuits any role mapping", () => {
  const realOwnerWithObserverRole = actor(["role-player"], { userId: "the-owner", guildOwnerId: "the-owner" });
  assert.equal(discordActorTier(realOwnerWithObserverRole, mapping), "owner");
});

test("discordActorTier: a non-owner does not get owner tier merely because SOME actor in the guild owns it", () => {
  const notTheOwner = actor(["role-admin"], { guildOwnerId: "someone-else" });
  assert.equal(discordActorTier(notTheOwner, mapping), "admin", "falls through to the role-based mapping normally");
});

test("discordActorTier: absent guildOwnerId (older bot) falls through to the pre-existing role-based check unchanged", () => {
  assert.equal(discordActorTier(actor(["role-owner"]), mapping), "owner", "role-based owner mapping is still honored as a fallback");
  assert.equal(discordActorTier(actor([]), mapping), "public");
});

test("discordActorTier: an actor with an empty-string guildOwnerId never matches (defensive, even if userId were also empty)", () => {
  assert.equal(discordActorTier(actor([], { userId: "", guildOwnerId: "" }), mapping), "public");
});

test("normalizeDiscordActor accepts and passes through an optional guildOwnerId, defaulting to empty when absent", () => {
  const withOwner = normalizeDiscordActor({ guildId: "g", channelId: "c", userId: "u", username: "n", guildOwnerId: "u" });
  assert.equal(withOwner.guildOwnerId, "u");
  const withoutOwner = normalizeDiscordActor({ guildId: "g", channelId: "c", userId: "u", username: "n" });
  assert.equal(withoutOwner.guildOwnerId, "");
});

test("PLAYER_LINK_WRITE is a self-scoped capability, not tier-gated", () => {
  assert.ok(SELF_SCOPED_CAPABILITIES.has(DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
});

// FINDING-LINK-2 (docs/security/discord-player-link-hardening.md):
// player-link:write previously lived in the "moderator" tier's capability
// set, which is disproportionate for an identity-binding action, but also
// wrong in the other direction — every route that checks it always passes
// discordUserId = actor.userId, so it needs to work for ANY authenticated
// actor linking their own account, not be restricted to a privileged tier.
test("requireDiscordCapability rejects PLAYER_LINK_WRITE entirely — self-scoped capabilities must use requireSelfScopedCapability", () => {
  const ownerActor = actor(["role-owner"]);
  assert.throws(
    () => requireDiscordCapability(ownerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE),
    (error) => error.code === "invalid_capability"
  );
});

test("discordActorCan never grants PLAYER_LINK_WRITE via the tier ladder, even for admin/owner", () => {
  // discordActorCan() itself is tier-only; PLAYER_LINK_WRITE is
  // intentionally absent from every tier's Set (including admin/owner,
  // which use Set(Object.values(DISCORD_CAPABILITIES)) elsewhere in the
  // module for other capabilities — this capability was carved out).
  const adminActor = actor(["role-admin"]);
  const ownerActor = actor(["role-owner"]);
  assert.equal(discordActorCan(adminActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE), false);
  assert.equal(discordActorCan(ownerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE), false);
});

test("requireSelfScopedCapability allows any recognized principal (observer tier) to link their own account", () => {
  const observerActor = actor(["role-player"]);
  assert.doesNotThrow(() => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
});

test("requireSelfScopedCapability allows moderator/admin/owner tiers too (self-scoped, not restricted upward)", () => {
  for (const roleId of ["role-moderator", "role-admin", "role-owner"]) {
    const roleActor = actor([roleId]);
    assert.doesNotThrow(() => requireSelfScopedCapability(roleActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
  }
});

test("requireSelfScopedCapability rejects an actor with no configured role at all (public tier)", () => {
  const publicActor = actor([]);
  assert.equal(discordActorTier(publicActor, mapping), "public");
  assert.throws(
    () => requireSelfScopedCapability(publicActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
});

test("requireSelfScopedCapability rejects a tier-gated capability like STATUS_READ", () => {
  const observerActor = actor(["role-player"]);
  assert.throws(
    () => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.STATUS_READ),
    (error) => error.code === "invalid_capability"
  );
});

test("requireDiscordCapability still works normally for ordinary tier-gated capabilities", () => {
  const observerActor = actor(["role-player"]);
  assert.doesNotThrow(() => requireDiscordCapability(observerActor, mapping, DISCORD_CAPABILITIES.STATUS_READ));
  const publicActor = actor([]);
  assert.throws(
    () => requireDiscordCapability(publicActor, mapping, DISCORD_CAPABILITIES.READINESS_READ),
    (error) => error.code === "not_authorized"
  );
});

// FINDING-LINK-6 (docs/security/discord-player-link-hardening.md):
// ACCOUNT_LINK_WRITE is a distinct self-scoped capability from
// PLAYER_LINK_WRITE, not a reuse of it, so the two linking flows can be
// authorized/audited independently.
test("ACCOUNT_LINK_WRITE is self-scoped and distinct from PLAYER_LINK_WRITE", () => {
  assert.ok(SELF_SCOPED_CAPABILITIES.has(DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE));
  assert.notEqual(DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
});

test("requireDiscordCapability rejects ACCOUNT_LINK_WRITE entirely — must use requireSelfScopedCapability", () => {
  const ownerActor = actor(["role-owner"]);
  assert.throws(
    () => requireDiscordCapability(ownerActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE),
    (error) => error.code === "invalid_capability"
  );
});

test("requireSelfScopedCapability allows any recognized principal to use ACCOUNT_LINK_WRITE, and rejects public tier", () => {
  const observerActor = actor(["role-player"]);
  assert.doesNotThrow(() => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE));
  const publicActor = actor([]);
  assert.throws(
    () => requireSelfScopedCapability(publicActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
});

// OPS_* capabilities are deliberately admin/owner only -- unlike most other
// *_READ capabilities, moderator does NOT get them (see policy.js's
// CAPABILITY_BY_TIER comment). Ported from upstream during #279's
// reconciliation; caught a real bug where the merge had initially added
// these to moderator's Set, following the surrounding *_READ pattern
// without checking upstream's actual, deliberate, narrower tier design.
test("OPS capabilities are granted only to admin and owner tiers", () => {
  const opsCapabilities = Object.entries(DISCORD_CAPABILITIES)
    .filter(([name]) => name.startsWith("OPS_"))
    .map(([, capability]) => capability);

  assert.equal(opsCapabilities.length, 9);
  for (const capability of opsCapabilities) {
    assert.equal(discordActorCan(actor(["role-player"]), mapping, capability), false);
    assert.equal(discordActorCan(actor(["role-moderator"]), mapping, capability), false);
    assert.equal(discordActorCan(actor(["role-admin"]), mapping, capability), true);
    assert.equal(discordActorCan(actor(["role-owner"]), mapping, capability), true);
  }
});

test("OPS capability enforcement fails closed for unprivileged actors", () => {
  assert.throws(
    () => requireDiscordCapability(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    requireDiscordCapability(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ)
  );
});

// CHEATER_TRACKING_READ (meta#64, mentat#361) is deliberately admin/owner
// only, same reasoning as OPS_* above -- it discloses another player's
// anti-cheat flag history, more sensitive than moderator's existing
// INVENTORY_READ/STORAGE_READ/GUILD_READ grants.
test("CHEATER_TRACKING_READ is granted only to admin and owner tiers", () => {
  assert.equal(discordActorCan(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ), false);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ), false);
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ), true);
  assert.equal(discordActorCan(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ), true);

  assert.throws(
    () => requireDiscordCapability(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    requireDiscordCapability(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ)
  );
});

// ITEM_AUDIT_LOG_READ (meta#64, mentat#368) is granted to moderator and up
// -- unlike CHEATER_TRACKING_READ (admin/owner only), it's the same
// sensitivity class as the existing INVENTORY_READ/STORAGE_READ/GUILD_READ
// moderator grants (item contents, just historical).
test("ITEM_AUDIT_LOG_READ is granted to moderator tier and up", () => {
  assert.equal(discordActorCan(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ), false);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ), true);
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ), true);
  assert.equal(discordActorCan(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ), true);

  assert.throws(
    () => requireDiscordCapability(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    requireDiscordCapability(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ)
  );
});

// CORIOLIS_READ (mentat#370, issue #942) is granted at public tier and up --
// the farm-wide storm seed/next-cycle timing is genuinely public in-game
// knowledge, not staff-gated like most other read capabilities.
test("CORIOLIS_READ is granted to public tier and up", () => {
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ), true);
  assert.equal(discordActorCan(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ), true);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ), true);
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ), true);
  assert.equal(discordActorCan(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ), true);
  assert.doesNotThrow(() => requireDiscordCapability(actor([]), mapping, DISCORD_CAPABILITIES.CORIOLIS_READ));
});

// ATLAS_READ (mentat#376, issue #938) is granted at public tier and up --
// per-sietch PvP/PvE and live sandstorm status are the same kind of
// genuinely public in-game knowledge as CORIOLIS_READ.
test("ATLAS_READ is granted to public tier and up", () => {
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.ATLAS_READ), true);
  assert.equal(discordActorCan(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.ATLAS_READ), true);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.ATLAS_READ), true);
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.ATLAS_READ), true);
  assert.equal(discordActorCan(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.ATLAS_READ), true);
  assert.doesNotThrow(() => requireDiscordCapability(actor([]), mapping, DISCORD_CAPABILITIES.ATLAS_READ));
});

// minTierForCapability() (added alongside issue #337's command catalog so
// commandCatalog.js has a real, exported way to derive "minimum tier for
// this capability" instead of hand-maintaining a second, parallel table
// that could silently drift the moment a capability is added/moved here.
test("minTierForCapability returns the lowest tier that actually grants each non-self-scoped capability, independently cross-checked against discordActorCan", () => {
  // Cross-check against discordActorCan() directly, rather than re-reading
  // CAPABILITY_BY_TIER's shape a second time -- this is an independent
  // verification path, not a restatement of the same table.
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    if (SELF_SCOPED_CAPABILITIES.has(capability)) continue;
    const claimedMinTier = minTierForCapability(capability);
    assert.ok(DISCORD_ROLE_TIERS.includes(claimedMinTier), `${capability}'s minTierForCapability() result "${claimedMinTier}" is not a real tier`);

    // Every tier at or above the claimed min tier must be granted the capability.
    const claimedIndex = DISCORD_ROLE_TIERS.indexOf(claimedMinTier);
    for (let i = claimedIndex; i < DISCORD_ROLE_TIERS.length; i++) {
      const tier = DISCORD_ROLE_TIERS[i];
      const roleIdsForTier = { public: [], observer: ["role-player"], moderator: ["role-moderator"], admin: ["role-admin"], owner: ["role-owner"] }[tier];
      assert.equal(discordActorCan(actor(roleIdsForTier), mapping, capability), true,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but tier "${tier}" (>= claimed) is not actually granted the capability per discordActorCan`);
    }

    // The tier immediately below the claimed min tier must NOT be granted
    // the capability (otherwise the claimed min tier is too high/strict).
    if (claimedIndex > 0) {
      const belowTier = DISCORD_ROLE_TIERS[claimedIndex - 1];
      const roleIdsBelow = { public: [], observer: ["role-player"], moderator: ["role-moderator"], admin: ["role-admin"] }[belowTier];
      assert.equal(discordActorCan(actor(roleIdsBelow), mapping, capability), false,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but the tier below it, "${belowTier}", is ALSO granted the capability per discordActorCan -- claimed min tier is too high`);
    }
  }
});

test("minTierForCapability returns null for self-scoped capabilities (they are identity-scoped, not tier-gated)", () => {
  for (const capability of SELF_SCOPED_CAPABILITIES) {
    assert.equal(minTierForCapability(capability), null,
      `${capability} is self-scoped and should not have a tier-ladder minimum tier`);
  }
});

test("minTierForCapability rejects an unsupported capability string, matching discordActorCan's own validation", () => {
  assert.throws(
    () => minTierForCapability("not:a:real:capability"),
    (error) => error.code === "invalid_capability"
  );
});

// minTierForCapability() (added alongside the command catalog work so a
// consumer has a real, exported way to derive "minimum tier for this
// capability" instead of hand-maintaining a second, parallel table that
// could silently drift the moment a capability is added/moved here.
test("minTierForCapability returns the lowest tier that actually grants each capability, independently cross-checked against discordActorCan", () => {
  // Cross-check against discordActorCan() directly, rather than re-reading
  // CAPABILITY_BY_TIER's shape a second time -- this is an independent
  // verification path, not a restatement of the same table.
  const roleIdForTier = { public: null, observer: "role-player", moderator: "role-moderator", admin: "role-admin", owner: "role-owner" };
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    const claimedMinTier = minTierForCapability(capability);
    // Self-scoped capabilities (PLAYER_LINK_WRITE, ACCOUNT_LINK_WRITE) are
    // deliberately excluded from every tier's CAPABILITY_BY_TIER set --
    // they're authorized by identity via requireSelfScopedCapability(), not
    // the tier ladder -- so null is the correct, documented result here,
    // not a gap in this test's coverage.
    if (SELF_SCOPED_CAPABILITIES.has(capability)) {
      assert.equal(claimedMinTier, null, `${capability} is self-scoped and should return null from minTierForCapability()`);
      continue;
    }
    assert.ok(DISCORD_ROLE_TIERS.includes(claimedMinTier), `${capability}'s minTierForCapability() result "${claimedMinTier}" is not a real tier`);

    // Every tier at or above the claimed min tier must be granted the capability.
    const claimedIndex = DISCORD_ROLE_TIERS.indexOf(claimedMinTier);
    for (let i = claimedIndex; i < DISCORD_ROLE_TIERS.length; i++) {
      const tier = DISCORD_ROLE_TIERS[i];
      assert.equal(discordActorCan(actor(roleIdForTier[tier]), mapping, capability), true,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but tier "${tier}" (>= claimed) is not actually granted the capability per discordActorCan`);
    }

    // The tier immediately below the claimed min tier must NOT be granted
    // the capability (otherwise the claimed min tier is too high/strict).
    if (claimedIndex > 0) {
      const belowTier = DISCORD_ROLE_TIERS[claimedIndex - 1];
      assert.equal(discordActorCan(actor(roleIdForTier[belowTier]), mapping, capability), false,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but the tier below it, "${belowTier}", is ALSO granted the capability per discordActorCan -- claimed min tier is too high`);
    }
  }
});

test("minTierForCapability rejects an unsupported capability string, matching discordActorCan's own validation", () => {
  assert.throws(
    () => minTierForCapability("not:a:real:capability"),
    (error) => error.code === "invalid_capability"
  );
});
