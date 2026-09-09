import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("hosted-bot routes resolve to the expected actions", () => {
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/start", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/callback", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/register", "POST"), "settings:discord-bot-hosted-register");
});

test("admin can start/callback the OAuth flow (updates:read) but cannot register (owner-only)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-hosted-register"), false);
});

test("owner can do both, with zero DEFAULT_POLICIES changes required", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-hosted-register"), true);
});
