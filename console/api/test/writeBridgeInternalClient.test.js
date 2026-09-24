// Dedicated tests for writeBridgeInternalClient.js (issue #215's Hop B HTTP
// client). Flagged as a real gap by the Layer 2 QA hat (issue #1023): this
// module had zero tests of its own before this file, despite an injectable
// `requestImpl` clearly built for isolated testing, and despite being the
// one piece every one of the 25 write actions' real dispatch depends on.
//
// Two tiers, matching this project's established discipline: a real Unix
// socket + real HTTP server for the primary, end-to-end proof that the
// right method/path/headers/body actually cross the wire; a handful of
// injected-requestImpl tests for edge cases a real socket can't easily
// force (a connection error, a non-JSON response body).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWriteBridgeInternalRoute } from "../src/integrations/discord/writeBridgeInternalClient.js";
import {
  getWriteBridgeToken,
  resetWriteBridgeTokenForTests,
  WRITE_BRIDGE_TOKEN_HEADER,
  WRITE_BRIDGE_ACTION_HEADER,
  WRITE_BRIDGE_TIER_HEADER,
  WRITE_BRIDGE_ACTOR_USER_ID_HEADER,
  WRITE_BRIDGE_ACTOR_USERNAME_HEADER
} from "../src/integrations/discord/writeBridgeCredential.js";

let tempDir;
test.beforeEach(() => {
  resetWriteBridgeTokenForTests();
  tempDir = mkdtempSync(join(tmpdir(), "write-bridge-internal-client-test-"));
});
test.afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

// --- real Unix socket + real HTTP server ---

function startRealTarget(socketPath, handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => resolve(server)).on("error", reject);
  });
}

test("callWriteBridgeInternalRoute: real request over a real Unix socket carries the exact method, path, body, and all five write-bridge headers", async () => {
  const socketPath = join(tempDir, "target.sock");
  let received = null;
  const server = await startRealTarget(socketPath, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      received = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const result = await callWriteBridgeInternalRoute({
      socketPath,
      method: "POST",
      path: "/api/players/Server%234242/kick",
      action: "player.kick",
      tier: "moderator",
      discordUserId: "user-1",
      discordUsername: "tester",
      body: { reason: "AFK" }
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { ok: true });

    assert.equal(received.method, "POST");
    assert.equal(received.url, "/api/players/Server%234242/kick");
    assert.deepEqual(received.body, { reason: "AFK" });
    assert.equal(received.headers[WRITE_BRIDGE_TOKEN_HEADER], getWriteBridgeToken());
    assert.equal(received.headers[WRITE_BRIDGE_ACTION_HEADER], "player.kick");
    assert.equal(received.headers[WRITE_BRIDGE_TIER_HEADER], "moderator");
    assert.equal(received.headers[WRITE_BRIDGE_ACTOR_USER_ID_HEADER], "user-1");
    assert.equal(received.headers[WRITE_BRIDGE_ACTOR_USERNAME_HEADER], "tester");
  } finally {
    server.close();
  }
});

test("callWriteBridgeInternalRoute: DELETE method (player.unban, guild.remove's real shape) crosses correctly with no body", async () => {
  const socketPath = join(tempDir, "delete.sock");
  let received = null;
  const server = await startRealTarget(socketPath, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      received = { method: req.method, contentLength: req.headers["content-length"], raw };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const result = await callWriteBridgeInternalRoute({
      socketPath,
      method: "DELETE",
      path: "/api/players/Server%234242/ban",
      action: "player.unban",
      tier: "admin",
      discordUserId: "user-2",
      discordUsername: "unbanner",
      body: undefined
    });
    assert.equal(result.statusCode, 200);
    assert.equal(received.method, "DELETE");
    assert.equal(received.contentLength, "0");
    assert.equal(received.raw, "");
  } finally {
    server.close();
  }
});

test("callWriteBridgeInternalRoute: an empty discordUsername falls back to an empty header value, never 'undefined'", async () => {
  const socketPath = join(tempDir, "empty-username.sock");
  let received = null;
  const server = await startRealTarget(socketPath, (req, res) => {
    received = { username: req.headers[WRITE_BRIDGE_ACTOR_USERNAME_HEADER] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    await callWriteBridgeInternalRoute({
      socketPath,
      method: "POST",
      path: "/api/server/restart",
      action: "server.restart",
      tier: "owner",
      discordUserId: "user-3",
      discordUsername: undefined,
      body: {}
    });
    assert.equal(received.username, "");
  } finally {
    server.close();
  }
});

test("callWriteBridgeInternalRoute: CR/LF in discordUsername can never reach the outgoing header raw -- encodeURIComponent escapes it, decodes back to the original content", async () => {
  const socketPath = join(tempDir, "crlf-username.sock");
  let received = null;
  const server = await startRealTarget(socketPath, (req, res) => {
    received = { username: req.headers[WRITE_BRIDGE_ACTOR_USERNAME_HEADER] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const original = "evil\r\nX-Injected: yes";
    await callWriteBridgeInternalRoute({
      socketPath,
      method: "POST",
      path: "/api/server/restart",
      action: "server.restart",
      tier: "owner",
      discordUserId: "user-3b",
      discordUsername: original,
      body: {}
    });
    assert.ok(!received.username.includes("\r") && !received.username.includes("\n"), "the raw outgoing header value must never contain a literal CR/LF byte");
    assert.equal(decodeURIComponent(received.username), original, "the receiving end must be able to recover the exact original content, not a lossily-stripped version of it");
  } finally {
    server.close();
  }
});

// [Layer 3 integration audit fix] Real Discord display names routinely
// contain characters outside Latin-1 (CJK, Cyrillic, Arabic, emoji) -- not
// just adversarial input. Node's http.request throws synchronously
// (ERR_INVALID_CHAR) for any header value containing a code unit outside
// \t/\x20-\x7e/\x80-\xff; the previous version of this header only stripped
// CR/LF and left every other such character raw, so an ordinary non-Latin-1
// display name crashed this call -- AFTER writeExecuteRoute had already
// irreversibly consumed the nonce, turning a legitimate confirmed action
// into a spent confirmation and a confusing 503 write_backend_unavailable.
test("callWriteBridgeInternalRoute: a real, non-Latin-1 Discord display name (CJK, Cyrillic, emoji) does not crash the outgoing request and round-trips exactly", async () => {
  const socketPath = join(tempDir, "unicode-username.sock");
  let received = null;
  const server = await startRealTarget(socketPath, (req, res) => {
    received = { username: req.headers[WRITE_BRIDGE_ACTOR_USERNAME_HEADER] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    for (const original of ["田中太郎", "Дмитрий", "أحمد", "🎮 GameMaster 🎮"]) {
      const result = await callWriteBridgeInternalRoute({
        socketPath,
        method: "POST",
        path: "/api/server/restart",
        action: "server.restart",
        tier: "owner",
        discordUserId: "user-unicode",
        discordUsername: original,
        body: {}
      });
      assert.equal(result.statusCode, 200, `a non-Latin-1 username must never prevent the real request from completing (got ${JSON.stringify(result)})`);
      assert.equal(decodeURIComponent(received.username), original);
    }
  } finally {
    server.close();
  }
});

test("callWriteBridgeInternalRoute: a non-JSON response body is returned as raw, not thrown -- the caller decides what to do with an unparseable response", async () => {
  const socketPath = join(tempDir, "non-json.sock");
  const server = await startRealTarget(socketPath, (req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("not json at all");
  });
  try {
    const result = await callWriteBridgeInternalRoute({
      socketPath,
      method: "POST",
      path: "/api/server/stop",
      action: "server.stop",
      tier: "owner",
      discordUserId: "user-4",
      discordUsername: "u4",
      body: {}
    });
    assert.equal(result.statusCode, 500);
    assert.equal(result.body, null);
    assert.equal(result.raw, "not json at all");
  } finally {
    server.close();
  }
});

// --- injected requestImpl: edge cases a real socket can't easily force ---

test("callWriteBridgeInternalRoute: a connection-level error rejects the promise, never hangs or resolves", async () => {
  const fakeRequestImpl = () => {
    const fake = new EventEmitter();
    fake.end = () => {
      setImmediate(() => fake.emit("error", new Error("ECONNREFUSED (simulated)")));
    };
    fake.setTimeout = () => {};
    fake.destroy = () => {};
    return fake;
  };
  await assert.rejects(
    () => callWriteBridgeInternalRoute({
      socketPath: "/nonexistent/does-not-matter.sock",
      method: "POST",
      path: "/api/care-package/enable",
      action: "carepackage.enable",
      tier: "admin",
      discordUserId: "user-5",
      discordUsername: "u5",
      body: {},
      requestImpl: fakeRequestImpl
    }),
    /ECONNREFUSED/
  );
});

test("callWriteBridgeInternalRoute: request options (socketPath, path, method) are exactly what's passed to requestImpl -- no silent transformation", async () => {
  let capturedOptions = null;
  const fakeRequestImpl = (options, callback) => {
    capturedOptions = options;
    const fakeRes = new EventEmitter();
    setImmediate(() => {
      callback(Object.assign(fakeRes, { statusCode: 200 }));
      setImmediate(() => {
        fakeRes.emit("data", "{}");
        fakeRes.emit("end");
      });
    });
    return { end: () => {}, on: () => {}, setTimeout: () => {}, destroy: () => {} };
  };
  await callWriteBridgeInternalRoute({
    socketPath: "/tmp/example.sock",
    method: "POST",
    path: "/api/maps/spawn",
    action: "map.spawn",
    tier: "admin",
    discordUserId: "user-6",
    discordUsername: "u6",
    body: { preset: "default" },
    requestImpl: fakeRequestImpl
  });
  assert.equal(capturedOptions.socketPath, "/tmp/example.sock");
  assert.equal(capturedOptions.path, "/api/maps/spawn");
  assert.equal(capturedOptions.method, "POST");
});

// --- issue #1033: Hop B must not hang forever after the nonce is consumed ---

test("callWriteBridgeInternalRoute: a request that never responds is rejected via req.setTimeout, and the request is destroyed", async () => {
  let timeoutCallback = null;
  let destroyed = false;
  const fakeRequestImpl = () => ({
    end: () => {},
    on: () => {},
    setTimeout: (ms, cb) => {
      assert.equal(ms, 15_000, "default timeout should be 15s when the env override is unset/invalid");
      timeoutCallback = cb;
    },
    destroy: () => { destroyed = true; }
  });
  const pending = callWriteBridgeInternalRoute({
    socketPath: "/tmp/never-responds.sock",
    method: "POST",
    path: "/api/server/stop",
    action: "server.stop",
    tier: "owner",
    discordUserId: "user-7",
    discordUsername: "u7",
    body: {},
    requestImpl: fakeRequestImpl
  });
  assert.ok(typeof timeoutCallback === "function", "setTimeout should have registered its callback synchronously");
  timeoutCallback();
  await assert.rejects(() => pending, /timed out after 15000ms/);
  assert.equal(destroyed, true, "the hung request must be destroyed on timeout, not left open");
});

test("callWriteBridgeInternalRoute: an out-of-range DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS falls back to the 15s default", async () => {
  const original = process.env.DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS;
  process.env.DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS = "999999";
  try {
    let capturedMs = null;
    let timeoutCallback = null;
    const fakeRequestImpl = () => ({
      end: () => {},
      on: () => {},
      setTimeout: (ms, cb) => { capturedMs = ms; timeoutCallback = cb; },
      destroy: () => {}
    });
    const pending = callWriteBridgeInternalRoute({
      socketPath: "/tmp/example.sock",
      method: "POST",
      path: "/api/server/stop",
      action: "server.stop",
      tier: "owner",
      discordUserId: "user-8",
      discordUsername: "u8",
      body: {},
      requestImpl: fakeRequestImpl
    });
    assert.equal(capturedMs, 15_000);
    timeoutCallback();
    await assert.rejects(() => pending, /timed out/);
  } finally {
    if (original === undefined) delete process.env.DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS;
    else process.env.DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS = original;
  }
});
