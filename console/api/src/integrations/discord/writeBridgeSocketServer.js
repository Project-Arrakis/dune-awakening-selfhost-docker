// Unix-socket listener lifecycle for the Discord write bridge (issue #215,
// docs/rw-architecture.md sections 3.1/3.4). This is Hop B's transport:
// reachability is filesystem-permission-gated (mode 0700), never
// network-address-gated -- eliminating the deployment-topology-dependent
// trust boundary that made a TCP-source-IP check (CRITICAL #742,
// unrelated -- a different, earlier design this fork rejected) unworkable.
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { existsSync, rmSync, chmodSync, statSync } from "node:fs";

const SOCKET_MODE = 0o700;
const LIVENESS_PROBE_TIMEOUT_MS = 2000;

// Root-UID startup refusal (docs/rw-architecture.md 3.4, CRITICAL #751):
// under this project's own shipped default (docker-compose.web.yml's
// `user: "${DUNE_HOST_UID:-0}:${DUNE_HOST_GID:-0}"`), Core runs as UID/GID
// 0 absent an explicitly-set env var. Root bypasses Unix DAC permission
// checks entirely, so 0700 on the socket file provides zero protection
// against any other root-running process on the host. Refusing to enable
// RW routes at all under this condition is the only correct response --
// injectable getuid so tests can exercise both branches without actually
// running this test suite as root.
export function isRunningAsRoot(getuid = process.getuid?.bind(process)) {
  if (typeof getuid !== "function") return false; // non-POSIX platform (no getuid at all) -- not the threat model this guard targets
  return getuid() === 0;
}

// Liveness probe (docs/rw-architecture.md 3.4, round-5/6/7 corrections):
// distinguishes a genuinely stale socket file (safe to unlink) from one
// backing a currently-live listener (must NOT be unlinked -- doing so
// silently orphans the live process and lets a second one take over,
// turning a loud failure into a silent one) from a probe that couldn't
// complete in time (timeout -- treated the same as "live", since a probe
// that couldn't complete is not proof of staleness).
//
// The `sock.destroy(new Error(...))` call on timeout is not optional: Node's
// net.Socket.destroy() called with NO argument emits only 'close', never
// 'error' -- since this probe's entire decision logic branches on 'connect'
// vs 'error' with ECONNREFUSED/ENOENT, a bare destroy() on timeout reaches
// neither branch and the calling code's await never settles, hanging Core's
// entire boot sequence (this exact bug, empirically reproduced, was
// CRITICAL #779 in this design's own audit history).
export function probeSocketLiveness(socketPath, { connect = netConnect, timeoutMs = LIVENESS_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const sock = connect({ path: socketPath });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => {
      sock.destroy();
      settle("live");
    });
    sock.on("timeout", () => {
      sock.destroy(new Error("write-bridge liveness probe timed out"));
    });
    sock.on("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") {
        settle("stale");
      } else if (error?.message === "write-bridge liveness probe timed out") {
        settle("timeout");
      } else {
        // An unexpected error class: treat the same as "live" (do not
        // unlink) -- the same conservative default the timeout case uses,
        // since an unrecognized failure mode is not proof of staleness.
        settle("live");
      }
    });
  });
}

// Prepares the socket path for a fresh .listen() call: probes for
// liveness, unlinking only when genuinely confirmed stale (docs/rw-
// architecture.md 3.4, round-5 correction #762). Returns whether it's now
// safe to proceed with .listen() at all -- "live"/"timeout" both mean NO,
// something else (or a real, currently-running instance) already holds
// this path, and the caller must disable the RW subsystem rather than
// silently taking over or crashing.
export async function prepareSocketPath(socketPath, deps = {}) {
  if (!existsSync(socketPath)) return { safeToListen: true };
  const liveness = await probeSocketLiveness(socketPath, deps);
  if (liveness === "live" || liveness === "timeout") {
    return { safeToListen: false, reason: `socket path already has a ${liveness === "live" ? "live listener" : "liveness probe timeout"}` };
  }
  (deps.rmSync || rmSync)(socketPath, { force: true });
  return { safeToListen: true };
}

// Starts the write-bridge's Unix-socket http.Server. `requestListener` is
// the SAME function the main TCP server uses -- no duplicated routing
// logic, matching docs/rw-architecture.md 3.1's "no parallel implementation"
// principle. Returns { server, disabled, reason } -- disabled:true means
// the RW subsystem must not be considered available (caller's
// responsibility to act on this; this function never throws for an
// expected/recoverable startup condition, only for genuine programmer
// error like a missing socketPath).
export async function startWriteBridgeSocketServer({ socketPath, requestListener, deps = {} }) {
  if (!socketPath) throw new Error("socketPath is required");

  if (isRunningAsRoot(deps.getuid)) {
    return { server: null, disabled: true, reason: "root_uid" };
  }

  const prepared = await prepareSocketPath(socketPath, deps);
  if (!prepared.safeToListen) {
    return { server: null, disabled: true, reason: "socket_path_unavailable", detail: prepared.reason };
  }

  // [Layer 3 integration audit fix, HIGH, issue #1036] Same defense-in-depth
  // as server.js's own TCP listener: requestListener (the shared
  // requestHandler) now catches its own thrown/rejected paths internally,
  // but this .catch() is the last line of defense against a silently hung
  // Hop B connection if a future change reintroduces an uncaught path.
  const server = createServer((req, res) => {
    // Promise.resolve(...) wraps in case a test double or future caller
    // passes a synchronous (non-Promise-returning) requestListener --
    // real production requestListener (requestHandler) is always async.
    Promise.resolve(requestListener(req, res, { viaWriteBridgeSocket: true })).catch((error) => {
      console.error(`Unhandled write-bridge request error: ${error?.message || "Unexpected error."}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unexpected error." }));
      }
    });
  });

  // Attach an explicit 'error' handler on THIS server instance before
  // calling .listen() -- an unhandled 'error' event on an http.Server
  // throws by default, crashing the entire Node process (not just the RW
  // subsystem). This must never be able to take an operator's whole
  // console offline (docs/rw-architecture.md 3.5's failure-scope
  // principle, applied here to the socket listener itself).
  let disabledAfterStart = false;
  server.on("error", (error) => {
    disabledAfterStart = true;
    console.error(`Write-bridge socket server error, RW subsystem disabled: ${error.message}`);
  });

  // Synchronous umask handling (docs/rw-architecture.md 3.4, round-5/6
  // corrections): Node's bind() for a Unix-domain-socket path happens
  // synchronously inside .listen(), so the socket file's permissions are
  // set at that exact moment -- restoring the umask must happen
  // synchronously on the very next line after .listen() returns, not in
  // the async 'listening' callback, or every OTHER file this process
  // creates during the real, measured ~1-2.5ms gap before 'listening'
  // fires silently inherits the tightened umask too.
  const originalUmask = process.umask(0o077);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  }).catch((error) => {
    process.umask(originalUmask);
    throw error;
  });
  process.umask(originalUmask);

  if (disabledAfterStart) {
    return { server: null, disabled: true, reason: "listen_error" };
  }

  // chmodSync as defense-in-depth on top of the umask fix above, plus a
  // startup self-check assertion the resulting mode is exactly 0700 --
  // Node's http.Server for AF_UNIX sets permissions from the process
  // umask at bind time, not a fixed mode automatically.
  const chmod = deps.chmodSync || chmodSync;
  chmod(socketPath, SOCKET_MODE);
  const stat = deps.statSync || statSync;
  const actualMode = stat(socketPath).mode & 0o777;
  if (actualMode !== SOCKET_MODE) {
    server.close();
    return { server: null, disabled: true, reason: "mode_assertion_failed", detail: `expected 0700, got 0${actualMode.toString(8)}` };
  }

  return { server, disabled: false };
}
