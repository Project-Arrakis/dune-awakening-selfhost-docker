import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  discordActorCan,
  requireDiscordCapability
} from "../src/integrations/discord/policy.js";

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
