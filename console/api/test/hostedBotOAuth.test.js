import assert from "node:assert/strict";
import test from "node:test";
import { fetchOwnedDiscordGuilds, createPendingRegistrationStore, hostedBotOAuthStateCookie, hostedBotRegistrationHandleCookie, hostedBotOAuthReturnPage } from "../src/integrations/discord/hostedBotOAuth.js";

test("fetchOwnedDiscordGuilds keeps only owner:true guilds and preserves id+name+owner", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) {
      return { ok: true, json: async () => ([
        { id: "111111111111111111", name: "Owned Guild", owner: true },
        { id: "222222222222222222", name: "Not Owned", owner: false }
      ]) };
    }
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.equal(result.userId, "999999999999999999");
  assert.deepEqual(result.guilds, [{ id: "111111111111111111", name: "Owned Guild", owner: true }]);
});

test("fetchOwnedDiscordGuilds returns an empty guilds array when the operator owns nothing", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "1", name: "x", owner: false }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.deepEqual(result.guilds, []);
});

test("pending-registration store is single-use, TTL-bound, and capacity-capped", () => {
  let clock = 1000;
  const store = createPendingRegistrationStore({ now: () => clock, ttlMs: 5000, maxEntries: 2 });
  const first = store.issue({ accessToken: "tok-a", ownedGuildIds: ["111111111111111111"], userId: "u1" });
  assert.ok(first.handle);
  const readBack = store.consume(first.handle, first.handle);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.entry.accessToken, "tok-a");

  const secondRead = store.consume(first.handle, first.handle);
  assert.equal(secondRead.ok, false, "a handle must be single-use");

  const second = store.issue({ accessToken: "tok-b", ownedGuildIds: [], userId: "u2" });
  clock += 6000;
  const expired = store.consume(second.handle, second.handle);
  assert.equal(expired.ok, false, "an entry past its TTL must be rejected");
});

test("pending-registration store rejects a handle that doesn't match the cookie value", () => {
  const store = createPendingRegistrationStore({});
  const issued = store.issue({ accessToken: "tok", ownedGuildIds: [], userId: "u1" });
  const result = store.consume(issued.handle, "some-other-cookie-value");
  assert.equal(result.ok, false);
});

test("pending-registration store enforces a capacity cap", () => {
  const store = createPendingRegistrationStore({ maxEntries: 1 });
  const first = store.issue({ accessToken: "a", ownedGuildIds: [], userId: "u1" });
  assert.ok(first);
  const second = store.issue({ accessToken: "b", ownedGuildIds: [], userId: "u2" });
  assert.equal(second, null);
});

test("hostedBotOAuthStateCookie and hostedBotRegistrationHandleCookie use distinct, path-scoped, HttpOnly cookies", () => {
  const stateCookie = hostedBotOAuthStateCookie("abc123", true);
  assert.match(stateCookie, /^hosted_bot_oauth_state=abc123/);
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /Path=\/api\/integrations\/discord\/hosted-bot\/oauth\/callback/);
  const handleCookie = hostedBotRegistrationHandleCookie("xyz789", true);
  assert.match(handleCookie, /^hosted_bot_registration_handle=xyz789/);
  assert.match(handleCookie, /HttpOnly/);
  assert.notEqual(stateCookie.split("=")[0], handleCookie.split("=")[0], "the two cookies must have distinct names");
});

test("hostedBotOAuthReturnPage embeds the owned-guilds list as JSON the SPA can read, and never embeds a token", () => {
  const guilds = [{ id: "111111111111111111", name: "Test Guild", owner: true }];
  const page = hostedBotOAuthReturnPage(guilds);
  assert.match(page, /window\.__hostedBotOwnedGuilds__\s*=\s*\[/);
  assert.match(page, /Test Guild/);
  assert.doesNotMatch(page, /accessToken|access_token/i, "the return page must never embed the raw Discord token");
});
