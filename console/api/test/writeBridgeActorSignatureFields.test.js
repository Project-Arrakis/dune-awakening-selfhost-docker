import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalActorSignaturePayload,
  signActorPayload,
  verifyActorSignature,
  constantTimeHexEqual,
  WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
} from "../src/integrations/discord/actorSignature.js";

const SECRET = "test-actor-secret";
const ACTOR = { userId: "111", username: "Alice", roleIds: ["mod"], guildId: "g1", channelId: "c1", interactionId: "i1", roleSnapshotAt: 1700000000 };

test("WRITE_BRIDGE_SIGNED_ACTOR_FIELDS is its own independent set, not the shared array", () => {
  assert.deepEqual(WRITE_BRIDGE_SIGNED_ACTOR_FIELDS, ["userId", "username", "roleIds", "guildId", "channelId", "roleSnapshotAt", "action", "params"]);
  assert.ok(!WRITE_BRIDGE_SIGNED_ACTOR_FIELDS.includes("interactionId"), "must not include interactionId -- nonce already binds the request");
});

test("canonicalActorSignaturePayload: default fields param is backward compatible (existing callers unaffected)", () => {
  const withDefault = canonicalActorSignaturePayload(ACTOR, 1700000000, "/api/integrations/discord/players/link");
  const withExplicitSharedFields = canonicalActorSignaturePayload(ACTOR, 1700000000, "/api/integrations/discord/players/link", ["userId", "guildId", "channelId", "roleIds", "interactionId"]);
  assert.equal(withDefault, withExplicitSharedFields);
});

test("signActorPayload + verifyActorSignature: a signature computed with WRITE_BRIDGE_SIGNED_ACTOR_FIELDS only verifies when the same fields are passed to verify", () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature } = signActorPayload(ACTOR, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };

  const result = verifyActorSignature({
    actorPayload: ACTOR,
    headers,
    config: { discordActorSecret: SECRET },
    route: "/api/integrations/discord/write/execute",
    required: true,
    fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
  });
  assert.equal(result.verified, true);
});

test("verifyActorSignature: a write-bridge signature does NOT verify against the shared (default) field set -- proves the two field sets are genuinely independent", () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature } = signActorPayload(ACTOR, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };

  assert.throws(
    () => verifyActorSignature({
      actorPayload: ACTOR,
      headers,
      config: { discordActorSecret: SECRET },
      route: "/api/integrations/discord/write/execute",
      required: true
      // fields omitted -- defaults to the SHARED array, must fail
    }),
    (error) => error.code === "invalid_actor_signature"
  );
});

test("verifyActorSignature: a tampered roleSnapshotAt invalidates the write-bridge signature (roleSnapshotAt is covered by the signature, not a separate unauthenticated field)", () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature } = signActorPayload(ACTOR, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };

  const tamperedActor = { ...ACTOR, roleSnapshotAt: 9999999999 };
  assert.throws(
    () => verifyActorSignature({
      actorPayload: tamperedActor,
      headers,
      config: { discordActorSecret: SECRET },
      route: "/api/integrations/discord/write/execute",
      required: true,
      fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
    }),
    (error) => error.code === "invalid_actor_signature"
  );
});

// [Layer 3 integration audit fix, CRITICAL] Before `action` was added to
// WRITE_BRIDGE_SIGNED_ACTOR_FIELDS, write/preview and write/execute's
// signature only bound the actor + route -- both routes are the SAME route
// for every action, so a captured, legitimately-signed envelope could be
// replayed with a completely different action and still verify. This test
// signs a payload extended with one action (matching routes.js's own
// readJsonWithActorSignature, which merges body.action into the signed
// payload before verification) and proves swapping the action invalidates
// the signature.
test("verifyActorSignature: a signed write-bridge envelope for one action does not verify for a different action (closes the cross-action replay gap)", () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedForWarn = { ...ACTOR, action: "player.warn" };
  const { signature } = signActorPayload(signedForWarn, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };

  const replayedForStop = { ...ACTOR, action: "server.stop" };
  assert.throws(
    () => verifyActorSignature({
      actorPayload: replayedForStop,
      headers,
      config: { discordActorSecret: SECRET },
      route: "/api/integrations/discord/write/execute",
      required: true,
      fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
    }),
    (error) => error.code === "invalid_actor_signature"
  );

  // Sanity: the original, untampered envelope still verifies -- proves the
  // failure above is specifically about the action mismatch, not some
  // unrelated break.
  const result = verifyActorSignature({
    actorPayload: signedForWarn,
    headers,
    config: { discordActorSecret: SECRET },
    route: "/api/integrations/discord/write/execute",
    required: true,
    fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
  });
  assert.equal(result.verified, true);
});

test("constantTimeHexEqual: exported, length-guarded before timingSafeEqual (never throws RangeError on mismatched length)", () => {
  assert.equal(constantTimeHexEqual("ab", "ab"), true);
  assert.equal(constantTimeHexEqual("ab", "abcd"), false);
  assert.equal(constantTimeHexEqual("", ""), false);
  assert.doesNotThrow(() => constantTimeHexEqual("a", "abcdef"));
});

// [Layer 3 integration audit fix, MEDIUM, issue #1052] Before this fix, "0"
// was silently reinterpreted as "use the 30s default" purely by accident of
// `Number("0") || 30`'s falsy-OR coercion, indistinguishable from any other
// invalid input landing on the default -- not a deliberate bounds decision.
// A true "zero tolerance" skew isn't actually practical to honor (ordinary
// network/clock skew would then reject every legitimate request), so this
// fix's explicit minimum (5s) deliberately treats "0" the same as any other
// out-of-range value: falls back to the real 30s default, now via clear,
// documented MIN/MAX bounds rather than an accidental coercion quirk.
test("verifyActorSignature: DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS=\"0\" is below the minimum and falls back to the 30s default (not honored as literal zero tolerance)", () => {
  const OLD = process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS;
  process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS = "0";
  try {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = now - 10; // within the true 30s default's acceptance window
    const { signature } = signActorPayload(ACTOR, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
    const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };
    assert.doesNotThrow(() => verifyActorSignature({
      actorPayload: ACTOR,
      headers,
      config: { discordActorSecret: SECRET },
      route: "/api/integrations/discord/write/execute",
      required: true,
      now,
      fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
    }));
  } finally {
    process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS = OLD;
  }
});

test("verifyActorSignature: an out-of-range huge DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS also falls back to the 30s default, never accepted unbounded", () => {
  const OLD = process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS;
  process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS = "999999999";
  try {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = now - 90; // outside the true 30s default's acceptance window
    const { signature } = signActorPayload(ACTOR, SECRET, timestamp, "/api/integrations/discord/write/execute", WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
    const headers = { "x-dune-actor-signature": signature, "x-dune-actor-timestamp": String(timestamp) };
    assert.throws(
      () => verifyActorSignature({
        actorPayload: ACTOR,
        headers,
        config: { discordActorSecret: SECRET },
        route: "/api/integrations/discord/write/execute",
        required: true,
        now,
        fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
      }),
      (error) => error.code === "stale_actor_signature"
    );
  } finally {
    process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS = OLD;
  }
});
