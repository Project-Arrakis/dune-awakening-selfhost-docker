import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_ROLE_TIERS,
  SELF_SCOPED_CAPABILITIES,
  discordActorCan,
  discordActorTier,
  minTierForCapability,
  requireDiscordCapability,
  requireSelfScopedCapability
} from "../src/integrations/discord/policy.js";

const mapping = {
  observerRoleIds: ["role-observer"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleIds = []) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds, username: "tester" };
}

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
  const observerActor = actor(["role-observer"]);
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
  const observerActor = actor(["role-observer"]);
  assert.throws(
    () => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.STATUS_READ),
    (error) => error.code === "invalid_capability"
  );
});

test("requireDiscordCapability still works normally for ordinary tier-gated capabilities", () => {
  const observerActor = actor(["role-observer"]);
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
  const observerActor = actor(["role-observer"]);
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

  assert.equal(opsCapabilities.length, 7);
  for (const capability of opsCapabilities) {
    assert.equal(discordActorCan(actor(["role-observer"]), mapping, capability), false);
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
      const roleIdsForTier = { public: [], observer: ["role-observer"], moderator: ["role-moderator"], admin: ["role-admin"], owner: ["role-owner"] }[tier];
      assert.equal(discordActorCan(actor(roleIdsForTier), mapping, capability), true,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but tier "${tier}" (>= claimed) is not actually granted the capability per discordActorCan`);
    }

    // The tier immediately below the claimed min tier must NOT be granted
    // the capability (otherwise the claimed min tier is too high/strict).
    if (claimedIndex > 0) {
      const belowTier = DISCORD_ROLE_TIERS[claimedIndex - 1];
      const roleIdsBelow = { public: [], observer: ["role-observer"], moderator: ["role-moderator"], admin: ["role-admin"] }[belowTier];
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
