import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const restartScript = resolve(repoRoot, "runtime/scripts/restart-director.sh");

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function runFixture(survivalRunning) {
  const fixture = mkdtempSync(join(tmpdir(), "dune-director-restart-"));
  const calls = join(fixture, "calls.log");
  const docker = join(fixture, "docker");
  const startDirector = join(fixture, "start-director");
  const startSurvival = join(fixture, "start-survival");
  const spicefield = join(fixture, "spicefield");
  const publishSietches = join(fixture, "publish-sietches");

  executable(docker, 'if [ "${MOCK_SURVIVAL_RUNNING:-0}" = "1" ]; then echo true; else echo false; fi');
  executable(startDirector, 'printf "director\\n" >> "$MOCK_CALLS"');
  executable(startSurvival, 'printf "survival\\n" >> "$MOCK_CALLS"');
  executable(spicefield, 'printf "spicefield %s\\n" "$*" >> "$MOCK_CALLS"');
  executable(publishSietches, 'printf "sietches %s\\n" "$*" >> "$MOCK_CALLS"');

  const result = spawnSync("bash", [restartScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MOCK_CALLS: calls,
      MOCK_SURVIVAL_RUNNING: survivalRunning ? "1" : "0",
      DUNE_DOCKER_BIN: docker,
      DUNE_DIRECTOR_START_SCRIPT: startDirector,
      DUNE_SURVIVAL_START_SCRIPT: startSurvival,
      DUNE_SPICEFIELD_SCRIPT: spicefield,
      DUNE_SIETCH_PUBLISH_SCRIPT: publishSietches,
    },
  });

  const callLog = readFileSync(calls, "utf8");
  rmSync(fixture, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { callLog, output: result.stdout };
}

test("Director restart re-registers a running primary map after replacing the Director", () => {
  const result = runFixture(true);
  assert.equal(
    result.callLog,
    "director\nsurvival\nspicefield apply\nsietches restart\nsietches once\n",
  );
  assert.match(result.output, /registers with the new Director/);
});

test("Director restart preserves an intentionally stopped primary map", () => {
  const result = runFixture(false);
  assert.equal(result.callLog, "director\n");
  assert.match(result.output, /leaving it stopped/);
});
