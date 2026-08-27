import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PASSWORD = "correct-horse-battery";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(port),
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_SECURE_COOKIES: "0",
      CONSOLE_TOTP_ENABLED: "1", // exercise the Tier 3 flow (default is off)
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("console did not become healthy in time");
}

function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

function api(port, path, { method = "POST", cookie, csrf, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}

function codeFor(secretBase32, offsetSteps = 0) {
  const secret = base32Decode(secretBase32);
  return totpCode(secret, Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

test("full enrollment: password login -> enroll -> TOTP login, with replay rejected", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);

    // 1. Fresh install: correct password -> enrollment required (no normal session).
    const login1 = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login1.status, 200);
    const body1 = await login1.json();
    assert.equal(body1.enrollmentRequired, true);
    assert.equal(body1.authenticated, undefined, "no normal session before enrollment");
    const enrollCookie = cookieFrom(login1);
    const enrollCsrf = body1.csrfToken;
    assert.ok(enrollCookie && enrollCsrf);

    // 2. The enrollment session is restricted -- a normal API is denied.
    const blocked = await api(port, "/api/auth/characters", { method: "GET", cookie: enrollCookie });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).enrollmentRequired, true);

    // 3. Setup: get the TOTP secret.
    const setup = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enrollCsrf });
    assert.equal(setup.status, 200);
    const { secret, otpauthUri, qrCodeDataUri } = await setup.json();
    assert.match(secret, /^[A-Z2-7]+$/);
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(qrCodeDataUri, /^data:image\/png;base64,/, "setup returns a renderable QR code for the setup screen");

    // 3b. A wrong code is rejected on confirm.
    const bad = await api(port, "/api/auth/2fa/confirm", { cookie: enrollCookie, csrf: enrollCsrf, body: { code: "000000" } });
    assert.equal(bad.status, 401);

    // 4. Confirm with the right code -> recovery codes shown once, session ended.
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie: enrollCookie, csrf: enrollCsrf, body: { code: codeFor(secret) } });
    assert.equal(confirm.status, 200);
    const confirmBody = await confirm.json();
    assert.equal(confirmBody.enrolled, true);
    assert.equal(confirmBody.recoveryCodes.length, 10);
    // the enrollment session is now invalid
    const afterConfirm = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enrollCsrf });
    assert.equal(afterConfirm.status, 403, "enrollment session is destroyed after confirm");

    // 5. Enrolled: password alone is not enough.
    const login2 = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login2.status, 401);
    assert.equal((await login2.json()).totpRequired, true);

    // 5b. RFC §4: the code just used to CONFIRM enrollment cannot be reused at
    // the forced first login (its step is seeded as already-consumed).
    const confirmStepCode = codeFor(secret);
    const replayConfirm = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: confirmStepCode } });
    assert.equal(replayConfirm.status, 401, "the confirm-time code is rejected as a replay at first login");

    // 6. Password + the NEXT step's TOTP -> authenticated.
    const theCode = codeFor(secret, 1);
    const login3 = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: theCode } });
    assert.equal(login3.status, 200, "password + the next step's TOTP signs in");
    assert.equal((await login3.json()).authenticated, true);

    // 7. Replay: the SAME code cannot be reused within its step.
    const login4 = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: theCode } });
    assert.equal(login4.status, 401, "a TOTP code cannot be replayed");
    assert.equal((await login4.json()).totpRequired, true);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("wrong password is rejected before any second-factor step", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-badpw-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const r = await api(port, "/api/auth/login", { body: { password: "wrong" } });
    assert.equal(r.status, 401);
    const b = await r.json();
    assert.equal(b.enrollmentRequired, undefined);
    assert.equal(b.totpRequired, undefined);
    assert.match(b.error, /Incorrect password/);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the 2fa endpoints reject a request with no enrollment session", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-nosession-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    assert.equal((await api(port, "/api/auth/2fa/setup")).status, 403);
    assert.equal((await api(port, "/api/auth/2fa/confirm", { body: { code: "123456" } })).status, 403);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("2fa/setup rejects a valid enrollment session that omits the CSRF token", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-csrf-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    const cookie = cookieFrom(login);
    const csrf = (await login.json()).csrfToken;
    // valid enroll cookie, NO csrf header -> rejected
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie })).status, 403);
    // with the csrf header -> accepted (proves the cookie itself is valid)
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie, csrf })).status, 200);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("login fails closed (503, no session) when the second-factor state file is corrupt", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-corrupt-"));
  // plant a corrupt second-factor file before the server reads it on login
  const genDir = join(tempDir, "runtime", "generated");
  mkdirSync(genDir, { recursive: true });
  writeFileSync(join(genDir, "console-second-factor.json"), "{ not valid json", { mode: 0o600 });
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(res.status, 503, "corrupt 2FA state must fail closed, never grant a session");
    const body = await res.json();
    assert.equal(body.authenticated, undefined);
    assert.equal(body.enrollmentRequired, undefined);
    assert.ok(!cookieFrom(res), "no session cookie on the fail-closed path");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a second enrollment that loses the race gets 409 already_configured", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-race-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    // two independent enrollment sessions (no factor configured yet, so each
    // password login yields an enroll session)
    const la = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    const ca = cookieFrom(la), sa = (await la.json()).csrfToken;
    const lb = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    const cb = cookieFrom(lb), sb = (await lb.json()).csrfToken;

    const setupA = await (await api(port, "/api/auth/2fa/setup", { cookie: ca, csrf: sa })).json();
    const setupB = await (await api(port, "/api/auth/2fa/setup", { cookie: cb, csrf: sb })).json();

    // A enrolls first -> 200
    const confA = await api(port, "/api/auth/2fa/confirm", { cookie: ca, csrf: sa, body: { code: codeFor(setupA.secret) } });
    assert.equal(confA.status, 200);
    // B's confirm now loses -> 409, and B's session is ended
    const confB = await api(port, "/api/auth/2fa/confirm", { cookie: cb, csrf: sb, body: { code: codeFor(setupB.secret) } });
    assert.equal(confB.status, 409, "the losing enrollment gets already_configured");
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie: cb, csrf: sb })).status, 403, "loser's session is invalidated");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Requirement 0: with CONSOLE_TOTP_ENABLED unset, password login is unchanged single-factor", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-flagoff-"));
  const console = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "" }); // flag OFF
  try {
    await waitForHealth(port);
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.equal(body.authenticated, true, "flag off -> immediate single-factor session");
    assert.equal(body.enrollmentRequired, undefined);
    // and the enrollment endpoints are inert (no enroll session is ever issued)
    const cookie = cookieFrom(login);
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie })).status, 403);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
