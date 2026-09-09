// Task 6 (hosted-bot console-initiated OAuth registration plan): closes the
// same gap discordAdapterSettingsRoutes.integration.test.js closes for the
// sibling /api/settings/discord-bot* routes -- exercising the 3 new routes
// over a real HTTP request through the real server.js entrypoint, not just
// via direct function calls on the underlying modules
// (hostedBotOAuth.test.js, hostedBotOAuthPolicy.test.js).
//
// These 3 tests are the load-bearing ones for this task's own IAM/gating
// claims:
//   1. the routes require an authenticated session at all (unlike
//      console-login's own OAuth routes, dispatched before the auth gate);
//   2. /register is owner-only -- an admin-tier session (minted the same
//      way oauthRoutes.integration.test.js's own admin-403 test mints one,
//      via a real Discord OAuth + bot-handoff round trip) gets a real 403;
//   3. /register fails closed on its own deploymentChoice gate even for a
//      genuine owner session, before any cookie/token/network work runs.
//
// None of these 3 tests ever reach the outbound call to mentat-backend.darkdante.org
// -- test 1 is rejected by requireAuth() before dispatch reaches the route at
// all, test 2 is rejected by the IAM policy gate (evaluate()) before the
// route body runs, and test 3 is rejected by the route's own
// deploymentChoice check, which this task's own self-review requires to run
// BEFORE any cookie/token/network work. That's deliberate: this file must
// never make a real network call to a real external host.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signPayload } from "../src/integrations/discord/handoff.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ADMIN_PASSWORD = "correct-password";
const HOME_GUILD = "111111111111111111";
const USER_ID = "222222222222222222";
const HANDOFF_SECRET = "e2e-handoff-shared-secret";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// Minimal fake Discord API -- only used by the admin-tier test below, which
// needs a real Discord OAuth round trip to mint its session. Modeled
// directly on oauthRoutes.integration.test.js's own startFakeDiscord().
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: HOME_GUILD }, { id: "123456789012345678" }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Fake bot handoff endpoint -- declares a fixed tier directly, no real
// guild-role mocking needed. Modeled directly on
// oauthRoutes.integration.test.js's own startFakeBot().
function startFakeBot(port, { tier = "admin", secret = HANDOFF_SECRET } = {}) {
  const server = createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname === "/resolve-console-tier") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const { userId, guildId } = JSON.parse(body || "{}");
        const payload = { userId, guildId, tier, ts: Date.now() };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...payload, signature: signPayload(payload, secret) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
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

function cookieFrom(setCookies, name) {
  const entries = Array.isArray(setCookies) ? setCookies : [setCookies];
  const entry = entries.find((v) => v && v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

async function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* best effort */ }
  return new Promise((resolve) => server.close(() => resolve()));
}

function api(port, path, { method, cookie, csrf, body } = {}) {
  const headers = {};
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

async function loginAsOwner(port, password = ADMIN_PASSWORD) {
  const res = await api(port, "/api/auth/login", { method: "POST", body: { password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res.headers.getSetCookie(), "asc_session"), csrf: body.csrfToken };
}

test("GET /api/integrations/discord/hosted-bot/oauth/start requires a real session (401 unauthenticated)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-unauth-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/oauth/start", { method: "GET" });
    // No session cookie at all -- auth.requireAuth() denies with 401 (this
    // codebase's real convention for "not signed in", distinct from the 403
    // an authenticated-but-unauthorized session gets).
    assert.equal(res.status, 401, "an unauthenticated request must never reach the route handler");
    const body = await res.json();
    assert.ok(body.error, "must return an error message");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hosted-bot/register requires owner tier -- an admin-tier session gets 403 and no outbound call is made", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-admin403-"));
  const console_ = startConsole(consolePort, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
    DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
    DISCORD_HOME_GUILD_ID: HOME_GUILD,
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    // Deliberately no owner-bootstrap allowlist -- tier comes from the bot
    // handoff below, matching oauthRoutes.integration.test.js's own
    // admin-tier harness.
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: ""
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);

    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = cookieFrom(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete");
    const sessionValue = cookieFrom(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must mint a real session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "sanity check: this really is an admin-tier session, not owner");

    const authState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.ok(authState.csrfToken, "must have a real CSRF token to exercise the route properly");

    const response = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/register`, {
      method: "POST",
      headers: {
        cookie: `asc_session=${sessionValue}`,
        "x-csrf-token": authState.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({ guildId: HOME_GUILD })
    });
    assert.equal(response.status, 403, "an admin-tier session must be rejected over the wire -- registering the hosted bot is owner-only");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    await closeServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hosted-bot/register with deploymentChoice !== \"hosted\" is blocked server-side even for owner", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-notchoice-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    assert.equal(session.status, 200);

    // deploymentChoice is deliberately left unset on this console instance
    // (never went through POST /api/settings/discord-bot/enable at all) --
    // readDiscordBotSettingsState(config).deploymentChoice is null, never
    // "hosted", so the route's own fail-closed gate must reject this
    // regardless of the owner-tier session.
    const res = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/register`, {
      method: "POST",
      headers: {
        cookie: `asc_session=${session.cookie}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json"
      },
      body: JSON.stringify({ guildId: "111111111111111111" })
    });
    assert.equal(res.status, 403, "an owner session must still be rejected when this console has not opted into the hosted deployment");
    const body = await res.json();
    assert.match(body.error || "", /hosted bot/i);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
