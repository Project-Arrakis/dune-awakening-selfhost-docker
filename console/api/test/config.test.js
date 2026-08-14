import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, publicConfig, resolvePorts } from "../src/config.js";

test("web config exposes safe deployment flags and JSON body limit", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  process.env.NODE_ENV = "production";
  process.env.ADMIN_MAX_JSON_BYTES = "12345";
  try {
    const config = loadConfig();
    assert.equal(config.secureCookies, true);
    assert.equal(config.maxJsonBytes, 12345);
    const exposed = publicConfig(config);
    assert.equal(exposed.secureCookies, true);
    assert.equal(exposed.authDisabled, false);
    assert.equal(exposed.mockMode, false);
    assert.equal(Object.hasOwn(exposed, "adminPassword"), false);
    assert.equal(Object.hasOwn(exposed, "sessionSecret"), false);

    process.env.ADMIN_SECURE_COOKIES = "0";
    assert.equal(loadConfig().secureCookies, false);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Regression guard: a full-codebase audit found 6 places hardcoded
// stock port values instead of reading them from a shared source,
// breaking any deployment running non-default configured ports. This
// test must fail if any consumer ever reverts to reading process.env
// directly instead of going through resolvePorts()/config.ports.
//
// This test covers the SERVICE ports (Postgres/RMQ/TextRouter/
// Director/Prometheus), which really are env-var-configured with no
// other source of truth -- confirmed against runtime-env.sh's
// resolve_*_port() functions, which read process.env the same way.
test("resolvePorts() honors configured (non-default) service ports, does not silently fall back to stock values", () => {
  const configuredEnv = {
    POSTGRES_PORT: "16432",
    RMQ_ADMIN_PORT: "33573",
    RMQ_GAME_PORT: "32982",
    RMQ_GAME_HTTP_PORT: "32983",
    RMQ_GAME_LOCAL_HTTP_PORT: "16672",
    TEXT_ROUTER_PORT: "6059",
    DIRECTOR_PORT: "12717",
    METRICS_PROMETHEUS_PORT: "10090"
  };
  const ports = resolvePorts(configuredEnv, "/nonexistent-repo-root-for-this-test");
  assert.equal(ports.postgres, 16432);
  assert.equal(ports.rmqAdmin, 33573);
  assert.equal(ports.rmqGame, 32982);
  assert.equal(ports.rmqGameHttp, 32983);
  assert.equal(ports.rmqGameLocalHttp, 16672);
  assert.equal(ports.textRouter, 6059);
  assert.equal(ports.director, 12717);
  assert.equal(ports.metricsPrometheus, 10090);
});

test("resolvePorts() falls back to stock values when nothing is configured and no profile file exists", () => {
  const ports = resolvePorts({}, "/nonexistent-repo-root-for-this-test");
  assert.deepEqual(ports, {
    postgres: 15432,
    rmqAdmin: 32573,
    rmqGame: 31982,
    rmqGameHttp: 31983,
    rmqGameLocalHttp: 15672,
    textRouter: 5059,
    director: 11717,
    metricsPrometheus: 9090,
    clientBase: 7777,
    clientBaseSecondary: 7778,
    igwBase: 7888,
    igwBaseSecondary: 7889
  });
});

// This is the REAL, authoritative source for Player/Game and IGW base
// ports: runtime/generated/gameplay-profile.ini's [Engine:URL] section
// (written by runtime/scripts/usersettings.py engine-set, e.g. via the
// Maps UI or multi-server-config.py) -- NOT an env var. A prior version
// of this test only validated CLIENT_PORT_BASE/IGW_PORT_BASE env vars,
// which are documented as secondary "compatibility/console metadata"
// only -- that test passed while the underlying implementation used
// the wrong source of truth, exactly the kind of gap a Requirement 20
// Layer 1/QA audit is meant to catch (found retroactively; see PR
// history). This test exercises the real mechanism directly.
test("resolvePorts() reads Player/Game and IGW base ports from gameplay-profile.ini, the real authoritative source (not .env)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-profile-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "; UserGame.ini managed by Docker.\n\n[Engine:URL]\nIGWPort=8888\n\nPort=8777\n"
    );
    // Deliberately set a DIFFERENT, stale value in .env to prove the
    // profile file wins -- this is exactly the staleness scenario a
    // real deployment could hit if an operator changed the port via
    // the Maps UI without also updating .env.
    const staleEnv = { CLIENT_PORT_BASE: "9999", IGW_PORT_BASE: "9998" };
    const ports = resolvePorts(staleEnv, repoRoot);
    assert.equal(ports.clientBase, 8777, "profile file's Port must win over stale .env CLIENT_PORT_BASE");
    assert.equal(ports.clientBaseSecondary, 8778);
    assert.equal(ports.igwBase, 8888, "profile file's IGWPort must win over stale .env IGW_PORT_BASE");
    assert.equal(ports.igwBaseSecondary, 8889);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolvePorts() falls back to .env CLIENT_PORT_BASE/IGW_PORT_BASE when gameplay-profile.ini doesn't exist yet", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-no-profile-"));
  try {
    const ports = resolvePorts({ CLIENT_PORT_BASE: "8777", IGW_PORT_BASE: "8888" }, repoRoot);
    assert.equal(ports.clientBase, 8777);
    assert.equal(ports.igwBase, 8888);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("publicConfig() exposes ports to the frontend", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-ports-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  process.env.POSTGRES_PORT = "16432";
  try {
    const config = loadConfig();
    const exposed = publicConfig(config);
    assert.equal(exposed.ports.postgres, 16432);
    assert.equal(exposed.ports.rmqGame, 31982);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
