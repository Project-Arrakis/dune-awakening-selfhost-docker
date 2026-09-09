// Task 6 (hosted-bot console-initiated OAuth registration plan): closes the
// same gap discordAdapterSettingsRoutes.integration.test.js closes for the
// sibling /api/settings/discord-bot* routes -- exercising the 3 new routes
// over a real HTTP request through the real server.js entrypoint, not just
// via direct function calls on the underlying modules
// (hostedBotOAuth.test.js, hostedBotOAuthPolicy.test.js).
//
// Fix round 1 note: `mentat-backend.darkdante.org` (the URL these routes
// forward registration to) was confirmed, during this round's own test
// authoring, to be a REAL, LIVE, reachable production hostname from this
// dev/CI environment (a direct `curl` to it returns a real response) -- not
// a dead/placeholder domain. That makes "assert no outbound call was made"
// a genuine safety property, not just a coverage nice-to-have: a test that
// only argued this in a comment could not tell a correct implementation
// apart from a regressed one that actually reached the live service. Every
// test below that needs to prove "zero outbound calls" does so against a
// real local listener, via `config.mentatBackendRegisterUrl`'s test-only
// env override (`MENTAT_BACKEND_REGISTER_URL`, added in config.js this same
// round) -- never against the real hardcoded default.

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

// Fake Discord API for the HOSTED-BOT flow specifically -- distinct from
// startFakeDiscord() above, because fetchOwnedDiscordGuilds() (unlike
// console-login's fetchDiscordIdentity()) only counts a guild as "owned"
// when Discord's own /users/@me/guilds response marks it `owner: true`.
// `guilds` lets each test control exactly which owned guilds the caller
// gets back.
function startHostedBotFakeDiscord(port, { userId = USER_ID, guilds = [{ id: HOME_GUILD, name: "Fleetyard", owner: true }] } = {}) {
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
      res.end(JSON.stringify({ id: userId, username: "fleetyard-operator" }));
      return;
    }
    if (url.pathname === "/users/@me/guilds") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(guilds));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Fake mentat-backend registration endpoint -- a real, local, listening
// server whose hit count is directly observable, standing in for the real
// (live, reachable) mentat-backend.darkdante.org via the
// MENTAT_BACKEND_REGISTER_URL test-only env override. Every test that needs
// to prove "no outbound call was made" asserts against `hits()` here,
// rather than arguing absence in a comment.
function startFakeMentatBackend(port, { status = 200, body = { ok: true } } = {}) {
  let hitCount = 0;
  const server = createServer((req, res) => {
    hitCount += 1;
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, hits: () => hitCount })));
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

// Enables the Discord bot adapter with deploymentChoice: "hosted" (so both
// the /register route's deploymentChoice+tokenConfigured gates, and the
// /oauth/start + /oauth/callback deploymentChoice gates added in fix round
// 1, all pass) for an already-logged-in owner session.
async function enableHostedDeployment(port, session) {
  const res = await api(port, "/api/settings/discord-bot/enable", {
    method: "POST",
    cookie: session.cookie,
    csrf: session.csrf,
    body: { playerRoleIds: "", moderatorRoleIds: "", adminRoleIds: "", deploymentChoice: "hosted" }
  });
  assert.equal(res.status, 202, "enabling the adapter with deploymentChoice: hosted must succeed");
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

test("hosted-bot/register requires owner tier -- an admin-tier session gets a real 403, and a fake mentat-backend listener records zero hits", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const mentatPort = await getFreePort();
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
    DISCORD_OAUTH_OWNER_ALLOWLIST: "",
    // Test-only override (config.js, fix round 1) -- points the route's
    // outbound call at our own local listener instead of the real, live
    // mentat-backend.darkdante.org, so "zero hits" below is a real,
    // observed fact, not an inference.
    MENTAT_BACKEND_REGISTER_URL: `http://127.0.0.1:${mentatPort}/api/consoles/register`
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  const mentat = await startFakeMentatBackend(mentatPort);
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
    assert.equal(mentat.hits(), 0, "the IAM gate must reject before the route body ever runs, so mentat-backend must never see a request");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    await closeServer(botServer);
    await closeServer(mentat.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hosted-bot/register with deploymentChoice !== \"hosted\" is blocked server-side even for owner, and a fake mentat-backend listener records zero hits", async () => {
  const port = await getFreePort();
  const mentatPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-notchoice-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_BACKEND_REGISTER_URL: `http://127.0.0.1:${mentatPort}/api/consoles/register`
  });
  const mentat = await startFakeMentatBackend(mentatPort);
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
    assert.equal(mentat.hits(), 0, "the deploymentChoice gate must reject before any network work, so mentat-backend must never see a request");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentat.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/oauth/start and .../oauth/callback also fail closed on deploymentChoice !== \"hosted\" for an owner session", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-oauth-notchoice-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    assert.equal(session.status, 200);

    const start = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/oauth/start`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}` }
    });
    assert.equal(start.status, 403, "oauth/start must fail closed on deploymentChoice, before checking Discord OAuth configuration at all");

    const callback = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/oauth/callback?code=x&state=y`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}; hosted_bot_oauth_state=y` }
    });
    assert.equal(callback.status, 403, "oauth/callback must fail closed on deploymentChoice, before checking the state cookie at all");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/oauth/callback rejects a state/cookie mismatch with 400", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-statebad-"));
  const console_ = startConsole(port, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/oauth/callback`
  });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    await enableHostedDeployment(port, session);

    // No real pending PKCE state was ever issued for "bogus-state" -- the
    // module-scope hostedBotOAuthPendingStates store (fix round 1,
    // Important #3) has no matching entry, so consume() must fail
    // regardless of what the request claims the cookie holds.
    const res = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/oauth/callback?code=somecode&state=bogus-state`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}; hosted_bot_oauth_state=bogus-state` }
    });
    assert.equal(res.status, 400, "an unrecognized state must be rejected with 400, before any Discord token exchange is attempted");
    const text = await res.text();
    assert.match(text, /invalid or expired/i);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hosted-bot OAuth start -> callback round trip succeeds end-to-end and returns the caller's real owned guilds", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const OWNED_GUILD_A = "333333333333333333";
  const OWNED_GUILD_B = "444444444444444444";
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-oauth-success-"));
  const console_ = startConsole(consolePort, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/callback`,
    DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`
  });
  const discordServer = await startHostedBotFakeDiscord(discordPort, {
    guilds: [
      { id: OWNED_GUILD_A, name: "Owned Alpha", owner: true },
      { id: OWNED_GUILD_B, name: "Owned Beta", owner: true },
      { id: "555555555555555555", name: "Not Owned", owner: false }
    ]
  });
  try {
    await waitForHealth(consolePort);
    const session = await loginAsOwner(consolePort);
    await enableHostedDeployment(consolePort, session);

    const start = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/start`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}` }
    });
    assert.equal(start.status, 302, "start must redirect to Discord's authorize URL");
    assert.match(start.headers.get("location") || "", /^https:\/\/discord\.com\/oauth2\/authorize/);
    const oauthStateValue = cookieFrom(start.headers.getSetCookie() || [], "hosted_bot_oauth_state");
    assert.ok(oauthStateValue, "start must set a real hosted_bot_oauth_state cookie");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/callback?code=validcode&state=${encodeURIComponent(oauthStateValue)}`,
      {
        redirect: "manual",
        headers: { cookie: `asc_session=${session.cookie}; hosted_bot_oauth_state=${oauthStateValue}` }
      }
    );
    assert.equal(callback.status, 200, "a valid callback must succeed");
    const handleCookie = cookieFrom(callback.headers.getSetCookie() || [], "hosted_bot_registration_handle");
    assert.ok(handleCookie, "callback must set a real hosted_bot_registration_handle cookie");
    const clearedState = (callback.headers.getSetCookie() || []).some((c) => c.startsWith("hosted_bot_oauth_state=;"));
    assert.ok(clearedState, "callback must clear the now-consumed hosted_bot_oauth_state cookie");

    const text = await callback.text();
    assert.match(text, new RegExp(OWNED_GUILD_A), "the return page must embed the caller's real owned guilds, not a placeholder");
    assert.match(text, new RegExp(OWNED_GUILD_B));
    assert.doesNotMatch(text, /555555555555555555/, "a guild the caller does NOT own must never be embedded in the return page");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hosted-bot/register rejects a guildId the caller does not own with 403, and a fake mentat-backend listener records zero hits", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const mentatPort = await getFreePort();
  const OWNED_GUILD = "333333333333333333";
  const NOT_OWNED_GUILD = "666666666666666666";
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-routes-e2e-guildnotowned-"));
  const console_ = startConsole(consolePort, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/callback`,
    DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
    MENTAT_BACKEND_REGISTER_URL: `http://127.0.0.1:${mentatPort}/api/consoles/register`
  });
  const discordServer = await startHostedBotFakeDiscord(discordPort, {
    guilds: [{ id: OWNED_GUILD, name: "Owned Alpha", owner: true }]
  });
  const mentat = await startFakeMentatBackend(mentatPort);
  try {
    await waitForHealth(consolePort);
    const session = await loginAsOwner(consolePort);
    await enableHostedDeployment(consolePort, session);

    const start = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/start`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}` }
    });
    const oauthStateValue = cookieFrom(start.headers.getSetCookie() || [], "hosted_bot_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/oauth/callback?code=validcode&state=${encodeURIComponent(oauthStateValue)}`,
      {
        redirect: "manual",
        headers: { cookie: `asc_session=${session.cookie}; hosted_bot_oauth_state=${oauthStateValue}` }
      }
    );
    assert.equal(callback.status, 200);
    const handleCookie = cookieFrom(callback.headers.getSetCookie() || [], "hosted_bot_registration_handle");
    assert.ok(handleCookie, "callback must set a real registration-handle cookie for the next step");

    // The caller genuinely completed OAuth and has a real, live pending
    // registration entry -- but requests a guildId that was never in
    // their owned-guilds set. This must be rejected, and must never reach
    // the outbound call to mentat-backend.
    const register = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/register`, {
      method: "POST",
      headers: {
        cookie: `asc_session=${session.cookie}; hosted_bot_registration_handle=${handleCookie}`,
        "x-csrf-token": session.csrf,
        "content-type": "application/json"
      },
      body: JSON.stringify({ guildId: NOT_OWNED_GUILD })
    });
    assert.equal(register.status, 403, "a guildId outside the caller's owned-guilds set must be rejected");
    const body = await register.json();
    assert.match(body.error || "", /could not verify you own/i);
    assert.equal(mentat.hits(), 0, "an unowned guildId must be rejected before the outbound call to mentat-backend is ever attempted");

    const clearedHandle = (register.headers.getSetCookie() || []).some((c) => c.startsWith("hosted_bot_registration_handle=;"));
    assert.ok(clearedHandle, "the now-consumed registration-handle cookie must be cleared even on a guild_not_owned rejection");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    await closeServer(mentat.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
