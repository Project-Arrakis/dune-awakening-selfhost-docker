import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #141: ADMIN_AUTH_DISABLED bypasses both password auth and the CSRF check --
// a fully unauthenticated API, not just a login skip. On a non-loopback bind
// with no ADMIN_ALLOWED_IPS, the server must refuse to start rather than
// silently serve that on the network. These tests spawn the real process and
// assert on its real exit code, not a unit-tested predicate.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function spawnConsole(port, tempDir, extraEnv) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("console did not become healthy in time");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

test("ADMIN_AUTH_DISABLED=1 on a non-loopback bind with no ADMIN_ALLOWED_IPS refuses to start", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auth-disabled-guard-"));
  const consoleProc = spawnConsole(port, tempDir, { ADMIN_AUTH_DISABLED: "1", ADMIN_BIND_HOST: "0.0.0.0" });
  try {
    const code = await waitForExit(consoleProc.child);
    assert.equal(code, 1, "process exits non-zero rather than starting");
    assert.match(consoleProc.logs(), /FATAL.*ADMIN_AUTH_DISABLED/s, "the reason is stated, not a silent exit");
    assert.match(consoleProc.logs(), /CSRF/, "the message names the CSRF bypass, not just the password one");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ADMIN_AUTH_DISABLED=1 on a non-loopback bind WITH ADMIN_ALLOWED_IPS starts, with a warning", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auth-disabled-allowlist-"));
  const consoleProc = spawnConsole(port, tempDir, {
    ADMIN_AUTH_DISABLED: "1",
    ADMIN_BIND_HOST: "0.0.0.0",
    // Includes 127.0.0.1 so this test's own health check (from the loopback
    // test harness) can reach it -- ADMIN_ALLOWED_IPS is a real, separate
    // access-control gate (server.js ~line 237) enforced ahead of this
    // guard's own check, not a stand-in for it.
    ADMIN_ALLOWED_IPS: "127.0.0.1",
  });
  try {
    await waitForHealth(port);
    assert.match(consoleProc.logs(), /Warning: ADMIN_AUTH_DISABLED=1/, "still warns even when allowed to start");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ADMIN_AUTH_DISABLED=1 on a loopback bind starts without ADMIN_ALLOWED_IPS, with a warning", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auth-disabled-loopback-"));
  const consoleProc = spawnConsole(port, tempDir, { ADMIN_AUTH_DISABLED: "1", ADMIN_BIND_HOST: "127.0.0.1" });
  try {
    await waitForHealth(port);
    assert.match(consoleProc.logs(), /Warning: ADMIN_AUTH_DISABLED=1/);
    assert.doesNotMatch(consoleProc.logs(), /FATAL/);
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ADMIN_AUTH_DISABLED unset: no warning, no exit, unaffected by this guard", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auth-enabled-control-"));
  const consoleProc = spawnConsole(port, tempDir, { ADMIN_BIND_HOST: "0.0.0.0" });
  try {
    await waitForHealth(port);
    assert.doesNotMatch(consoleProc.logs(), /ADMIN_AUTH_DISABLED/);
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
