import test from "node:test";
import assert from "node:assert/strict";
import {
  createPendingStateStore,
  exchangeDiscordAuthCode,
  fetchDiscordIdentity,
  resolveBootstrapTier,
  parseDiscordAllowlist,
  buildAuthorizeUrl,
  oauthError
} from "../src/integrations/discord/oauth.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("pending state issues single-use cookie-bound entries", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0] });
  const state = store.issue();
  assert.ok(state && state.length > 0);
  assert.equal(store.size(), 1);

  const first = store.consume(state, state, 1_000_100);
  assert.equal(first.ok, true);
  assert.equal(store.size(), 0);

  const second = store.consume(state, state, 1_000_200);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "missing_or_reused_state");
});

test("pending state: stale TTL is rejected", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0], ttlMs: 10_000 });
  const state = store.issue();
  now[0] += 10_001;
  const result = store.consume(state, state, now[0]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale_state");
});

test("pending state: cookie mismatch rejected and state still consumed", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0] });
  const state = store.issue();
  const result = store.consume(state, "attacker-chosen-cookie", now[0]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_cookie_mismatch");
  assert.equal(store.size(), 0);
  const retried = store.consume(state, state, now[0]);
  assert.equal(retried.ok, false);
  assert.equal(retried.reason, "missing_or_reused_state");
});

test("pending state: full store refuses new issues", () => {
  const store = createPendingStateStore({ maxEntries: 2 });
  store.issue();
  store.issue();
  assert.equal(store.issue(), null);
});

test("token exchange: missing/invalid code rejected", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "", redirectUri: "https://console.example/cb", clientId: "id", clientSecret: "sec", fetchImpl: async () => jsonResponse({}) }),
    (error) => error.code === "missing_code"
  );
});

test("token exchange: upstream non-2xx yields oauth_upstream_error", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({ error: "bad" }, 400) }),
    (error) => error.code === "oauth_upstream_error"
  );
});

test("token exchange: unreachable host yields tied-down error, not a throw", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => { throw new Error("network"); } }),
    (error) => error.code === "discord_unreachable"
  );
});

test("token exchange: malformed / missing access_token rejected", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({}) }),
    (error) => error.code === "oauth_missing_token"
  );
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({ access_token: "" }) }),
    (error) => error.code === "oauth_missing_token"
  );
});

test("token exchange: happy path returns access token", async () => {
  const token = await exchangeDiscordAuthCode({
    code: "auth-code", redirectUri: "https://x.example/api/auth/discord/callback", clientId: "client", clientSecret: "secret",
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/oauth2\/token$/);
      assert.match(String(init.headers["content-type"]), /application\/x-www-form-urlencoded/);
      assert.match(String(init.body), /code=auth-code/);
      return jsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 604800 });
    }
  });
  assert.equal(token.access_token, "tok");
});

test("identity: /users/@me + guilds resolve cleanly", async () => {
  const identity = await fetchDiscordIdentity({
    accessToken: "tok",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/users/@me")) return jsonResponse({ id: "123456789012345678", username: "operator" });
      if (String(url).endsWith("/users/@me/guilds")) return jsonResponse([{ id: "987654321098765432" }, { id: "555", bad: true }]);
      throw new Error("unexpected fetch");
    }
  });
  assert.equal(identity.userId, "123456789012345678");
  assert.equal(identity.username, "operator");
  assert.deepEqual(identity.guildIds, ["987654321098765432"]);
});

test("identity: malformed user payload rejected", async () => {
  await assert.rejects(
    fetchDiscordIdentity({ accessToken: "tok", fetchImpl: () => jsonResponse({ id: "abc", username: "nope" }) }),
    (error) => error.code === "oauth_bad_identity"
  );
  await assert.rejects(
    fetchDiscordIdentity({ accessToken: "tok", fetchImpl: () => jsonResponse({ id: "123456789012345678", username: "" }) }),
    (error) => error.code === "oauth_bad_identity"
  );
});

test("identity: failed guilds lookup fails closed (no partial identity)", async () => {
  await assert.rejects(
    fetchDiscordIdentity({
      accessToken: "tok",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/users/@me")) return jsonResponse({ id: "123456789012345678", username: "x" });
        return new Response("not json", { status: 500 });
      }
    }),
    (error) => ["oauth_bad_response", "oauth_upstream_error"].includes(error.code)
  );
});

test("bootstrap tier: every owner gate must pass", () => {
  const policy = { userId: "111111111111111111", guildIds: ["222222222222222222"], allowOwnerBootstrap: true, homeGuildId: "222222222222222222", ownerAllowlist: ["111111111111111111"] };
  assert.equal(resolveBootstrapTier(policy), "owner");

  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: undefined }), "");
  assert.equal(resolveBootstrapTier({ ...policy, allowOwnerBootstrap: false }), "");
  assert.equal(resolveBootstrapTier({ ...policy, homeGuildId: "" }), "");
  assert.equal(resolveBootstrapTier({ ...policy, guildIds: [] }), "");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: ["333333333333333333"] }), "");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: ["111111111111111111"] }), "owner");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: [] }), "", "empty allowlist is fail-closed, never 'any guild member'");
});

test("allowlist parsing: only snowflake ids survive", () => {
  assert.deepEqual(parseDiscordAllowlist("111111111111111111, foo, 222222222222222222"), ["111111111111111111", "222222222222222222"]);
  assert.deepEqual(parseDiscordAllowlist(["123"]), []);
  assert.deepEqual(parseDiscordAllowlist(""), []);
});

test("authorize URL carries identify+guilds scope and state", () => {
  const url = buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/r", state: "st" });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("scope"), "identify guilds");
  assert.equal(parsed.searchParams.get("state"), "st");
  assert.equal(parsed.searchParams.get("client_id"), "cid");
});

test("oauthError carries a status code for routes", () => {
  const error = oauthError("no_access", "nope", 403);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "no_access");
});
