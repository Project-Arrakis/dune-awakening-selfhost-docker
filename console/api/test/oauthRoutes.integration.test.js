import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const repoRoot = dirname(dirname(apiRoot));
const HOME_GUILD = "111111111111111111";
const USER_ID = "222222222222222222";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Minimal fake Discord API: token exchange, /users/@me, /users/@me/guilds.
// A code of "notmember" simulates a user outside the designated home guild.
function startFakeDiscord(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/oauth2/token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code") || "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 604800 }));
      });
      return;
    }
    if (url.pathname === "/users/@me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: USER_ID, username: "fleetyard-operator" }));
      return;
    }
    if (url.pathname === "/users/@me/guilds") {
      const nonMember = String(req.headers.authorization || "").includes("token-notmember");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(nonMember ? [{ id: "123456789012345678" }] : [{ id: HOME_GUILD }, { id: "123456789012345678" }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function startConsole(consolePort, discordPort, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(consolePort),
      ADMIN_PASSWORD: "correct-password",
      ADMIN_SECURE_COOKIES: "0",
      DISCORD_OAUTH_CLIENT_ID: "client-id",
      DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
      DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
      DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
      DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "1",
      DISCORD_OAUTH_OWNER_ALLOWLIST: USER_ID,
      DISCORD_HOME_GUILD_ID: HOME_GUILD,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("console did not become healthy in time");
}

function sessionCookieValue(setCookies, name) {
  const entry = (Array.isArray(setCookies) ? setCookies : [setCookies]).find((value) => value.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
}

function closeDiscordServer(server) {
  try {
    server.closeAllConnections?.();
  } catch {
    // best effort
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Discord OAuth sign-in flow works end-to-end through the real server", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  let sessionValue = null;
  let pendingStateValue = null;
  try {
    await waitForHealth(consolePort);

    const serverState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(serverState.config.discordOAuthConfigured, true, "public state must advertise Discord OAuth once configured");

    const startResponse = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(startResponse.status, 302);
    assert.match(startResponse.headers.get("location") || "", /^https:\/\/discord\.com\/oauth2\/authorize/, `unexpected redirect: ${startResponse.headers.get("location")}`);
    const startCookies = startResponse.headers.getSetCookie().length ? startResponse.headers.getSetCookie() : [];
    pendingStateValue = sessionCookieValue(startCookies, "discord_oauth_state");
    assert.ok(pendingStateValue, "start must set the pending-state cookie");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "valid login should mint a session");
    const callbackBody = await callback.text();
    assert.match(callbackBody, /window\.location\.replace\("\/"\)/, "callback must return the HTML return page so the browser lands back on the console");
    sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionCookieValue, "callback must set the session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "owner");
    assert.equal(me.user.id, USER_ID);
    assert.equal(me.user.username, "fleetyard-operator");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Discord OAuth callback denies a user outside the home guild", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-deny-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=notmember&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 403, "non-member must be denied");
    assert.equal((await callback.json()).authenticated, undefined);
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Discord OAuth start returns 404 when OAuth is not configured", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-unconfigured-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(consolePort),
      ADMIN_PASSWORD: "correct-password",
      ADMIN_SECURE_COOKIES: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 404);
    const state = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(state.config.discordOAuthConfigured, false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- POST /api/auth/discord/exchange (issue #403: fail closed, no owner) ----

async function exchangeStatus(consolePort, token) {
  return fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
}

test("exchange denies (fail closed) when ATRIUM_ALLOWED_DISCORD_USER_ID is unset", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-exch-unset-"));
  const console = startConsole(consolePort, discordPort, tempDir); // gate not set
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const res = await exchangeStatus(consolePort, "validtoken");
    assert.equal(res.status, 403, "unset gate must deny, never mint a session");
    const body = await res.json();
    assert.equal(body.authenticated, undefined);
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith("asc_session=")), "no session cookie may be set");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exchange denies a Discord account that does not match the configured allowlist", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-exch-wrong-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    ATRIUM_ALLOWED_DISCORD_USER_ID: "999999999999999999"
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const res = await exchangeStatus(consolePort, "validtoken"); // fake Discord returns USER_ID
    assert.equal(res.status, 403, "non-matching Discord user must be denied");
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith("asc_session=")));
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exchange grants the allowlisted user a read-only observer session, never owner", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-exch-ok-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    ATRIUM_ALLOWED_DISCORD_USER_ID: USER_ID
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const res = await exchangeStatus(consolePort, "validtoken");
    assert.equal(res.status, 200, "the configured Atrium user must be allowed in");
    const sessionValue = sessionCookieValue(res.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "a session cookie must be set");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "observer", "exchange must mint observer, not owner (issue #403)");
    assert.equal(me.user.id, USER_ID);
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
