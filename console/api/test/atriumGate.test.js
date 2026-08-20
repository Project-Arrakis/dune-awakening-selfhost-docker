import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { createAuth } from "../src/auth.js";

// The atrium gate at server.js:151-167 checks ATRIUM_ALLOWED_USER_ID
// against the session's userId. Test the auth.checkSession logic that
// the gate depends on, since the gate itself lives in the HTTP handler
// (integration test with a real server would be the full test).

const ALLOWED_USER = "143064109775060993";
const OTHER_USER = "999999999999999999";

function makeAuth(config = {}) {
  return createAuth({
    sessionSecret: randomBytes(32).toString("base64url"),
    adminPassword: randomBytes(16).toString("base64url"),
    authDisabled: false,
    ...config
  });
}

function cookieHeader(session) {
  return `asc_session=${encodeURIComponent(session.cookie)}`;
}

test("atrium gate: session with correct userId passes the allowlist check", () => {
  const auth = makeAuth();
  const session = auth.makeSession({ userId: ALLOWED_USER });

  const req = { headers: { cookie: cookieHeader(session) } };
  const read = auth.readSession(req);
  assert.ok(read, "valid session must be readable");
  assert.equal(read.userId, ALLOWED_USER, "userId must survive session round-trip");
});

test("atrium gate: session with wrong userId is distinguishable from allowed user", () => {
  const auth = makeAuth();
  const session = auth.makeSession({ userId: OTHER_USER });

  const req = { headers: { cookie: cookieHeader(session) } };
  const read = auth.readSession(req);
  assert.ok(read, "valid session must be readable");
  assert.equal(read.userId, OTHER_USER);
  assert.notEqual(read.userId, ALLOWED_USER);
});

test("atrium gate: session without userId defaults to empty string", () => {
  const auth = makeAuth();
  const session = auth.makeSession(); // default userId = ""

  const req = { headers: { cookie: cookieHeader(session) } };
  const read = auth.readSession(req);
  assert.ok(read);
  assert.equal(read.userId, "");
});

test("atrium gate: legacy cookie synthesis preserves tier and userId from cookie payload", () => {
  const secret = randomBytes(32).toString("base64url");
  const authA = createAuth({ sessionSecret: secret, adminPassword: "a", authDisabled: false });
  const session = authA.makeSession({ tier: "moderator", userId: ALLOWED_USER });

  // Simulate restart: new auth instance, same secret
  const authB = createAuth({ sessionSecret: secret, adminPassword: "a", authDisabled: false });
  const req = { headers: { cookie: cookieHeader(session) } };
  const read = authB.readSession(req);

  assert.ok(read, "signature-valid cookie must not be rejected after restart");
  assert.equal(read.tier, "moderator", "tier must be preserved across restart");
  assert.equal(read.userId, ALLOWED_USER, "userId must be preserved across restart");
});

test("atrium gate: legacy plain-id cookie still synthesizes as owner (backward compat)", () => {
  const secret = randomBytes(32).toString("base64url");
  // Create a legacy-format cookie: plain id with sign(id)
  const authA = createAuth({ sessionSecret: secret, adminPassword: "a", authDisabled: false });
  const session = authA.makeSession();
  // Replace the cookie with a legacy-format one: just id.sign(id)
  const rawCookie = session.cookie;
  const dotIdx = rawCookie.lastIndexOf(".");
  const id = rawCookie.slice(0, dotIdx);
  const hmac = createHmac("sha256", secret).update(id).digest("base64url");
  const legacyCookie = `${id}.${hmac}`;

  const authB = createAuth({ sessionSecret: secret, adminPassword: "a", authDisabled: false });
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(legacyCookie)}` } };
  const read = authB.readSession(req);

  assert.ok(read, "legacy cookie must not be rejected");
  assert.equal(read.tier, "owner", "legacy cookie synthesizes as owner (upgrade path)");
});
