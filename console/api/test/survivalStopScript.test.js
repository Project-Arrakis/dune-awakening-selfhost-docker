import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

// Mirrors sietchRestartScript.test.js's fixture style: the script under test
// runs for real, but its dependencies (runtime-env.sh's port resolution,
// docker itself) are faked rather than exercising the real config-resolution
// chain, matching how the rest of this suite fakes cross-script dependencies.
function runFixture(env = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "dune-survival-stop-"));
  const scripts = join(fixture, "runtime", "scripts");
  const bin = join(fixture, "bin");
  const calls = join(fixture, "calls.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/stop-server-survival-1.sh"), join(scripts, "stop-server-survival-1.sh"));
  writeFileSync(calls, "");

  executable(join(scripts, "runtime-env.sh"), [
    "resolve_client_port_base() { echo 7777; }",
    "resolve_igw_port_base() { echo 7888; }"
  ].join("\n"));

  executable(join(bin, "docker"), `printf "%s\\n" "$*" >> "${calls}"`);

  const result = spawnSync("bash", ["runtime/scripts/stop-server-survival-1.sh"], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
  });
  const callLog = readFileSync(calls, "utf8");
  rmSync(fixture, { recursive: true, force: true });
  return { ...result, callLog };
}

test("stop-server-survival-1.sh removes the container and clears its partition/farm state", () => {
  const result = runFixture({ DUNE_SURVIVAL_PARTITION_ID: "5" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.callLog, /rm -f dune-server-survival-1/);
  assert.match(result.callLog, /exec dune-postgres psql/);
  assert.match(result.callLog, /partition_id = 5/);
  assert.match(result.callLog, /game_port = 7778/);
  assert.match(result.callLog, /igw_port = 7888/);
});

test("stop-server-survival-1.sh never starts a new container", () => {
  const result = runFixture({});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.callLog, /docker run/);
  assert.doesNotMatch(result.callLog, /\brun -d\b/);
});

test("stop-server-survival-1.sh defaults to partition 1 without DUNE_SURVIVAL_PARTITION_ID", () => {
  const result = runFixture({});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.callLog, /partition_id = 1/);
});
