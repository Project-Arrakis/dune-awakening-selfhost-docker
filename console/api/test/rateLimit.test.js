import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, createMutationRateLimiter } from "../src/rateLimit.js";

test("login rate limiter blocks repeated failures and resets after success", () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({
    maxAttempts: 3,
    globalMaxAttempts: 99,
    windowMs: 1000,
    blockMs: 5000,
    now: () => currentTime
  });

  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, false);
  assert.equal(limiter.check("client").allowed, false);

  currentTime += 5001;
  assert.equal(limiter.check("client").allowed, true);
  limiter.recordFailure("client");
  limiter.recordSuccess("client");
  assert.equal(limiter.check("client").allowed, true);
});

test("login rate limiter blocks aggregate failures across rotating clients", () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({
    maxAttempts: 99,
    globalMaxAttempts: 4,
    windowMs: 1000,
    blockMs: 5000,
    now: () => currentTime
  });

  assert.equal(limiter.recordFailure("client-a").allowed, true);
  assert.equal(limiter.recordFailure("client-b").allowed, true);
  assert.equal(limiter.recordFailure("client-c").allowed, true);
  assert.equal(limiter.recordFailure("client-d").allowed, false);
  assert.equal(limiter.check("client-e").allowed, false);

  limiter.recordSuccess("client-a");
  assert.equal(limiter.check("client-e").allowed, false);

  currentTime += 5001;
  assert.equal(limiter.check("client-e").allowed, true);
});

test("mutation rate limiter blocks repeated authenticated writes and resets after the window", () => {
  let currentTime = 1000;
  const limiter = createMutationRateLimiter({
    maxRequests: 2,
    globalMaxRequests: 99,
    windowMs: 1000,
    now: () => currentTime
  });

  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-intel").allowed, false);
  assert.equal(limiter.check("session-a:players.add-currency").allowed, true);

  currentTime += 1001;
  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
});

test("mutation rate limiter applies a global cap across rotating write scopes", () => {
  let currentTime = 1000;
  const limiter = createMutationRateLimiter({
    maxRequests: 99,
    globalMaxRequests: 3,
    windowMs: 1000,
    now: () => currentTime
  });

  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-currency").allowed, true);
  limiter.record("session-a:players.add-currency");
  assert.equal(limiter.check("session-a:database.row-update").allowed, true);
  limiter.record("session-a:database.row-update");
  assert.equal(limiter.check("session-a:players.give-item").allowed, false);

  currentTime += 1001;
  assert.equal(limiter.check("session-a:players.give-item").allowed, true);
});
