import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function source(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("installer repairs nested ownership before checking the existing Web UI port", () => {
  const installer = source("install.sh");
  const mainOwnershipRepair = installer.lastIndexOf("\nmigrate_existing_ownership\n");
  const mainPortChoice = installer.lastIndexOf("\nchoose_web_port\n");

  assert.ok(mainOwnershipRepair > 0, "installer does not run the ownership migration");
  assert.ok(mainOwnershipRepair < mainPortChoice, "ownership migration must run before the port check");
  assert.match(installer, /find "\$ownership_repo_root" -xdev \\\( -user root -o -group root \\\)/);
  assert.doesNotMatch(installer, /find "\$ownership_repo_root" -maxdepth 1 -user root/);
});

test("installer reuses a persisted port owned by the running console", () => {
  const installer = source("install.sh");

  assert.match(installer, /existing_console_uses_port\(\)/);
  assert.match(installer, /inspect -f '\{\{\.State\.Running\}\}' redblink-dune-docker-console/);
  assert.match(installer, /if is_valid_port "\$persisted_web_port" && existing_console_uses_port "\$persisted_web_port"/);
});

test("root-run override publishers restore ownership of generated host files", () => {
  const helperPath = resolve(repoRoot, "runtime/scripts/host-file-ownership.sh");
  assert.notEqual(statSync(helperPath).mode & 0o111, 0, "ownership helper must be executable");

  for (const path of ["runtime/scripts/publish-sietch-overrides.sh", "runtime/scripts/publish-deepdesert-overrides.sh"]) {
    const publisher = source(path);
    assert.match(publisher, /source runtime\/scripts\/host-file-ownership\.sh/);
    assert.match(publisher, /dune_set_host_path_owner "\$PID_FILE"/);
    assert.match(publisher, /dune_set_host_path_owner "\$current_log"/);
  }

  assert.match(source("runtime/scripts/publish-sietch-overrides.sh"), /dune_set_host_path_owner "\$RMQ_CREDS_FILE"/);
  assert.match(source("runtime/scripts/publish-deepdesert-overrides.sh"), /dune_set_host_path_owner "\$cache_tmp"/);
});

test("settings writes preserve the configured host owner", () => {
  const usersettings = source("runtime/scripts/usersettings.py");

  assert.match(usersettings, /def configured_host_owner\(\) -> tuple\[int, int\] \| None:/);
  assert.match(usersettings, /os\.chown\(path, \*owner\)/);
  assert.match(usersettings, /apply_host_ownership\(tmp_path\)[\s\S]*?tmp_path\.replace\(path\)/);
});

test("latency tuning uses a unique temporary log instead of a shared root-owned path", () => {
  const runtimeEnv = source("runtime/scripts/runtime-env.sh");

  assert.match(runtimeEnv, /source runtime\/scripts\/host-file-ownership\.sh/);
  assert.match(runtimeEnv, /mktemp "\$\{TMPDIR:-\/tmp\}\/dune-host-latency-tune\.XXXXXX\.log"/);
  assert.doesNotMatch(runtimeEnv, />\/tmp\/dune-host-latency-tune\.log/);
  assert.match(runtimeEnv, /dune_set_host_path_owner "\$stamp"/);
  assert.match(runtimeEnv, /dune_set_host_path_owner "\$latency_log"/);
});
