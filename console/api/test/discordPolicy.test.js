import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_ROLE_TIERS,
  DISCORD_WRITE_CAPABILITIES,
  EXPERIMENTAL_READ_ONLY_CAPABILITIES,
  discordActorCan,
  minTierForCapability,
  partitionProblems,
  requireDiscordCapability,
  requireExperimentalReadOnlyCapability,
  selfCheckDiscordCapabilityPartition
} from "../src/integrations/discord/policy.js";

// [Layer 3 integration audit fix, issue #1037 -- fixed] requireExperimentalReadOnlyCapability()
// used to be structurally a no-op: EXPERIMENTAL_READ_ONLY_CAPABILITIES was
// defined as exactly "DISCORD_CAPABILITIES minus DISCORD_WRITE_CAPABILITIES",
// so its own throw branch could never fire for any real capability -- a
// future write-type capability added to DISCORD_CAPABILITIES but
// accidentally omitted from DISCORD_WRITE_CAPABILITIES would have been
// silently absorbed into the "read-only" set by construction, exactly the
// mistake class this codebase already came close to making once when
// introducing WRITE_BRIDGE_ACCESS. Fixed by making EXPERIMENTAL_READ_ONLY_CAPABILITIES
// its own independent, hand-maintained allowlist (see policy.js's own
// comment) plus selfCheckDiscordCapabilityPartition(), a boot-time check
// (wired into server.js) that every real capability lands in exactly one of
// the two sets. The tests below now verify the real, non-tautological
// behavior, not just document the old no-op as a known gap.
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

test("selfCheckDiscordCapabilityPartition: real, current DISCORD_CAPABILITIES has zero problems (both sets are independently correct and complete)", () => {
  assert.deepEqual(selfCheckDiscordCapabilityPartition(), []);
});

test("requireExperimentalReadOnlyCapability: does not throw for any real, currently-classified capability", () => {
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    assert.doesNotThrow(() => requireExperimentalReadOnlyCapability(capability));
  }
  assert.throws(() => requireExperimentalReadOnlyCapability(""), /capability.*required/i);
});

// [Mutation-tested proof this fix has real teeth] Every one of the tests
// above passes identically whether EXPERIMENTAL_READ_ONLY_CAPABILITIES is
// the new independent allowlist OR the old, buggy derivation (`new Set(
// Object.values(DISCORD_CAPABILITIES).filter((c) => !DISCORD_WRITE_CAPABILITIES.has(c)))`)
// -- confirmed directly by temporarily reverting to that derivation and
// re-running this file: all prior tests still passed, because no CURRENTLY
// EXISTING capability's classification differs between the two approaches.
// That's exactly why the old bug was invisible: it only manifests for a
// capability that doesn't exist yet. This test proves the real difference
// using partitionProblems() (the extracted, parameterized core logic behind
// selfCheckDiscordCapabilityPartition()) against a deliberately-simulated
// "forgot to classify a new write capability" scenario -- the one concrete
// case this fix exists to catch.
test("partitionProblems: a capability missing from BOTH sets is flagged -- proves the old tautological derivation (which could never produce this) is really gone", () => {
  const allCapabilities = [...Object.values(DISCORD_CAPABILITIES), "hypothetical:new-write-capability"];
  // Simulates the real mistake: a new capability was added to the overall
  // catalog but never added to DISCORD_WRITE_CAPABILITIES (a real, human
  // step). Under the OLD derivation, computing read-only as "everything not
  // in writeSet" would have silently absorbed it into read-only right here.
  const problems = partitionProblems(allCapabilities, EXPERIMENTAL_READ_ONLY_CAPABILITIES, DISCORD_WRITE_CAPABILITIES);
  assert.deepEqual(problems, [
    '"hypothetical:new-write-capability" is in NEITHER EXPERIMENTAL_READ_ONLY_CAPABILITIES nor DISCORD_WRITE_CAPABILITIES -- every real use of it will now be rejected by requireExperimentalReadOnlyCapability()'
  ]);

  // The old, buggy derivation applied to the SAME input would have found
  // zero problems -- silently accepting the unclassified capability as
  // read-only instead of flagging it. This is the concrete, mechanical proof
  // the two approaches genuinely differ, not just an assertion that they should.
  const oldStyleReadOnly = new Set(allCapabilities.filter((c) => !DISCORD_WRITE_CAPABILITIES.has(c)));
  assert.deepEqual(partitionProblems(allCapabilities, oldStyleReadOnly, DISCORD_WRITE_CAPABILITIES), []);
});

// Note: this specific assertion (a string that was never in DISCORD_CAPABILITIES
// at all gets rejected) holds under the OLD tautological derivation too --
// it isn't a differentiator on its own. It's included anyway as a real,
// useful property of the live enforcement function: fail-closed for a truly
// unrecognized capability, cross-checked against the boot-time check's own
// logic (partitionProblems, tested above) reaching the same conclusion for
// the actually-interesting case (a capability that WAS added to the catalog
// but forgotten in DISCORD_WRITE_CAPABILITIES).
test("requireExperimentalReadOnlyCapability: a capability in neither set is rejected, not silently treated as read-only", () => {
  assert.equal(EXPERIMENTAL_READ_ONLY_CAPABILITIES.has("hypothetical:new-write-capability"), false);
  assert.equal(DISCORD_WRITE_CAPABILITIES.has("hypothetical:new-write-capability"), false);
  assert.throws(
    () => requireExperimentalReadOnlyCapability("hypothetical:new-write-capability"),
    (error) => error.code === "not_read_only"
  );
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
