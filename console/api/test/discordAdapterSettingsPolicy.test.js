import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("Discord Bot settings routes resolve to the expected actions", () => {
  // Audit finding #6 (LOW): GET must resolve to an action admin already
  // holds via an existing wildcard (updates:*), not settings:read (denied
  // to admin by the settings:* Deny wildcard) -- otherwise admin can
  // blindly mutate this feature's state via the POST routes below but
  // can never read it back first.
  assert.equal(actionForRoute("/api/settings/discord-bot", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/settings/discord-bot/enable", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/role-ids", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/regenerate-token", "POST"), "settings:discord-bot-regenerate-token");
  // Real UAT finding (2026-09-09): the restart trigger split out of
  // /enable and /role-ids -- same action as both.
  assert.equal(actionForRoute("/api/settings/discord-bot/restart", "POST"), "updates:apply");
  // Real UAT finding (2026-09-09, "I see no path to remove the bot") --
  // owner-only, same tier restriction as regenerate-token, via its own
  // distinct action name.
  assert.equal(actionForRoute("/api/settings/discord-bot/disable", "POST"), "settings:discord-bot-disable");
  // Real UAT finding (2026-09-09): the hosted-bot connection's own,
  // independent Discord Application config -- prerequisite setup, not a
  // destructive/credential-invalidating action, so updates:apply (admin
  // reachable) not owner-only.
  assert.equal(actionForRoute("/api/settings/discord-bot/oauth-config", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/oauth-secret", "POST"), "updates:apply");
});

test("admin can enable the Discord adapter (already has updates:apply via self-update) but cannot regenerate its token (settings:* denied)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-regenerate-token"), false);
});

test("admin cannot disable the Discord adapter (settings:* denied, same as regenerate-token)", () => {
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-disable"), false);
});

test("admin can read the Discord Bot settings state (updates:* Allow wildcard), unlike settings:read which is denied", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:read"), false);
});

test("owner can do both", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-regenerate-token"), true);
});

test("owner can disable the Discord adapter", () => {
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-disable"), true);
});
