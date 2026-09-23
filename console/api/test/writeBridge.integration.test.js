// Live-process integration tests for the Discord write bridge (issue #215).
// Follows discordAdapter.test.js's established "mount handleDiscordAdapterRoute
// on a real http.createServer and fetch it" pattern -- these tests exercise
// the real route handlers, real bearer-token check, real actor-signature
// verification, real capability/tier checks, and the real nonce store, not
// mocks of any of them. This file's own harness never runs a real
// write-bridge socket server, so write/execute's real Hop-B dispatch always
// reaches its own honest 503 write_backend_unavailable boundary here by
// design -- proving everything up to and including the dispatch attempt
// itself is real, tested validation. writeBridgeEndToEnd.integration.test.js
// covers the real socket + real mutation side of Hop B that this file
// deliberately doesn't.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDiscordAdapterRoute } from "../src/integrations/discord/routes.js";
import { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER, WRITE_BRIDGE_SIGNED_ACTOR_FIELDS } from "../src/integrations/discord/actorSignature.js";
import { resetWriteNonceStoreForTests } from "../src/integrations/discord/writeBridgeState.js";
import { setRequiresDualConfirmationForTests, resetRequiresDualConfirmationOverridesForTests } from "../src/integrations/discord/writeActionRoutes.js";

const BOT_TOKEN = "write-bridge-test-bot-token";
const ACTOR_SECRET = "write-bridge-test-actor-secret";

function actor(roleIds, overrides = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    roleIds,
    roleSnapshotAt: Math.floor(Date.now() / 1000),
    ...overrides
  };
}

function signedHeaders(actorPayload, route) {
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature } = signActorPayload(actorPayload, ACTOR_SECRET, timestamp, route, WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
}

async function withServer(testConfig, fn) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://local");
    const path = url.pathname;
    const readJson = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    };
    const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
    await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json });
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let tempDir;
let tokenFile;
let auditLog;
let generatedDir;
let testConfig;
let OLD_ACTOR_SECRET;
let OLD_WRITES_ENABLED;
let OLD_MODERATOR_ROLE_IDS;
let OLD_ADMIN_ROLE_IDS;
let OLD_OWNER_ROLE_IDS;

test.beforeEach(() => {
  resetWriteNonceStoreForTests();
  resetRequiresDualConfirmationOverridesForTests();
  tempDir = mkdtempSync(join(tmpdir(), "write-bridge-test-"));
  tokenFile = join(tempDir, "bot-token.txt");
  auditLog = join(tempDir, "audit.jsonl");
  generatedDir = join(tempDir, "generated");
  writeFileSync(tokenFile, BOT_TOKEN);
  testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog, generatedDir, discordWritesEnabled: true };

  OLD_ACTOR_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  OLD_WRITES_ENABLED = process.env.DUNE_DISCORD_WRITES_ENABLED;
  OLD_MODERATOR_ROLE_IDS = process.env.DISCORD_MODERATOR_ROLE_IDS;
  OLD_ADMIN_ROLE_IDS = process.env.DISCORD_ADMIN_ROLE_IDS;
  OLD_OWNER_ROLE_IDS = process.env.DISCORD_OWNER_ROLE_IDS;
  process.env.DUNE_DISCORD_ACTOR_SECRET = ACTOR_SECRET;
  process.env.DUNE_DISCORD_WRITES_ENABLED = "1";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "role-moderator";
  process.env.DISCORD_ADMIN_ROLE_IDS = "role-admin";
  process.env.DISCORD_OWNER_ROLE_IDS = "role-owner";
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  resetWriteNonceStoreForTests();
  resetRequiresDualConfirmationOverridesForTests();
  process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_WRITES_ENABLED = OLD_WRITES_ENABLED;
  process.env.DISCORD_MODERATOR_ROLE_IDS = OLD_MODERATOR_ROLE_IDS;
  process.env.DISCORD_ADMIN_ROLE_IDS = OLD_ADMIN_ROLE_IDS;
  process.env.DISCORD_OWNER_ROLE_IDS = OLD_OWNER_ROLE_IDS;
});

const PREVIEW_ROUTE = "/api/integrations/discord/write/preview";
const EXECUTE_ROUTE = "/api/integrations/discord/write/execute";

test("write/preview: no bot token -> 401, before any body is even read", async () => {
  await withServer(testConfig, async (base) => {
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "missing_bot_token");
  });
});

test("write/preview: valid bot token but unsigned actor -> 403 (actor signing required, not optional, for this route)", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ actor: a, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "missing_actor_signature");
  });
});

test("write/preview: signed with the SHARED (default) field set instead of WRITE_BRIDGE_SIGNED_ACTOR_FIELDS -> rejected -- proves the two field sets are genuinely enforced as independent at the real route, not just in unit tests", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(a, ACTOR_SECRET, timestamp, PREVIEW_ROUTE); // no fields override -> shared array
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) },
      body: JSON.stringify({ actor: a, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "invalid_actor_signature");
  });
});

test("write/preview: writes disabled -> 403 writes_disabled, checked before actor signature", async () => {
  process.env.DUNE_DISCORD_WRITES_ENABLED = "0";
  testConfig.discordWritesEnabled = false;
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "writes_disabled");
  });
});

test("write/preview: public tier (no role) -> 403 not_authorized, real end-to-end capability rejection", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor([]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "not_authorized");
  });
});

test("write/preview: moderator attempting an owner-tier action -> 403 not_authorized -- proves meetsMinTier is a REAL, independent second gate beyond the coarse WRITE_BRIDGE_ACCESS capability", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.give-item", params: { playerId: "Server#4242" } })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "not_authorized");
  });
});

test("write/preview: moderator attempting a moderator-tier action succeeds -- positive control proving the tier gate isn't just blanket-denying (QA hat's earlier finding, addressed)", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.warn" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.nonce);
    assert.ok(body.expiresAt);
  });
});

test("write/preview: owner attempting the same owner-tier action that rejected a moderator succeeds -- proves the gate is keyed off the real actor's tier, not a constant", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-owner"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.give-item", params: { playerId: "Server#4242" } })
    });
    assert.equal(response.status, 200);
  });
});

test("write/preview: path-traversal-shaped param is rejected with 400, never silently accepted into the internal path template", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-admin"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.kick", params: { playerId: ".." } })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "invalid_parameters");
  });
});

test("write/preview: unknown action -> 400 unknown_write_action, not a 500 or silent pass-through", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-owner"]);
    const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
      body: JSON.stringify({ actor: a, action: "player.does-not-exist" })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "unknown_write_action");
  });
});

// --- write/execute: full round trip through the real nonce store ---

async function preview(base, a, action, params) {
  const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE) },
    body: JSON.stringify({ actor: a, action, params })
  });
  assert.equal(response.status, 200, `preview failed: ${JSON.stringify(await response.clone().json())}`);
  return response.json();
}

test("full round trip: preview -> execute reaches the real Hop-B boundary (503, not a silent success) when no write-bridge socket is running -- everything up to the boundary is real, tested validation", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const { nonce } = await preview(base, a, "player.warn");

    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: a, nonce, action: "player.warn" })
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "write_backend_unavailable");
  });
});

test("write/execute: nonce is single-use -- a second execute with the same nonce gets 410, not a repeated attempt at the mutation", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const { nonce } = await preview(base, a, "player.warn");

    const first = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: a, nonce, action: "player.warn" })
    });
    assert.equal(first.status, 503); // consumes the nonce even though no socket server is running in this test

    const second = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: a, nonce, action: "player.warn" })
    });
    assert.equal(second.status, 410);
    const body = await second.json();
    assert.equal(body.code, "nonce_not_found");
  });
});

test("write/execute: unknown nonce -> 410, never a 500 or crash", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: a, nonce: "not-a-real-nonce", action: "player.warn" })
    });
    assert.equal(response.status, 410);
  });
});

test("write/execute: a different actor presenting someone else's nonce is rejected -- real exact-actor-binding enforcement, not just documented intent", async () => {
  await withServer(testConfig, async (base) => {
    const owner = actor(["role-owner"], { userId: "owner-user" });
    const { nonce } = await preview(base, owner, "player.give-item", { playerId: "Server#4242" });

    const attacker = actor(["role-owner"], { userId: "attacker-user" });
    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(attacker, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: attacker, nonce, action: "player.give-item" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "nonce_actor_mismatch");
  });
});

test("write/execute: action mismatch between preview and execute is rejected with 409", async () => {
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const { nonce } = await preview(base, a, "player.warn");

    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: a, nonce, action: "player.kick", params: { playerId: "Server#4242" } })
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "nonce_action_mismatch");
  });
});

test("write/execute: stale roleSnapshotAt (older than the freshness window) is rejected with 403 stale_actor_signature", async () => {
  await withServer(testConfig, async (base) => {
    const fresh = actor(["role-moderator"]);
    const { nonce } = await preview(base, fresh, "player.warn");

    const stale = actor(["role-moderator"], { roleSnapshotAt: Math.floor(Date.now() / 1000) - 9999 });
    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(stale, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: stale, nonce, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "stale_actor_signature");
  });
});

test("write/execute: malformed roleSnapshotAt (NaN-shaped) is rejected, never silently passes the freshness check (regression guard for the exact bug class the design doc warns about: Math.abs(now-NaN) > N is always false)", async () => {
  await withServer(testConfig, async (base) => {
    const fresh = actor(["role-moderator"]);
    const { nonce } = await preview(base, fresh, "player.warn");

    const malformed = actor(["role-moderator"], { roleSnapshotAt: "not-a-number" });
    const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(malformed, EXECUTE_ROUTE) },
      body: JSON.stringify({ actor: malformed, nonce, action: "player.warn" })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "invalid_actor_signature");
  });
});

// --- the generic dual-confirmation gate mechanism (issue #1019) ---
//
// These tests exercise the REAL dual-confirmation state machine in routes.js
// over real HTTP, exactly as they always have. What changed: they no longer
// ride on server.stop's own route-table flag, because server.stop no longer
// sets it (deliberate operator decision -- the companion bot's RBAC model
// makes owner tier exactly one account per guild, so a second, genuinely
// different owner-tier confirmer cannot exist in practice). No production
// action currently opts in.
//
// The mechanism itself is real, reusable, already-audited infrastructure that
// must not silently drop to unit-test-only coverage just because nothing
// currently opts in -- so these tests force the flag on for ONE already-real
// action (server.restart, chosen because it is owner-tier just like
// server.stop was, so every tier assertion below maps across unchanged) via
// writeActionRoutes.js's test-only setRequiresDualConfirmationForTests(),
// reset in this file's beforeEach/afterEach alongside
// resetWriteNonceStoreForTests(). Only that one boolean field is overridden:
// the action's real path, policyAction, min tier, audit behavior, nonce
// handling, and Hop-B dispatch are all genuinely unmodified.
const DUAL_CONFIRM_TEST_ACTION = "server.restart";

function forceDualConfirmation(action = DUAL_CONFIRM_TEST_ACTION) {
  setRequiresDualConfirmationForTests(action, true);
}

async function executeAs(base, a, nonce, action) {
  const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE) },
    body: JSON.stringify({ actor: a, nonce, action })
  });
  return { status: response.status, body: await response.json() };
}

test("the dual-confirmation gate mechanism (exercised via a test-only override, since no real action currently requires it): the first execute call marks the nonce pending a second confirmation and never reaches Hop B", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const primary = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, primary, DUAL_CONFIRM_TEST_ACTION);

    const first = await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(first.status, 202);
    assert.equal(first.body.code, "second_confirmation_required");
    assert.equal(first.body.nonce, nonce, "the same nonce is reused for the second confirmation, not a fresh one");
    assert.ok(first.body.expiresAt > Date.now(), "the extended TTL must be a real, later expiry");
  });
});

test("the dual-confirmation gate mechanism (test-only override): the SAME actor cannot provide both confirmations", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const primary = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, primary, DUAL_CONFIRM_TEST_ACTION);
    await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);

    const second = await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(second.status, 403);
    assert.equal(second.body.code, "second_confirmation_same_actor");
  });
});

test("the dual-confirmation gate mechanism (test-only override): a second, DIFFERENT owner-tier actor completes the confirmation and reaches the real Hop-B boundary", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const primary = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, primary, DUAL_CONFIRM_TEST_ACTION);
    const first = await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(first.status, 202);

    const secondAdmin = actor(["role-owner"], { userId: "owner-second" });
    const second = await executeAs(base, secondAdmin, nonce, DUAL_CONFIRM_TEST_ACTION);
    // No write-bridge socket is running in this test's config -- reaching the
    // 503 Hop-B boundary (rather than 202/403/410) is exactly the proof that
    // both confirmations passed and the real dispatch was actually attempted.
    assert.equal(second.status, 503);
    assert.equal(second.body.code, "write_backend_unavailable");
  });
});

test("the dual-confirmation gate mechanism (test-only override): after the second confirmation consumes the nonce, a third attempt gets 410, not a third dispatch attempt", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const primary = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, primary, DUAL_CONFIRM_TEST_ACTION);
    await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);
    const secondAdmin = actor(["role-owner"], { userId: "owner-second" });
    const second = await executeAs(base, secondAdmin, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(second.status, 503, "precondition: the nonce must have been genuinely consumed by the second call");

    const third = await executeAs(base, secondAdmin, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(third.status, 410);
    assert.equal(third.body.code, "nonce_not_found");
  });
});

test("the dual-confirmation gate mechanism (test-only override): a second confirmer who does not meet the min tier is rejected, independent of the primary confirmer's own tier", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const primary = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, primary, DUAL_CONFIRM_TEST_ACTION);
    await executeAs(base, primary, nonce, DUAL_CONFIRM_TEST_ACTION);

    // The vehicle action requires owner tier (the same min tier server.stop
    // has) -- an admin-tier second confirmer must still be rejected, proving
    // the tier gate is re-checked for whichever actor is presenting the
    // nonce, not only for the original previewer. The override changes only
    // requiresDualConfirmation, never the real min-tier table.
    const adminTierSecond = actor(["role-admin"], { userId: "admin-second" });
    const rejected = await executeAs(base, adminTierSecond, nonce, DUAL_CONFIRM_TEST_ACTION);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, "not_authorized");
  });
});

test("the dual-confirmation gate mechanism (test-only override): a non-dual-confirmation action is completely unaffected -- single actor, single call, straight to the Hop-B boundary", async () => {
  forceDualConfirmation();
  await withServer(testConfig, async (base) => {
    const a = actor(["role-moderator"]);
    const { nonce } = await preview(base, a, "player.warn");
    const response = await executeAs(base, a, nonce, "player.warn");
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "write_backend_unavailable");
  });
});

test("server.stop no longer requires dual confirmation at the real route: one owner-tier actor, one call, straight to the Hop-B boundary -- no 202 second_confirmation_required step", async () => {
  // The operator-approved flag flip, proven at the real HTTP route rather
  // than only against the route table. No override is set here: this is
  // server.stop's genuine, current production behavior.
  await withServer(testConfig, async (base) => {
    const owner = actor(["role-owner"], { userId: "owner-primary" });
    const { nonce } = await preview(base, owner, "server.stop");
    const response = await executeAs(base, owner, nonce, "server.stop");
    assert.equal(response.status, 503, `expected the Hop-B boundary, got ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, "write_backend_unavailable");
  });
});
