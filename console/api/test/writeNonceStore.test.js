import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteNonceStore, defaultTtlSecondsForAction } from "../src/integrations/discord/writeNonceStore.js";

function fakeClock(startMs = 1_000_000) {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

test("defaultTtlSecondsForAction: general 60s, server.restart overridden to 90s", () => {
  assert.equal(defaultTtlSecondsForAction("player.kick"), 60);
  assert.equal(defaultTtlSecondsForAction("server.restart"), 90);
  assert.equal(defaultTtlSecondsForAction("server.stop"), 60);
});

test("create + consume: single round trip returns the same entry", () => {
  const store = createWriteNonceStore();
  const { nonce } = store.create({ actorUserId: "u1", action: "player.kick", params: { playerId: "p1" } });
  const entry = store.consume(nonce);
  assert.equal(entry.actorUserId, "u1");
  assert.equal(entry.action, "player.kick");
  assert.deepEqual(entry.params, { playerId: "p1" });
});

test("consume is single-use: a second consume of the same nonce returns null", () => {
  const store = createWriteNonceStore();
  const { nonce } = store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  assert.notEqual(store.consume(nonce), null);
  assert.equal(store.consume(nonce), null);
});

test("consume returns null for an unknown nonce, never throws", () => {
  const store = createWriteNonceStore();
  assert.equal(store.consume("not-a-real-nonce"), null);
});

test("consume returns null once the nonce has expired, using the general 60s TTL", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  clock.advance(60_001);
  assert.equal(store.consume(nonce), null);
});

test("consume succeeds just under the general 60s TTL boundary", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  clock.advance(59_000);
  assert.notEqual(store.consume(nonce), null);
});

test("server.restart gets the 90s override TTL, not the general 60s -- proves widening actually applies at issuance", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "server.restart", params: {} });
  clock.advance(89_000);
  assert.notEqual(store.consume(nonce), null, "must still be valid at 89s, inside the 90s override");
});

test("server.restart's own nonce still expires past 90s", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "server.restart", params: {} });
  clock.advance(90_001);
  assert.equal(store.consume(nonce), null);
});

test("caller can override TTL explicitly (server.stop's runtime-dependent TTL selection)", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "server.stop", params: {}, ttlSeconds: 30 });
  clock.advance(30_001);
  assert.equal(store.consume(nonce), null);
});

test("each nonce is scoped to its own actor -- consuming one actor's nonce never affects another's", () => {
  const store = createWriteNonceStore();
  const a = store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  const b = store.create({ actorUserId: "u2", action: "player.kick", params: {} });
  assert.notEqual(store.consume(a.nonce), null);
  assert.notEqual(store.consume(b.nonce), null);
});

test("max-entries-per-actor eviction cap: the 21st pending confirmation for one actor throws", () => {
  const store = createWriteNonceStore();
  for (let i = 0; i < 20; i++) {
    store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  }
  assert.throws(() => store.create({ actorUserId: "u1", action: "player.kick", params: {} }), /Too many pending confirmations/);
});

test("max-entries-per-actor cap is per-actor, not global -- a different actor is unaffected", () => {
  const store = createWriteNonceStore();
  for (let i = 0; i < 20; i++) {
    store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  }
  assert.doesNotThrow(() => store.create({ actorUserId: "u2", action: "player.kick", params: {} }));
});

test("create requires actorUserId and action, fails closed with a throw", () => {
  const store = createWriteNonceStore();
  assert.throws(() => store.create({ action: "player.kick", params: {} }), /actorUserId is required/);
  assert.throws(() => store.create({ actorUserId: "u1", params: {} }), /action is required/);
});

test("prune() removes expired entries so they no longer count against the per-actor cap", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  for (let i = 0; i < 20; i++) {
    store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  }
  clock.advance(60_001);
  // create() calls prune() internally before checking the cap.
  assert.doesNotThrow(() => store.create({ actorUserId: "u1", action: "player.kick", params: {} }));
});

test("peek(): returns the entry without consuming it", () => {
  const store = createWriteNonceStore();
  const { nonce } = store.create({ actorUserId: "u1", action: "server.stop", params: {} });
  const peeked = store.peek(nonce);
  assert.equal(peeked.actorUserId, "u1");
  // Still consumable afterwards -- peek must never delete.
  assert.notEqual(store.consume(nonce), null);
});

test("peek(): returns null for an expired entry and removes it", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "player.kick", params: {} });
  clock.advance(60_001);
  assert.equal(store.peek(nonce), null);
  assert.equal(store.size(), 0);
});

test("markPendingSecondConfirmation: extends TTL and marks the entry pending, without consuming it", () => {
  const clock = fakeClock();
  const store = createWriteNonceStore({ now: clock.now });
  const { nonce } = store.create({ actorUserId: "u1", action: "server.stop", params: {}, ttlSeconds: 30 });
  const marked = store.markPendingSecondConfirmation(nonce, 300);
  assert.equal(marked.secondConfirmationRequired, true);
  assert.equal(marked.primaryConfirmedAt, clock.now());

  // Original 30s TTL would have expired by now, but the 300s extension keeps it alive.
  clock.advance(250_000);
  assert.notEqual(store.peek(nonce), null);

  clock.advance(51_000); // total 301s past the extension point
  assert.equal(store.peek(nonce), null);
});

test("markPendingSecondConfirmation: returns null for an unknown or already-expired nonce", () => {
  const store = createWriteNonceStore();
  assert.equal(store.markPendingSecondConfirmation("unknown", 300), null);
});

test("startPruning/stopPruning: does not throw, and stopPruning is idempotent", () => {
  const store = createWriteNonceStore({ pruneIntervalMs: 10 });
  store.startPruning();
  store.stopPruning();
  assert.doesNotThrow(() => store.stopPruning());
});
