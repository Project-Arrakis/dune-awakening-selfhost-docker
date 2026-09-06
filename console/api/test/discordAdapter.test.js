import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_ADAPTER_ROUTES, DISCORD_CATALOG_PROTOCOL_VERSION, discordAdapterErrorResponse, discordAdapterHealth, discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices, discordAdapterStatus, discordWritesEnabled } from "../src/integrations/discord/adapter.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env.DISCORD_OBSERVER_ROLE_IDS = "role-observer";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "role-moderator";
  process.env.DISCORD_ADMIN_ROLE_IDS = "role-admin";
  process.env.DISCORD_OWNER_ROLE_IDS = "role-owner";
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DUNE_DISCORD_WRITES_ENABLED = "false";
}

function actor(roleIds = []) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    roleIds,
    interactionId: "interaction-1",
    commandName: "/dune status"
  };
}

const config = {
  auditLog: "/tmp/dune-discord-adapter-test-audit.jsonl",
  generatedDir: "/tmp/dune-discord-adapter-test-generated"
};

test.beforeEach(resetEnv);
test.after(() => {
  process.env = OLD_ENV;
});

test("reports adapter health with isolated link-state writes", async () => {
  const result = await discordAdapterHealth({});
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.experimental, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.gameDataWritesEnabled, false);
  assert.deepEqual(result.adapterDataWrites, ["player-link", "account-link"]);
  assert.equal(result.writesEnabled, false);
  // Issue #337 (RFC §3.4): /health must report the catalog protocol
  // version so the bot can detect a contract-breaking change without
  // needing to fetch the full catalog first.
  assert.equal(typeof result.protocolVersion, "number");
  assert.equal(result.protocolVersion, DISCORD_CATALOG_PROTOCOL_VERSION);
  // Issue #245 fix: LOGS, MAP_STATE, and MAINTENANCE were promoted from
  // planned -> live (see adapter.js's DISCORD_LIVE_ADAPTER_ROUTES,
  // "fix(adapter): implement LOGS, MAP_STATE, MAINTENANCE handlers" --
  // 8 bot slash commands were 404ing before this), but this hardcoded
  // exact-match expected array was never updated to include them, so
  // assert.deepEqual failed on the 3 missing entries even though the
  // real, current behavior is correct and intentional.
  assert.deepEqual([...result.liveRoutes].sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/broadcast",
    "/api/integrations/discord/db",
    "/api/integrations/discord/guild-character-grants/default",
    "/api/integrations/discord/guild-character-grants/disable",
    "/api/integrations/discord/guild-character-grants/enable",
    "/api/integrations/discord/guilds/faction-summary",
    "/api/integrations/discord/guilds/find",
    "/api/integrations/discord/guilds/storage",
    "/api/integrations/discord/health",
    "/api/integrations/discord/logs",
    "/api/integrations/discord/maintenance",
    "/api/integrations/discord/map-state",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/ops/activity",
    "/api/integrations/discord/ops/combat",
    "/api/integrations/discord/ops/dashboard",
    "/api/integrations/discord/ops/economy",
    "/api/integrations/discord/ops/inventory",
    "/api/integrations/discord/ops/prometheus",
    "/api/integrations/discord/ops/resources",
    "/api/integrations/discord/ops/soc",
    "/api/integrations/discord/players/accounts/link",
    "/api/integrations/discord/players/accounts/link-steam",
    "/api/integrations/discord/players/accounts/link/verify",
    "/api/integrations/discord/players/accounts/list",
    "/api/integrations/discord/players/accounts/set-default",
    "/api/integrations/discord/players/accounts/unlink",
    "/api/integrations/discord/players/faction",
    "/api/integrations/discord/players/find",
    "/api/integrations/discord/players/inventory",
    "/api/integrations/discord/players/inventory-search",
    "/api/integrations/discord/players/link",
    "/api/integrations/discord/players/link/verify",
    "/api/integrations/discord/players/me",
    "/api/integrations/discord/players/storage",
    "/api/integrations/discord/players/unlink",
    "/api/integrations/discord/population",
    "/api/integrations/discord/ports",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/servers",
    "/api/integrations/discord/services",
    "/api/integrations/discord/status",
    "/api/integrations/discord/version"
  ].sort());
  // ops/activity, ops/combat, ops/resources, ops/economy, ops/inventory,
  // ops/soc, ops/prometheus are now wired to real data sources and moved
  // to liveRoutes (see the seven assertions above — soc via an in-memory
  // rolling counter over the audit log, prometheus via a real HTTP
  // integration against an optional metrics stack that may itself report
  // "not running", neither a SQL query like the other five). The
  // remaining OPS route (location) is intentionally, permanently out of
  // scope for this addon (per-player location tracking already belongs
  // to the Console's own map UI — decided 2026-07-24) and is correctly,
  // permanently reported as planned.
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/ops/location"));
  assert.ok(!result.liveRoutes.includes("/api/integrations/discord/ops/location"));
  assert.ok(result.liveRoutes.includes("/api/integrations/discord/ops/soc"));
  assert.ok(result.liveRoutes.includes("/api/integrations/discord/ops/inventory"));
  assert.ok(result.liveRoutes.includes("/api/integrations/discord/ops/prometheus"));
  assert.ok(!result.plannedRoutes.includes("/api/integrations/discord/logs"));
  assert.ok(!result.plannedRoutes.includes("/api/integrations/discord/ops/activity"));
});

test("keeps writes disabled by default and accepts explicit opt-in values", () => {
  delete process.env.DUNE_DISCORD_WRITES_ENABLED;
  assert.equal(discordWritesEnabled({}), false);
  process.env.DUNE_DISCORD_WRITES_ENABLED = "1";
  assert.equal(discordWritesEnabled({}), true);
  process.env.DUNE_DISCORD_WRITES_ENABLED = "true";
  assert.equal(discordWritesEnabled({}), true);
});

test("exposes only allowlisted adapter route names", () => {
  const routes = Object.values(DISCORD_ADAPTER_ROUTES);
  assert.deepEqual(routes.sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/broadcast",
    // catalog (issue #337, Phase 1 of docs/rfc-command-discovery.md):
    // read-only metadata describing the other routes' shape/capability/
    // tier, not itself a data route -- deliberately excluded from
    // DISCORD_LIVE_ADAPTER_ROUTES (see adapter.js's own comment) but still
    // a real, allowlisted route constant here.
    "/api/integrations/discord/catalog",
    "/api/integrations/discord/db",
    "/api/integrations/discord/guild-character-grants/default",
    "/api/integrations/discord/guild-character-grants/disable",
    "/api/integrations/discord/guild-character-grants/enable",
    "/api/integrations/discord/guilds/faction-summary",
    "/api/integrations/discord/guilds/find",
    "/api/integrations/discord/guilds/storage",
    "/api/integrations/discord/health",
    "/api/integrations/discord/logs",
    "/api/integrations/discord/map-state",
    "/api/integrations/discord/maintenance",
    "/api/integrations/discord/ops/activity",
    "/api/integrations/discord/ops/combat",
    "/api/integrations/discord/ops/dashboard",
    "/api/integrations/discord/ops/economy",
    "/api/integrations/discord/ops/inventory",
    "/api/integrations/discord/ops/location",
    "/api/integrations/discord/ops/prometheus",
    "/api/integrations/discord/ops/resources",
    "/api/integrations/discord/ops/soc",
    "/api/integrations/discord/players/accounts/link",
    "/api/integrations/discord/players/accounts/link-steam",
    "/api/integrations/discord/players/accounts/link/verify",
    "/api/integrations/discord/players/accounts/list",
    "/api/integrations/discord/players/accounts/set-default",
    "/api/integrations/discord/players/accounts/unlink",
    "/api/integrations/discord/players/faction",
    "/api/integrations/discord/players/find",
    "/api/integrations/discord/players/inventory",
    "/api/integrations/discord/players/inventory-search",
    "/api/integrations/discord/players/link",
    "/api/integrations/discord/players/link/verify",
    "/api/integrations/discord/players/me",
    "/api/integrations/discord/players/storage",
    "/api/integrations/discord/players/unlink",
    "/api/integrations/discord/population",
    "/api/integrations/discord/ports",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/servers",
    "/api/integrations/discord/services",
    "/api/integrations/discord/status",
    "/api/integrations/discord/version"
  ].sort());
  // guild-character-grants/* (issue #696) is a deliberate, narrow
  // exception to this naming lint's "grant" term. The URL itself is a
  // fixed external wire contract: Project-Arrakis/mentat's own
  // config.js DEFAULT_PATHS already hardcodes
  // "/api/integrations/discord/guild-character-grants/{enable,disable,default}"
  // as the path it calls (shipped before this route existed on Core),
  // so renaming the path to dodge this lint would break the live bot,
  // not just this test. It is not a privilege-grant in the RBAC sense
  // this lint's other terms guard against (admin, elevation, teleport,
  // kick) -- it's a self-scoped per-guild enable/disable toggle on a
  // character the caller already linked to their own Discord account
  // (requireSelfScopedCapability(ACCOUNT_LINK_WRITE), same gate as the
  // already-allowlisted players/accounts/unlink and players/link
  // routes), never granting access to anyone else's data or tier.
  const GUILD_CHARACTER_GRANTS_ALLOWLIST = new Set([
    "/api/integrations/discord/guild-character-grants/enable",
    "/api/integrations/discord/guild-character-grants/disable",
    "/api/integrations/discord/guild-character-grants/default"
  ]);
  for (const route of routes) {
    if (GUILD_CHARACTER_GRANTS_ALLOWLIST.has(route)) continue;
    assert.doesNotMatch(route, /write|execute|delete|restore|kick|grant|teleport|reset|admin/i);
  }
});

test("returns sanitized public status", async () => {
  const response = await discordAdapterStatus({
    config,
    actorPayload: actor([]),
    diagnostic: false,
    statusProvider: async () => ({
      db_connected: true,
      ssh_connected: true,
      ssh_host: "172.19.240.122:22",
      runtime: "docker"
    })
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.db_connected, true);
  assert.equal(response.result.ssh_connected, true);
  assert.equal(response.result.runtime, "docker");
  assert.equal(Object.hasOwn(response.result, "ssh_host"), false);
});

test("requires admin capability before diagnostic status provider runs", async () => {
  let called = false;
  await assert.rejects(() => discordAdapterStatus({
    config,
    actorPayload: actor(["role-moderator"]),
    diagnostic: true,
    statusProvider: async () => {
      called = true;
      return { ssh_host: "172.19.240.122:22" };
    }
  }), /not authorized/);
  assert.equal(called, false);

  const response = await discordAdapterStatus({
    config,
    actorPayload: actor(["role-admin"]),
    diagnostic: true,
    statusProvider: async () => ({ ssh_host: "172.19.240.122:22" })
  });
  assert.equal(response.result.ssh_host, undefined);
});

test("allows observer readiness and services", async () => {
  const readiness = await discordAdapterReadiness({
    config,
    actorPayload: actor(["role-observer"]),
    readinessProvider: async () => ({ ready: true, overall: "READY", issues: [] })
  });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.result.ready, true);

  const services = await discordAdapterServices({
    config,
    actorPayload: actor(["role-observer"]),
    servicesProvider: async () => ({ overall: "OK", services: [{ name: "Database", status: "up" }], issues: [] })
  });
  assert.equal(services.ok, true);
  assert.equal(services.result.services[0].name, "Database");
});

test("allows moderator population summary", async () => {
  const response = await discordAdapterPopulation({
    config,
    actorPayload: actor(["role-moderator"]),
    populationProvider: async () => ({ overall: "OK", onlinePlayers: 2, totalPlayers: 3, detailsSuppressed: true })
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.onlinePlayers, 2);
  assert.equal(response.result.detailsSuppressed, true);
});

test("blocks public readiness services and population", async () => {
  await assert.rejects(() => discordAdapterReadiness({
    config,
    actorPayload: actor([]),
    readinessProvider: async () => ({ ready: true })
  }), /not authorized/);

  await assert.rejects(() => discordAdapterServices({
    config,
    actorPayload: actor([]),
    servicesProvider: async () => ({ services: [] })
  }), /not authorized/);

  await assert.rejects(() => discordAdapterPopulation({
    config,
    actorPayload: actor([]),
    populationProvider: async () => ({ onlinePlayers: 1 })
  }), /not authorized/);
});

test("formats safe adapter errors", () => {
  const error = new Error("Failed with marker sample-value at 127.0.0.1:15432");
  error.code = "bad_request";
  error.statusCode = 400;
  const response = discordAdapterErrorResponse(error);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "bad_request");
  assert.doesNotMatch(response.body.error, /127\.0\.0\.1/);
});

// Server route integration test — exercises handleDiscordAdapterRoute through a live HTTP server
import { createServer } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { handleDiscordAdapterRoute } from "../src/integrations/discord/routes.js";

test("adapter routes respond through mounted HTTP server path", async () => {
  const tokenFile = "/tmp/discord-adapter-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-test-generated" };

  // Mock providers so routes return 200 without requiring a running Dune server
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });
  const mockReadiness = async () => ({ ready: true, overall: "READY", issues: [] });
  const mockServices = async () => ({ overall: "OK", services: [{ name: "Database", status: "up" }] });
  const mockPopulation = async () => ({ onlinePlayers: 8, totalPlayers: 128, aggregate: true, detailsSuppressed: true });
  const commandCalls = [];
  const mockCommandRunner = async (_config, args) => {
    commandCalls.push(args);
    if (args.join(" ") === "db list") {
      return { code: 0, stdout: "2026-08-09 12:34 dune-db-test-20260809-123400.backup\n", stderr: "" };
    }
    if (args.join(" ") === "maps list") {
      return { code: 0, stdout: "Hagga Basin  running\nDeep Desert  running\n", stderr: "" };
    }
    if (args.join(" ") === "ready") {
      return { code: 0, stdout: "Overall: READY\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const mockDockerLogs = async (service, options) => ({
    code: 0,
    stdout: `${service} ready on 127.0.0.1:7778\n`,
    stderr: "",
    options
  });
  const mockAnnouncements = async () => ({
    settings: { joinEnabled: true, joinMessage: "Welcome {playerName}", leaveEnabled: false, leaveMessage: "Goodbye {playerName}" }
  });

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({
          req, res, path, config: testConfig, readJson, json,
          statusProvider: mockStatus,
          readinessProvider: mockReadiness,
          servicesProvider: mockServices,
          populationProvider: mockPopulation,
          commandRunner: mockCommandRunner,
          dockerLogsRunner: mockDockerLogs,
          announcementsProvider: mockAnnouncements
        });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // Health
          const health = await (await fetch(`${base}/api/integrations/discord/health`, { headers: auth })).json();
          assert.equal(health.ok, true);
          assert.equal(health.enabled, true);

          // Status
          const status = await (await fetch(`${base}/api/integrations/discord/status`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(status.ok, true);

          // Readiness
          const readiness = await (await fetch(`${base}/api/integrations/discord/readiness`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(readiness.ok, true);

          // Services
          const services = await (await fetch(`${base}/api/integrations/discord/services`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(services.ok, true);
          assert.ok(Array.isArray(services.result.services));

          // Population
          const pop = await (await fetch(`${base}/api/integrations/discord/population`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(pop.ok, true);

          const maintenance = await (await fetch(`${base}/api/integrations/discord/maintenance`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(maintenance.ok, true);
          assert.match(maintenance.output, /READY/);

          const logs = await (await fetch(`${base}/api/integrations/discord/logs`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-admin"]), service: "survival" }) })).json();
          assert.equal(logs.ok, true);
          assert.equal(logs.service, "survival");
          assert.equal(logs.lines.length, 1);
          assert.doesNotMatch(logs.lines[0], /127\.0\.0\.1/);

          const blockedLogs = await fetch(`${base}/api/integrations/discord/logs`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]), service: "survival" }) });
          assert.equal(blockedLogs.status, 403);

          const mapState = await (await fetch(`${base}/api/integrations/discord/map-state`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(mapState.ok, true);
          assert.deepEqual(mapState.maps, ["Hagga Basin  running", "Deep Desert  running"]);

          const backups = await (await fetch(`${base}/api/integrations/discord/backups/list`, { headers: auth })).json();
          assert.equal(backups.ok, true);
          assert.equal(backups.backups[0].name, "dune-db-test-20260809-123400.backup");

          const announcements = await (await fetch(`${base}/api/integrations/discord/announcements`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(announcements.ok, true);
          assert.equal(announcements.announcements.settings.joinEnabled, true);

          assert.deepEqual(commandCalls, [["ready"], ["maps", "list"], ["db", "list"]]);

          // Existing version route remains live after adding player routes
          const version = await (await fetch(`${base}/api/integrations/discord/version`, { headers: auth })).json();
          assert.equal(version.ok, true);
          assert.equal(version.version, "dev");

          // Command catalog (Phase 1 of docs/rfc-command-discovery.md,
          // issue #337) -- bearer-token auth only, matching health.
          const catalog = await (await fetch(`${base}/api/integrations/discord/catalog`, { headers: auth })).json();
          assert.equal(catalog.ok, true);
          assert.equal(typeof catalog.protocolVersion, "number");
          assert.ok(Array.isArray(catalog.catalog.groups));
          assert.ok(catalog.catalog.groups.length > 0);
          assert.equal((await fetch(`${base}/api/integrations/discord/catalog`)).status, 401);

          // Auth: 401 without token
          assert.equal((await fetch(`${base}/api/integrations/discord/health`)).status, 401);

          // Auth: 404 unknown route
          assert.equal((await fetch(`${base}/api/integrations/discord/nonexistent`, { headers: auth })).status, 404);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// Actor signature enforcement — FINDING-LINK-1
// (docs/security/discord-player-link-hardening.md): when
// DUNE_DISCORD_ACTOR_SECRET is configured, the bearer token alone is no
// longer sufficient to make requests on behalf of an arbitrary actor.
test("adapter route rejects an unsigned or spoofed actor when DUNE_DISCORD_ACTOR_SECRET is configured", async () => {
  const tokenFile = "/tmp/discord-adapter-actor-sig-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "integration-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-actor-sig-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-actor-sig-test-generated" };
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, statusProvider: mockStatus });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);

          // Valid bearer token but no actor signature at all: rejected even
          // though this exact request would have succeeded before
          // DUNE_DISCORD_ACTOR_SECRET was configured.
          const unsigned = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(unsigned.status, 403);
          const unsignedBody = await unsigned.json();
          assert.equal(unsignedBody.code, "missing_actor_signature");

          // Correctly signed actor: accepted.
          const timestamp = Math.floor(Date.now() / 1000);
          const { signature } = signActorPayload(observerActor, "integration-test-actor-secret", timestamp, "/api/integrations/discord/status");
          const validSigned = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              [ACTOR_SIGNATURE_HEADER]: signature,
              [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
            },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(validSigned.status, 200);
          const validBody = await validSigned.json();
          assert.equal(validBody.ok, true);

          // Signature was computed for a different actor (observer); an
          // attacker with the bearer token tries to reuse that signature
          // while claiming an owner role to escalate privilege. Must be
          // rejected — this is exactly the confused-deputy scenario
          // FINDING-LINK-1 describes.
          const spoofedActor = { ...observerActor, roleIds: ["role-owner"] };
          const spoofed = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              [ACTOR_SIGNATURE_HEADER]: signature,
              [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
            },
            body: JSON.stringify({ actor: spoofedActor })
          });
          assert.equal(spoofed.status, 403);
          const spoofedBody = await spoofed.json();
          assert.equal(spoofedBody.code, "invalid_actor_signature");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Issue #691 code-review finding: guildOwnerId is NOT part of
// actorSignature.js's SIGNED_ACTOR_FIELDS, so once DUNE_DISCORD_ACTOR_SECRET
// is configured, a party able to obtain one validly-signed low-privilege
// envelope could inject an unsigned guildOwnerId matching their own (signed)
// userId to self-escalate to owner tier -- the signature never covers that
// field, so it still verifies. routes.js strips actor.guildOwnerId whenever
// signing is configured, closing this: prove it end-to-end through the real
// HTTP path, not just at the policy.js unit level (a prior review pass
// flagged that the unit tests alone didn't exercise this).
test("adapter route strips an unsigned guildOwnerId self-escalation attempt when DUNE_DISCORD_ACTOR_SECRET is configured", async () => {
  const tokenFile = "/tmp/discord-adapter-owner-strip-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "owner-strip-test-actor-secret";
  // Deliberately no DISCORD_ADMIN_ROLE_IDS/DISCORD_OWNER_ROLE_IDS configured
  // -- the only way this actor could reach the admin/owner-only OPS
  // capability is via the guildOwnerId claim.
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-owner-strip-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-owner-strip-test-generated" };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          // No admin/owner role -- only what a real observer-tier member
          // would legitimately hold.
          const lowPrivActor = actor(["role-observer"]);
          const timestamp = Math.floor(Date.now() / 1000);
          const route = "/api/integrations/discord/ops/activity";
          // Signature covers ONLY the 5 real SIGNED_ACTOR_FIELDS -- it is
          // computed exactly as a legitimate signer would for this actor.
          const { signature } = signActorPayload(lowPrivActor, "owner-strip-test-actor-secret", timestamp, route);
          // The self-escalation attempt: guildOwnerId is added on top of the
          // validly-signed actor, claiming this same user owns the guild.
          // Since guildOwnerId isn't hashed, the signature above still
          // matches this modified body.
          const escalatedActor = { ...lowPrivActor, guildOwnerId: lowPrivActor.userId };

          const response = await fetch(`${base}${route}`, {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              [ACTOR_SIGNATURE_HEADER]: signature,
              [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
            },
            body: JSON.stringify({ actor: escalatedActor })
          });
          // If guildOwnerId were honored here, this would be 200 (OPS_*
          // capabilities are admin/owner only) -- it must be 403, proving
          // the unsigned claim was stripped before discordActorTier() ran.
          assert.equal(response.status, 403);
          const body = await response.json();
          assert.equal(body.code, "not_authorized");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Cross-route replay rejection — FINDING-LINK-1 hardening. A signature that
// covered only actor identity fields (not the route) could be captured from
// one legitimate request (e.g. a routine "status" call, which requires no
// special privilege to observe) and replayed verbatim against a completely
// different, more sensitive route within the freshness window. Proves the
// route-bound signature closes that gap: the same actor + signature +
// timestamp that is valid for /status must be rejected for /readiness.
test("a signature valid for one route is rejected when replayed against a different route", async () => {
  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  const tokenFile = "/tmp/discord-adapter-cross-route-replay-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "cross-route-test-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-cross-route-replay-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-cross-route-replay-test-generated" };
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });
  const mockReadiness = async () => ({ ready: true, overall: "READY", issues: [] });

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, statusProvider: mockStatus, readinessProvider: mockReadiness });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);
          const timestamp = Math.floor(Date.now() / 1000);
          const { signature } = signActorPayload(observerActor, "cross-route-test-secret", timestamp, "/api/integrations/discord/status");
          const headers = {
            ...auth,
            "content-type": "application/json",
            [ACTOR_SIGNATURE_HEADER]: signature,
            [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
          };

          // The signature is valid for /status...
          const statusResponse = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers,
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(statusResponse.status, 200);

          // ...but must be rejected when replayed against /readiness, even
          // though the actor, timestamp, and signature bytes are identical
          // and still within the freshness window.
          const readinessResponse = await fetch(`${base}/api/integrations/discord/readiness`, {
            method: "POST",
            headers,
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(readinessResponse.status, 403);
          const readinessBody = await readinessResponse.json();
          assert.equal(readinessBody.code, "invalid_actor_signature");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Self-scoped capability enforcement — FINDING-LINK-2
// (docs/security/discord-player-link-hardening.md): player-link:write is
// no longer tier-gated at all; it authorizes any recognized Discord
// principal to act on their own identity, and rejects an actor with no
// configured role (public tier) regardless of what they claim as userId.
test("player-link route rejects a public-tier actor and allows an observer-tier actor", async () => {
  const tokenFile = "/tmp/discord-adapter-self-scoped-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  // Issue #245 fix: PLAYERS_LINK now requires a signed actor payload
  // unconditionally (routes.js's readJson(req, { requireActorSignature: true }))
  // -- without DUNE_DISCORD_ACTOR_SECRET configured, verifyActorSignature()
  // throws actor_signing_disabled (403) before the tier/capability check
  // this test means to exercise ever runs, for EITHER actor. Configuring
  // the secret and signing every request (matching the pattern the
  // "adapter route rejects an unsigned or spoofed actor..." test above
  // already established) lets the tier check underneath actually run.
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "player-link-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-self-scoped-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-self-scoped-test-generated" };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  function signedHeaders(actorPayload, route) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(actorPayload, "player-link-test-actor-secret", timestamp, route);
    return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
  }

  // Minimal permissive db stub: satisfies migrateDiscordAdapterSchema()'s
  // DDL calls and resolvePlayerByName()'s lookup query. Returns no rows for
  // the player lookup so linkPlayerProvider() itself returns a normal "no
  // player found" business result for the observer-tier case — the point
  // of this test is proving the actor never reaches that far when
  // unauthorized, not exercising the full link/whisper flow.
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const route = "/api/integrations/discord/players/link";

          // Public tier (no configured role at all) must be rejected, even
          // with a valid bearer token AND a validly-signed actor payload,
          // even though PLAYER_LINK_WRITE is a self-scoped capability
          // meant to be broadly available.
          const publicActor = { guildId: "guild-1", channelId: "channel-1", userId: "public-user", username: "no-role", roleIds: [] };
          const publicResponse = await fetch(`${base}${route}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(publicActor, route) },
            body: JSON.stringify({ actor: publicActor, characterName: "Chani" })
          });
          assert.equal(publicResponse.status, 403);
          const publicBody = await publicResponse.json();
          assert.equal(publicBody.code, "not_authorized");

          // Observer tier (any recognized principal) is authorized for
          // this self-scoped action — the request proceeds into
          // linkPlayerProvider() and returns a normal business result
          // (no player found, since the db stub returns no rows) rather
          // than a 403.
          const observerActor = actor(["role-observer"]);
          const observerResponse = await fetch(`${base}${route}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, route) },
            body: JSON.stringify({ actor: observerActor, characterName: "Chani" })
          });
          assert.equal(observerResponse.status, 200);
          const observerBody = await observerResponse.json();
          assert.equal(observerBody.ok, false);
          assert.match(observerBody.error, /No player found/i);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Verification rate limiting — FINDING-LINK-3
// (docs/security/discord-player-link-hardening.md): repeated wrong-code
// guesses against /players/link/verify for one discordUserId must
// eventually be rejected with 429, not left unthrottled.
test("player-link verify route rate limits repeated wrong-code attempts for one discordUserId", async () => {
  const { resetVerifyRateLimiterForTests } = await import("../src/integrations/discord/linkProvider.js");
  const { createLoginRateLimiter } = await import("../src/rateLimit.js");
  resetVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 2, globalMaxAttempts: 99, windowMs: 60000, blockMs: 60000 }));

  const tokenFile = "/tmp/discord-adapter-verify-rate-limit-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  // Issue #245 fix: PLAYERS_LINK_VERIFY now requires a signed actor
  // payload unconditionally (routes.js) -- see the identical fix and
  // comment on "player-link route rejects a public-tier actor..." above.
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "player-link-verify-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-verify-rate-limit-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-verify-rate-limit-test-generated" };
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  function signedHeaders(actorPayload, route) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(actorPayload, "player-link-verify-test-actor-secret", timestamp, route);
    return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
  }

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const route = "/api/integrations/discord/players/link/verify";
          const observerActor = actor(["role-observer"]);
          const verifyOnce = () => fetch(`${base}${route}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, route) },
            body: JSON.stringify({ actor: observerActor, code: "MENTAT-WRONG" })
          });

          const first = await verifyOnce();
          assert.equal(first.status, 200);
          const firstBody = await first.json();
          assert.equal(firstBody.ok, false);

          const second = await verifyOnce();
          assert.equal(second.status, 200);

          const third = await verifyOnce();
          assert.equal(third.status, 429);
          const thirdBody = await third.json();
          assert.equal(thirdBody.code, "verify_rate_limited");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Multi-account routes — FINDING-LINK-6
// (docs/security/discord-player-link-hardening.md): additive to the
// single-link routes above, gated by its own self-scoped capability
// (ACCOUNT_LINK_WRITE), not by reusing PLAYER_LINK_WRITE.
test("account-link routes reject a public-tier actor and allow an observer-tier actor to link and list accounts", async () => {
  const tokenFile = "/tmp/discord-adapter-multi-account-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  // Issue #245 fix: PLAYERS_ACCOUNTS_LINK and PLAYERS_ACCOUNTS_LIST both
  // now require a signed actor payload unconditionally (routes.js) -- see
  // the identical fix and comment on "player-link route rejects a
  // public-tier actor..." above.
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "account-link-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-multi-account-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-multi-account-test-generated" };

  const player = { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Online", funcom_id: "Chani#1234" };
  const accounts = [];
  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        return { rows: [player], rowCount: 1 };
      }
      if (text.includes("from console.discord_account_links dal")) {
        const rows = accounts.filter((a) => a.discordUserId === values[0]).map((a) => ({
          discord_user_id: a.discordUserId,
          player_controller_id: a.playerControllerId,
          is_default: a.isDefault,
          character_name: player.character_name,
          player_pawn_id: player.player_pawn_id,
          online_status: player.online_status
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("for update")) return { rows: [], rowCount: 0 };
      if (text.includes("select 1 from console.discord_account_links")) return { rows: [], rowCount: 0 };
      if (text.includes("insert into console.discord_account_links")) {
        accounts.push({ discordUserId: values[0], playerControllerId: values[1], isDefault: Boolean(values[2]) });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  function signedHeaders(actorPayload, route) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(actorPayload, "account-link-test-actor-secret", timestamp, route);
    return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
  }

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const linkRoute = "/api/integrations/discord/players/accounts/link";
          const listRoute = "/api/integrations/discord/players/accounts/list";

          // Public tier is rejected for the account-link route, same as the
          // single-link route — ACCOUNT_LINK_WRITE is self-scoped but still
          // requires a recognized principal (observer tier or above).
          const publicActor = { guildId: "guild-1", channelId: "channel-1", userId: "public-user", username: "no-role", roleIds: [] };
          const publicResponse = await fetch(`${base}${linkRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(publicActor, linkRoute) },
            body: JSON.stringify({ actor: publicActor, characterName: "Chani" })
          });
          assert.equal(publicResponse.status, 403);
          const publicBody = await publicResponse.json();
          assert.equal(publicBody.code, "not_authorized");

          // Observer tier is authorized: the list route reaches
          // listAccountsProvider without a 403 and returns a normal empty
          // result for a user with no linked accounts yet.
          const observerActor = actor(["role-observer"]);
          const listResponse = await fetch(`${base}${listRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, listRoute) },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(listResponse.status, 200);
          const listBody = await listResponse.json();
          assert.equal(listBody.ok, true);
          assert.deepEqual(listBody.accounts, []);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// End-to-end coverage for the Steam-OAuth-based link route (link-steam) --
// see linkAccountViaSteamProvider()'s own comment for why match-check and
// link happen together in one route rather than as two.
// Issue #245 fix: this test previously asserted the OLD, real-linking
// behavior of this route (public-tier 403, observer-tier genuine link,
// cross-user conflict with a generic error) -- routes.js's
// PLAYERS_ACCOUNTS_LINK_STEAM handler was intentionally changed (security
// review 2026-08-08, see the route's own comment) to unconditionally
// return a 200 "disabled" response for every request, regardless of actor
// tier or request body, because the underlying implementation accepted a
// playerControllerId/steamId64List directly without validating a Discord
// OAuth token or binding the Steam connection to an OAuth state. That
// change was never reflected in this test, which is why the old
// assertions (403 for public, real link for observer, 409 for a
// conflicting second user) all failed against the new, always-200-disabled
// actual response. Rewritten to assert the real, current, intentional
// behavior. Provider-level coverage for the underlying
// linkAccountViaSteamProvider() logic (which this disabled route no
// longer reaches) still exists directly in
// discordMultiAccountLinkProvider.test.js, unaffected by this route-level
// change.
test("link-steam route unconditionally returns disabled, regardless of actor tier (security review 2026-08-08, FINDING-STEAM-3)", async () => {
  const tokenFile = "/tmp/discord-adapter-link-steam-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-link-steam-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-link-steam-test-generated" };
  const STEAM_ID = "76561198000000042";
  const db = { transaction: (fn) => fn(db), async query() { return { rows: [], rowCount: 0 }; } };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const route = "/api/integrations/discord/players/accounts/link-steam";

          // Public tier: 200 disabled, not 403 -- the route returns before
          // any tier/capability check ever runs.
          const publicActor = { guildId: "guild-1", channelId: "channel-1", userId: "public-user", username: "no-role", roleIds: [] };
          const publicResponse = await fetch(`${base}${route}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: publicActor, playerControllerId: "42", steamId64List: [STEAM_ID] })
          });
          assert.equal(publicResponse.status, 200);
          const publicBody = await publicResponse.json();
          assert.equal(publicBody.ok, false);
          assert.equal(publicBody.status, "disabled");
          assert.equal(publicBody.reason, "steam_linking_pending_oauth_binding");

          // Observer tier: identical disabled response -- proves the
          // disablement is unconditional, not merely a side effect of the
          // public actor's own lack of authorization.
          const observerActor = actor(["role-observer"]);
          const observerResponse = await fetch(`${base}${route}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor, playerControllerId: "42", steamId64List: [STEAM_ID] })
          });
          assert.equal(observerResponse.status, 200);
          const observerBody = await observerResponse.json();
          assert.equal(observerBody.ok, false);
          assert.equal(observerBody.status, "disabled");
          assert.equal(observerBody.reason, "steam_linking_pending_oauth_binding");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// Rate limiting for the multi-account verify route — mirrors the
// single-link route's rate-limit test, but proves it uses a SEPARATE
// limiter instance so exhausting one flow's allowance never affects the
// other (FINDING-LINK-6's "Minimal Impact" design decision).
test("account-link verify route rate limits independently from the single-link verify route", async () => {
  const { resetVerifyRateLimiterForTests } = await import("../src/integrations/discord/linkProvider.js");
  const { resetAccountLinkVerifyRateLimiterForTests } = await import("../src/integrations/discord/multiAccountLinkProvider.js");
  const { createLoginRateLimiter } = await import("../src/rateLimit.js");
  resetVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 99, globalMaxAttempts: 999, windowMs: 60000, blockMs: 60000 }));
  resetAccountLinkVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 2, globalMaxAttempts: 99, windowMs: 60000, blockMs: 60000 }));

  const tokenFile = "/tmp/discord-adapter-multi-account-rate-limit-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  // Issue #245 fix: both PLAYERS_ACCOUNTS_LINK_VERIFY and
  // PLAYERS_LINK_VERIFY now require a signed actor payload
  // unconditionally (routes.js) -- see the identical fix and comment on
  // "player-link route rejects a public-tier actor..." above.
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "multi-account-rate-limit-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-multi-account-rate-limit-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-multi-account-rate-limit-test-generated" };
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  function signedHeaders(actorPayload, route) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(actorPayload, "multi-account-rate-limit-test-actor-secret", timestamp, route);
    return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
  }

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);
          const accountVerifyRoute = "/api/integrations/discord/players/accounts/link/verify";
          const singleVerifyRoute = "/api/integrations/discord/players/link/verify";

          const verifyAccountOnce = () => fetch(`${base}${accountVerifyRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, accountVerifyRoute) },
            body: JSON.stringify({ actor: observerActor, code: "MENTAT-WRONG" })
          });
          const verifySingleOnce = () => fetch(`${base}${singleVerifyRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, singleVerifyRoute) },
            body: JSON.stringify({ actor: observerActor, code: "MENTAT-WRONG" })
          });

          assert.equal((await verifyAccountOnce()).status, 200);
          assert.equal((await verifyAccountOnce()).status, 200);
          const thirdAccount = await verifyAccountOnce();
          assert.equal(thirdAccount.status, 429);
          const thirdAccountBody = await thirdAccount.json();
          assert.equal(thirdAccountBody.code, "verify_rate_limited");

          // The single-link verify route (separate limiter, and configured
          // with a much higher allowance above) is unaffected by the
          // account-link route's lockout for the same discordUserId.
          const singleAfterAccountLockout = await verifySingleOnce();
          assert.equal(singleAfterAccountLockout.status, 200);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// OPS observability routes — real data wiring (Phase 1/2 of the cross-repo
// stats/live-data remediation effort). ops/activity, ops/combat,
// ops/resources, ops/economy, ops/inventory, ops/soc, ops/prometheus are
// now backed by real data sources via opsProvider.js; the remaining OPS
// route (location) remains an unimplemented placeholder pending a
// privacy-consideration decision. Exercises the actual HTTP route path
// (not just the provider function directly) to prove db reaches the
// provider correctly through handleDiscordAdapterRoute()'s routing.
test("ops/activity, ops/inventory, ops/soc, and ops/prometheus routes return real data (or a real, specific 'unavailable' reason) through the HTTP route path, ops/location remains a planned placeholder", async () => {
  const tokenFile = "/tmp/discord-adapter-ops-live-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-ops-live-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-ops-live-test-generated" };

  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("from dune.player_state") && text.includes("count(*)::int as total_players")) {
        return { rows: [{ total_players: 9, online_players: 4, players_dead: 1, active_last_1h: 0, active_last_24h: 0, active_last_7d: 0, inactive_players: 0, returning_players: 0, new_players: 0 }] };
      }
      if (text.includes("from dune.items") && text.includes("count(*)::int as total_items")) {
        return { rows: [{ total_items: 5 }] };
      }
      if (text.includes("from dune.items") && text.includes("group by i.template_id")) {
        return { rows: [{ template_id: "Stone", count: 5, total_stack: 2477 }] };
      }
      if (text.includes("from dune.placeables p") && text.includes("building_type in")) {
        return { rows: [{ id: 13, name: "", class: "SpiceSilo_Placeable", map: "HaggaBasin", item_count: 5, owner_name: "Sihaya" }] };
      }
      return { rows: [] };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          // OPS_* capabilities are deliberately admin/owner only, not
          // granted to moderator or observer (see policy.js's
          // CAPABILITY_BY_TIER and discordPolicy.test.js's "OPS
          // capabilities are granted only to admin and owner tiers") --
          // an observer- or moderator-tier actor is correctly rejected by
          // requireDiscordCapability() now that the opsRoutes dispatch in
          // routes.js actually enforces it (merged from upstream during
          // #279's reconciliation; this test previously exercised these
          // routes with no real authorization gate in place at all).
          const observerActor = actor(["role-admin"]);

          const activityResponse = await fetch(`${base}/api/integrations/discord/ops/activity`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(activityResponse.status, 200);
          const activityBody = await activityResponse.json();
          assert.equal(activityBody.ok, true);
          assert.equal(activityBody.result.totalPlayers, 9);
          assert.equal(activityBody.result.onlinePlayers, 4);
          assert.equal("status" in activityBody, false, "must not look like the old placeholder shape");

          const inventoryResponse = await fetch(`${base}/api/integrations/discord/ops/inventory`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(inventoryResponse.status, 200);
          const inventoryBody = await inventoryResponse.json();
          assert.equal(inventoryBody.ok, true);
          assert.equal(inventoryBody.result.totalItems, 5);
          assert.equal(inventoryBody.result.totalInventories, 1);
          assert.equal(inventoryBody.result.totalCrafted, null, "totalCrafted has no real source and must stay null, never a guessed number");
          assert.equal("status" in inventoryBody, false, "must not look like the old placeholder shape");

          const socResponse = await fetch(`${base}/api/integrations/discord/ops/soc`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(socResponse.status, 200);
          const socBody = await socResponse.json();
          assert.equal(socBody.ok, true);
          // The Discord adapter path (handleDiscordAdapterRoute, tested
          // here) never itself calls audit(config, req, "addons.bridge",
          // ...) — only the separate addon-bridge path in server.js does,
          // for installed third-party addons, which is a different
          // consumer than the Discord bot. So the in-memory rolling
          // counter this route reads from is correctly, legitimately
          // empty in this test's process — asserting a real 0, not a
          // placeholder, is exactly the right check here.
          assert.equal(socBody.result.bridgeRequests, 0);
          assert.equal(socBody.result.bridgeErrors, 0);
          assert.equal(socBody.result.platformHealth, "Unknown");
          assert.equal("status" in socBody, false, "must not look like the old placeholder shape");

          // ops/prometheus is real, but conditionally available: this
          // test environment does not have the optional metrics stack
          // running (dune metrics start), so this correctly exercises
          // addonOpsPrometheusHealth()'s "not running" precondition path
          // — the same, real, distinct-from-generic-"planned" shape that
          // was directly verified against a live deployment before this
          // was written (see duneDb.js's own comment on
          // addonOpsPrometheusHealth for that verification).
          const prometheusResponse = await fetch(`${base}/api/integrations/discord/ops/prometheus`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(prometheusResponse.status, 200);
          const prometheusBody = await prometheusResponse.json();
          assert.equal(prometheusBody.ok, true);
          assert.equal(prometheusBody.result.status, "planned");
          assert.equal(prometheusBody.result.reason, "metrics_stack_not_running", "must report the specific reason, distinct from a generically unimplemented route");

          // ops/location is intentionally, permanently out of scope for
          // this addon (per-player location tracking already belongs to
          // the Console's own map UI — decided 2026-07-24) and, unlike
          // the other OPS routes, is not wired into opsRoutes' dispatch
          // table at all (no capability defined for it, since it will
          // never return real data) -- the route correctly 404s through
          // the same dispatch path every other unrecognized route does,
          // rather than a fake 200 placeholder response. Confirmed via
          // discordAdapterHealth()'s own plannedRoutes/liveRoutes split
          // (tested separately, above) that this is reported accurately
          // to callers who ask about capability, without ever needing a
          // live HTTP round-trip to a route that can never do anything.
          const locationResponse = await fetch(`${base}/api/integrations/discord/ops/location`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(locationResponse.status, 404);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// ops/dashboard regression: this route was genuinely live through the
// 2026-08-06 baseline, silently dropped from routes.js's opsRoutes
// dispatch table by an unrelated upstream refactor, and 404'd for a real,
// unnoticed period before being caught (see dune-awakening-selfhost-docker#695).
// opsDashboardProvider() itself was never touched by that regression --
// only the dispatch wiring was missing -- so this exercises the actual
// HTTP route path end to end, the same way the sibling OPS routes above
// are tested, rather than calling the provider function directly.
test("ops/dashboard route dispatches to opsDashboardProvider through the real HTTP path, and enforces admin/owner-only capability", async () => {
  const tokenFile = "/tmp/discord-adapter-ops-dashboard-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-ops-dashboard-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-ops-dashboard-test-generated" };

  const db = {
    transaction: (fn) => fn(db),
    async query(text) {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("from dune.player_state") && text.includes("count(*)::int as total_players")) {
        return { rows: [{ total_players: 9, online_players: 4, players_dead: 1, active_last_1h: 0, active_last_24h: 0, active_last_7d: 0, inactive_players: 0, returning_players: 0, new_players: 0 }] };
      }
      return { rows: [] };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // Admin (and, by the same admin/owner-only OPS_* pattern every
          // other OPS capability follows, owner) can reach it.
          const adminResponse = await fetch(`${base}/api/integrations/discord/ops/dashboard`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-admin"]) })
          });
          assert.equal(adminResponse.status, 200);
          const adminBody = await adminResponse.json();
          assert.equal(adminBody.ok, true);
          // Aggregates all eight sub-providers, including the always-a-
          // placeholder location one -- same mixed-shape contract
          // opsDashboardProvider's own comment describes.
          assert.deepEqual(
            Object.keys(adminBody.dashboard).sort(),
            ["activity", "combat", "economy", "inventory", "location", "prometheus", "resources", "soc"]
          );
          assert.equal(adminBody.dashboard.activity.result.totalPlayers, 9, "real data reaches the aggregate through the actual dispatch path, not a stub");
          assert.equal(adminBody.dashboard.location.status, "planned");

          // Moderator and observer are correctly rejected -- OPS_DASHBOARD_READ
          // follows the same admin/owner-only pattern as every other OPS_*
          // capability (see discordPolicy.test.js's "OPS capabilities are
          // granted only to admin and owner tiers").
          const moderatorResponse = await fetch(`${base}/api/integrations/discord/ops/dashboard`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-moderator"]) })
          });
          assert.equal(moderatorResponse.status, 403);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// players/faction and guild-character-grants/* (issue #696) -- real HTTP
// dispatch path, not just the provider-level unit coverage in
// discordLinkProvider.test.js / discordMultiAccountLinkProvider.test.js.
test("players/faction route dispatches to playerFactionProvider through the real HTTP path, and enforces tier-gated capability", async () => {
  const tokenFile = "/tmp/discord-adapter-players-faction-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-players-faction-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-players-faction-test-generated" };

  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from console.discord_player_links dpl")) {
        return {
          rows: [{ discord_user_id: values[0], player_controller_id: "42", character_name: "Chani", player_pawn_id: "84", online_status: "Online" }],
          rowCount: 1
        };
      }
      if (text.includes("from dune.player_faction pf")) {
        return { rows: [{ actor_id: "42", faction_id: "7", faction_name: "House Atreides" }], rowCount: 1 };
      }
      return { rows: [] };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // INVENTORY_READ (the same capability PLAYERS_ME/whoami uses) is
          // moderator-tier-and-above, not observer -- see discordPolicy.js's
          // CAPABILITY_BY_TIER. A caller-supplied "faction" body field, if
          // any were sent, must be ignored entirely -- this route is
          // read-only/auto-detected.
          const response = await fetch(`${base}/api/integrations/discord/players/faction`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-moderator"]), faction: "House Harkonnen" })
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.ok, true);
          assert.equal(body.linked, true);
          assert.equal(body.hasFaction, true);
          assert.equal(body.factionName, "House Atreides", "must report the real dune.player_faction value, never the caller-supplied one");

          // Observer tier (below INVENTORY_READ's moderator floor) is rejected.
          const observerResponse = await fetch(`${base}/api/integrations/discord/players/faction`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-observer"]) })
          });
          assert.equal(observerResponse.status, 403);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

test("guild-character-grants/* routes dispatch through the real HTTP path, scope guildId from the signed actor (not the request body), and enforce self-scoped capability", async () => {
  const tokenFile = "/tmp/discord-adapter-guild-grants-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");

  // GUILD_GRANTS_* use requireActorSignature: true (same as
  // PLAYERS_ACCOUNTS_LINK/UNLINK) -- verifyActorSignature() throws
  // actor_signing_disabled (403) for any mutation route when no secret is
  // configured, before the tier/capability check this test means to
  // exercise ever runs. Same fix as the "adapter route rejects an
  // unsigned or spoofed actor..." / PLAYERS_LINK tests above: configure
  // the secret and sign every request.
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "guild-grants-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-guild-grants-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-guild-grants-test-generated" };

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  function signedHeaders(actorPayload, route) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = signActorPayload(actorPayload, "guild-grants-test-actor-secret", timestamp, route);
    return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
  }

  const guildState = [];
  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("select 1 from console.discord_account_links")) {
        const linked = values[1] === "42";
        return { rows: linked ? [{}] : [], rowCount: linked ? 1 : 0 };
      }
      if (text.includes("insert into console.discord_account_link_guild_state")) {
        const [discordUserId, guildId, playerControllerId] = values;
        const enabled = text.includes("is_default") ? true : Boolean(values[3]);
        const isDefault = text.includes("is_default");
        let row = guildState.find((g) => g.discordUserId === discordUserId && g.guildId === guildId && g.playerControllerId === playerControllerId);
        if (!row) { row = { discordUserId, guildId, playerControllerId }; guildState.push(row); }
        row.enabled = enabled;
        if (isDefault) row.isDefault = true;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("update console.discord_account_link_guild_state")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const enableRoute = "/api/integrations/discord/guild-character-grants/enable";
          const defaultRoute = "/api/integrations/discord/guild-character-grants/default";
          const disableRoute = "/api/integrations/discord/guild-character-grants/disable";

          // Any recognized principal can enable their OWN character
          // (self-scoped ACCOUNT_LINK_WRITE, same gate as
          // players/accounts/unlink) -- observer tier is enough.
          const observerActor = actor(["role-observer"]);
          const enableResponse = await fetch(`${base}${enableRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, enableRoute) },
            // guildId is deliberately NOT sent here -- it must come from
            // the signed actor object (actor().guildId === "guild-1"),
            // never a body field a caller could forge to act on a guild
            // they aren't actually in.
            body: JSON.stringify({ actor: observerActor, characterLinkId: "42" })
          });
          assert.equal(enableResponse.status, 200);
          const enableBody = await enableResponse.json();
          assert.equal(enableBody.ok, true);
          assert.equal(guildState[0].guildId, "guild-1", "guildId must be taken from actor.guildId, not a body field");
          assert.equal(guildState[0].playerControllerId, "42");
          assert.equal(guildState[0].enabled, true);

          const defaultResponse = await fetch(`${base}${defaultRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, defaultRoute) },
            body: JSON.stringify({ actor: observerActor, characterLinkId: "42" })
          });
          assert.equal(defaultResponse.status, 200);
          assert.equal(guildState[0].isDefault, true);

          // A character not linked to the caller is a business error
          // (found: false), not a crash or a silent success.
          const notLinkedResponse = await fetch(`${base}${disableRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(observerActor, disableRoute) },
            body: JSON.stringify({ actor: observerActor, characterLinkId: "999" })
          });
          assert.equal(notLinkedResponse.status, 200);
          const notLinkedBody = await notLinkedResponse.json();
          assert.equal(notLinkedBody.ok, false);

          // Public tier (no recognized role) is rejected -- self-scoped
          // capabilities still require SOME recognized principal.
          const publicActor = actor([]);
          const publicResponse = await fetch(`${base}${enableRoute}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", ...signedHeaders(publicActor, enableRoute) },
            body: JSON.stringify({ actor: publicActor, characterLinkId: "42" })
          });
          assert.equal(publicResponse.status, 403);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// guilds/faction-summary (issue #699) -- real HTTP dispatch path for the
// bot's own per-guild themed-embed faction auto-sync aggregate.
test("guilds/faction-summary route dispatches to guildFactionSummaryProvider through the real HTTP path, tallies each linked player's real IN-GAME GUILD's faction, and enforces GUILD_READ (moderator-and-up)", async () => {
  const tokenFile = "/tmp/discord-adapter-guild-faction-summary-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-guild-faction-summary-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-guild-faction-summary-test-generated" };

  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from information_schema.columns")) {
        const [, table] = values;
        if (table === "guild_members") return { rows: [{ column_name: "player_id" }, { column_name: "guild_id" }] };
        if (table === "guilds") return { rows: [{ column_name: "guild_id" }, { column_name: "guild_faction" }] };
        return { rows: [] };
      }
      if (text.includes("with resolved as")) {
        // discord-1/discord-2's characters are in real in-game guilds
        // whose faction is House Atreides -- NOT a claim about either
        // player's own personal faction.
        const links = { "discord-1": "42", "discord-2": "43" };
        const factions = { "42": "House Atreides", "43": "House Atreides" };
        const tally = {};
        for (const id of values[0] || []) {
          const pcId = links[id];
          const name = pcId && factions[pcId];
          if (name) tally[name] = (tally[name] || 0) + 1;
        }
        return { rows: Object.entries(tally).map(([faction_name, tally_count]) => ({ faction_name, tally_count })) };
      }
      return { rows: [] };
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          const response = await fetch(`${base}/api/integrations/discord/guilds/faction-summary`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-moderator"]), discordUserIds: ["discord-1", "discord-2", "discord-3"] })
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.ok, true);
          assert.deepEqual(body.tally, { "House Atreides": 2 });
          assert.equal(body.consideredCount, 2, "discord-3 (never linked) must not be counted");
          assert.deepEqual(Object.keys(body).sort(), ["consideredCount", "ok", "tally"], "must never echo back per-user identity alongside the tally");

          // Observer tier (below GUILD_READ's moderator floor) is rejected.
          const observerResponse = await fetch(`${base}/api/integrations/discord/guilds/faction-summary`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-observer"]), discordUserIds: ["discord-1"] })
          });
          assert.equal(observerResponse.status, 403);

          // A non-array discordUserIds is a real 400, not a crash or a
          // silently-empty tally.
          const badResponse = await fetch(`${base}/api/integrations/discord/guilds/faction-summary`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: actor(["role-moderator"]), discordUserIds: "discord-1" })
          });
          assert.equal(badResponse.status, 400);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});
