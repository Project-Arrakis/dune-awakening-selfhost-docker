import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sietchesSource = readFileSync(join(repoRoot, "runtime/scripts/sietches.sh"), "utf8");
const autoscalerSource = readFileSync(join(repoRoot, "runtime/scripts/autoscaler.sh"), "utf8");
const reconcileSource = sietchesSource.match(/reconcile_map_dimensions\(\) \{([\s\S]*?)\n\}\n\nset_partition_value\(\)/)?.[1] || "";

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function runFixture(row) {
  const fixture = mkdtempSync(join(tmpdir(), "dune-sietch-restart-"));
  const scripts = join(fixture, "runtime", "scripts");
  const generated = join(fixture, "runtime", "generated");
  const bin = join(fixture, "bin");
  const calls = join(generated, "calls.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/sietches.sh"), join(scripts, "sietches.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/sietch-name.sh"), join(scripts, "sietch-name.sh"));
  writeFileSync(join(generated, "sietch-config.json"), '{"maps":{"Survival_1":{"active_dimensions":2}},"partitions":{}}\n');
  writeFileSync(calls, "");

  executable(join(bin, "docker"), [
    'if [ "${1:-}" = "ps" ] && [ "${2:-}" = "-a" ]; then',
    '  printf "%s\\n" dune-server-survival-1-31',
    'elif [ "${1:-}" = "ps" ]; then',
    '  printf "%s\\n" dune-postgres dune-server-survival-1 dune-server-survival-1-31',
    'elif [ "${1:-}" = "exec" ]; then',
    '  printf "%s\\n" "$MOCK_PARTITION_ROW"',
    'fi'
  ].join("\n"));

  for (const [name, label] of [
    ["start-server-survival-1.sh", "primary"],
    ["spicefield-overrides.sh", "spicefield"],
    ["publish-sietch-overrides.sh", "publish"],
    ["despawn-server.sh", "despawn"],
    ["spawn-server.sh", "spawn"]
  ]) {
    executable(join(scripts, name), `printf "${label} %s\\n" "$*" >> "${calls}"`);
  }

  const result = spawnSync("bash", ["runtime/scripts/sietches.sh", "restart", row.startsWith("0|") ? "1" : "31"], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_PARTITION_ROW: row }
  });
  const callLog = readFileSync(calls, "utf8");
  rmSync(fixture, { recursive: true, force: true });
  return { ...result, callLog };
}

test("primary Sietch restart touches only the primary Survival_1 container", () => {
  const result = runFixture("0|f|1");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "primary \nspicefield apply\npublish restart\npublish once\n");
  assert.match(result.stdout, /primary Survival_1 Sietch/);
});

test("secondary Sietch restart despawns and respawns only its partition", () => {
  const result = runFixture("1|f|2");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "despawn 31 --force\nspawn 31\n");
  assert.match(result.stdout, /partition 31 restart completed/);
});

test("inactive Sietches cannot be restarted", () => {
  const result = runFixture("2|f|3");
  assert.notEqual(result.status, 0);
  assert.equal(result.callLog, "");
  assert.match(result.stderr, /not active/);
});

test("changing active Sietches does not restart Director or primary Survival", () => {
  assert.doesNotMatch(reconcileSource, /refresh_survival_control_plane_state/);
  assert.doesNotMatch(reconcileSource, /refresh_survival_director_state/);
  assert.doesNotMatch(reconcileSource, /restart-director\.sh/);
  assert.doesNotMatch(reconcileSource, /start-server-survival-1\.sh/);
  assert.match(reconcileSource, /sync_survival_sietch_topology_state/);
  assert.match(reconcileSource, /refresh_survival_browser_state/);
});

test("new Sietches settle before publishing the updated topology", () => {
  const settleAt = reconcileSource.indexOf('wait_for_survival_topology_settle "$target" 90');
  const refreshAt = reconcileSource.indexOf("refresh_survival_browser_state");
  assert.ok(settleAt >= 0, "missing Survival topology settle wait");
  assert.ok(refreshAt > settleAt, "topology publication must run after new Sietches settle");
});

test("autoscaler browser healing pauses during coordinated Sietch topology changes", () => {
  assert.match(reconcileSource, /sietch-topology-maintenance/);
  assert.match(reconcileSource, /trap 'touch "\$topology_maintenance_file"' EXIT/);
  assert.match(autoscalerSource, /SIETCH_TOPOLOGY_MAINTENANCE_FILE=/);
  assert.match(autoscalerSource, /SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS=/);
  assert.match(
    autoscalerSource,
    /marker_age.*SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS[\s\S]*?director_heal_clear stale_since\s+return 0/,
  );
});

test("scaling down removes inactive Sietch rows before publishing topology", () => {
  const deleteAt = reconcileSource.indexOf("delete from dune.world_partition");
  const refreshAt = reconcileSource.indexOf("refresh_survival_browser_state");
  assert.ok(deleteAt >= 0, "missing inactive partition deletion");
  assert.ok(refreshAt > deleteAt, "topology publication must run after inactive partitions are removed");
  assert.match(reconcileSource, /ranked\.ord > \$target\s+and ranked\.server_id = ''/);
});

test("Sietch publisher generations supersede loops across PID namespaces", () => {
  const publisherSource = readFileSync(join(repoRoot, "runtime/scripts/publish-sietch-overrides.sh"), "utf8");
  assert.match(publisherSource, /LOOP_TOKEN_FILE=/);
  assert.match(publisherSource, /stop_loop_processes\(\)[\s\S]*?invalidate_loop_token/);
  assert.match(publisherSource, /start_loop\(\)[\s\S]*?write_loop_token "\$loop_token"/);
  assert.match(publisherSource, /while true; do\s+if ! loop_token_is_current "\$loop_token"/);
});
