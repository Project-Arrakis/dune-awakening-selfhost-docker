import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getFreePort, waitForHealth, stopProcess } from "../test-support/consoleHarness.js";
import { withIsolatedDatabase, pgConnectionConfig } from "../test-support/pgIntegrationDb.js";

// Two-player object-level authorization (IDOR) test against a REAL console and
// a REAL PostgreSQL schema. A `player`-tier session signed in as DUNCAN (A) tries
// to reach GURNEY's (B) data through every player-reachable route, with every
// identifier form B has, plus hostile query strings. Nothing of B's -- name,
// ids, guild, bases, vehicles, chests -- may appear in any response body.
//
// Fixture ids are chosen so B's tokens cannot collide with A's or with ordinary
// JSON numbers: the body scan looks for B's name and B's distinctive ids.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOME_GUILD = "111111111111111111";
const PLAYER_ROLE = "400000000000000004";
const DISCORD_A = "222222222222222203";

const A = { pawn: 21, controller: 11, account: 100, name: "Duncan" };
const B = { pawn: 7742881, controller: 7742882, account: 7742883, name: "GurneyHalleck" };
const B_TOKENS = [B.name, String(B.pawn), String(B.controller), String(B.account), "Gurney Fortress", "Gurney Guild", "7742890", "FLSBBB777"];

const SCHEMA = `
  create schema dune;
  create type dune.vector3 as (x double precision, y double precision, z double precision);
  create type dune.transform as (location dune.vector3);
  create table dune.buildings (id bigint primary key, owner_id bigint);
  create table dune.building_instances (building_id bigint not null, instance_id integer not null, building_type text, owner_entity_id bigint, health real);
  create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null);
  create table dune.actors (id bigint primary key, class text, map text, partition_id bigint, owner_account_id bigint, transform dune.transform);
  create table dune.permission_actor (actor_id bigint primary key, actor_name text, actor_type smallint, access_level smallint, is_child boolean default false, edited_by_player_id bigint);
  create table dune.permission_actor_rank (permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade, player_id bigint not null, rank smallint not null, unique (permission_actor_id, player_id));
  create table dune.player_state (id bigint, account_id bigint, player_controller_id bigint, player_pawn_id bigint, character_name text, online_status text default 'Offline');
  create table dune.placeables (id bigint primary key, owner_entity_id bigint, health real, building_type text, is_hologram boolean not null default false);
  create table dune.inventories (id bigint primary key, actor_id bigint, max_item_count integer, max_item_volume real);
  create table dune.items (id bigint primary key, inventory_id bigint, stack_size bigint, position_index bigint, template_id text);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.discord_player_links (discord_user_id text primary key, player_controller_id text unique);
  create table dune.accounts (id bigint primary key, last_seen timestamptz, funcom_id text, platform_id text, platform_name text, "user" text);
  create table dune.guilds (guild_id bigint primary key, guild_name text, guild_description text);
  create table dune.guild_members (guild_id bigint not null, player_id bigint not null);
`;

function base(id, name) {
  return `
    insert into dune.buildings (id) values (${id});
    insert into dune.actors (id, class, map, partition_id, transform) values (${id}, '/Game/Totem.Totem_C', 'HaggaBasin', 1, row(row(1,2,3)::dune.vector3)::dune.transform);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${id + 500}, ${id});
    insert into dune.building_instances (building_id, instance_id, building_type, owner_entity_id, health) values (${id}, 1, 'Sardaukar_Foundation', ${id + 500}, 100);
    insert into dune.permission_actor (actor_id, actor_name, actor_type, access_level, is_child) values (${id}, '${name}', 1, 3, false);`;
}

const SEED = `
  insert into dune.actors (id, class, owner_account_id) values
    (${A.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${A.account}),
    (${B.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${B.account}),
    (${A.controller}, null, ${A.account}), (${B.controller}, null, ${B.account});
  insert into dune.accounts (id, "user") values (${A.account}, 'FLSAAA111'), (${B.account}, 'FLSBBB777');
  insert into dune.player_state (id, account_id, player_controller_id, player_pawn_id, character_name) values
    (1, ${A.account}, ${A.controller}, ${A.pawn}, '${A.name}'), (2, ${B.account}, ${B.controller}, ${B.pawn}, '${B.name}');
  insert into dune.discord_player_links (discord_user_id, player_controller_id) values ('${DISCORD_A}', '${A.controller}'), ('999000999000999000', '${B.controller}');
  insert into dune.guilds (guild_id, guild_name) values (5001, 'Atreides Guild'), (7742890, 'Gurney Guild');
  insert into dune.guild_members (guild_id, player_id) values (5001, ${A.controller}), (7742890, ${B.controller});
  ${base(1001, "Duncan Keep")}
  ${base(1004, "Gurney Fortress")}
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (1001, ${A.controller}, 1), (1004, ${B.controller}, 1);
`;

const OWN_RESOURCES = ["crafting-recipes", "research-items", "building-unlocks", "customizations", "journey", "inventory", "vehicles", "bases", "currency", "solaris-coin", "factions", "intel", "specs", "position", "progression", "vitals", "events", "stats", "history"];

function startFakeDiscord(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth2/token") { req.resume(); return req.on("end", () => json({ access_token: "token-player", token_type: "Bearer", expires_in: 604800 })); }
    if (url.pathname === "/users/@me") return json({ id: DISCORD_A, username: "duncan-player", mfa_enabled: false });
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) return json({ user: { id: DISCORD_A }, roles: [PLAYER_ROLE] });
    if (url.pathname === "/users/@me/guilds") return json([{ id: HOME_GUILD, name: "Fleetyard", owner: false }]);
    res.writeHead(404); res.end("{}");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const cookieValue = (list, name) => (list.find((v) => v.startsWith(`${name}=`)) || "").split(";")[0].slice(name.length + 1) || null;

test("two-player IDOR: a signed-in player cannot reach another player's data through any player-tier route", async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "idor_http", unavailableLabel: "the player IDOR HTTP test" }, async (pool, dbName) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    const cfg = pgConnectionConfig(dbName);
    const consolePort = await getFreePort();
    const discordPort = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "idor-http-"));
    const child = spawn(process.execPath, ["server.js"], {
      cwd: apiRoot,
      env: {
        PATH: dirname(process.execPath), HOME: tempDir, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(consolePort), ADMIN_PASSWORD: "correct-password",
        ADMIN_SECURE_COOKIES: "0", ADMIN_MOCK_MODE: "1",
        DUNE_DB_HOST: cfg.host, DUNE_DB_PORT: String(cfg.port), DUNE_DB_NAME: dbName, DUNE_DB_USER: cfg.user, DUNE_DB_PASSWORD: cfg.password,
        DISCORD_OAUTH_CLIENT_ID: "client-id", DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
        DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`, DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
        DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "", DISCORD_HOME_GUILD_ID: HOME_GUILD, DISCORD_CONSOLE_PLAYER_ROLE_IDS: PLAYER_ROLE
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
      const start = await fetch(`${base}/api/auth/discord/start`, { redirect: "manual" });
      const pending = cookieValue(start.headers.getSetCookie(), "discord_oauth_state");
      const cb = await fetch(`${base}/api/auth/discord/callback?code=player&state=${encodeURIComponent(pending)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${pending}` } });
      await cb.text();
      const cookie = `asc_session=${cookieValue(cb.headers.getSetCookie(), "asc_session")}`;
      const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
      assert.equal(me.user.tier, "player", logs);

      const get = async (path) => { const r = await fetch(base + path, { headers: { cookie } }); return { status: r.status, text: await r.text() }; };
      const leaks = [];
      const scan = (label, { status, text }) => {
        for (const token of B_TOKENS) if (text.includes(token)) leaks.push(`${label} (status ${status}) leaked ${token}`);
      };

      // Sanity: A can see A, so a clean scan is not just "everything is broken".
      const ownList = await get("/api/players");
      assert.equal(ownList.status, 200, ownList.text);
      assert.ok(ownList.text.includes(A.name), `A must see their own character: ${ownList.text}`);
      scan("GET /api/players", ownList);
      const ownRow = JSON.parse(ownList.text).rows?.[0];
      assert.ok(ownRow, "A's own row");
      const ownId = ownRow.action_player_id;

      // B's identifiers in every form the resolver might accept.
      const bForms = [B.pawn, B.controller, B.account, B.name, encodeURIComponent(B.name), `${B.pawn}.0`, ` ${B.pawn}`, `${B.pawn}%20`, `0${B.pawn}`, `-${B.pawn}`, `${B.pawn}%00`, `${B.pawn}/../${ownId}`, `..%2f${B.pawn}`];
      for (const form of bForms) {
        scan(`GET /api/players/${form}`, await get(`/api/players/${form}`));
        for (const resource of OWN_RESOURCES) {
          const res = await get(`/api/players/${form}/${resource}`);
          scan(`GET /api/players/${form}/${resource}`, res);
          if (![403, 404, 400].includes(res.status) && res.status < 500) leaks.push(`GET /api/players/${form}/${resource} -> ${res.status} (expected a refusal)`);
        }
      }
      // A's own resources must NOT be refused (otherwise the refusals above prove nothing).
      for (const resource of ["inventory", "currency", "vitals"]) {
        const res = await get(`/api/players/${encodeURIComponent(ownId)}/${resource}`);
        assert.notEqual(res.status, 403, `own ${resource} must not be gate- or scope-refused: ${res.text}`);
      }

      // Lists with hostile query strings.
      for (const path of [
        `/api/players?q=Gurney`, `/api/players?q=${B.pawn}`, `/api/players/search?q=Gurney`, `/api/players/search?q=${B.controller}`,
        `/api/players/online`, `/api/players?status=all&pageSize=500&sortColumn=character_name`, `/api/players?playerId=${B.pawn}`,
        `/api/players?onlyPlayerControllerId=${B.controller}`, `/api/players?sortColumn=character_name%3B--`,
        `/api/guilds`, `/api/guilds?q=Gurney`, `/api/guilds?onlyGuildId=7742890`, `/api/guilds?guildId=7742890&pageSize=200`,
        `/api/bases`, `/api/bases?q=Fortress`, `/api/bases?playerId=${B.pawn}&access=all`, `/api/bases?sortColumn=shared_with`, `/api/bases?owner=${B.controller}`,
        `/api/vehicles`, `/api/vehicles?playerId=${B.pawn}&access=all`, `/api/vehicles?q=Gurney`,
        `/api/storage`, `/api/storage?playerId=${B.pawn}&access=all`, `/api/storage?q=Gurney`, `/api/server/status`
      ]) scan(`GET ${path}`, await get(path));

      // Another guild's roster by id, in a few encodings.
      for (const gid of ["7742890", "7742890%20", "07742890", "7742890%2f..%2f5001"]) {
        const res = await get(`/api/guilds/${gid}/members`);
        scan(`GET /api/guilds/${gid}/members`, res);
        if (res.status === 200 && !res.text.includes('"rows":[]') && !res.text.includes("notLinked")) leaks.push(`GET /api/guilds/${gid}/members -> 200 with rows`);
      }
      // Own guild roster must still work (positive control for the 403 above).
      const ownGuild = await get("/api/guilds/5001/members");
      assert.equal(ownGuild.status, 200, `own guild roster must be readable: ${ownGuild.text}`);

      assert.deepEqual(leaks, []);
    } finally {
      discord.closeAllConnections?.();
      await new Promise((r) => discord.close(() => r()));
      await stopProcess(child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
