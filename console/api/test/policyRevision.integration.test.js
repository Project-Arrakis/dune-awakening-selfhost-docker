// Real-server tests for the If-Match revision check on PUT /api/settings/iam/policy (issue #1193),
// following discordAdapterSettingsRoutes.integration.test.js: spawn server.js and fetch it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

// method defaults to GET when no body is given, POST when one is -- every
// caller below passes method explicitly anyway, this just keeps the helper
// terse for the plain-GET call sites.
function api(port, path, { method, cookie, csrf, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
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

async function login(port, password) {
  const res = await api(port, "/api/auth/login", { method: "POST", body: { password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: body.csrfToken, body };
}

function auditRows(tempDir) {
  try {
    return readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8");
  } catch {
    return "";
  }
}


// Issue #1193: the real PUT /api/settings/iam/policy handler with a real If-Match header. The unit tests in
// policyRevision.test.js cover setPolicies; this covers the header parsing, the 409 and the audit entry.

async function withConsole(fn) {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "iam-revision-e2e-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);
    const get = async () => (await api(port, "/api/settings/iam/policies", { cookie: session.cookie })).json();
    const put = (store, ifMatch) => api(port, "/api/settings/iam/policy", {
      method: "PUT", cookie: session.cookie, csrf: session.csrf, body: store,
      headers: ifMatch === undefined ? {} : { "if-match": ifMatch }
    });
    await fn({ get, put, tempDir });
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const withAdmin = (store, action) => ({
  ...store,
  admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: [action] }] }
});

test("PUT honours If-Match: current revision saves, stale is a 409 with the current store and an audit entry", async () => {
  await withConsole(async ({ get, put, tempDir }) => {
    const first = await get();
    assert.match(first.revision, /^[0-9a-f]{64}$/);

    const ok = await put(withAdmin(first.policies, "backups:create"), `"${first.revision}"`);
    assert.equal(ok.status, 200);
    const saved = await ok.json();
    assert.notEqual(saved.revision, first.revision);
    assert.equal((await get()).revision, saved.revision);

    // A second admin still holding the first revision.
    const stale = await put(withAdmin(first.policies, "backups:delete"), `"${first.revision}"`);
    assert.equal(stale.status, 409);
    const refused = await stale.json();
    assert.equal(refused.conflict, true);
    assert.equal(refused.revision, saved.revision);
    assert.deepEqual(refused.policies.admin.statements[0].Action, ["backups:create"]);
    assert.deepEqual((await get()).policies.admin.statements[0].Action, ["backups:create"], "nothing was written");

    assert.match(auditRows(tempDir), /iam\.policy-conflict/);
  });
});

test("PUT accepts a weak-prefixed or unquoted tag, treats * and no header as unconditional, and refuses an empty one", async () => {
  await withConsole(async ({ get, put }) => {
    let current = await get();
    assert.equal((await put(withAdmin(current.policies, "backups:create"), `W/"${current.revision}"`)).status, 200);
    current = await get();
    assert.equal((await put(withAdmin(current.policies, "backups:delete"), current.revision)).status, 200);
    current = await get();
    assert.equal((await put(withAdmin(current.policies, "backups:create"), "*")).status, 200);
    current = await get();
    assert.equal((await put(withAdmin(current.policies, "backups:delete"))).status, 200, "older clients send no header");

    const before = (await get()).revision;
    for (const empty of ['""', 'W/""', " "]) {
      const res = await put(withAdmin(current.policies, "backups:create"), empty);
      assert.equal(res.status, 400, `If-Match ${JSON.stringify(empty)} must be refused, not skipped`);
    }
    assert.equal((await get()).revision, before, "a refused save writes nothing");
    assert.equal((await put(withAdmin(current.policies, "backups:create"), "a-list,of-tags")).status, 409);
  });
});
