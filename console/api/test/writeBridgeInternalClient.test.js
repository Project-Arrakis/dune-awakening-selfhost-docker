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

test("callWriteBridgeInternalRoute: CR/LF in discordUsername is stripped before it reaches the outgoing header (issue #1022)", async () => {
  const socketPath = join(tempDir, "crlf-username.sock");
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
      discordUserId: "user-3b",
      discordUsername: "evil\r\nX-Injected: yes",
      body: {}
    });
    assert.equal(received.username, "evilX-Injected: yes");
    assert.ok(!received.username.includes("\r") && !received.username.includes("\n"));
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
    return { end: () => {}, on: () => {} };
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
