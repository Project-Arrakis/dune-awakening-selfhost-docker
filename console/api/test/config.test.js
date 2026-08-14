import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

// See issue #266: a Layer 2 audit found 6 places across the codebase
// hardcoded Instance-1 stock port values instead of reading them from a
// shared source, breaking multi-server Instance 2+ deployments. This
// test is the regression guard for the fix -- it must fail if any
// consumer ever reverts to reading process.env directly instead of
// going through resolvePorts()/config.ports.
test("resolvePorts() honors configured (non-default) ports, does not silently fall back to stock values", () => {
  const configuredEnv = {
    POSTGRES_PORT: "16432",
    RMQ_ADMIN_PORT: "33573",
    RMQ_GAME_PORT: "32982",
    RMQ_GAME_HTTP_PORT: "32983",
    RMQ_GAME_LOCAL_HTTP_PORT: "16672",
    TEXT_ROUTER_PORT: "6059",
    DIRECTOR_PORT: "12717",
    METRICS_PROMETHEUS_PORT: "10090",
    CLIENT_PORT_BASE: "8777",
    IGW_PORT_BASE: "8888"
  };
  const ports = resolvePorts(configuredEnv);
  assert.deepEqual(ports, {
    postgres: 16432,
    rmqAdmin: 33573,
    rmqGame: 32982,
    rmqGameHttp: 32983,
    rmqGameLocalHttp: 16672,
    textRouter: 6059,
    director: 12717,
    metricsPrometheus: 10090,
    clientBase: 8777,
    clientBaseSecondary: 8778,
    igwBase: 8888,
    igwBaseSecondary: 8889
  });
});

test("resolvePorts() falls back to Instance-1 stock values when nothing is configured", () => {
  const ports = resolvePorts({});
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
