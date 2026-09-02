import test from "node:test";
import assert from "node:assert/strict";
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

test("auth (F3, #573): roleName is carried on the session when provided, and absent entirely when not", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const withName = auth.makeSession({ tier: "admin", userId: "123", username: "Tester", roleName: "Heavy Bats" });
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(withName.cookie)}` } };
  assert.equal(auth.readSession(req)?.roleName, "Heavy Bats");

  const withoutName = auth.makeSession({ tier: "admin", userId: "456", username: "Other" });
  const req2 = { headers: { cookie: `asc_session=${encodeURIComponent(withoutName.cookie)}` } };
  assert.equal("roleName" in auth.readSession(req2), false, "no roleName was given -- must not appear as a phantom undefined field");
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
