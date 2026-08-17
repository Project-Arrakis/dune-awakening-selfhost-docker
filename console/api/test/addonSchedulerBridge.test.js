import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Route-level coverage for EDA retirement in server.js: boot the real API in
// mock mode against a temp repo that still has the old addon installed.

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 20000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-scheduler-http-"));
  const addonDir = join(repoRoot, "runtime/addons/installed/eda-exchange-bot");
  mkdirSync(join(addonDir, "web"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
    schemaVersion: 1,
    id: "eda-exchange-bot",
    name: "EDA Exchange Bot",
    version: "0.9.9",
    type: "ui",
    entry: { path: "web/index.html" },
    permissions: ["database:read", "database:write", "scheduler:server"]
  }));
  writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({
    "eda-exchange-bot": { enabled: true, approvedPermissions: ["database:read", "database:write", "scheduler:server"] }
  }));
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
  return { child, ready };
}

async function bridge(addonId, body) {
  const response = await fetch(`${BASE}/api/addons/installed/${addonId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("retired EDA bridge over HTTP", async (t) => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;

    await t.test("rejects scheduler actions for other addon ids", async () => {
      const { status, body } = await bridge("some-other-addon", { action: "scheduler.schedule.get" });
      assert.equal(status, 400);
      assert.match(body.error, /not supported for this addon/);
    });

    await t.test("returns 410 and directs operators to native Market Bot", async () => {
      const { status, body } = await bridge("eda-exchange-bot", { action: "scheduler.schedule.get" });
      assert.equal(status, 410);
      assert.match(body.error, /retired.*Exchange > Market Bot/i);
    });

    await t.test("removes the addon and initializes disabled core schedules", () => {
      assert.equal(existsSync(join(repoRoot, "runtime/addons/installed/eda-exchange-bot")), false);
      const buyback = JSON.parse(readFileSync(join(repoRoot, "runtime/generated/market-bot/buyback.json"), "utf8"));
      const seed = JSON.parse(readFileSync(join(repoRoot, "runtime/generated/market-bot/seed.json"), "utf8"));
      assert.deepEqual([buyback.enabled, buyback.source], [false, "console"]);
      assert.deepEqual([seed.enabled, seed.source], [false, "console"]);
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
