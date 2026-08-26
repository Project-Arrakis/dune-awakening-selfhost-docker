import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, createMutationRateLimiter, resolveClientIp } from "../src/rateLimit.js";

function fakeReq(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test("resolveClientIp: with no trusted proxies configured, always returns the raw socket address", () => {
  const req = fakeReq("203.0.113.9", { "x-forwarded-for": "198.51.100.1" });
  assert.equal(resolveClientIp(req, []), "203.0.113.9");
  assert.equal(resolveClientIp(req), "203.0.113.9");
});

test("resolveClientIp: strips the IPv4-mapped IPv6 prefix from the socket address", () => {
  assert.equal(resolveClientIp(fakeReq("::ffff:203.0.113.9"), []), "203.0.113.9");
});

test("resolveClientIp: an untrusted peer's X-Forwarded-For is ignored, even if present", () => {
  const req = fakeReq("203.0.113.9", { "x-forwarded-for": "198.51.100.1" });
  assert.equal(resolveClientIp(req, ["10.0.0.5"]), "203.0.113.9");
});

test("resolveClientIp: a trusted peer's X-Forwarded-For is honored, leftmost entry wins", () => {
  const req = fakeReq("10.0.0.5", { "x-forwarded-for": "198.51.100.1, 10.0.0.5" });
  assert.equal(resolveClientIp(req, ["10.0.0.5"]), "198.51.100.1");
});

test("resolveClientIp: trusted peer with no X-Forwarded-For header falls back to the socket address", () => {
  const req = fakeReq("10.0.0.5", {});
  assert.equal(resolveClientIp(req, ["10.0.0.5"]), "10.0.0.5");
});

test("resolveClientIp: a spoofed empty forwarded entry falls back to the socket address rather than key on ''", () => {
  const req = fakeReq("10.0.0.5", { "x-forwarded-for": "" });
  assert.equal(resolveClientIp(req, ["10.0.0.5"]), "10.0.0.5");
});

test("resolveClientIp: missing socket address never throws and returns 'unknown'", () => {
  assert.equal(resolveClientIp({ headers: {} }, []), "unknown");
  assert.equal(resolveClientIp({ headers: {} }, ["10.0.0.5"]), "unknown");
});

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
