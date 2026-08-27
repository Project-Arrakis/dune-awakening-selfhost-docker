import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signPayload } from "../src/integrations/discord/handoff.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const repoRoot = dirname(dirname(apiRoot));
const HOME_GUILD = "111111111111111111";
const ADMIN_ROLE = "400000000000000002";
const MOD_ROLE = "400000000000000003";
const PLAYER_ROLE = "400000000000000004";
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
      const auth = String(req.headers.authorization || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: USER_ID, username: "fleetyard-operator", mfa_enabled: auth.includes("token-mfa") }));
      return;
    }
    // Member endpoint (guilds.members.read): roles are chosen by the code so a
    // test can sign in "as" a moderator, an admin, or a member with no mapped role.
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) {
      const auth = String(req.headers.authorization || "");
      const roles = auth.includes("token-moderator") ? [MOD_ROLE]
        : auth.includes("token-admin") ? [ADMIN_ROLE, PLAYER_ROLE]
        : auth.includes("token-mfa") ? [ADMIN_ROLE]
        : auth.includes("token-norole") ? ["999999999999999999"]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { id: USER_ID }, roles }));
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
    assert.match(callback.headers.get("content-type") || "", /text\/html/, "callback failures render an HTML page, not raw JSON");
    const denyBody = await callback.text();
    assert.match(denyBody, /not authorized/i);
    assert.match(denyBody, /href="\/"/, "denial page must link back to the console sign-in");
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith("asc_session=")), "denial must not set a session cookie");
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

// ---- Tier 1: handoff-configured callback behavior ----

const HANDOFF_SECRET = "e2e-handoff-shared-secret";

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

test("handoff configured but bot unreachable denies with the HTML error page -- even with a permissive allowlist", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const deadBotPort = await getFreePort(); // freed immediately -- nothing listens
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-handoff-down-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${deadBotPort}`
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 403, "handoff failure must deny -- never fall through to the bootstrap allowlist");
    assert.match(callback.headers.get("content-type") || "", /text\/html/);
    const body = await callback.text();
    assert.match(body, /could not verify your current Discord role/i);
    assert.match(body, /href="\/"/, "error page must link back to sign-in");
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith("asc_session=")), "no session may be minted");

    const auditRows = readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8");
    assert.match(auditRows, /"auth\.handoff-denied"/, "denial must be recorded under auth.handoff-denied");
    assert.match(auditRows, /"reason":"unreachable"/, "audit row must carry the reason code");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handoff configured with bootstrap disabled completes sign-in via the bot (gate no longer requires bootstrap)", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-handoff-up-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: ""
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete without owner bootstrap");
    const sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must set the session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "tier must come from the bot handoff, not the bootstrap allowlist");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    await closeDiscordServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});


// ---- §2.1.1: console-native role -> tier, enforcement, and the opt-in 2FA gate ----

async function signInWithCode(consolePort, code) {
  const startResponse = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
  const pendingStateValue = sessionCookieValue(startResponse.headers.getSetCookie(), "discord_oauth_state");
  const callback = await fetch(
    `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=${code}&state=${encodeURIComponent(pendingStateValue)}`,
    { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
  );
  const body = await callback.text();
  return { status: callback.status, body, sessionValue: sessionCookieValue(callback.headers.getSetCookie(), "asc_session") };
}

const ROLE_ENV = {
  DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0",
  DISCORD_OAUTH_OWNER_ALLOWLIST: "",
  DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE,
  DISCORD_CONSOLE_MODERATOR_ROLE_IDS: MOD_ROLE,
  DISCORD_CONSOLE_PLAYER_ROLE_IDS: PLAYER_ROLE,
};

test("roles: a member holding the mapped moderator role signs in as moderator, and the policy gate holds", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "moderator");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${r.sessionValue}` } })).json();
    assert.equal(me.user.tier, "moderator");
    assert.ok(me.allowedActions.includes("players:read"));
    assert.ok(!me.allowedActions.includes("settings:read"), "a moderator must not see settings");
    // Enforcement is server-side: the settings API refuses this session.
    const settings = await fetch(`http://127.0.0.1:${consolePort}/api/settings`, { headers: { cookie: `asc_session=${r.sessionValue}` } });
    assert.equal(settings.status, 403);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("roles: the highest mapped role wins (admin + player -> admin)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "admin");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${r.sessionValue}` } })).json();
    assert.equal(me.user.tier, "admin");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("roles: a home-guild member with no mapped role is denied, with no session", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "norole");
    assert.equal(r.status, 403);
    assert.match(r.body, /not authorized to sign in/);
    assert.equal(r.sessionValue, null);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("2FA gate: opt-in; when set, an admin without Discord 2FA is refused and told why, and one with it is admitted", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-mfa-"));
  const console = startConsole(consolePort, discordPort, tempDir, { ...ROLE_ENV, DISCORD_OAUTH_REQUIRE_MFA_TIERS: "owner,admin" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const denied = await signInWithCode(consolePort, "admin");        // admin role, mfa_enabled false
    assert.equal(denied.status, 403);
    assert.match(denied.body, /two-factor authentication on your Discord account/);
    assert.match(denied.body, /admin access/);
    assert.equal(denied.sessionValue, null);
    const admitted = await signInWithCode(consolePort, "mfa");        // admin role, mfa_enabled true
    assert.equal(admitted.status, 200, admitted.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${admitted.sessionValue}` } })).json();
    assert.equal(me.user.tier, "admin");
    // Ungated tier is unaffected by the gate.
    const mod = await signInWithCode(consolePort, "moderator");
    assert.equal(mod.status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("no tier source at all: the callback denies early with an actionable message", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-nosource-"));
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "admin");
    assert.equal(r.status, 403);
    assert.match(r.body, /no way to decide what a Discord user may do/);
    // oauthErrorPage HTML-escapes the message, so the arrow arrives as -&gt;.
    assert.match(r.body, /Settings -&gt; Discord OAuth/);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- separation of duties: one Discord role, one tier ----

test("SoD: a hand-edited .env mapping one role to owner AND admin disables Discord sign-in, naming the role", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-sod-"));
  const console = startConsole(consolePort, discordPort, tempDir, { ...ROLE_ENV, DISCORD_CONSOLE_OWNER_ROLE_IDS: ADMIN_ROLE });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 403, "must not even send the user to Discord");
    const body = await start.text();
    assert.match(body, /two different access levels/);
    assert.match(body, new RegExp(`role ${ADMIN_ROLE} is mapped to owner and admin`));
    // Password sign-in is unaffected.
    const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    assert.equal(login.status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("SoD: the settings API refuses to save a mapping that gives one role two tiers, including against already-saved fields", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-sod-save-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    const { csrfToken } = await login.json();
    const cookie = `asc_session=${sessionCookieValue(login.headers.getSetCookie(), "asc_session")}`;
    const post = (payload) => fetch(`http://127.0.0.1:${consolePort}/api/setup/write-oauth-config`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify(payload) });

    // Same role submitted for owner and admin in one request.
    const same = await post({ DISCORD_CONSOLE_OWNER_ROLE_IDS: ADMIN_ROLE, DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE });
    assert.equal(same.status, 400);
    assert.match((await same.json()).error, /Owner and Admin must be different roles/);

    // Save a sound admin mapping, then try to add that role as owner in a SEPARATE request.
    assert.equal((await post({ DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE })).status, 200);
    const partial = await post({ DISCORD_CONSOLE_OWNER_ROLE_IDS: ADMIN_ROLE });
    assert.equal(partial.status, 400, "a partial update must be checked against the fields it did not touch");
    assert.match((await partial.json()).error, new RegExp(`role ${ADMIN_ROLE} is mapped to owner and admin`));

    // A distinct owner role is fine.
    assert.equal((await post({ DISCORD_CONSOLE_OWNER_ROLE_IDS: "400000000000000009" })).status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});
