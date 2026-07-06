import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("scheduled restart reapplies saved Spice Field overrides after startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-schedule-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  copyFileSync(
    join(repoRoot, "runtime", "scripts", "restart-schedule.sh"),
    join(scriptsDir, "restart-schedule.sh")
  );
  chmodSync(join(scriptsDir, "restart-schedule.sh"), 0o700);

  writeExecutable(join(scriptsDir, "runtime-env.sh"), [
    "resolve_server_ip_mode() { echo local; }",
    "resolve_server_ip() { :; }",
    "is_ipv4() { return 1; }",
    "is_private_ipv4() { return 0; }"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "stop-all.sh"), [
    "#!/usr/bin/env bash",
    "echo stop >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "start-all.sh"), [
    "#!/usr/bin/env bash",
    "echo start foreground=${DUNE_START_FOREGROUND_DEFERRED_RECONCILE:-} >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "spicefield-overrides.sh"), [
    "#!/usr/bin/env bash",
    "echo spicefield-$1 >> runtime/generated/restart-order.log"
  ].join("\n"));

  const result = spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "0",
      DUNE_SCHEDULED_RESTART_SPICEFIELD_REPLAY_DELAYS: "0"
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(join(generatedDir, "restart-order.log"), "utf8").trim().split("\n"), [
    "stop",
    "start foreground=1",
    "spicefield-apply"
  ]);
});

test("scheduled restart skips queued back-to-back activations", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-schedule-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  copyFileSync(
    join(repoRoot, "runtime", "scripts", "restart-schedule.sh"),
    join(scriptsDir, "restart-schedule.sh")
  );
  chmodSync(join(scriptsDir, "restart-schedule.sh"), 0o700);

  writeExecutable(join(scriptsDir, "runtime-env.sh"), "resolve_server_ip_mode() { echo local; }");
  writeExecutable(join(scriptsDir, "stop-all.sh"), [
    "#!/usr/bin/env bash",
    "echo stop >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "start-all.sh"), [
    "#!/usr/bin/env bash",
    "echo start >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "spicefield-overrides.sh"), [
    "#!/usr/bin/env bash",
    "echo spicefield-$1 >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeFileSync(join(generatedDir, "restart-schedule-last-run"), `${Math.floor(Date.now() / 1000)}\n`);

  const result = spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "900",
      DUNE_SCHEDULED_RESTART_SPICEFIELD_REPLAY_DELAYS: "0"
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Skipping scheduled restart/);
  assert.throws(() => readFileSync(join(generatedDir, "restart-order.log"), "utf8"), /ENOENT/);
});

function writeExecutable(path, content) {
  writeFileSync(path, `${content}\n`);
  chmodSync(path, 0o700);
}
