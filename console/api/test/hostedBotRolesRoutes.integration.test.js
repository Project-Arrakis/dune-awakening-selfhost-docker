// dune-awakening-selfhost-docker#853 / mentat-link#183: exercises the new
// GET/POST /api/integrations/discord/hosted-bot/roles routes over a real
// HTTP request through the real server.js entrypoint -- same discipline as
// hostedBotRegistrationRoutes.integration.test.js and
// autoInviteRoutes.integration.test.js, whose fake-listener / session
// harnesses this file mirrors rather than re-deriving.
//
// Most tests set hosted-bot state directly via env vars
// (DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE/DUNE_DISCORD_ADAPTER_TOKEN/
// DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID) rather than running the full
// OAuth+register round trip first -- that round trip is already covered by
// hostedBotRegistrationRoutes.integration.test.js and would only add
// unrelated setup cost here. The one test that genuinely needs an
// admin-tier (not owner) session replicates the Discord-OAuth+bot-handoff
// harness from autoInviteRoutes.integration.test.js, since this codebase
// has no local-password path to a non-owner tier.

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
const CONNECTED_GUILD_ID = "111111111111111111";
const HANDOFF_SECRET = "e2e-handoff-shared-secret";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// Fake mentat-link /api/consoles/:guildId/roles proxy -- a real, local,
// listening server standing in for the real (live) mentat-link.darkdante.org
// via the MENTAT_LINK_ROLES_URL_BASE test-only env override (config.js).
// `requests()` exposes every request this listener received (method, path,
// authorization header, parsed JSON body where applicable) so a test can
// assert exactly what Core forwarded, not just that it forwarded something.
function startFakeMentatLinkRoles(port, { getStatus = 200, getBody = { roles: [] }, postStatus = 200, postBody = { applied: true } } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      requests.push({ method: "GET", url: req.url, authorization: req.headers.authorization || null });
      res.writeHead(getStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(getBody));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ method: "POST", url: req.url, authorization: req.headers.authorization || null, body: JSON.parse(raw || "{}") });
      res.writeHead(postStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(postBody));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests: () => requests, hits: () => requests.length })));
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

// A console instance already connected to a hosted-bot guild, without going
// through the full OAuth+register round trip -- see this file's own header
// comment for why.
function startConnectedConsole(port, tempDir, mentatLinkPort, extraEnv = {}) {
  return startConsole(port, tempDir, {
    DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE: "hosted",
    DUNE_DISCORD_ADAPTER_TOKEN: "test-adapter-token-value",
    DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID: CONNECTED_GUILD_ID,
    MENTAT_LINK_ROLES_URL_BASE: `http://127.0.0.1:${mentatLinkPort}/api/consoles`,
    ...extraEnv
  });
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

test("GET .../hosted-bot/roles requires a real session (401 unauthenticated)", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-unauth-get-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles");
    assert.equal(res.status, 401, "an unauthenticated request must never reach the route handler");
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles requires a real session (401 unauthenticated)", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-unauth-post-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", body: { playerRoleIds: [] } });
    assert.equal(res.status, 401);
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/roles fails closed when deploymentChoice !== \"hosted\", even for an owner session", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-notchoice-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  // Deliberately NOT startConnectedConsole -- deploymentChoice is left unset.
  const console_ = startConsole(port, tempDir, { MENTAT_LINK_ROLES_URL_BASE: `http://127.0.0.1:${mentatLinkPort}/api/consoles` });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    assert.equal(session.status, 200);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { cookie: session.cookie });
    assert.equal(res.status, 403);
    assert.equal(mentatLink.hits(), 0, "the deploymentChoice gate must reject before any network work");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/roles returns 400 when hosted but no guild is connected yet, mentat-link never hit", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-noguild-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConsole(port, tempDir, {
    DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE: "hosted",
    DUNE_DISCORD_ADAPTER_TOKEN: "test-adapter-token-value",
    MENTAT_LINK_ROLES_URL_BASE: `http://127.0.0.1:${mentatLinkPort}/api/consoles`
  });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { cookie: session.cookie });
    assert.equal(res.status, 400);
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/roles relays mentat-link's real roles list, and forwards the adapter token as a Bearer header", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-get-ok-"));
  const roles = [{ id: "1", name: "Player", color: "#ffffff", position: 1 }];
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort, { getBody: { roles } });
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { cookie: session.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { roles, cacheStale: false });
    assert.equal(mentatLink.hits(), 1);
    assert.equal(mentatLink.requests()[0].url, `/api/consoles/${CONNECTED_GUILD_ID}/roles`);
    assert.equal(mentatLink.requests()[0].authorization, "Bearer test-adapter-token-value");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/roles surfaces cacheStale:true from mentat-link unchanged (bot not yet reconnected to this guild)", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-cachestale-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort, { getBody: { roles: [], cacheStale: true } });
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { cookie: session.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cacheStale, true, "the fallback-to-manual-entry signal must reach the frontend, never be swallowed");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../hosted-bot/roles returns 502 when mentat-link is unreachable", async () => {
  const port = await getFreePort();
  const deadPort = await getFreePort(); // freed immediately -- nothing listens here
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-unreachable-"));
  const console_ = startConnectedConsole(port, tempDir, deadPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { cookie: session.cookie });
    assert.equal(res.status, 502);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles saves and returns 200, forwarding the array-shaped body verbatim and updating the local display cache", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-post-ok-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const submission = { playerRoleIds: ["100000000000000001"], moderatorRoleIds: ["100000000000000002"], adminRoleIds: [] };
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: submission });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { applied: true });
    assert.equal(mentatLink.hits(), 1);
    assert.deepEqual(mentatLink.requests()[0].body, submission);
    assert.equal(mentatLink.requests()[0].authorization, "Bearer test-adapter-token-value");

    // Design doc §4.7 point 3: mentat's write is authoritative, Core's local
    // copy is a display cache only -- verify it was actually updated.
    const settingsRes = await api(port, "/api/settings/discord-bot", { cookie: session.cookie });
    const settings = await settingsRes.json();
    assert.deepEqual(settings.roleIds, { player: ["100000000000000001"], moderator: ["100000000000000002"], admin: [] });
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles rejects a non-array role-id field with 400, mentat-link never hit", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-badshape-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { playerRoleIds: "100000000000000001" } });
    assert.equal(res.status, 400);
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles rejects a malformed role id with 400, mentat-link never hit", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-badid-"));
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { playerRoleIds: ["not-a-snowflake"] } });
    assert.equal(res.status, 400);
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles relays a 409 tier-conflict from mentat-link as-is, with the conflict body intact", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-conflict-"));
  const conflict = { roleId: "100000000000000001", currentTier: "player", requestedTier: "admin" };
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort, { postStatus: 409, postBody: { conflict } });
  const console_ = startConnectedConsole(port, tempDir, mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { playerRoleIds: [], moderatorRoleIds: [], adminRoleIds: ["100000000000000001"] } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body, { conflict });

    // A rejected save must not touch the local display cache.
    const settingsRes = await api(port, "/api/settings/discord-bot", { cookie: session.cookie });
    const settings = await settingsRes.json();
    assert.deepEqual(settings.roleIds, { player: [], moderator: [], admin: [] });
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles returns 502 when mentat-link is unreachable, without touching the local display cache", async () => {
  const port = await getFreePort();
  const deadPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-post-unreachable-"));
  const console_ = startConnectedConsole(port, tempDir, deadPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/roles", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { playerRoleIds: ["100000000000000001"] } });
    assert.equal(res.status, 502);
    const settingsRes = await api(port, "/api/settings/discord-bot", { cookie: session.cookie });
    const settings = await settingsRes.json();
    assert.deepEqual(settings.roleIds.player, [], "a failed save must not leave a half-applied local cache");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../hosted-bot/roles changing admin-tier role IDs is owner-only -- an admin-tier session gets 403, mentat-link never hit", async () => {
  // Reuses the exact admin-tier-via-bot-handoff harness proven in
  // autoInviteRoutes.integration.test.js's own analogous test.
  const HOME_GUILD = "333333333333333333";
  const USER_ID = "444444444444444444";
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "hosted-bot-roles-e2e-admin403-"));

  const discordServer = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/oauth2/token") {
        let body = "";
        req.on("data", (c) => { body += c; });
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
        res.end(JSON.stringify([{ id: HOME_GUILD }]));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(discordPort, "127.0.0.1", () => resolve(server));
  });
  const botServer = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (new URL(req.url, "http://localhost").pathname === "/resolve-console-tier") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const { userId, guildId } = JSON.parse(body || "{}");
          const payload = { userId, guildId, tier: "admin", ts: Date.now() };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...payload, signature: signPayload(payload, HANDOFF_SECRET) }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(botPort, "127.0.0.1", () => resolve(server));
  });
  const mentatLink = await startFakeMentatLinkRoles(mentatLinkPort);

  const console_ = startConsole(consolePort, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
    DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
    DISCORD_HOME_GUILD_ID: HOME_GUILD,
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: "",
    DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE: "hosted",
    DUNE_DISCORD_ADAPTER_TOKEN: "test-adapter-token-value",
    DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID: CONNECTED_GUILD_ID,
    MENTAT_LINK_ROLES_URL_BASE: `http://127.0.0.1:${mentatLinkPort}/api/consoles`
  });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = cookieFrom(start.headers.getSetCookie() || [], "discord_oauth_state");
    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    const sessionValue = cookieFrom(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must mint a real session cookie");

    const response = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/roles`, {
      method: "POST",
      headers: { cookie: `asc_session=${sessionValue}`, "content-type": "application/json" },
      body: JSON.stringify({ adminRoleIds: ["100000000000000001"] })
    });
    assert.equal(response.status, 403, "an admin-tier session must be rejected when changing admin-tier role IDs, matching the self-hosted route's own gating");
    assert.equal(mentatLink.hits(), 0, "the escalation guard must reject before mentat-link ever sees a request");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    await closeServer(botServer);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
