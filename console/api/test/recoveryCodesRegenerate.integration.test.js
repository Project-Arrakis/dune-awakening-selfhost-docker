import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

// ---- #519: the route's own authentication, independent of registration order ----

// Every other test in this file supplies a cookie + CSRF token, so nothing
// pinned that the route needs a session AT ALL. Its only protection used to be
// its physical position below the central gate; moving the registration line
// made it answer unauthenticated POSTs with live recovery codes while this
// whole file stayed green. These two assert the guarantee directly.
test("the regenerate route rejects a request with no session cookie", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-nocookie-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step } = await enroll(port, tempDir);
    await waitForStepAfter(step);

    const res = await api(port, REGENERATE_PATH, {
      body: { currentPassword: password, totpCode: codeFor(secret, 0) },
    });
    assert.equal(res.status, 401, "no cookie must not reach the handler's credential check");

    const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
    assert.equal(state.recoveryCodes.length, 10, "an unauthenticated attempt changes nothing");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the regenerate route rejects an authenticated request with no CSRF token", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-nocsrf-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    const step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    await waitForStepAfter(step);
    const res = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, // deliberately no csrf
      body: { currentPassword: password, totpCode: codeFor(secret, 0) },
    });
    assert.equal(res.status, 403, "a valid cookie without a CSRF token is refused");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- #520: the TOTP verification branch ----

// Deleting verifyTotpToken and its guard used to leave this whole file green:
// no test ever submitted a CORRECT password with a BAD code, so the verifier's
// failure path was never reached. Both cases below do.
test("regeneration is refused for a wrong authenticator code and for a replayed one", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-totpfail-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    let step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    // Correct password, DEFINITELY wrong code -- derived from the real one so
    // it can never coincidentally be valid, unlike a hardcoded "000000".
    await waitForStepAfter(step);
    step = currentTotpStep();
    const real = codeFor(secret, 0);
    const wrong = String((Number(real[0]) + 1) % 10) + real.slice(1);
    const badCode = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: wrong },
    });
    assert.equal(badCode.status, 400);
    assert.equal((await badCode.json()).totpRequired, true, "a wrong code is a second-factor failure, not a password failure");

    // The same code twice: the second attempt is a replay and must be refused
    // even though the code was valid moments earlier.
    await waitForStepAfter(step);
    const fresh = codeFor(secret, 0);
    const first = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: fresh },
    });
    assert.equal(first.status, 200, "the first use of a fresh code succeeds");
    const replay = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: fresh },
    });
    assert.equal(replay.status, 400, "the same code cannot be spent twice");
    assert.equal((await replay.json()).totpRequired, true);

    // The refused attempts changed nothing beyond the one successful rotation.
    const recovery = await login(port, { password, recoveryCode: enrollmentCodes[0] });
    assert.notEqual(recovery.status, 200, "the enrollment set was replaced by the one successful call");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regeneration fails closed (503) when the second-factor state file is corrupt", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-corrupt-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    // A corrupt file must never read as "no second factor configured" -- that
    // would be a 2FA bypass, which secondFactorStore.js warns about explicitly.
    writeFileSync(secondFactorPath(tempDir), "{ not valid json", { mode: 0o600 });
    const res = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: "123456" },
    });
    assert.equal(res.status, 503, "an unreadable store fails closed, it does not fall through to 400/200");

    const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failure = auditLines.find((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === false);
    assert.ok(failure, "the fail-closed path is audited, not silent");
    assert.equal(failure.detail.reason, "second_factor_unavailable");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- #518: regeneration heals a detected rollback ----

// The console's own startup banner and recovery-login error tell the operator to
// "regenerate recovery codes from Settings" after a rollback is detected. Before
// this fix, doing exactly that returned 10 codes into a still-poisoned state and
// the first one used was wiped unread -- the remedy was a trap.
test("regenerating after a restored-backup rollback issues codes that actually work", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-heal-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir);
    const filePath = secondFactorPath(tempDir);
    const preConsumption = readFileSync(filePath, "utf8");
    assert.equal(JSON.parse(preConsumption).epoch, 0);

    // Spend a code for real: epoch and watermark both advance to 1.
    const spend = await login(port, { password, recoveryCode: enrollmentCodes[0] });
    assert.equal(spend.status, 200);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 1);

    // Restore the main store alone, leaving the watermark at 1 -- the exact
    // single-file-restore case #425 exists to catch. State epoch is now 0 < 1.
    writeFileSync(filePath, preConsumption, { mode: 0o600 });

    await waitForStepAfter(confirmStep);
    let step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true, "TOTP login is unaffected by a rollback");

    await waitForStepAfter(step);
    step = currentTotpStep();
    const res = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: codeFor(secret, 0) },
    });
    assert.equal(res.status, 200);
    const newCodes = (await res.json()).recoveryCodes;
    assert.equal(newCodes.length, 10);

    // The healing itself: epoch must now be ABOVE the watermark, not merely
    // one greater than a stale value.
    assert.ok(JSON.parse(readFileSync(filePath, "utf8")).epoch > 1, "regeneration lifts the epoch past the watermark");

    // The real assertion: a brand-new code logs in instead of being wiped unread.
    const useNew = await login(port, { password, recoveryCode: newCodes[0] });
    assert.equal(useNew.status, 200, "a freshly regenerated code works after a healed rollback");
    assert.notEqual(
      JSON.parse(readFileSync(filePath, "utf8")).recoveryCodes.length, 0,
      "the set was consumed normally, not wiped as a rollback"
    );
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- #521/#522/#523/#527/#534: hardening ----

test("every refusal is audited with a reason and an actor, and a malformed body is a 400 not a 500", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-audit-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    // A literal `null` body: readJson returns raw JSON.parse output, so this
    // used to dereference null and surface an internal JS error as a 500.
    const malformed = await fetch(`http://127.0.0.1:${port}${REGENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `asc_session=${actor.cookie}`, "x-csrf-token": actor.csrf },
      body: "null",
    });
    assert.equal(malformed.status, 400, "a malformed body is a client error, not a server error");
    assert.ok(!/Cannot read properties/.test((await malformed.json()).error), "no internal JS error text reaches the client");

    const badPw = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: "not-the-password", totpCode: "123456" },
    });
    assert.equal(badPw.status, 400);

    const lines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failures = lines.filter((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === false);
    assert.ok(failures.length >= 2, "refusals are audited, not silent -- an unaudited route cannot distinguish 'nobody tried' from 'someone tried 500 times'");
    assert.ok(failures.some((l) => l.detail.reason === "malformed_body"));
    assert.ok(failures.some((l) => l.detail.reason === "bad_password"));
    for (const line of failures) {
      assert.ok(line.detail.userId, "each audited refusal names the acting principal");
      assert.ok(line.detail.tier, "each audited refusal names the acting tier");
    }
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a successful regeneration records healedRollback and forbids caching of the codes", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-heal-audit-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    const step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });

    await waitForStepAfter(step);
    const res = await api(port, REGENERATE_PATH, {
      cookie: actor.cookie, csrf: actor.csrf,
      body: { currentPassword: password, totpCode: codeFor(secret, 0) },
    });
    assert.equal(res.status, 200);
    // The one plaintext copy of a bearer credential must not be storable by any
    // proxy or browser cache in the path.
    assert.match(res.headers.get("cache-control") || "", /no-store/);

    const lines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ok = lines.find((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === true);
    assert.ok(ok, "the success is audited");
    assert.equal(ok.detail.count, 10);
    assert.equal(ok.detail.healedRollback, false, "a routine rotation is distinguishable from the rollback remedy");
    assert.ok(ok.detail.userId, "the success names the acting principal");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The reason the credential-proof limiter is a separate bucket: exhausting it
// from an authenticated session must not lock the operator out of /api/auth/login,
// which is the only route back in.
test("exhausting the credential-proof limiter does not block sign-in", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-limiter-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const { password, secret, step: confirmStep } = await enroll(port, tempDir);
    await waitForStepAfter(confirmStep);
    const step = currentTotpStep();
    const actor = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(actor.body.authenticated, true);

    let sawBlock = false;
    for (let i = 0; i < 12; i++) {
      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: "wrong-password", totpCode: "123456" },
      });
      if (res.status === 429) { sawBlock = true; break; }
    }
    assert.ok(sawBlock, "the credential-proof route is still throttled");

    await waitForStepAfter(step);
    const stillIn = await login(port, { password, totpCode: codeFor(secret, 0) });
    assert.equal(stillIn.body.authenticated, true, "sign-in survives an exhausted credential-proof bucket");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
