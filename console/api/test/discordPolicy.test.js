import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_ROLE_TIERS,
  DISCORD_WRITE_CAPABILITIES,
  discordActorCan,
  minTierForCapability,
  requireDiscordCapability,
  requireExperimentalReadOnlyCapability
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
// this branch and is called from every Discord capability check
// (requireDiscordCapability), so redesigning its live logic under this
// change's own time/risk budget would be a wide-blast-radius change to
// authorization enforcement across the entire Discord integration, based on
// a guess at intent rather than a verified one.
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
  observerRoleIds: ["role-observer"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleId) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds: roleId ? [roleId] : [], username: "tester" };
}

test("OPS capabilities are granted only to admin and owner tiers", () => {
  const opsCapabilities = Object.entries(DISCORD_CAPABILITIES)
    .filter(([name]) => name.startsWith("OPS_"))
    .map(([, capability]) => capability);

  assert.equal(opsCapabilities.length, 7);
  for (const capability of opsCapabilities) {
    assert.equal(discordActorCan(actor("role-observer"), mapping, capability), false);
    assert.equal(discordActorCan(actor("role-moderator"), mapping, capability), false);
    assert.equal(discordActorCan(actor("role-admin"), mapping, capability), true);
    assert.equal(discordActorCan(actor("role-owner"), mapping, capability), true);
  }
});

test("OPS capability enforcement fails closed for unprivileged actors", () => {
  assert.throws(
    () => requireDiscordCapability(actor("role-moderator"), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    requireDiscordCapability(actor("role-admin"), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ)
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
  const roleIdForTier = { public: null, observer: "role-observer", moderator: "role-moderator", admin: "role-admin", owner: "role-owner" };
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    const claimedMinTier = minTierForCapability(capability);
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
