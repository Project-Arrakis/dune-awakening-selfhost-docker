// Module-level singleton state for the Discord write bridge (issue #215).
// routes.js's handleDiscordAdapterRoute() is otherwise a pure per-request
// function -- this is the one piece of real, in-process state the write
// bridge needs (the nonce store), held here rather than inline in routes.js
// so tests can reset/inject a fresh store without reaching into routes.js's
// own module state.
import { createWriteNonceStore } from "./writeNonceStore.js";

let nonceStore = null;

export function getWriteNonceStore() {
  if (!nonceStore) {
    nonceStore = createWriteNonceStore();
    nonceStore.startPruning();
  }
  return nonceStore;
}

// Test-only: force a fresh store (and let the old one's prune timer die
// naturally via unref) so tests don't leak nonces across test files.
export function resetWriteNonceStoreForTests() {
  if (nonceStore) nonceStore.stopPruning();
  nonceStore = null;
}
