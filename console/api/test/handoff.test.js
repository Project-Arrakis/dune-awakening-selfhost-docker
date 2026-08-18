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

// Rewritten per L1 audit finding L1-C4 (QA hat, verified by direct regex
// execution): this test previously asserted tier: "superuser" is rejected,
// which encoded the OLD fixed-5-name Set-membership semantics. Under the
// AWS-mirrored policy/role model (design §4.6), validatePayload() checks
// shape only (RESERVED_TIER_NAME_PATTERN) -- "superuser" is shaped exactly
// like a valid tier name, it just isn't one of the 5 built-ins, which is no
// longer disqualifying once custom tiers can exist. The old test would
// fail as written against the new implementation; replaced with a value
// that is genuinely malformed BY SHAPE (uppercase/punctuation), which the
// pattern correctly still rejects regardless of the tier-name model.
test("validatePayload rejects a tier name that is malformed by shape", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "Superuser!", ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tier");
});

test("validatePayload rejects a tier name that is too long (over 32 chars)", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "x".repeat(33), ts: 1700000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tier");
});

test("validatePayload accepts all 5 built-in tier values", () => {
  for (const tier of ["owner", "admin", "moderator", "player", "observer"]) {
    const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier, ts: 1700000000000 });
    assert.equal(result.ok, true, `tier ${tier} should be valid`);
  }
});

// New capability this design adds (L1 design §4.6): a well-formed CUSTOM
// tier name -- not one of the 5 built-ins -- is no longer rejected by
// validatePayload()'s shape check. Proves the intended new capability
// actually works, not just that the old test was updated to stop failing.
test("validatePayload accepts a well-formed custom (non-built-in) tier name", () => {
  const result = validatePayload({ userId: "143064109775060993", guildId: "143064109775060993", tier: "event-mod", ts: 1700000000000 });
  assert.equal(result.ok, true);
  assert.equal(result.payload.tier, "event-mod");
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

test("disabled handoff resolveTier returns empty string", async () => {
  const h = createHandoff({ secret: "", botUrl: "", homeGuildId: "" });
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
});

// ---- createHandoff: enabled (mocked fetch) ----

function signedResponse({ userId, guildId, tier, ts }, secret = SECRET) {
  const payload = { userId, guildId, tier, ts };
  const signature = signPayload(payload, secret);
  return { ...payload, signature };
}

function mockFetch(response, status = 200) {
  return async (url, init) => {
    if (status !== 200) {
      const err = new Error("not ok");
      err.ok = false;
      err.status = status;
      throw err;
    }
    return {
      ok: true,
      status,
      json: async () => response
    };
  };
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "admin");
});

test("createHandoff resolveTier returns empty on bot unreachable", async () => {
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: mockFetchError()
  });
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
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
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
});

test("createHandoff resolveTier returns empty on malformed JSON response", async () => {
  const h = createHandoff({
    secret: SECRET,
    botUrl: "http://localhost:9876",
    homeGuildId: "143064109775060993",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("parse error"); } })
  });
  const tier = await h.resolveTier({ userId: "143064109775060993" });
  assert.equal(tier, "");
});

// ---- createOAuthTierResolver: handoff priority with bootstrap fallback ----

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
  const tier = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(tier, "admin");
});

test("createOAuthTierResolver falls back to bootstrap when handoff returns empty", async () => {
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
  const tier = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(tier, "owner");
});

test("createOAuthTierResolver returns empty when handoff fails and bootstrap denies", async () => {
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
      ownerAllowlist: ["999999999999999999"]
    },
    handoff
  });
  const tier = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(tier, "");
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
  const tier = await resolve({ userId: "143064109775060993", username: "test", guildIds: ["143064109775060993"] });
  assert.equal(tier, "owner");
});
