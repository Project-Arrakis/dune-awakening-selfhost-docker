import test from "node:test";
import assert from "node:assert/strict";
import { customizationGrantOutcome, liveItemGrantOk, liveItemGrantPublished, liveItemGrantWarning, summarizeCustomizationGrantResults } from "../src/grantResults.js";

test("live item grants fail verification when inventory did not change", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\n",
    stderr: "WARNING: publish succeeded, but the player's inventory stack did not increase for Cold Survival Exploration Suit.\n"
  };
  assert.equal(liveItemGrantOk(result), false);
  assert.equal(liveItemGrantPublished(result), true);
  assert.match(liveItemGrantWarning(result), /inventory did not change/i);
});

test("live item grants pass when command succeeds without verifier warning", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\nVerified full inventory grant: Cup of Water x10 (0 -> 10).\n",
    stderr: ""
  };
  assert.equal(liveItemGrantOk(result), true);
  assert.equal(liveItemGrantPublished(result), true);
  assert.equal(liveItemGrantWarning(result), "");
});

test("live item grants fail verification when only part of the quantity arrived", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\n",
    stderr: "WARNING: inventory grant was incomplete: requested 100, verified 20 for Cup of Water (0 -> 20).\n"
  };
  assert.equal(liveItemGrantOk(result), false);
  assert.equal(
    liveItemGrantWarning(result),
    "Published to RabbitMQ, but only 20 of 100 requested items were verified. The missing quantity was not retried to avoid duplicate items."
  );
});

test("customization grants keep accepted but immediately consumed tokens distinct from failures", () => {
  assert.deepEqual(
    customizationGrantOutcome({ ok: false, published: true }),
    { ok: true, verified: false, inventoryVerified: false, ownershipVerified: false, deliveryRequested: true }
  );
  assert.deepEqual(
    customizationGrantOutcome({ ok: false, published: false }),
    { ok: false, verified: false, inventoryVerified: false, ownershipVerified: false, deliveryRequested: false }
  );
  assert.deepEqual(
    customizationGrantOutcome({ ok: true, published: true }),
    { ok: true, verified: false, inventoryVerified: true, ownershipVerified: false, deliveryRequested: false }
  );
});

test("customization grant summaries count delivery requests separately from verified grants and failures", () => {
  assert.deepEqual(summarizeCustomizationGrantResults([
    { ok: true, verified: true },
    { ok: true, verified: false, deliveryRequested: true },
    { ok: true, skipped: true },
    { ok: false }
  ]), {
    ok: false,
    granted: 1,
    requested: 1,
    skipped: 1,
    failed: 1
  });
});
