import test from "node:test";
import assert from "node:assert/strict";
import { liveItemGrantOk, liveItemGrantWarning } from "../src/grantResults.js";

test("live item grants fail verification when inventory did not change", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\n",
    stderr: "WARNING: publish succeeded, but the player's inventory stack did not increase for Cold Survival Exploration Suit.\n"
  };
  assert.equal(liveItemGrantOk(result), false);
  assert.match(liveItemGrantWarning(result), /inventory did not change/i);
});

test("live item grants pass when command succeeds without verifier warning", () => {
  const result = {
    code: 0,
    stdout: "Grant item command published.\nVerified full inventory grant: Cup of Water x10 (0 -> 10).\n",
    stderr: ""
  };
  assert.equal(liveItemGrantOk(result), true);
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
