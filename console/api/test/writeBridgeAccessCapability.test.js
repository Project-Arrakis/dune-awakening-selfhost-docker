import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_WRITE_CAPABILITIES,
  discordActorCan,
  requireDiscordCapability
} from "../src/integrations/discord/policy.js";

const mapping = {
  playerRoleIds: ["role-player"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleIds = []) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds, username: "tester" };
}

test("WRITE_BRIDGE_ACCESS is registered as a write capability", () => {
  assert.ok(DISCORD_WRITE_CAPABILITIES.has(DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS));
});

test("Section 0 invariant: public and observer tiers never have WRITE_BRIDGE_ACCESS, no exceptions", () => {
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS), false);
  assert.equal(discordActorCan(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS), false);
});

test("moderator, admin, and owner all have WRITE_BRIDGE_ACCESS", () => {
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS), true);
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS), true);
  assert.equal(discordActorCan(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS), true);
});

test("requireDiscordCapability rejects public/observer for WRITE_BRIDGE_ACCESS", () => {
  assert.throws(
    () => requireDiscordCapability(actor([]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS),
    (error) => error.code === "not_authorized"
  );
  assert.throws(
    () => requireDiscordCapability(actor(["role-player"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS),
    (error) => error.code === "not_authorized"
  );
});

test("requireDiscordCapability passes for moderator+ for WRITE_BRIDGE_ACCESS", () => {
  assert.doesNotThrow(() => requireDiscordCapability(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS));
  assert.doesNotThrow(() => requireDiscordCapability(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS));
  assert.doesNotThrow(() => requireDiscordCapability(actor(["role-owner"]), mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS));
});

// The claim "WRITE_BRIDGE_ACCESS alone does not grant any specific write
// action -- that's writeActionMinTier.js's job" used to have a test here
// (Layer 2 QA finding, issue #1023): its only assertion was byte-identical
// to "requireDiscordCapability passes for moderator+" above and proved
// nothing about the claim in its name. The real assertion already lives
// where the comment always said it should: writeBridge.integration.test.js's
// "moderator attempting an owner-tier action -- 403 not_authorized" test,
// which actually exercises a moderator passing this coarse capability gate
// and then being rejected by the separate, real tier check.
