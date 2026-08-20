import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAuth, clearSessionCookie, setSessionCookie, json, serializeJsonResponse } from "../src/auth.js";

test("auth creates readable signed sessions", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req)?.id, session.id);
  assert.equal(auth.passwordMatches("admin"), true);
  assert.equal(auth.passwordMatches("wrong"), false);
});

test("auth keeps tier and identity in the server-side session while the cookie remains opaque", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession({ tier: "moderator", userId: "123", username: "Tester" });
  assert.equal(session.cookie.split(".")[0], session.id);
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } })?.tier, "moderator");

});

test("auth uses the injected clock for session expiry", () => {
  let currentTime = 1_700_000_000_000;
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false, now: () => currentTime });
  const session = auth.makeSession();
  currentTime += 12 * 60 * 60 * 1000 + 1;
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } }), null);
});

test("auth rejects state-changing requests without CSRF token", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { method: "POST", headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  const res = fakeResponse();
  assert.equal(auth.requireAuth(req, res), null);
  assert.equal(res.status, 403);
});

test("auth accepts state-changing requests with CSRF token", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { method: "POST", headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}`, "x-csrf-token": session.csrf } };
  const res = fakeResponse();
  assert.equal(auth.requireAuth(req, res)?.id, session.id);
  assert.equal(res.status, null);
});

test("session cookies can opt into Secure for production/container deployments", () => {
  const res = fakeResponse();
  setSessionCookie(res, { cookie: "abc.sig" }, { secureCookies: true });
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);
  assert.match(res.headers["Set-Cookie"], /Secure/);

  clearSessionCookie(res, { secureCookies: true });
  assert.match(res.headers["Set-Cookie"], /Max-Age=0/);
  assert.match(res.headers["Set-Cookie"], /Secure/);
});

test("json responses include defensive browser headers", () => {
  const res = fakeResponse();
  json(res, 200, { ok: true });
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["permissions-policy"], /camera=\(\)/);
});

test("auth rejects a cookie whose HMAC signature was tampered", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const tampered = session.cookie.slice(0, -2) + (session.cookie.endsWith("aa") ? "bb" : "aa");
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(tampered)}` } };
  assert.equal(auth.readSession(req), null);
});

test("auth rejects an expired session", () => {
  let currentTime = 1_700_000_000_000;
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false, now: () => currentTime });
  const session = auth.makeSession();
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } })?.id, session.id);
  currentTime += 12 * 60 * 60 * 1000 + 1000;
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req), null);
});

// A signature-valid cookie whose session id is no longer in the in-memory
// Map (e.g. after a restart) MUST be rejected outright, not resurrected
// with tier/identity synthesized from the cookie itself. See CRITICAL
// issue #309: the fork's earlier "upgrade path" behavior (a since-deleted
// test previously here) allowed anyone holding sessionSecret to forge an
// arbitrary-tier session for an id that was never actually issued, and
// made session revocation (tier downgrade, password rotation, #139)
// impossible, since any Map eviction re-synthesized the original tier.
test("a signature-valid cookie with no matching in-memory session is rejected, not resurrected", () => {
  const auth = createAuth({ sessionSecret: "shared-secret", adminPassword: "admin", authDisabled: false });
  // Simulates an attacker who has obtained sessionSecret (e.g. a leaked
  // runtime/secrets/admin-web-session-secret.txt) forging a brand-new,
  // never-issued session id -- or, equivalently, a legitimately-issued
  // session id whose Map entry no longer exists (server restart, explicit
  // revocation). Either way, the signature alone proves nothing about
  // tier/identity in this design; only an actual Map entry does.
  const forgedId = "forged-id-that-was-never-issued";
  const forgedSignature = createHmac("sha256", "shared-secret").update(forgedId).digest("base64url");
  const forgedCookie = `${forgedId}.${forgedSignature}`;
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(forgedCookie)}` } };
  assert.equal(auth.readSession(req), null);
});

test("makeSession defaults to owner tier and carries identity fields", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const plain = auth.makeSession();
  assert.equal(plain.tier, "owner");
  assert.equal(plain.userId, "");

  const oauth = auth.makeSession({ tier: "owner", userId: "123456789012345678", username: "operator", guildId: "987654321098765432" });
  assert.equal(oauth.tier, "owner");
  assert.equal(oauth.userId, "123456789012345678");
  assert.equal(oauth.username, "operator");
  assert.equal(oauth.guildId, "987654321098765432");

  const readBack = auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(oauth.cookie)}` } });
  assert.equal(readBack?.tier, "owner");
  assert.equal(readBack?.userId, "123456789012345678");
  assert.equal(readBack?.username, "operator");
});

test("ADMIN_AUTH_DISABLED=1 returns dev owner session, bypasses password and CSRF", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: true });
  const req = { method: "POST", headers: {} };
  const res = fakeResponse();
  const session = auth.requireAuth(req, res);
  assert.equal(session?.id, "dev");
  assert.equal(session?.tier, "owner");
  assert.equal(session?.csrf, "dev");
  assert.equal(res.status, null);
  assert.equal(auth.passwordMatches("anything"), false); // disabled doesn't skip passwordMatches
});

test("logout deletes session and cookie is cleared", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const cookieValue = session.cookie;
  const res = fakeResponse();
  clearSessionCookie(res, { secureCookies: false });
  assert.match(res.headers["Set-Cookie"], /Max-Age=0/);
  assert.match(res.headers["Set-Cookie"], /asc_session=;/);

  // After logout cookie is sent, the old session cookie should be rejected
  // because the in-memory session should be deleted by the logout handler.
  // This test verifies the cookie-clearing side; the server-side deletion
  // is tested in the integration layer.
});

test("when authDisabled is false, missing cookie returns null", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  assert.equal(auth.readSession({ headers: {} }), null);
});

test("constant-time HMAC comparison rejects mismatched signatures", () => {
  const auth = createAuth({ sessionSecret: "secret-a", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const otherAuth = createAuth({ sessionSecret: "secret-b", adminPassword: "admin", authDisabled: false });
  const otherSession = otherAuth.makeSession();

  // Tamper by swapping signatures between two different secrets
  const [idA] = session.cookie.split(".");
  const [, sigB] = otherSession.cookie.split(".");
  const tamperedCookie = `${idA}.${sigB}`;
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(tamperedCookie)}` } }), null);
});

test("json response serialization preserves ordinary public payloads", () => {
  const output = serializeJsonResponse({ ok: true, result: { status: "ready" } });
  assert.deepEqual(JSON.parse(output), { ok: true, result: { status: "ready" } });
});

function fakeResponse() {
  return {
    status: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    }
  };
}
