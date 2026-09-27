// Full, real end-to-end proof of the Discord write bridge. Every other write-bridge test either mounts
// handleDiscordAdapterRoute directly in-process with no socket server
// running at all (writeBridge.integration.test.js, which deliberately gets
// 503 write_backend_unavailable at the Hop-B boundary), or exercises Hop B's
// individual components in isolation (writeBridgeSocketServer.test.js,
// writeBridgeCredential.test.js, etc.). None of them prove the actual, real
// success round trip: a real write/preview -> write/execute HTTP call that
// really crosses a really-running Unix socket, reaches a real target-route
// handler, and really persists a real mutation to disk. This file is that
// proof -- the "undeniable, not just unit-tested" standard this feature was
// built to.
//
// Two things this file deliberately does NOT attempt, and why:
//   - Spawning the real server.js entrypoint as a child process (the pattern
//     autoInviteRoutes.integration.test.js uses) was tried and abandoned: it
//     requires the child to run as a non-root UID to exercise the socket's
//     root-UID-refusal-free success path (this sandbox genuinely runs as
//     root -- see writeBridgeSocketServer.test.js), but this repo lives
//     under /root, which is mode 0700, so a non-root child cannot even
//     traverse into the working directory to find server.js. Root-refusal
//     itself is already proven correct, in isolation, by
//     writeBridgeSocketServer.test.js.
//   - Re-deriving server.js's ~3700-line route dispatcher's own if/else path
//     matching. That's a separate, already-covered concern (rbacParity.test.js,
//     apiKeyAuthWiring.test.js, and dozens of route-specific tests all
//     exercise it) with no write-bridge-specific risk -- WRITE_ACTION_ROUTES's
//     own selfCheckWriteActionRoutes() plus matchesWriteActionTarget's own
//     exhaustive test already prove the write bridge's routing table agrees
//     with the real dispatcher's real IAM actions.
//
// What IS real and unmocked here: the actor-signature verification, the
// nonce store, the capability/tier checks, a REAL startWriteBridgeSocketServer()
// Unix-socket listener, a REAL http-over-socket client
// (callWriteBridgeInternalRoute), and the REAL enableCarePackage() mutation
// function from carePackage.js -- imported directly, not reimplemented --
// which is what proves the on-disk mutation is genuine. The one deliberate
// stand-in is the HTTP framing/path-matching immediately around
// enableCarePackage() (server.js's own carePackageEnableRoute is not
// exported for reuse) -- it mirrors that handler's real logic exactly
// (same confirmation-phrase gate, same function call, same response shape).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E_SCRATCH_ROOT = tmpdir();
import { handleDiscordAdapterRoute, WRITE_BRIDGE_SOCKET_FILENAME } from "../src/integrations/discord/routes.js";
import { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER, WRITE_BRIDGE_SIGNED_ACTOR_FIELDS } from "../src/integrations/discord/actorSignature.js";
import { resetWriteNonceStoreForTests } from "../src/integrations/discord/writeBridgeState.js";
import { startWriteBridgeSocketServer } from "../src/integrations/discord/writeBridgeSocketServer.js";
import { resolveWriteBridgePrincipal } from "../src/integrations/discord/writeBridgeCredential.js";
import { audit } from "../src/audit.js";
import { enableCarePackage, carePackageConfig } from "../src/carePackage.js";

const BOT_TOKEN = "e2e-write-bridge-bot-token";
const ACTOR_SECRET = "e2e-write-bridge-actor-secret";
const PREVIEW_ROUTE = "/api/integrations/discord/write/preview";
const EXECUTE_ROUTE = "/api/integrations/discord/write/execute";

function actor(overrides = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "e2e-user",
    username: "e2e-tester",
    roleIds: ["role-admin"],
    roleSnapshotAt: Math.floor(Date.now() / 1000),
    ...overrides
  };
}

// `action` and `params` must match the real request body's own fields
// exactly (see actorSignature.js's WRITE_BRIDGE_SIGNED_ACTOR_FIELDS) -- the
// signature binds the specific action AND parameters being requested, not
// just the actor+route.
function signedHeaders(actorPayload, route, action, params) {
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature } = signActorPayload({ ...actorPayload, action, params }, ACTOR_SECRET, timestamp, route, WRITE_BRIDGE_SIGNED_ACTOR_FIELDS);
  return { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(timestamp) };
}

// A faithful stand-in for server.js's own carePackageEnableRoute (not
// exported for direct reuse): same confirmation-phrase gate, same real
// enableCarePackage() call, same response shape, same real audit() call
// with the same real attribution wiring server.js's requestHandler/handleApi
// actually does (resolveWriteBridgePrincipal() -> req.authSession = principal
// -> audit()'s principalOf(req.authSession)). Added because the original
// stand-in silently omitted both the try/catch AND the audit() call,
// meaning no test anywhere verified that a write-bridge-driven mutation is
// actually attributed to the real Discord actor in the audit log. This is
// what a real write-bridge internal HTTP client
// (callWriteBridgeInternalRoute) sees on the other end of the real socket --
// exactly the interface server.js's real dispatcher presents.
function realTargetRouteListener(testConfig) {
  return (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      // Real attribution wiring, not server.js's routing (already covered
      // elsewhere -- see the header comment): a write-bridge request always
      // arrives with viaWriteBridgeSocket true from requestHandler's
      // perspective, so this mirrors that exactly.
      req.authSession = resolveWriteBridgePrincipal({ headers: req.headers, method: req.method, path: req.url, viaWriteBridgeSocket: true });
      if (req.method === "POST" && req.url === "/api/care-package/enable") {
        const body = raw ? JSON.parse(raw) : {};
        if (body.confirmation !== "ENABLE CARE PACKAGE") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Confirmation phrase required: ENABLE CARE PACKAGE" }));
          return;
        }
        try {
          const saved = enableCarePackage(testConfig, true); // the real mutation
          audit(testConfig, req, "care-package.enable", { supported: true, version: saved.version });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(saved));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error?.message || "Unexpected error.") }));
        }
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  };
}

async function withHopAServer(testConfig, fn) {
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
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writePreview(base, a, action, params) {
  const response = await fetch(`${base}${PREVIEW_ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, PREVIEW_ROUTE, action, params) },
    body: JSON.stringify({ actor: a, action, params })
  });
  return { status: response.status, body: await response.json() };
}

async function writeExecute(base, a, nonce, action, params) {
  const response = await fetch(`${base}${EXECUTE_ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json", ...signedHeaders(a, EXECUTE_ROUTE, action, params) },
    body: JSON.stringify({ actor: a, nonce, action, params })
  });
  return { status: response.status, body: await response.json() };
}

let tempDir;
let testConfig;
let socketServer;
let OLD_ACTOR_SECRET;
let OLD_WRITES_ENABLED;
let OLD_ADMIN_ROLE_IDS;

test.beforeEach(async () => {
  resetWriteNonceStoreForTests();
  tempDir = mkdtempSync(join(E2E_SCRATCH_ROOT, "run-"));
  testConfig = {
    discordBotApiTokenFile: null,
    discordAdapterToken: BOT_TOKEN,
    discordAdapterEnabled: true,
    discordWritesEnabled: true,
    auditLog: join(tempDir, "audit.jsonl"),
    generatedDir: join(tempDir, "generated")
  };
  // Real production config.js's loadConfig() always mkdir's generatedDir at
  // boot before anything tries to use it -- this hand-built testConfig
  // isn't loaded through loadConfig(), so it must do the same thing here.
  mkdirSync(testConfig.generatedDir, { recursive: true });

  OLD_ACTOR_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  OLD_WRITES_ENABLED = process.env.DUNE_DISCORD_WRITES_ENABLED;
  OLD_ADMIN_ROLE_IDS = process.env.DISCORD_ADMIN_ROLE_IDS;
  process.env.DUNE_DISCORD_ACTOR_SECRET = ACTOR_SECRET;
  process.env.DUNE_DISCORD_WRITES_ENABLED = "1";
  process.env.DISCORD_ADMIN_ROLE_IDS = "role-admin";

  // The REAL Unix-socket listener (Hop B), started exactly the
  // way server.js's own boot sequence starts it -- the only difference is
  // `deps: { getuid: () => 1000 }`, standing in for a real non-root
  // production process (this sandbox genuinely runs as root; see the header
  // comment for why an OS-level UID drop isn't feasible here). Everything
  // downstream of this call -- the socket file, its 0700 mode, the real
  // HTTP-over-socket protocol -- is exactly production code, unmodified.
  const socketPath = join(testConfig.generatedDir, WRITE_BRIDGE_SOCKET_FILENAME);
  const result = await startWriteBridgeSocketServer({
    socketPath,
    requestListener: realTargetRouteListener(testConfig),
    deps: { getuid: () => 1000 }
  });
  assert.equal(result.disabled, false, "the real write-bridge socket must actually start for this test to prove anything");
  socketServer = result.server;
});

test.afterEach(() => {
  socketServer?.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetWriteNonceStoreForTests();
  process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_WRITES_ENABLED = OLD_WRITES_ENABLED;
  process.env.DISCORD_ADMIN_ROLE_IDS = OLD_ADMIN_ROLE_IDS;
});

test("full real round trip: write/preview -> write/execute crosses a REAL running Unix socket and REALLY mutates care-package.json on disk", async () => {
  await withHopAServer(testConfig, async (base) => {
    const a = actor();

    const preview = await writePreview(base, a, "carepackage.enable");
    assert.equal(preview.status, 200, `preview failed: ${JSON.stringify(preview.body)}`);
    assert.ok(preview.body.nonce, "preview must return a real, usable nonce");

    // This is also the live regression proof for a real, previously-shipped
    // bug: carepackage.enable was missing its required confirmPhrase in
    // WRITE_ACTION_ROUTES, so write/execute never injected `confirmation`
    // into the internal loopback body, and this exact call would have
    // 400'd with "Confirmation phrase required: ENABLE CARE PACKAGE"
    // against the real target route.
    const execute = await writeExecute(base, a, preview.body.nonce, "carepackage.enable");
    assert.equal(execute.status, 200, `execute failed: ${JSON.stringify(execute.body)}`);
    assert.equal(execute.body.enabled, true);

    // Proof the mutation is real, not just a 200 the stand-in happened to
    // return: read the actual file the real enableCarePackage() wrote,
    // independent of the HTTP response, and independently via the real
    // carePackageConfig() reader too.
    const configFile = join(testConfig.generatedDir, "care-package.json");
    assert.ok(existsSync(configFile), "the real enableCarePackage() call must have written its real config file");
    const onDisk = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(onDisk.enabled, true);
    assert.equal(carePackageConfig(testConfig).enabled, true, "the real reader function must also observe the real mutation");

    // Proof the real attribution chain actually reaches the
    // real audit log for a write-bridge-driven mutation, not just that
    // writeBridgeCredential.js constructs a userId-bearing object in
    // isolation (already covered elsewhere) -- read the real audit.jsonl
    // file the real audit() call wrote to.
    //
    // type: "discord-write-bridge", not the generic "session" (STRIDE
    // Repudiation): before this fix, principalOf() had no
    // branch for the write-bridge principal, so this row was indistinguishable
    // from a real interactive browser/OAuth session -- this real end-to-end
    // assertion is the proof the fix actually reaches the durable audit log,
    // not just principalOf()'s own unit tests.
    const auditRows = readFileSync(testConfig.auditLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const auditRow = auditRows.find((row) => row.action === "care-package.enable");
    assert.ok(auditRow, "the real target route's audit() call must have produced a row");
    assert.deepEqual(auditRow.principal, { type: "discord-write-bridge", tier: "admin", userId: "e2e-user" },
      "the audit row must attribute this mutation to the real Discord actor via a distinguishable write-bridge type, not an anonymous/api-key/generic-session principal");
  });
});

test("full real round trip: an actor whose tier cannot perform the action never reaches the real socket -- proven by the target file never being created", async () => {
  process.env.DISCORD_ADMIN_ROLE_IDS = "";
  process.env.DISCORD_OWNER_ROLE_IDS = "role-owner";
  await withHopAServer(testConfig, async (base) => {
    const moderator = actor({ roleIds: ["role-admin"] }); // no tier at all now that admin role mapping is cleared

    // carepackage.grant-all requires owner tier (writeActionMinTier.js); this
    // actor has no recognized tier role at all and must be rejected at Hop A.
    const preview = await writePreview(base, moderator, "carepackage.grant-all");
    assert.equal(preview.status, 403);

    const configFile = join(testConfig.generatedDir, "care-package.json");
    assert.equal(existsSync(configFile), false, "a request rejected at Hop A must never reach the real target route");
  });
});
