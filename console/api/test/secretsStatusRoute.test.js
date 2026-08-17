import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real end-to-end HTTP test for GET /api/secrets/status (issue #318/#320),
// following the exact spawn-real-server pattern already established by
// bridgeActionDispatch.test.js -- spawns the actual src/server.js as a
// child process rather than calling secretsStatusRoute()/allSecretStates()
// directly (already covered, in isolation, by secretsStatus.test.js), so
// this test catches a different, real defect class: a routing/wiring
// mistake in server.js's handleApi if/else chain itself (e.g. the route
// silently falling through to a 404, or a typo in the path string) that a
// pure-function unit test could never see.

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 21000 + ((process.pid + 1) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-secrets-status-route-"));
  mkdirSync(join(repoRoot, "runtime", "secrets"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime", "generated", ".secrets-migrated"), { recursive: true });
  mkdirSync(join(repoRoot, "console", "web", "dist"), { recursive: true });
  return repoRoot;
}

function startServer(repoRoot, extraEnv = {}) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    shell: false,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_MOCK_MODE: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist"),
      DUNE_KEK_FILE: undefined,
      DUNE_AGE_IDENTITY_FILE: undefined,
      ...extraEnv
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`API did not start listening.\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolveReady();
        }
      } catch {
        // Not listening yet.
      }
    }, 150);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready, getOutput: () => output };
}

async function stopServer(child, repoRoot) {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    child.on("exit", resolveExit);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 3000).unref?.();
  });
  rmSync(repoRoot, { recursive: true, force: true });
}

test("GET /api/secrets/status returns both wired secrets with backend-not-configured when no age env vars are set", async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready, getOutput } = startServer(repoRoot);
  try {
    await ready;
    const response = await fetch(`${BASE}/api/secrets/status`);
    assert.equal(response.status, 200, `did not respond 200. Server output:\n${getOutput()}`);
    const body = await response.json();
    assert.ok(Array.isArray(body.secrets), "response must include a secrets array");
    assert.equal(body.secrets.length, 2);
    assert.deepEqual(body.secrets.map((s) => s.name).sort(), ["server-login-password-secret", "username-server-login-secret"]);
    assert.ok(body.secrets.every((s) => s.state === "backend-not-configured"));
  } finally {
    await stopServer(child, repoRoot);
  }
});

test("GET /api/secrets/status reflects a real migrated secret when the age env vars and .enc file are present", async () => {
  const repoRoot = makeRepoRoot();
  const encPath = join(repoRoot, "runtime", "secrets", "server-login-password-secret.enc");
  writeFileSync(encPath, "enc:v2:1:fake:fake");
  chmodSync(encPath, 0o600);
  const { child, ready, getOutput } = startServer(repoRoot, {
    DUNE_KEK_FILE: join(repoRoot, "runtime", "generated", "kek.age"),
    DUNE_AGE_IDENTITY_FILE: join(repoRoot, "identity.txt")
  });
  try {
    await ready;
    const response = await fetch(`${BASE}/api/secrets/status`);
    assert.equal(response.status, 200, `did not respond 200. Server output:\n${getOutput()}`);
    const body = await response.json();
    const serverLogin = body.secrets.find((s) => s.name === "server-login-password-secret");
    const usernameLogin = body.secrets.find((s) => s.name === "username-server-login-secret");
    assert.equal(serverLogin.state, "migrated");
    assert.equal(usernameLogin.state, "not-migrated");
  } finally {
    await stopServer(child, repoRoot);
  }
});

test("GET /api/secrets/status never includes a secret value or anything resembling ciphertext in its response", async () => {
  const repoRoot = makeRepoRoot();
  const encPath = join(repoRoot, "runtime", "secrets", "server-login-password-secret.enc");
  const fakeCiphertext = "enc:v2:1:VkVSWVNFQ1JFVFdSQVBQRURfREVL:U09NRVJFQUxMWVNFTlNJVElWRUNJUEhFUlRFWFQ=";
  writeFileSync(encPath, fakeCiphertext);
  const { child, ready, getOutput } = startServer(repoRoot, {
    DUNE_KEK_FILE: join(repoRoot, "runtime", "generated", "kek.age"),
    DUNE_AGE_IDENTITY_FILE: join(repoRoot, "identity.txt")
  });
  try {
    await ready;
    const response = await fetch(`${BASE}/api/secrets/status`);
    assert.equal(response.status, 200, `did not respond 200. Server output:\n${getOutput()}`);
    const rawText = await response.text();
    assert.ok(!rawText.includes(fakeCiphertext), "response must never include the raw .enc file contents");
    assert.ok(!rawText.includes("VkVSWVNFQ1JFVFdSQVBQRURfREVL"), "response must never include even a fragment of the ciphertext");
  } finally {
    await stopServer(child, repoRoot);
  }
});
