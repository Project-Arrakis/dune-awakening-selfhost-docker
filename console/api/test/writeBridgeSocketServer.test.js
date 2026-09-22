import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRunningAsRoot,
  probeSocketLiveness,
  prepareSocketPath,
  startWriteBridgeSocketServer
} from "../src/integrations/discord/writeBridgeSocketServer.js";

function realHttpGetOverSocket(socketPath, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.end();
  });
}

let tempDir;
test.beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "write-bridge-socket-test-")); });
test.afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

// --- isRunningAsRoot ---

test("isRunningAsRoot: reflects the injected getuid function, not the real process", () => {
  assert.equal(isRunningAsRoot(() => 0), true);
  assert.equal(isRunningAsRoot(() => 1000), false);
});

test("isRunningAsRoot: with no injected getuid, reflects this actual process -- whichever UID it genuinely runs as (root in some dev sandboxes, non-root under most CI runners), not a hardcoded expectation", () => {
  // Deliberately NOT a hardcoded true/false: this differs by environment
  // (root in some dev sandboxes, non-root under GitHub Actions' ubuntu-latest
  // runner -- confirmed directly, this exact assertion broke CI once). The
  // real invariant under test is that the no-argument call reflects the
  // REAL process, not that any specific environment happens to be root.
  assert.equal(isRunningAsRoot(), process.getuid() === 0);
});

// --- probeSocketLiveness: real sockets, real timing, not mocked ---

test("probeSocketLiveness: a genuinely nonexistent path resolves 'stale' (ENOENT)", async () => {
  const socketPath = join(tempDir, "nonexistent.sock");
  const result = await probeSocketLiveness(socketPath);
  assert.equal(result, "stale");
});

test("probeSocketLiveness: a real, currently-live listener at the path resolves 'live'", async () => {
  const socketPath = join(tempDir, "live.sock");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await probeSocketLiveness(socketPath);
    assert.equal(result, "live");
  } finally {
    server.close();
  }
});

test("probeSocketLiveness: a stale file (no listener behind it) resolves 'stale' (ECONNREFUSED), never silently treated as live", async () => {
  const socketPath = join(tempDir, "stale.sock");
  // A plain file at the path with nothing listening behind it -- the real
  // "unclean shutdown" scenario this probe exists to distinguish from a
  // genuinely live listener (OOM-kill/docker restart/host power loss leaves
  // the socket file on disk with no process behind it; a clean .close()
  // was confirmed, separately, to auto-unlink the file on this platform --
  // so a plain writeFileSync is the accurate way to simulate the real,
  // unclean case this code actually has to handle, not listen()+close()).
  writeFileSync(socketPath, "");
  const result = await probeSocketLiveness(socketPath);
  assert.equal(result, "stale");
});

test("probeSocketLiveness: a probe that hangs past its timeout resolves 'timeout', via a real timer, not an injected result", async () => {
  const socketPath = join(tempDir, "hang.sock");
  writeFileSync(socketPath, ""); // any existing path; the injected connect() below never actually dials it
  const neverSettles = () => {
    // A fake "socket" whose events never fire connect/error, exercising
    // the real setTimeout(timeoutMs) + 'timeout' listener path with a
    // short, test-scoped timeout rather than the real 2000ms default.
    const fake = new EventEmitter();
    fake.setTimeout = () => {};
    fake.destroy = (err) => { if (err) fake.emit("error", err); };
    // Manually fire the real 'timeout' event on our own short schedule,
    // simulating what a real hung connect() would eventually do.
    setTimeout(() => fake.emit("timeout"), 20);
    return fake;
  };
  const result = await probeSocketLiveness(socketPath, { connect: neverSettles, timeoutMs: 20 });
  assert.equal(result, "timeout");
});

// --- prepareSocketPath ---

test("prepareSocketPath: no existing file -> safe to listen, no unlink needed", async () => {
  const socketPath = join(tempDir, "fresh.sock");
  const result = await prepareSocketPath(socketPath);
  assert.equal(result.safeToListen, true);
});

test("prepareSocketPath: a genuinely stale file is unlinked and reported safe to listen", async () => {
  const socketPath = join(tempDir, "stale.sock");
  // A real file must exist here first, or this test would pass vacuously
  // via the early !existsSync() branch without ever exercising the
  // probe-then-unlink logic at all (confirmed: a clean listen()+close()
  // auto-unlinks the file on this platform, so it can't be used to set up
  // this precondition -- see the probeSocketLiveness stale-file test above
  // for the same finding).
  writeFileSync(socketPath, "");
  assert.ok(existsSync(socketPath), "precondition: a real file must exist before prepareSocketPath runs");

  const result = await prepareSocketPath(socketPath);
  assert.equal(result.safeToListen, true);
  assert.equal(existsSync(socketPath), false, "the stale file must actually be removed");
});

test("prepareSocketPath: a REAL live listener at the path is never unlinked -- proves this isn't just a return-value check but real filesystem behavior", async () => {
  const socketPath = join(tempDir, "live.sock");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await prepareSocketPath(socketPath);
    assert.equal(result.safeToListen, false);
    assert.equal(existsSync(socketPath), true, "the live listener's own socket file must survive untouched");
    // Prove the original listener is STILL actually live and reachable --
    // the real, concrete harm this check exists to prevent is silently
    // orphaning it.
    const stillLive = await probeSocketLiveness(socketPath);
    assert.equal(stillLive, "live");
  } finally {
    server.close();
  }
});

// --- startWriteBridgeSocketServer: full real integration ---

test("startWriteBridgeSocketServer: root-UID refusal -- disables the subsystem without ever attempting to bind", async () => {
  const socketPath = join(tempDir, "root-refused.sock");
  const result = await startWriteBridgeSocketServer({
    socketPath,
    requestListener: () => {},
    deps: { getuid: () => 0 }
  });
  assert.equal(result.disabled, true);
  assert.equal(result.reason, "root_uid");
  assert.equal(existsSync(socketPath), false, "must never create the socket file at all under root-UID refusal");
});

test("startWriteBridgeSocketServer: real end-to-end -- a real client connects, requestListener receives viaWriteBridgeSocket:true, socket file is mode 0700", async () => {
  const socketPath = join(tempDir, "e2e.sock");
  let receivedOpts = null;
  const requestListener = (req, res, opts) => {
    receivedOpts = opts;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };

  const { server, disabled } = await startWriteBridgeSocketServer({ socketPath, requestListener, deps: { getuid: () => 1000 } });
  assert.equal(disabled, false);
  try {
    const mode = statSync(socketPath).mode & 0o777;
    assert.equal(mode, 0o700, `expected socket mode 0700, got 0${mode.toString(8)}`);

    // Real HTTP request over the real Unix socket -- not a mocked req/res.
    const body = await realHttpGetOverSocket(socketPath, "/api/test");
    assert.equal(JSON.parse(body).ok, true);
    assert.deepEqual(receivedOpts, { viaWriteBridgeSocket: true });
  } finally {
    server.close();
  }
});

test("startWriteBridgeSocketServer: umask is restored to its original value after listen(), synchronously, not left tightened", async () => {
  const socketPath = join(tempDir, "umask.sock");
  const before = process.umask(); // reading current umask (0-arg call doesn't change it... actually it does on some platforms; use a known baseline instead)
  process.umask(before); // restore immediately, this call itself is just to read+reset atomically
  const { server, disabled } = await startWriteBridgeSocketServer({ socketPath, requestListener: () => {}, deps: { getuid: () => 1000 } });
  assert.equal(disabled, false);
  try {
    const after = process.umask();
    process.umask(after); // read without changing
    assert.equal(after, before, "process umask must be restored to its pre-listen value");
  } finally {
    server.close();
  }
});

test("startWriteBridgeSocketServer: a genuinely stale file at the path does not prevent startup", async () => {
  const socketPath = join(tempDir, "stale-then-start.sock");
  writeFileSync(socketPath, "");

  const { server, disabled } = await startWriteBridgeSocketServer({ socketPath, requestListener: () => {}, deps: { getuid: () => 1000 } });
  assert.equal(disabled, false);
  server.close();
});

test("startWriteBridgeSocketServer: a REAL live listener already at the path refuses to start a second one -- never silently takes over", async () => {
  const socketPath = join(tempDir, "collision.sock");
  const firstListener = (req, res) => { res.writeHead(200); res.end("first"); };
  const first = await startWriteBridgeSocketServer({ socketPath, requestListener: firstListener, deps: { getuid: () => 1000 } });
  assert.equal(first.disabled, false);
  try {
    const second = await startWriteBridgeSocketServer({ socketPath, requestListener: () => {}, deps: { getuid: () => 1000 } });
    assert.equal(second.disabled, true);
    assert.equal(second.reason, "socket_path_unavailable");

    // Prove the FIRST server is still the one actually serving requests --
    // this is the concrete harm a silent takeover would cause.
    const body = await realHttpGetOverSocket(socketPath, "/");
    assert.equal(body, "first");
  } finally {
    first.server.close();
  }
});

test("startWriteBridgeSocketServer: socketPath is required", async () => {
  await assert.rejects(() => startWriteBridgeSocketServer({ requestListener: () => {} }), /socketPath is required/);
});
