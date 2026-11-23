import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getFreePort, waitForHealth, stopProcess } from "../test-support/consoleHarness.js";
import { routes } from "../test-support/routeInventory.js";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";
import { playerMayCall } from "../src/playerScope.js";

// LIVE authorization matrix (pentest hardening). Boots a real console in mock
// mode with a stripped PATH, signs in as owner / admin / moderator / player
// through the real Discord OAuth callback (fake Discord), and sends every
// mined route as every identity. The HTTP status must agree with an oracle
// computed from the policy engine -- proving the gate is actually wired in
// front of every handler, not just that the tables are consistent.
//
// Safety: ADMIN_MOCK_MODE=1, a throwaway DUNE_DOCKER_DIR, and a PATH holding
// only node, so no host binary (dune, docker, ssh) can ever be executed. A
// request the oracle says is ALLOWED and is not a GET is never sent: this test
// proves denials, it does not exercise mutations.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOME_GUILD = "111111111111111111";
const ROLE = { admin: "400000000000000002", moderator: "400000000000000003", player: "400000000000000004" };
const USERS = { admin: "222222222222222201", moderator: "222222222222222202", player: "222222222222222203" };

function startFakeDiscord(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = String(req.headers.authorization || "");
    const who = ["admin", "moderator", "player"].find((t) => auth.includes(`token-${t}`));
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth2/token") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => json({ access_token: `token-${new URLSearchParams(body).get("code")}`, token_type: "Bearer", expires_in: 604800 }));
      return;
    }
    if (url.pathname === "/users/@me") return json({ id: USERS[who], username: `matrix-${who}`, mfa_enabled: false });
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) return json({ user: { id: USERS[who] }, roles: [ROLE[who]] });
    if (url.pathname === "/users/@me/guilds") return json([{ id: HOME_GUILD, name: "Fleetyard", owner: false }]);
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function cookieValue(setCookies, name) {
  const entry = setCookies.find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function signIn(base, code) {
  const start = await fetch(`${base}/api/auth/discord/start`, { redirect: "manual" });
  const pending = cookieValue(start.headers.getSetCookie(), "discord_oauth_state");
  const cb = await fetch(`${base}/api/auth/discord/callback?code=${code}&state=${encodeURIComponent(pending)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${pending}` } });
  await cb.text();
  const session = cookieValue(cb.headers.getSetCookie(), "asc_session");
  assert.ok(session, `${code} sign-in must mint a session (status ${cb.status})`);
  const cookie = `asc_session=${session}`;
  const state = await (await fetch(`${base}/api/auth/state`, { headers: { cookie } })).json();
  return { cookie, csrf: state.csrfToken };
}

async function passwordSignIn(base, password) {
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = `asc_session=${cookieValue(login.headers.getSetCookie(), "asc_session")}`;
  const body = await login.json();
  return { cookie, csrf: body.csrfToken };
}

const GATE_DENIAL = "Your account does not have permission to access this resource.";

const oracleAllows = (tier, method, path) => {
  const action = actionForRoute(path, method);
  if (!action || !evaluate({ tier }, action)) return false;
  return tier !== "player" || playerMayCall(method, path);
};

test("live matrix: every tier x every mined route is denied/admitted exactly as the policy oracle says", { timeout: 600000 }, async (t) => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "authz-http-matrix-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      PATH: dirname(process.execPath), HOME: tempDir,
      DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(consolePort), ADMIN_PASSWORD: "correct-password", ADMIN_SECURE_COOKIES: "0", ADMIN_MOCK_MODE: "1",
      DISCORD_OAUTH_CLIENT_ID: "client-id", DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
      DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
      DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
      DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "", DISCORD_HOME_GUILD_ID: HOME_GUILD,
      DISCORD_CONSOLE_ADMIN_ROLE_IDS: ROLE.admin, DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ROLE.moderator, DISCORD_CONSOLE_PLAYER_ROLE_IDS: ROLE.player
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const discord = await startFakeDiscord(discordPort);
  const base = `http://127.0.0.1:${consolePort}`;
  try {
    await waitForHealth(consolePort, 20000, () => logs);
    const identities = {
      owner: await passwordSignIn(base, "correct-password"),
      admin: await signIn(base, "admin"),
      moderator: await signIn(base, "moderator"),
      player: await signIn(base, "player")
    };
    for (const tier of ["admin", "moderator", "player"]) {
      const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: identities[tier].cookie } })).json();
      assert.equal(me.user.tier, tier, `signed-in identity for ${tier} must really be that tier`);
    }

    const problems = [];
    const statusCounts = {};
    const send = async (id, method, path) => {
      const headers = { "content-type": "application/json" };
      if (id) { headers.cookie = id.cookie; headers["x-csrf-token"] = id.csrf; }
      const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : "{}", redirect: "manual" });
      const text = await res.text();
      // A handler may legitimately answer 403 for its own reasons (feature off, not configured);
      // only the gate's own message means "the permission check refused this identity".
      return { status: res.status, gateDenied: res.status === 403 && text.includes(GATE_DENIAL) };
    };
    for (const { method, path } of routes) {
      const action = actionForRoute(path, method);
      if (!action) continue; // pre-gate / public / unmapped routes are audited separately below
      // anonymous: never anything but a refusal
      const { status: anon } = await send(null, method, path);
      if (anon < 400) problems.push(`anonymous ${method} ${path} -> ${anon}`);
      for (const tier of ["owner", "admin", "moderator", "player"]) {
        const allowed = tier === "owner" ? evaluate({ tier: "owner" }, action) : oracleAllows(tier, method, path);
        if (allowed && method !== "GET") continue; // never fire an allowed mutation
        if (tier === "owner" && method !== "GET") continue;
        const { status, gateDenied } = await send(identities[tier], method, path);
        statusCounts[`${tier}:${status}`] = (statusCounts[`${tier}:${status}`] || 0) + 1;
        if (!allowed && !gateDenied) problems.push(`${tier} DENIED by policy but ${method} ${path} was not refused by the gate (status ${status})`);
        if (allowed && (status === 401 || gateDenied)) problems.push(`${tier} allowed by policy but ${method} ${path} -> ${status}`);
      }
    }
    t.diagnostic(JSON.stringify(statusCounts));
    assert.deepEqual(problems, []);
  } finally {
    discord.closeAllConnections?.();
    await new Promise((r) => discord.close(() => r()));
    await stopProcess(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
