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
// This spawns the real server.js entrypoint (same pattern
// autoInviteRoutes.integration.test.js already uses successfully for
// non-socket routes) and hammers a real, harmless task()-backed route
// (POST /api/server/network-bind/fix -- buildDuneArgs("networkBindFix", {})
// is a static, argument-free lookup-table entry that never throws, and the
// real `dune` binary invocation happens asynchronously after task() has
// already responded, so repeating this call is safe) over real HTTP,
// proving the real mutationRateLimiter singleton -- the exact one every
// other server.js mutation route already shares -- now actually gates this
// path too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ADMIN_PASSWORD = "correct-password";

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
      ADMIN_PASSWORD,
      ADMIN_SECURE_COOKIES: "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("console did not become healthy in time");
}

function cookieFrom(setCookies, name) {
  const entries = Array.isArray(setCookies) ? setCookies : [setCookies];
  const entry = entries.find((v) => v && v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

function api(port, path, { method, cookie, csrf, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
}

async function loginAsOwner(port) {
  const res = await api(port, "/api/auth/login", { method: "POST", body: { password: ADMIN_PASSWORD } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res.headers.getSetCookie(), "asc_session"), csrf: body.csrfToken };
}

test("POST /api/server/network-bind/fix (task()-backed): the 21st rapid call in one window is real-HTTP 429'd, proving task() now shares the real mutationRateLimiter, not just returns 202 forever", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "task-rate-limit-e2e-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    assert.equal(session.status, 200, "login must succeed for this test to prove anything about an authenticated mutation route");

    const statuses = [];
    // createMutationRateLimiter's real default is maxRequests: 20 per 60s
    // window (rateLimit.js) -- the exact same singleton every other
    // server.js mutation route already shares. 21 calls must produce exactly
    // one boundary crossing.
    for (let i = 0; i < 21; i += 1) {
      const res = await api(port, "/api/server/network-bind/fix", { method: "POST", cookie: session.cookie, csrf: session.csrf });
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
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
