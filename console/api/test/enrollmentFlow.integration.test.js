import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
    const { secret, otpauthUri } = await setup.json();
    assert.match(secret, /^[A-Z2-7]+$/);
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);

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

    // 6. Password + current TOTP -> authenticated.
    const theCode = codeFor(secret);
    const login3 = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: theCode } });
    assert.equal(login3.status, 200, "password + valid TOTP signs in");
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
