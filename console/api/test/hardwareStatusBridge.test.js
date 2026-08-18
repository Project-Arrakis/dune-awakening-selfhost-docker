import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 24000 + (process.pid % 15000);
const BASE = `http://127.0.0.1:${PORT}`;

function writeAddon(repoRoot, id, approvedPermissions) {
  const addonDir = join(repoRoot, "runtime/addons/installed", id);
  mkdirSync(join(addonDir, "web"), { recursive: true });
  writeFileSync(join(addonDir, "web/index.html"), "<!doctype html><title>Test</title>");
  writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    description: "Hardware bridge test addon",
    author: "Test",
    version: "1.0.0",
    type: "ui",
    entry: { navigation: "Test", path: "web/index.html" },
    permissions: { server: ["status"] }
  }));
  return { enabled: true, approvedPermissions };
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-hardware-bridge-http-"));
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  const state = {
    "hardware-allowed": writeAddon(repoRoot, "hardware-allowed", ["server:status"]),
    "hardware-unapproved": writeAddon(repoRoot, "hardware-unapproved", [])
  };
  writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify(state));
  return repoRoot;
}

function startServer(repoRoot) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    shell: false,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_MOCK_MODE: "1",
      ADMIN_AUTO_START_STACK_ON_BOOT: "0",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
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
      } catch {}
    }, 100);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready };
}

async function bridge(addonId, action) {
  const response = await fetch(`${BASE}/api/addons/installed/${addonId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action })
  });
  return { status: response.status, body: await response.json() };
}

test("server.hardware.status bridge is core-owned and permission gated", async (t) => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;

    await t.test("returns the stable hardware status contract", async () => {
      const { status, body } = await bridge("hardware-allowed", "server.hardware.status");
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.result.version, 2);
      assert.ok(Array.isArray(body.result.temperatures));
      assert.equal(typeof body.result.cpu, "object");
      assert.ok(Array.isArray(body.result.storage));
      assert.equal(typeof body.result.memory.total_kb, "number");
      assert.equal(typeof body.result.swap.total_kb, "number");
      assert.equal(typeof body.result.load.one, "number");
      assert.equal(typeof body.result.uptime_seconds, "number");
    });

    await t.test("refuses an addon without approved server status access", async () => {
      const { status, body } = await bridge("hardware-unapproved", "server.hardware.status");
      assert.equal(status, 500);
      assert.match(body.error, /not approved for server:status/i);
    });

    await t.test("does not add a vendor-specific shell action", async () => {
      const { status, body } = await bridge("hardware-allowed", "fluffyfox.sensors.read");
      assert.equal(status, 400);
      assert.match(body.error, /Unsupported addon action/);
    });
  } finally {
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
});
