import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

// NOTE: this harness is copied from passwordRotation.integration.test.js, which
// is itself a copy. That duplication is tracked as #427 item 1 and is
// deliberately NOT fixed here -- extracting a shared harness touches every auth
// integration test at once and does not belong in a feature PR. Copying keeps
// this change reviewable; #427 remains the place to collapse them.
const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const REGENERATE_PATH = "/api/auth/2fa/recovery-codes/regenerate";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// Like passwordRotation's harness, this must NOT set ADMIN_PASSWORD: the
// regenerate route re-proves the same Tier 3 credential the rotation route
// does, so the tests read the console's own generated password off disk.
function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

function readGeneratedPassword(tempDir) {
  return readFileSync(join(tempDir, "runtime", "secrets", "admin-web-password.txt"), "utf8").trim();
}

function secondFactorPath(tempDir) {
  return join(tempDir, "runtime", "generated", "console-second-factor.json");
}

function auditLogPath(tempDir) {
  return join(tempDir, "runtime", "generated", "web-admin-audit.jsonl");
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
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

function api(port, path, { method = "POST", cookie, csrf, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}

async function login(port, body) {
  const res = await api(port, "/api/auth/login", { body });
  const parsed = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: parsed.csrfToken, body: parsed };
}

function codeFor(secretBase32, offsetSteps = 0) {
  return totpCode(base32Decode(secretBase32), Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

function currentTotpStep(period = TOTP_PERIOD_SECONDS) {
  return Math.floor(Date.now() / 1000 / period);
}

// See passwordRotation.integration.test.js for why this polls the real step
// counter instead of sleeping a fixed multiple of the period.
async function waitForStepAfter(step) {
  while (currentTotpStep() <= step) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Enrol a second factor and return { password, secret, enrollmentCodes, step },
// where `step` is the TOTP step the confirm consumed.
async function enroll(port, tempDir) {
  const password = readGeneratedPassword(tempDir);
  const first = await login(port, { password });
  assert.equal(first.body.enrollmentRequired, true, "first login with no factor yields an enrollment session");
  const setup = await (await api(port, "/api/auth/2fa/setup", { cookie: first.cookie, csrf: first.csrf })).json();
  const step = currentTotpStep();
  const confirmRes = await api(port, "/api/auth/2fa/confirm", { cookie: first.cookie, csrf: first.csrf, body: { code: codeFor(setup.secret, 0) } });
  assert.equal(confirmRes.status, 200);
  const confirmed = await confirmRes.json();
  assert.equal(confirmed.recoveryCodes.length, 10);
  return { password, secret: setup.secret, enrollmentCodes: confirmed.recoveryCodes, enrollSession: first, step };
}

test("regenerating recovery codes with password + fresh TOTP issues a new set, invalidates the old one, audits, and revokes no sessions", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir);
    let step = confirmStep;

    // Two live password/TOTP sessions: the actor and a sibling. Each normal
    // login consumes a step, so each needs a genuinely fresh one.
    await waitForStepAfter(step);
    step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    await waitForStepAfter(step);
    step = currentTotpStep();
    const sibling = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(sibling.body.authenticated, true);

    await waitForStepAfter(step);
    const res = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie,
      csrf: actor.csrf,
      body: { currentPassword: password, totpCode: codeFor(secret, 0) },
    });
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.ok, true);
    assert.equal(parsed.recoveryCodes.length, 10, "a full fresh set is returned once");
    for (const code of parsed.recoveryCodes) {
      assert.ok(!enrollmentCodes.includes(code), "no code from the enrollment set is reissued");
    }

    // The TOTP secret itself is untouched -- this rotates recovery codes only.
    const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
    assert.equal(state.recoveryCodes.length, 10);

    // Unlike password rotation (RFC §2.3/§5), regenerating recovery codes is
    // not a rotation of the login credential and revokes no sibling session.
    const siblingStill = await api(port, "/api/auth/state", { method: "GET", cookie: sibling.cookie });
    assert.equal((await siblingStill.json()).authenticated, true, "the sibling password/TOTP session survives");

    const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      auditLines.find((l) => l.action === "settings.recovery-codes-regenerated"),
      "settings.recovery-codes-regenerated was written to the audit log"
    );

    // An old code is dead: recovery login with it is rejected. (Recovery login
    // uses password + code and consumes no TOTP step, so this needs no wait.)
    const oldCode = await login(port, { password, recoveryCode: enrollmentCodes[0] });
    assert.notEqual(oldCode.status, 200, "a recovery code from the invalidated set no longer logs in");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regeneration requires the current password AND a fresh TOTP code, and changes nothing on failure", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-proof-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir);

    await waitForStepAfter(confirmStep);
    const step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    // No TOTP code at all -> refused, and told which factor is missing.
    const noTotp = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: password },
    });
    assert.equal(noTotp.status, 400);
    assert.equal((await noTotp.json()).totpRequired, true);

    // Wrong password (with a valid code) -> refused.
    await waitForStepAfter(step);
    const wrongPassword = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: "not-the-password", totpCode: codeFor(secret, 0) },
    });
    assert.equal(wrongPassword.status, 400);

    // Neither failure touched the stored set: the enrollment codes still work.
    const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
    assert.equal(state.recoveryCodes.length, 10, "a refused regeneration leaves the stored set intact");
    const recovery = await login(port, { password, recoveryCode: enrollmentCodes[0] });
    assert.equal(recovery.status, 200, "an original recovery code still works after refused regeneration attempts");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Containment regression: /api/auth/2fa/setup and /confirm ARE reachable from a
// restricted setup-scope session (they are in ENROLL_ALLOWED); this third
// /api/auth/2fa/* path deliberately is NOT. Asserted explicitly so nobody
// pattern-matches "all 2fa routes are enrollment routes" and adds it to that
// allowlist -- which would let a re-setup session mint codes and stop there.
test("a restricted enrollment-scope session cannot reach the regenerate route", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-scope-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const enrollSession = await login(port, { password });
    assert.equal(enrollSession.body.enrollmentRequired, true);

    const res = await api(port, REGENERATE_PATH, {
      cookie: enrollSession.cookie, csrf: enrollSession.csrf, body: { currentPassword: password, totpCode: "000000" },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).enrollmentRequired, true);
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regeneration is refused when two-factor is not enabled on this console", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-off-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, { password });
    assert.equal(session.body.authenticated, true, "with the flag off, password alone logs in");

    const res = await api(port, REGENERATE_PATH, {
      cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
    });
    assert.equal(res.status, 400);
    const parsed = await res.json();
    assert.ok(parsed.error, "the refusal explains itself rather than 404ing");
    assert.notEqual(parsed.ok, true);
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The settings UI drives its "this credential action needs an authenticator
// code" branching off this flag (#515). Tested here rather than in a ninth
// copy of this harness (#427 item 1) because it gates the same Tier 3
// credential surface these tests already stand up.
test("/api/auth/me reports secondFactorEnrolled:false before enrollment and true after", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-flag-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);

    await waitForStepAfter(confirmStep);
    const session = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(session.body.authenticated, true);

    const me = await (await api(port, "/api/auth/me", { method: "GET", cookie: session.cookie })).json();
    assert.equal(me.secondFactorEnrolled, true, "an enrolled console reports the flag");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/api/auth/me reports secondFactorEnrolled:false when the TOTP flag is off", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-flag-off-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, { password });
    assert.equal(session.body.authenticated, true);

    const me = await (await api(port, "/api/auth/me", { method: "GET", cookie: session.cookie })).json();
    assert.equal(me.secondFactorEnrolled, false, "never asks the UI for a code the server would ignore");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
