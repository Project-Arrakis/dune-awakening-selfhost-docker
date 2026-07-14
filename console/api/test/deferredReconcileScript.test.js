import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("deferred reconcile leaves dynamic Deep Desert stopped", () => {
  const { dir, generatedDir } = createFixture("dynamic");
  const result = runDeferredReconcile(dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readActions(generatedDir), [
    "spicefield-apply",
    "sietches-reconcile Survival_1",
    "publish-sietch-once"
  ]);
  assert.match(result.stdout, /skipped DeepDesert_1 because its map mode is not always-on/i);
});

test("deferred reconcile restores always-on Deep Desert dimensions", () => {
  const { dir, generatedDir } = createFixture("always-on");
  const result = runDeferredReconcile(dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readActions(generatedDir), [
    "spicefield-apply",
    "sietches-reconcile Survival_1",
    "sietches-reconcile DeepDesert_1",
    "publish-sietch-once"
  ]);
});

function createFixture(mapMode) {
  const dir = mkdtempSync(join(tmpdir(), "dune-deferred-reconcile-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  const binDir = join(dir, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  copyFileSync(
    join(repoRoot, "runtime", "scripts", "deferred-reconcile.sh"),
    join(scriptsDir, "deferred-reconcile.sh")
  );
  chmodSync(join(scriptsDir, "deferred-reconcile.sh"), 0o700);

  writeExecutable(join(binDir, "docker"), [
    "#!/usr/bin/env bash",
    "if [ \"${1:-}\" = ps ]; then",
    "  printf '%s\\n' dune-postgres dune-server-survival-1 dune-server-overmap",
    "elif [ \"${1:-}\" = exec ]; then",
    "  echo true",
    "fi"
  ].join("\n"));
  writeRecorder(join(scriptsDir, "spicefield-overrides.sh"), "spicefield");
  writeRecorder(join(scriptsDir, "sietches.sh"), "sietches");
  writeRecorder(join(scriptsDir, "publish-sietch-overrides.sh"), "publish-sietch");
  writeExecutable(join(scriptsDir, "map-modes.sh"), [
    "#!/usr/bin/env bash",
    `if [ \"${mapMode}\" = always-on ] && [ \"\${1:-}\" = is-always-on ]; then exit 0; fi`,
    "exit 1"
  ].join("\n"));

  return { dir, generatedDir, binDir };
}

function runDeferredReconcile(dir) {
  return spawnSync("bash", ["runtime/scripts/deferred-reconcile.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      DUNE_DEFERRED_RECONCILE_TIMEOUT_SECONDS: "2",
      DUNE_DEFERRED_RECONCILE_POLL_SECONDS: "0"
    }
  });
}

function writeRecorder(path, label) {
  writeExecutable(path, [
    "#!/usr/bin/env bash",
    `echo ${label}-$* >> runtime/generated/actions.log`
  ].join("\n"));
}

function readActions(generatedDir) {
  return readFileSync(join(generatedDir, "actions.log"), "utf8").trim().split("\n");
}

function writeExecutable(path, content) {
  writeFileSync(path, `${content}\n`);
  chmodSync(path, 0o700);
}
