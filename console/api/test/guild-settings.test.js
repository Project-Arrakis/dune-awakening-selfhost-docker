import test from "node:test";
import assert from "node:assert/strict";
import { parseEffectiveGuildMemberLimit } from "../src/services/guildSettings.js";

test("guild member limit uses the effective legacy-precedence value", () => {
  assert.equal(parseEffectiveGuildMemberLimit([
    "max_guild_members_allowed\t48",
    "guild_settings_max_guild_members_allowed\t32"
  ].join("\n")), 48);
});

test("guild member limit uses the canonical value when the legacy field is absent", () => {
  assert.equal(parseEffectiveGuildMemberLimit("guild_settings_max_guild_members_allowed\t64\n"), 64);
});

test("guild member limit defaults safely and rejects malformed values", () => {
  assert.equal(parseEffectiveGuildMemberLimit(""), 32);
  assert.throws(() => parseEffectiveGuildMemberLimit("max_guild_members_allowed\t0\n"), /invalid/);
  assert.throws(() => parseEffectiveGuildMemberLimit("max_guild_members_allowed\tnot-a-number\n"), /invalid/);
});
