import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for issue #1229 (found by the Layer 3 review of the v1.4.51
// sync, PR #1226). The sync merged upstream's trusted TLS-forwarding identity
// (tlsClientAddress) into the fork's ADMIN_ALLOWED_IPS gate and the Discord
// write-bridge exemption inside the one shared requestHandler. Unit tests cover
// each piece; nothing proved the merged ORDER over real sockets:
//   1. a forged or partial x-dune-tls-* header is rejected (403), not trusted;
//   2. an ADMIN_ALLOWED_IPS-restricted console denies a non-listed client even
//      when it spoofs X-Forwarded-For;
//   3. a Unix-socket (write-bridge) request without the in-process token is
//      NOT exempted from the allowlist (the exemption is credential-gated).
// The positive path (valid token, allowlist set -> succeeds) needs the token
// minted inside the console process, so it stays covered in-process by
// writeBridgeEndToEnd.integration.test.js.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function startConsole(port, tempDir, extraEnv) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(port),
      ADMIN_PASSWORD: "correct-horse-battery",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitUntil(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not become ready in time`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

function tcpGet(port, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/health`, { headers });
}

function socketGet(socketPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: "/api/health", method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("ADMIN_ALLOWED_IPS gate holds over real sockets after the v1.4.51 merge (#1229)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dune-allowed-ips-"));
  const port = await getFreePort();
  // 127.0.0.1 is the real peer; it is deliberately NOT in the allowlist.
  const { child, logs } = startConsole(port, tempDir, { ADMIN_ALLOWED_IPS: "203.0.113.9" });
  t.after(async () => { await stopProcess(child); rmSync(tempDir, { recursive: true, force: true }); });

  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`console exited early:\n${logs()}`);
    const res = await tcpGet(port);
    return res.status === 403; // gate answers before any route; 403 means it is serving
  }, 20000, "console");

  await t.test("a client outside the allowlist is denied", async () => {
    assert.equal((await tcpGet(port)).status, 403);
  });

  await t.test("a spoofed X-Forwarded-For does not grant allowlist access", async () => {
    assert.equal((await tcpGet(port, { "x-forwarded-for": "203.0.113.9" })).status, 403);
  });

  await t.test("a forged full x-dune-tls-* identity (bad signature) is rejected, not trusted", async () => {
    const res = await tcpGet(port, {
      "x-dune-tls-client-address": "203.0.113.9",
      "x-dune-tls-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-dune-tls-signature": "0".repeat(64),
    });
    assert.equal(res.status, 403);
  });

  await t.test("a partial x-dune-tls-* identity is rejected", async () => {
    assert.equal((await tcpGet(port, { "x-dune-tls-client-address": "203.0.113.9" })).status, 403);
  });

  await t.test("a write-bridge Unix-socket request without the token is not exempted", async (st) => {
    const socketPath = join(tempDir, "runtime", "generated", "discord-write-bridge.sock");
    const present = await waitUntil(() => existsSync(socketPath), 5000, "write-bridge socket").then(() => true, () => false);
    if (!present) {
      st.skip("write-bridge socket not started in this environment (the console refuses to start it as root; CI runs non-root)");
      return;
    }
    assert.equal(await socketGet(socketPath), 403);
    assert.equal(await socketGet(socketPath, { "x-dune-write-bridge-token": "0".repeat(64) }), 403);
  });
});
