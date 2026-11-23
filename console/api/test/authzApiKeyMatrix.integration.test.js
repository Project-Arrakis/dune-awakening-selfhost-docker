import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getFreePort, waitForHealth, stopProcess } from "../test-support/consoleHarness.js";
import { routes } from "../test-support/routeInventory.js";
import { actionForRoute, NAMESPACES } from "../src/actions.js";
import { keyAllows } from "../src/apiKeys.js";
import { isCrownJewelAction } from "../src/policy.js";
import { KEY_DENIED_ACTIONS, KEY_DENIED_NAMESPACES, namespaceOf } from "../src/apiKeyScopes.js";

// API-key authorization over live HTTP. An owner creates keys at three
// strengths (no scopes, read-everything, write-everything -- the strongest key
// the model allows) and every mined route is sent with each as a Bearer token.
// Independent of the key oracle, three hard invariants are asserted for the
// strongest key: crown-jewel actions, credential/backup-destroying actions and
// the settings/database/setup namespaces are NEVER reachable by any key.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const GATE = ["Your account does not have permission to access this resource.", "This API key is not permitted to use this endpoint."];

test("API keys: every mined route x {none, read-all, write-all} key matches the oracle; forbidden classes are unreachable", { timeout: 600000 }, async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "authz-apikey-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { PATH: dirname(process.execPath), HOME: tempDir, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_PASSWORD: "correct-password", ADMIN_SECURE_COOKIES: "0", ADMIN_MOCK_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(port, 20000, () => logs);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    const cookie = `asc_session=${(login.headers.getSetCookie().find((c) => c.startsWith("asc_session=")) || "").split(";")[0].slice(12)}`;
    const { csrfToken } = await login.json();
    const mint = async (name, scopes) => {
      const res = await fetch(`${base}/api/settings/api-keys`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify({ name, scopes, rateLimitPerMinute: 10000 }) });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      return body;
    };
    const everyNamespace = Object.values(NAMESPACES);
    const keys = {
      none: await mint("none", {}),
      read: await mint("read-all", Object.fromEntries(everyNamespace.map((n) => [n, "read"]))),
      write: await mint("write-all", Object.fromEntries(everyNamespace.map((n) => [n, "write"])))
    };
    const problems = [];
    for (const { method, path } of routes) {
      const action = actionForRoute(path, method);
      if (!action) continue;
      for (const [label, { key, secret }] of Object.entries(keys)) {
        const allowed = keyAllows(key, action);
        const forbidden = isCrownJewelAction(action) || KEY_DENIED_ACTIONS.has(action) || KEY_DENIED_NAMESPACES.has(namespaceOf(action));
        if (forbidden && allowed) problems.push(`${label} key oracle ALLOWS forbidden ${method} ${path} (${action})`);
        if (allowed && method !== "GET") continue;
        const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}", redirect: "manual" });
        const text = await res.text();
        const denied = res.status === 403 && GATE.some((m) => text.includes(m));
        if (!allowed && !denied) problems.push(`${label} key must be denied ${method} ${path} (${action}) but got ${res.status}`);
        if (allowed && (res.status === 401 || denied)) problems.push(`${label} key should reach ${method} ${path} (${action}) but got ${res.status}`);
      }
    }
    assert.deepEqual(problems, []);
    // key-minting must never be reachable with a key, even the strongest
    const mintWithKey = await fetch(`${base}/api/settings/api-keys`, { method: "POST", headers: { authorization: `Bearer ${keys.write.secret}`, "content-type": "application/json" }, body: JSON.stringify({ name: "escalate", scopes: { players: "write" } }) });
    assert.equal(mintWithKey.status, 403);
    // a revoked key stops working at once
    const revoke = await fetch(`${base}/api/settings/api-keys/${keys.read.key.id}`, { method: "DELETE", headers: { cookie, "x-csrf-token": csrfToken } });
    assert.ok(revoke.status < 300, `revoke status ${revoke.status}`);
    const after = await fetch(`${base}/api/players`, { headers: { authorization: `Bearer ${keys.read.secret}` } });
    assert.equal(after.status, 401, "a revoked key must be refused");
  } finally {
    await stopProcess(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
