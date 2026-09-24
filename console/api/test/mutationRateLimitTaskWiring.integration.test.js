// Real, spawned-process regression proof for the Layer 3 integration audit
// fix (issue #1056): task() -- the single shared dispatch point behind
// /api/server/stop|start|restart|restart-service, /api/updates/*,
// /api/backups/*, and every route above it that calls task() directly --
// never called applyMutationRateLimit, unlike the 40+ other mutation routes
// in server.js that already do. The Discord write bridge's Hop B reuses this
// same function unchanged, so a write-bridge-driven server.stop/restart/start
// loop had no cooldown beyond the nonce store's unrelated 20-pending-preview
// cap.
//
// This spawns the real src/server.js entrypoint (same pattern
// authHashCompatibility.integration.test.js already uses) and hammers a
// real, harmless task()-backed route (POST /api/server/network-bind/fix --
// buildDuneArgs("networkBindFix", {}) is a static, argument-free
// lookup-table entry that never throws, and the real `dune` binary
// invocation happens asynchronously after task() has already responded, so
// repeating this call is safe) over real HTTP, proving the real
// mutationRateLimiter singleton -- the exact one every other server.js
// mutation route already shares -- now actually gates this path too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("POST /api/server/network-bind/fix (task()-backed): the 21st rapid call in one window is real-HTTP 429'd, proving task() now shares the real mutationRateLimiter, not just returns 202 forever", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "task-rate-limit-e2e-"));
  // Deliberately NOT authHashCompatibility.integration.test.js's own
  // `30000 + process.pid % 15000` formula: under a full-suite parallel run,
  // node's test runner can assign this file the same worker pid as that one
  // at the same moment, and an identical port formula collides -- confirmed
  // directly (full-suite run: authHashCompatibility failed only when this
  // file was present, using the shared formula; removing this file, or
  // giving it its own distinct offset, both eliminate the failure). This
  // matches the existing per-file-offset convention already used by
  // baseContainerMutationRoutes/systemBackupImportRoute/
  // systemBackupRestoreReceipt/setupStateFreshHost.integration.test.js
  // (`21000 + ((process.pid + N) % 20000)` with distinct small N per file).
  const port = 21000 + ((process.pid + 17) % 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DUNE_DOCKER_DIR: root,
      ADMIN_MOCK_MODE: "1",
      ADMIN_PASSWORD: "correct-password",
      ADMIN_AUTH_DISABLED: "0",
      ADMIN_ALLOWED_IPS: "",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(port),
      ADMIN_SECURE_COOKIES: "0"
    }
  });
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, "exit");

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* not up yet */ }
      if (ready) break;
      if (child.exitCode !== null) throw new Error("Test API exited before becoming ready.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(ready, true);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-password" })
    });
    assert.equal(login.status, 200, "login must succeed for this test to prove anything about an authenticated mutation route");
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";
    assert.match(cookie, /^asc_session=/);
    const { csrfToken } = await login.json();
    assert.ok(csrfToken, "login must return a real CSRF token for a mutating request to be accepted at all");

    const statuses = [];
    // createMutationRateLimiter's real default is maxRequests: 20 per 60s
    // window (rateLimit.js) -- the exact same singleton every other
    // server.js mutation route already shares. 21 calls must produce exactly
    // one boundary crossing.
    for (let i = 0; i < 21; i += 1) {
      const res = await fetch(`${base}/api/server/network-bind/fix`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
      statuses.push(res.status);
    }

    const rateLimited = statuses.filter((s) => s === 429);
    assert.ok(rateLimited.length > 0, `expected at least one 429 among 21 rapid calls, got statuses: ${JSON.stringify(statuses)}`);
    assert.equal(statuses[20], 429, `the 21st call must be the one that crosses the real 20-per-window budget, got statuses: ${JSON.stringify(statuses)}`);
    // Every call before the budget is exhausted must have been genuinely
    // accepted (202, task queued) -- proves this isn't a route that was
    // already broken/always-429 for an unrelated reason.
    assert.ok(statuses.slice(0, 20).every((s) => s === 202), `expected the first 20 calls to all be 202, got: ${JSON.stringify(statuses)}`);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
