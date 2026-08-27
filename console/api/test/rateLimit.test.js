import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, createMutationRateLimiter, resolveClientIp } from "../src/rateLimit.js";

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

// ---- resolveClientIp: X-Forwarded-For handling (finding #2, ultra review of PR #554) ----

function fakeReq(remoteAddress, forwardedFor) {
  const headers = {};
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  return { socket: { remoteAddress }, headers };
}

test("resolveClientIp: no trusted proxies -> always the socket peer, header ignored", () => {
  assert.equal(resolveClientIp(fakeReq("203.0.113.5", "1.2.3.4"), []), "203.0.113.5");
});

test("resolveClientIp: peer NOT in the trusted list -> header ignored (negative test)", () => {
  assert.equal(resolveClientIp(fakeReq("203.0.113.5", "1.2.3.4"), ["10.0.0.1"]), "203.0.113.5");
});

test("resolveClientIp: trusted appending proxy -> the RIGHTMOST entry, never the client-controlled leftmost", () => {
  // nginx's proxy_add_x_forwarded_for turns a spoofed leftmost into
  // "evil, <realpeer>": trusting [0] would key the limiter on the attacker's
  // chosen value (bypass) or a victim's IP (lockout). The rightmost is the one
  // the trusted proxy itself appended.
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", "1.1.1.1, 203.0.113.9"), ["10.0.0.1"]), "203.0.113.9");
});

test("resolveClientIp: trusted proxy, single forwarded entry -> that entry", () => {
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", "203.0.113.9"), ["10.0.0.1"]), "203.0.113.9");
});

test("resolveClientIp: trusted proxy, no forwarded header -> falls back to the socket peer", () => {
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", undefined), ["10.0.0.1"]), "10.0.0.1");
});
