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
  assert.deepEqual(WRITE_BRIDGE_SIGNED_ACTOR_FIELDS, ["userId", "username", "roleIds", "guildId", "channelId", "roleSnapshotAt"]);
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

test("constantTimeHexEqual: exported, length-guarded before timingSafeEqual (never throws RangeError on mismatched length)", () => {
  assert.equal(constantTimeHexEqual("ab", "ab"), true);
  assert.equal(constantTimeHexEqual("ab", "abcd"), false);
  assert.equal(constantTimeHexEqual("", ""), false);
  assert.doesNotThrow(() => constantTimeHexEqual("a", "abcdef"));
});
