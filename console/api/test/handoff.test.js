import test from "node:test";
import assert from "node:assert/strict";

import {
  signPayload,
  verifyPayload,
  validatePayload,
  isFresh,
  createHandoff,
} from "../src/integrations/discord/handoff.js";
import { createOAuthTierResolver, resolveBootstrapTier } from "../src/integrations/discord/oauth.js";

const SECRET = "test-handoff-secret-key-for-unit-tests";

// ---- sign / verify roundtrip ----

test("signPayload produces a hex string", () => {
  const sig = signPayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 }, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
});

test("verifyPayload accepts a valid signature", () => {
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  const signature = signPayload(payload, SECRET);
  assert.equal(verifyPayload(payload, signature, SECRET), true);
});

test("verifyPayload rejects a tampered payload", () => {
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  const signature = signPayload(payload, SECRET);
  const tampered = { ...payload, tier: "owner" };
  assert.equal(verifyPayload(tampered, signature, SECRET), false);
});

test("verifyPayload rejects a forged signature", () => {
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  const forged = signPayload({ ...payload, tier: "owner" }, "wrong-secret");
  assert.equal(verifyPayload(payload, forged, SECRET), false);
});

test("verifyPayload rejects a short signature", () => {
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  assert.equal(verifyPayload(payload, "abcd", SECRET), false);
});

test("verifyPayload rejects a non-string signature", () => {
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  assert.equal(verifyPayload(payload, null, SECRET), false);
});

// ---- validatePayload ----

test("validatePayload accepts a valid payload", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 });
  assert.equal(result.ok, true);
  assert.equal(result.payload.tier, "admin");
});

test("validatePayload rejects a null payload", () => {
  const result = validatePayload(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_payload");
});

test("validatePayload rejects a missing userId", () => {
  const result = validatePayload({ guildId: "143064109775060993", tier: "admin", ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_user_id");
});

test("validatePayload rejects a short userId", () => {
  const result = validatePayload({ userId: "123", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_user_id");
});

test("validatePayload rejects a missing guildId", () => {
  const result = validatePayload({ userId: "143064109775060993", tier: "admin", ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_guild_id");
});

test("validatePayload rejects an invalid tier", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "superuser", ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tier");
});

test("validatePayload accepts all valid tier values", () => {
  for (const tier of ["owner", "admin", "moderator", "player", "observer"]) {
    const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier, ts: 1700000000000 });
    assert.equal(result.ok, true, `tier ${tier} should be valid`);
  }
});

test("validatePayload rejects a missing timestamp", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_timestamp");
});

test("validatePayload rejects a zero timestamp", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_timestamp");
});

test("validatePayload rejects a non-number timestamp", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: "now" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_timestamp");
});

// ---- isFresh ----

test("isFresh accepts a timestamp within the window", () => {
  const now = () => 1700000005000;
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  assert.equal(isFresh(payload, 30000, now), true);
});

test("isFresh rejects a timestamp outside the window", () => {
  const now = () => 1700000035000;
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000000000 };
  assert.equal(isFresh(payload, 30000, now), false);
});

test("isFresh rejects a future timestamp", () => {
  const now = () => 1700000020000;
  const payload = { userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: 1700000030000 };
  assert.equal(isFresh(payload, 30000, now), false);
});

// ---- createHandoff: disabled ----

test("createHandoff returns disabled when secret is missing", () => {
  const h = createHandoff({ secret: "", botUrl: "http://localhost:9876", homeGuildId: "143064109775060993" });
  assert.equal(h.enabled, false);
});

test("createHandoff returns disabled when botUrl is missing", () => {
  const h = createHandoff({ secret: SECRET, botUrl: "", homeGuildId: "143064109775060993" });
  assert.equal(h.enabled, false);
});

test("disabled handoff resolveTier returns empty tier", async () => {
  const h = createHandoff({ secret: "", botUrl: "", homeGuildId: "" });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "not_configured");
});

// ---- createHandoff: half-configured is refused at boot, not treated as live ----

test("createHandoff flags half-configuration when homeGuildId is missing", () => {
  const h = createHandoff({ secret: SECRET, botUrl: "http://localhost:9876", homeGuildId: "" });
  assert.equal(h.enabled, false);
  assert.equal(h.misconfigured, true);
  assert.deepEqual(h.missing, ["homeGuildId"]);
});

test("createHandoff flags half-configuration when only secret is set", () => {
  const h = createHandoff({ secret: SECRET, botUrl: "", homeGuildId: "" });
  assert.equal(h.enabled, false);
  assert.equal(h.misconfigured, true);
  assert.deepEqual(h.missing, ["botUrl", "homeGuildId"]);
});

test("createHandoff flags half-configuration when only botUrl is set", () => {
  const h = createHandoff({ secret: "", botUrl: "http://localhost:9876", homeGuildId: "143064109775060993" });
  assert.equal(h.enabled, false);
  assert.equal(h.misconfigured, true);
  assert.deepEqual(h.missing, ["secret"]);
});

test("createHandoff flags half-configuration when only botUrl is missing", () => {
  const h = createHandoff({ secret: SECRET, botUrl: "", homeGuildId: "143064109775060993" });
  assert.equal(h.enabled, false);
  assert.equal(h.misconfigured, true);
  assert.deepEqual(h.missing, ["botUrl"]);
});

test("createHandoff flags a present-but-unusable botUrl as invalid", () => {
  for (const bad of ["not a url", "ftp://bot.example", "localhost:9876"]) {
    const h = createHandoff({ secret: SECRET, botUrl: bad, homeGuildId: "143064109775060993" });
    assert.equal(h.enabled, false, `botUrl ${bad} must not boot a live handoff`);
    assert.equal(h.misconfigured, true);
    assert.deepEqual(h.invalid, ["botUrl"]);
  }
});

test("createHandoff does not flag bootstrap-only config (homeGuildId alone)", () => {
  // homeGuildId doubles as bootstrap config; setting it without any
  // handoff-specific value is not a handoff attempt.
  const h = createHandoff({ secret: "", botUrl: "", homeGuildId: "143064109775060993" });
  assert.equal(h.enabled, false);
  assert.equal(h.misconfigured, undefined);
});

// ---- createHandoff: enabled (mocked fetch) ----

function signedResponse({ userId, guildId, tier, ts }, secret = SECRET) {
  const payload = { userId, guildId, tier, ts };
  const signature = signPayload(payload, secret);
  return { ...payload, signature };
}

// Mirrors real fetch semantics: a non-2xx response resolves with
// ok: false -- it does not throw. (An earlier version of this mock threw
// on non-200, which silently rerouted every non-2xx test through the
// unreachable/network-error branch instead of the response.ok check.)
function mockFetch(response, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response
  });
}

function mockFetchError() {
  return async () => { throw new Error("ECONNREFUSED"); };
}

test("createHandoff resolveTier returns tier on valid signed response", async () => {
  const ts = Date.now();
  const response = signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response)
  });
  assert.equal(h.enabled, true);
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "admin");
  assert.equal(result.reason, "");
});

test("createHandoff resolveTier returns empty on bot unreachable", async () => {
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetchError()
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "unreachable");
});

test("createHandoff resolveTier returns empty on bot non-200 response", async () => {
  const ts = Date.now();
  const response = signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response, 502)
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "http_502");
});

test("createHandoff resolveTier returns empty on invalid signature", async () => {
  const ts = Date.now();
  const response = signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts }, "wrong-secret");
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response)
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "bad_signature");
});

test("createHandoff resolveTier returns empty when userId mismatches", async () => {
  const ts = Date.now();
  const response = signedResponse({ userId: "999999999999999999", guildId: "143064109775060993", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response)
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "user_mismatch");
});

test("createHandoff resolveTier returns empty when guildId mismatches", async () => {
  const ts = Date.now();
  const response = signedResponse({ userId: "143064109775060993", guildId: "888888888888888888", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response)
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "guild_mismatch");
});

test("createHandoff resolveTier returns empty on stale handoff", async () => {
  const ts = Date.now() - 60_000;
  const response = signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(response)
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "stale_handoff");
});

test("createHandoff resolveTier returns empty on malformed JSON response", async () => {
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("parse error"); } })
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "");
  assert.equal(result.reason, "malformed_response");
});

// ---- createOAuthTierResolver: handoff is authoritative when configured ----
// (rfc-console-auth.md §2.1 -- a configured handoff's empty result means
// deny; the bootstrap allowlist applies only when no handoff was ever
// configured. The "falls back to bootstrap when handoff returns empty"
// test that used to live here asserted the fail-open behavior this fix
// removes.)

test("createOAuthTierResolver uses handoff when enabled", async () => {
  const ts = Date.now();
  const handoff = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts }))
  });
  const resolve = createOAuthTierResolver({
    bootstrap: { allowOwnerBootstrap: false, homeGuildId: "143064109775060993", ownerAllowlist: [] },
    handoff
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "admin");
  assert.equal(result.source, "handoff");
  assert.equal(result.reason, "");
});

test("createOAuthTierResolver denies when handoff is configured but fails -- even with a permissive bootstrap allowlist", async () => {
  const handoff = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetchError()
  });
  const resolve = createOAuthTierResolver({
    bootstrap: {
      allowOwnerBootstrap: true,
      homeGuildId: "143064109775060993",
      ownerAllowlist: ["143064109775060993"]
    },
    handoff
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "");
  assert.equal(result.source, "handoff");
  assert.equal(result.reason, "unreachable");
});

test("createOAuthTierResolver denies on explicit bot refusal without consulting bootstrap", async () => {
  const ts = Date.now();
  const handoff = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetch(signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts }), 403)
  });
  const resolve = createOAuthTierResolver({
    bootstrap: {
      allowOwnerBootstrap: true,
      homeGuildId: "143064109775060993",
      ownerAllowlist: ["143064109775060993"]
    },
    handoff
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "");
  assert.equal(result.source, "handoff");
  assert.equal(result.reason, "http_403");
});

test("createOAuthTierResolver reason codes never change the authorization outcome", async () => {
  // Every distinct handoff failure mode produces the same denial --
  // reasons differ, tiers never do.
  const ts = Date.now();
  const cases = [
    { fetchImpl: mockFetchError(), reason: "unreachable" },
    { fetchImpl: mockFetch(signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts }, "wrong-secret")), reason: "bad_signature" },
    { fetchImpl: mockFetch(signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts: ts - 60_000 })), reason: "stale_handoff" }
  ];
  for (const { fetchImpl, reason } of cases) {
    const handoff = createHandoff({ secret: SECRET, botUrl: "http://localhost:9876", homeGuildId: "143064109775060993", fetchImpl });
    const resolve = createOAuthTierResolver({
      bootstrap: { allowOwnerBootstrap: true, homeGuildId: "143064109775060993", ownerAllowlist: ["143064109775060993"] },
      handoff
    });
    const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
    assert.equal(result.tier, "", `reason ${reason} must still deny`);
    assert.equal(result.reason, reason);
  }
});

test("createOAuthTierResolver falls back to bootstrap when handoff is disabled", async () => {
  const handoff = createHandoff({ secret: "", botUrl: "", homeGuildId: "" });
  const resolve = createOAuthTierResolver({
    bootstrap: {
      allowOwnerBootstrap: true,
      homeGuildId: "143064109775060993",
      ownerAllowlist: ["143064109775060993"]
    },
    handoff
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "owner");
  assert.equal(result.source, "bootstrap");
});

test("createOAuthTierResolver denies via bootstrap when handoff was never configured and allowlist misses", async () => {
  const handoff = createHandoff({ secret: "", botUrl: "", homeGuildId: "" });
  const resolve = createOAuthTierResolver({
    bootstrap: {
      allowOwnerBootstrap: true,
      homeGuildId: "143064109775060993",
      ownerAllowlist: ["999999999999999999"]
    },
    handoff
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "");
  assert.equal(result.source, "bootstrap");
  assert.equal(result.reason, "not_authorized");
});

test("createHandoff resolveTier sends the expected request to the bot", async () => {
  const ts = Date.now();
  const captured = {};
  const response = signedResponse({ userId: "143064109775060993", guildId: "143064109775060993", tier: "admin", ts });
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: async (url, init) => {
      captured.url = url;
      captured.init = init;
      return { ok: true, status: 200, json: async () => response };
    }
  });
  const result = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(result.tier, "admin");
  assert.equal(captured.url, "http://localhost:9876/resolve-console-tier");
  assert.equal(captured.init.method, "POST");
  assert.ok(captured.init.signal, "request must carry the timeout abort signal");
  assert.deepEqual(JSON.parse(captured.init.body), { userId: "143064109775060993", guildId: "143064109775060993" });
});

test("createOAuthTierResolver treats a half-configured handoff as not configured (bootstrap applies)", async () => {
  // Mirrors server boot behavior: a misconfigured handoff is disabled,
  // so today's effective bootstrap path is preserved -- now with a loud
  // boot warning instead of a silently dead handoff.
  const handoff = createHandoff({ secret: SECRET, botUrl: "http://localhost:9876", homeGuildId: "" });
  const resolve = createOAuthTierResolver({
    bootstrap: {
      allowOwnerBootstrap: true,
      homeGuildId: "143064109775060993",
      ownerAllowlist: ["143064109775060993"]
    },
    handoff: handoff.enabled ? handoff : null
  });
  const result = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(result.tier, "owner");
  assert.equal(result.source, "bootstrap");
});
