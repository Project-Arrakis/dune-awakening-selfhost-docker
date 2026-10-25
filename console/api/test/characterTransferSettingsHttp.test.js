import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { characterTransferDefaults, readCharacterTransferSettings } from "../src/services/characterTransferSettings.js";

import { createServer as createTcpServer } from "node:net";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

test("Console HTTP saves and restores through the native Director API without restart tasks", { timeout: 30000 }, async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-transfer-http-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let effective = { ...characterTransferDefaults };
  let rejectUpdates = false;
  let updates = 0;
  const director = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v0/BattlegroupUpdateCharacterTransferSettings" && req.method === "POST") {
      updates++;
      let body = "";
      for await (const chunk of req) body += chunk;
      if (rejectUpdates) { res.writeHead(503); res.end("{}"); return; }
      effective = JSON.parse(body);
      res.end("{}");
    } else if (req.url === "/v0/BattlegroupFetchCharacterTransferRules" && req.method === "GET") {
      res.end(JSON.stringify({ config: Object.fromEntries(Object.entries(effective).map(([key, value]) => [key[0].toLowerCase() + key.slice(1), value])) }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  director.listen(0, "127.0.0.1");
  await once(director, "listening");
  t.after(() => { director.closeAllConnections(); director.close(); });
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DUNE_DOCKER_DIR: repoRoot, ADMIN_MOCK_MODE: "1",
      ADMIN_AUTH_DISABLED: "1", ADMIN_ALLOWED_IPS: "", ADMIN_BIND_HOST: "127.0.0.1", ADMIN_BIND_PORT: String(port),
      DIRECTOR_PORT: String(director.address().port) }
  });
  const exited = once(child, "exit");
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(ready, true, output);
  const endpoint = `${base}/api/admin/character-transfer-settings`;
  const post = (body) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const settings = { ...characterTransferDefaults, ExportCharacterTimeout: 1800 };
  let response = await post({ settings });
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.equal(result.task, undefined);
  assert.equal(result.applied, true);
  assert.deepEqual(result.settings, settings);
  assert.deepEqual(effective, settings);
  assert.equal((await fetch(endpoint).then((res) => res.json())).applied, true);
  rejectUpdates = true;
  response = await post({ restoreDefaults: true });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /were saved.*No services were restarted/);
  assert.deepEqual(readCharacterTransferSettings({ repoRoot }).settings, characterTransferDefaults);
  assert.equal((await fetch(endpoint).then((res) => res.json())).applied, false);
  rejectUpdates = false;
  response = await post({ restoreDefaults: true });
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.task, undefined);
  assert.deepEqual(effective, characterTransferDefaults);
  assert.equal(updates, 3);
});
