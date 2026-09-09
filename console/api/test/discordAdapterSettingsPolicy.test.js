import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("Discord Bot settings routes resolve to the expected actions", () => {
  assert.equal(actionForRoute("/api/settings/discord-bot", "GET"), "settings:read");
  assert.equal(actionForRoute("/api/settings/discord-bot/enable", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/role-ids", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/regenerate-token", "POST"), "settings:discord-bot-regenerate-token");
});

test("admin can enable the Discord adapter (already has updates:apply via self-update) but cannot regenerate its token (settings:* denied)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-regenerate-token"), false);
});

test("owner can do both", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-regenerate-token"), true);
});
