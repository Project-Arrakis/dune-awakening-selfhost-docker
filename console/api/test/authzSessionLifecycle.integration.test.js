import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getFreePort, waitForHealth, stopProcess } from "../test-support/consoleHarness.js";

// Session lifecycle security (pentest hardening): logout really kills the
// server-side session, a tampered cookie is refused, and -- the open finding --
// whether a Discord role change is ever re-applied to a LIVE session.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOME_GUILD = "111111111111111111";
const ADMIN_ROLE = "400000000000000002";
const USER = "222222222222222201";

async function withConsole(run) {
  const discordState = { roles: [ADMIN_ROLE], inGuild: true };
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "authz-session-"));
  const discord = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth2/token") { req.resume(); return req.on("end", () => json({ access_token: "token-x", token_type: "Bearer", expires_in: 604800 })); }
    if (url.pathname === "/users/@me") return json({ id: USER, username: "lifecycle", mfa_enabled: false });
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) return discordState.inGuild ? json({ user: { id: USER }, roles: discordState.roles }) : json({ message: "Unknown Member" }, 404);
    if (url.pathname === "/users/@me/guilds") return json(discordState.inGuild ? [{ id: HOME_GUILD, name: "Fleetyard", owner: false }] : []);
    json({}, 404);
  });
  await new Promise((r) => discord.listen(discordPort, "127.0.0.1", r));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      PATH: dirname(process.execPath), HOME: tempDir, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(consolePort), ADMIN_PASSWORD: "correct-password", ADMIN_SECURE_COOKIES: "0", ADMIN_MOCK_MODE: "1",
      DISCORD_OAUTH_CLIENT_ID: "client-id", DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
      DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`, DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
      DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "", DISCORD_HOME_GUILD_ID: HOME_GUILD, DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const base = `http://127.0.0.1:${consolePort}`;
  const cookieValue = (list, name) => (list.find((v) => v.startsWith(`${name}=`)) || "").split(";")[0].slice(name.length + 1) || null;
  const signIn = async () => {
    const start = await fetch(`${base}/api/auth/discord/start`, { redirect: "manual" });
    const pending = cookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`${base}/api/auth/discord/callback?code=x&state=${encodeURIComponent(pending)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${pending}` } });
    await cb.text();
    const value = cookieValue(cb.headers.getSetCookie(), "asc_session");
    return { status: cb.status, value, cookie: `asc_session=${value}` };
  };
  try {
    await waitForHealth(consolePort, 20000, () => logs);
    return await run({ base, discordState, signIn, logs: () => logs });
  } finally {
    discord.closeAllConnections?.();
    await new Promise((r) => discord.close(() => r()));
    await stopProcess(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const adminCall = (base, cookie) => fetch(`${base}/api/players`, { headers: { cookie } }).then(async (r) => { await r.text(); return r.status; });

test("logout invalidates the session server-side (a replayed cookie is refused)", async () => {
  await withConsole(async ({ base, signIn }) => {
    const s = await signIn();
    assert.notEqual(await adminCall(base, s.cookie), 401);
    const state = await (await fetch(`${base}/api/auth/state`, { headers: { cookie: s.cookie } })).json();
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": state.csrfToken, "content-type": "application/json" }, body: "{}" });
    assert.ok(out.status < 400, `logout status ${out.status}`);
    assert.equal(await adminCall(base, s.cookie), 401, "the old cookie must be dead after logout");
  });
});

test("a tampered or truncated session cookie is refused", async () => {
  await withConsole(async ({ base, signIn }) => {
    const s = await signIn();
    const [id, sig] = s.value.split(".");
    for (const bad of [`${id}.${sig.slice(0, -2)}AA`, `${id}.`, id, `${id.slice(0, -1)}0.${sig}`, `${sig}.${id}`, `${s.value}x`]) {
      assert.equal(await adminCall(base, `asc_session=${bad}`), 401, bad);
    }
  });
});

// OPEN FINDING (pentest 2026-11-23): the tier is a snapshot taken at sign-in and the session
// slides on every request, so removing a Discord role, or the user leaving the guild, does
// not demote or end a live session. Kept as an executable `todo` so it fails visibly until
// fixed without breaking the suite; flip to a plain test() when the console re-validates.
test("a live session stops working after the Discord role is removed", { todo: "finding: tier is not re-validated against Discord after sign-in" }, async () => {
  await withConsole(async ({ base, discordState, signIn }) => {
    const s = await signIn();
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: s.cookie } })).json()).user.tier, "admin");
    discordState.roles = [];
    discordState.inGuild = false;
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: s.cookie } });
    const body = await me.json().catch(() => ({}));
    assert.ok(me.status === 401 || body.user?.tier !== "admin", `session is still ${body.user?.tier} after the role was removed and the user left the guild`);
  });
});

test("login rate limit cannot be dodged by spoofing X-Forwarded-For / X-Real-IP", async () => {
  await withConsole(async ({ base }) => {
    const attempt = (i) => fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i % 250}`, "x-real-ip": `198.51.100.${i % 250}`, forwarded: `for=192.0.2.${i % 250}` },
      body: JSON.stringify({ password: `wrong-${i}` })
    }).then(async (r) => { await r.text(); return r.status; });
    const statuses = [];
    for (let i = 0; i < 25; i += 1) statuses.push(await attempt(i));
    assert.ok(statuses.includes(429), `25 failed logins with rotating spoofed client-IP headers were never rate limited: ${[...new Set(statuses)]}`);
    // and a correct password from yet another spoofed address is still locked out
    const ok = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.18.0.77" }, body: JSON.stringify({ password: "correct-password" }) });
    await ok.text();
    assert.equal(ok.status, 429, "lockout must key on the real peer, not a client-supplied header");
  });
});
