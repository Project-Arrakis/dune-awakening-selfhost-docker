// Nonce store for the Discord write bridge. write/preview mints a nonce binding one specific actor,
// action, and params; write/execute consumes it exactly once. In-memory only
// -- a server restart mid-confirmation simply expires the pending nonce
// (nothing has mutated yet, so losing it is safe; the user just retries).
import { randomUUID } from "node:crypto";

// General 60s TTL, with named per-action overrides: restart's post-match 30s cancellable countdown needs the
// nonce to still be valid when write/execute is finally called, so its TTL
// is widened to 90s (60s window + 30s countdown budget) at issuance, not
// renegotiated at confirm time. stop's own TTLs depend on which confirmation
// path is taken (single-admin fallback vs. 2+-admin dual-confirmation) and
// are resolved by the caller, not this generic default table, since they
// depend on runtime state (how many eligible admins exist) this store has
// no way to know on its own.
const GENERAL_TTL_SECONDS = 60;
const ACTION_TTL_OVERRIDES = {
  "server.restart": 90
};

// Eviction policy: entries are pruned on a periodic timer, with a
// max-entries-per-actor bound as a belt-and-braces cap against unbounded
// growth from a misbehaving moderator+ actor flooding write/preview (cheap
// to call repeatedly since it doesn't mutate anything).
const MAX_ENTRIES_PER_ACTOR = 20;
const DEFAULT_PRUNE_INTERVAL_MS = 30_000;

export function defaultTtlSecondsForAction(action) {
  return Object.hasOwn(ACTION_TTL_OVERRIDES, action) ? ACTION_TTL_OVERRIDES[action] : GENERAL_TTL_SECONDS;
}

export function createWriteNonceStore({ now = () => Date.now(), pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS } = {}) {
  const entries = new Map();
  let pruneTimer = null;

  function countForActor(actorUserId) {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.actorUserId === actorUserId) count++;
    }
    return count;
  }

  function prune() {
    const nowMs = now();
    for (const [nonce, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(nonce);
    }
  }

  function create({ actorUserId, action, params, ttlSeconds }) {
    if (!actorUserId) throw new Error("actorUserId is required to create a write-bridge nonce");
    if (!action) throw new Error("action is required to create a write-bridge nonce");
    prune();
    if (countForActor(actorUserId) >= MAX_ENTRIES_PER_ACTOR) {
      throw new Error(`Too many pending confirmations for this actor (max ${MAX_ENTRIES_PER_ACTOR})`);
    }
    const nonce = randomUUID();
    const effectiveTtlSeconds = ttlSeconds ?? defaultTtlSecondsForAction(action);
    const expiresAt = now() + effectiveTtlSeconds * 1000;
    entries.set(nonce, {
      actorUserId,
      action,
      params: params || {},
      expiresAt,
      // Dual-confirmation fields for server.stop's 2+-admin gate. null/false
      // until that specific flow marks them -- every other action never
      // touches these.
      secondConfirmationRequired: false,
      primaryConfirmedAt: null
    });
    return { nonce, expiresAt };
  }

  // Single-use: deletes the entry on lookup, whether or not it was valid, so
  // a caller can never accidentally consume the same nonce twice by racing
  // its own retry logic. Returns null (not a thrown error) for "not found or
  // expired" -- the caller maps that to a 410 response, a distinct case
  // from every other rejection.
  function consume(nonce) {
    const entry = entries.get(nonce);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(nonce);
      return null;
    }
    entries.delete(nonce);
    return entry;
  }

  // Peek without consuming -- needed by the stop dual-confirmation flow,
  // which must inspect and mutate an entry (mark it pending) WITHOUT
  // deleting it, unlike every other action's single consume-and-execute call.
  function peek(nonce) {
    const entry = entries.get(nonce);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(nonce);
      return null;
    }
    return entry;
  }

  // Extends an existing, still-valid entry's expiry and marks it pending a
  // second confirmation, without deleting it -- used only by server.stop's
  // 2+-admin gate: the primary's own call does not consume the nonce, it
  // marks secondConfirmationRequired and extends the TTL to 5 minutes from
  // now.
  function markPendingSecondConfirmation(nonce, extendedTtlSeconds) {
    const entry = entries.get(nonce);
    if (!entry || entry.expiresAt <= now()) {
      entries.delete(nonce);
      return null;
    }
    entry.secondConfirmationRequired = true;
    entry.primaryConfirmedAt = now();
    entry.expiresAt = entry.primaryConfirmedAt + extendedTtlSeconds * 1000;
    return entry;
  }

  function size() {
    return entries.size;
  }

  function startPruning() {
    if (pruneTimer) return;
    pruneTimer = setInterval(prune, pruneIntervalMs);
    if (typeof pruneTimer.unref === "function") pruneTimer.unref();
  }

  function stopPruning() {
    if (!pruneTimer) return;
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  return { create, consume, peek, markPendingSecondConfirmation, prune, size, startPruning, stopPruning };
}
