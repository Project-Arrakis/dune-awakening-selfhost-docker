import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dune-awakening-selfhost-docker#308: complements bridgeActionContract.test.js
// (which verifies distinct ops.* actions return non-overlapping payload
// shapes, calling duneDb.js's handler functions directly). THIS test
// covers a different, real defect class: the actual 2026-08-10
// containerHealth incident was a hard SyntaxError in server.js's
// addon-bridge dispatch chain (a missing `if (` -- confirmed via
// `node --check` against the exact broken commit, 5f8310bb) that
// crashed the whole module at import time. A shape-contract test that
// calls duneDb.js functions directly would never even run in that
// scenario -- the module import itself fails first. This test instead
// spawns the REAL src/server.js as a child process (same infra pattern
// as addonSchedulerBridge.test.js) and asserts every documented ops.*
// action responds over real HTTP, so a future dispatch-chain wiring bug
// fails this test directly and legibly (a specific action's request
// times out/errors) instead of only surfacing as an opaque
// "did not become healthy in time" timeout on an unrelated test.

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 20000 + ((process.pid + 1) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

// Every ops.* action currently wired into server.js's addon-bridge
// dispatch table (console/api/src/server.js, confirmed via direct
// reading, not guessed) that requires only "ops:read" -- the addon-
// bridge permission this test's fake addon requests and gets approved
// for. ops.location.activity is intentionally excluded: it's a
// permanently-out-of-scope placeholder with no permission check at all
// (see server.js's own comment on that action), a different code path
// than what this test is verifying.
const OPS_READ_ACTIONS = [
  "ops.health.summary",
  "ops.health.players",
  "ops.health.farms",
  "ops.health.summary.v2",
  "ops.activity.summary",
  "ops.resources.summary",
  "ops.combat.deaths",
  "ops.economy.summary",
  "ops.inventory.summary",
  "ops.soc.summary",
  "ops.health.prometheus",
  "ops.health.containers",
  "ops.health.postgres",
  "ops.health.rabbitmq"
];

function writeAddonState(repoRoot, approvedPermissions) {
  writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({
    "dune-ops-observability": { enabled: true, approvedPermissions }
  }));
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-ops-bridge-http-"));
  const addonDir = join(repoRoot, "runtime/addons/installed/dune-ops-observability");
  mkdirSync(join(addonDir, "web"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dune-ops-observability",
    name: "Dune Ops Observability",
    version: "0.5.1",
    type: "ui",
    entry: { path: "web/index.html" },
    permissions: ["ops:read"]
  }));
  writeAddonState(repoRoot, ["ops:read"]);
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
  return { child, ready, getOutput: () => output };
}

async function bridge(addonId, body) {
  const response = await fetch(`${BASE}/api/addons/installed/${addonId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

test("every documented ops.* action responds over the real HTTP bridge route, individually", async (t) => {
  const repoRoot = makeRepoRoot();
  const { child, ready, getOutput } = startServer(repoRoot);
  try {
    await ready;

    for (const action of OPS_READ_ACTIONS) {
      await t.test(action, async () => {
        const { status, body } = await bridge("dune-ops-observability", { action });
        assert.equal(status, 200, `${action} did not respond 200 (got ${status}). Server output:\n${getOutput()}`);
        assert.ok(body, `${action}'s response body did not parse as JSON`);
        assert.equal(typeof body.ok, "boolean", `${action}'s response is missing the standard {ok: boolean} envelope`);
      });
    }

    await t.test("an unknown ops.* action is rejected, not silently routed to a real handler", async () => {
      const { status, body } = await bridge("dune-ops-observability", { action: "ops.this.does.not.exist" });
      assert.notEqual(status, 200, "an unrecognized action must not succeed");
      assert.ok(body === null || body.ok !== true, "an unrecognized action must not report ok: true");
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
