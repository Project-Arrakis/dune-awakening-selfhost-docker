import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("HTTP login accepts an existing scrypt password file", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dune-auth-hash-"));
  const secretDir = join(root, "runtime/secrets");
  await mkdir(secretDir, { recursive: true });
  const password = "Dummy-Console-Password-123";
  const salt = "0123456789abcdef0123456789abcdef";
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  await writeFile(join(secretDir, "admin-web-password.txt"), `scrypt$${salt}$${key.toString("hex")}\n`, { mode: 0o600 });

  const port = 30000 + process.pid % 15000;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DUNE_DOCKER_DIR: root,
      ADMIN_MOCK_MODE: "1",
      ADMIN_PASSWORD: "",
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
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (ready) break;
      if (child.exitCode !== null) throw new Error("Test API exited before becoming ready.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(ready, true);

    const rejected = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    assert.equal(rejected.status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";
    assert.match(cookie, /^asc_session=/);

    const state = await fetch(`${base}/api/auth/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).authenticated, true);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
