import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePorts } from "../src/config.js";

// Requirement 20 Layer 3 (integration) audit finding, HIGH: config.js's
// own top comment asserts resolvePorts() and runtime-env.sh's
// resolve_client_port_base()/resolve_igw_port_base() "MUST stay in
// sync... must never drift" -- but until this file was added, nothing
// in the repository actually verified that claim. That gap is exactly
// why two CRITICAL divergences (a missing-.env-fallback difference, and
// opposite duplicate-key precedence) shipped with every existing test
// green: Layer 1 and Layer 2 each audited the Node side and the shell/
// Python side as separate concerns, and neither diffed the two
// implementations against the same input.
//
// This test runs BOTH real implementations -- Node's resolvePorts() and
// the actual runtime-env.sh shell functions (which shell out to the
// real runtime/scripts/usersettings.py, not a mock) -- against the same
// gameplay-profile.ini fixtures, and asserts they agree. It intentionally
// does not stub or reimplement either side; it exercises the exact code
// path each real caller (the Node console, and every game-server start/
// stop script) actually uses in production.
//
// repoRoot must be the real repository root (not a temp directory) for
// the shell side, because runtime-env.sh sources sibling scripts via
// paths relative to the current working directory (e.g.
// `source runtime/scripts/memory-swap-common.sh`) rather than resolving
// relative to its own location. DUNE_GAMEPLAY_PROFILE/
// DUNE_USERSETTINGS_CONFIG (both already-supported override env vars,
// see usersettings.py's CONFIG_PATH/PROFILE_PATH) point the actual data
// files at an isolated temp directory per test, so this never touches
// the real repo's own runtime/generated/ state.
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function resolveViaShell(profilePath, usersettingsPath) {
  const result = spawnSync(
    "bash",
    ["-c", "source runtime/scripts/runtime-env.sh && resolve_client_port_base && echo --- && resolve_igw_port_base"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DUNE_COMPOSE_PROJECT_NAME: "cross-consistency-test",
        DUNE_GAMEPLAY_PROFILE: profilePath,
        DUNE_USERSETTINGS_CONFIG: usersettingsPath
      }
    }
  );
  if (result.status !== 0) {
    throw new Error(`runtime-env.sh resolve_*_port_base() failed: ${result.stderr}`);
  }
  const [clientBase, igwBase] = result.stdout.trim().split("---").map((part) => Number(part.trim()));
  return { clientBase, igwBase };
}

// Node's resolvePorts(env, repoRoot) resolves gameplay-profile.ini/
// usersettings.json at repoRoot/runtime/generated/*, so fixtures for
// the Node side must be written under that subpath. The shell side is
// pointed at the exact same two files via the DUNE_GAMEPLAY_PROFILE/
// DUNE_USERSETTINGS_CONFIG overrides, so both resolvers read identical
// bytes from identical paths.
function fixturePaths(dir) {
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(generatedDir, { recursive: true });
  return {
    profilePath: join(generatedDir, "gameplay-profile.ini"),
    usersettingsPath: join(generatedDir, "usersettings.json")
  };
}

test("resolvePorts() (Node) and resolve_client_port_base()/resolve_igw_port_base() (shell, via the real usersettings.py) agree: stock defaults, no profile file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cross-consistency-stock-"));
  try {
    const { profilePath, usersettingsPath } = fixturePaths(dir);
    const nodePorts = resolvePorts({}, dir);
    const shellPorts = resolveViaShell(profilePath, usersettingsPath);
    assert.equal(nodePorts.clientBase, shellPorts.clientBase, "Node and shell must agree on the stock client port default");
    assert.equal(nodePorts.igwBase, shellPorts.igwBase, "Node and shell must agree on the stock IGW port default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePorts() (Node) and the shell resolver agree: real gameplay-profile.ini values", () => {
  const dir = mkdtempSync(join(tmpdir(), "cross-consistency-profile-"));
  try {
    const { profilePath, usersettingsPath } = fixturePaths(dir);
    writeFileSync(profilePath, "[Engine:URL]\nPort=8001\nIGWPort=8002\n");
    const nodePorts = resolvePorts({}, dir);
    const shellPorts = resolveViaShell(profilePath, usersettingsPath);
    assert.equal(nodePorts.clientBase, shellPorts.clientBase);
    assert.equal(nodePorts.igwBase, shellPorts.igwBase);
    assert.equal(nodePorts.clientBase, 8001);
    assert.equal(nodePorts.igwBase, 8002);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// This is the exact CRITICAL divergence independently reproduced during
// the Layer 3 audit: with a configured .env value and no profile file
// yet, Node's OLD implementation returned the .env value while the real
// shell/Python resolver returned the stock default (ignoring .env
// entirely) -- this test asserts both now agree that .env is NOT
// consulted for these two fields.
test("resolvePorts() (Node) and the shell resolver agree: .env's CLIENT_PORT_BASE/IGW_PORT_BASE is NOT used as a fallback by either side", () => {
  const dir = mkdtempSync(join(tmpdir(), "cross-consistency-env-ignored-"));
  try {
    const { profilePath, usersettingsPath } = fixturePaths(dir);
    // No profile file, no usersettings.json -- only a (would-be) .env
    // value, which neither side should read for these fields.
    const nodePorts = resolvePorts({ CLIENT_PORT_BASE: "9001", IGW_PORT_BASE: "9002" }, dir);
    const shellPorts = resolveViaShell(profilePath, usersettingsPath);
    assert.equal(nodePorts.clientBase, shellPorts.clientBase, "Node must not use .env's CLIENT_PORT_BASE when the shell side wouldn't either");
    assert.equal(nodePorts.igwBase, shellPorts.igwBase, "Node must not use .env's IGW_PORT_BASE when the shell side wouldn't either");
    assert.notEqual(nodePorts.clientBase, 9001, "confirms .env genuinely was NOT used (would be a false pass if both sides happened to agree by coincidence)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePorts() (Node) and the shell resolver agree: legacy usersettings.json fallback when no profile file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cross-consistency-legacy-"));
  try {
    const { profilePath, usersettingsPath } = fixturePaths(dir);
    writeFileSync(usersettingsPath, JSON.stringify({ engine: { port: "8501", igw_port: "8502" }, maps: {}, partitions: {} }));
    const nodePorts = resolvePorts({}, dir);
    const shellPorts = resolveViaShell(profilePath, usersettingsPath);
    assert.equal(nodePorts.clientBase, shellPorts.clientBase);
    assert.equal(nodePorts.igwBase, shellPorts.igwBase);
    assert.equal(nodePorts.clientBase, 8501);
    assert.equal(nodePorts.igwBase, 8502);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// This is the second exact CRITICAL divergence independently reproduced
// during the Layer 3 audit: a duplicate Port=/IGWPort= key in the same
// section -- Node's OLD regex took the first occurrence, while the real
// Python tool (profile_get_key(), iterating reversed()) takes the last.
// usersettings.py's own _advanced_editor_duplicate_key_warnings()
// explicitly anticipates this as a real, reachable state.
test("resolvePorts() (Node) and the shell resolver agree: duplicate Port/IGWPort keys both resolve to the LAST occurrence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cross-consistency-dup-"));
  try {
    const { profilePath, usersettingsPath } = fixturePaths(dir);
    writeFileSync(profilePath, "[Engine:URL]\nPort=7777\nPort=9999\nIGWPort=8001\nIGWPort=8888\n");
    const nodePorts = resolvePorts({}, dir);
    const shellPorts = resolveViaShell(profilePath, usersettingsPath);
    assert.equal(nodePorts.clientBase, shellPorts.clientBase, "Node and the real Python tool must agree on which duplicate key wins");
    assert.equal(nodePorts.igwBase, shellPorts.igwBase, "Node and the real Python tool must agree on which duplicate key wins");
    assert.equal(nodePorts.clientBase, 9999, "the LAST Port= line must win");
    assert.equal(nodePorts.igwBase, 8888, "the LAST IGWPort= line must win");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
