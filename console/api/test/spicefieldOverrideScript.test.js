import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("spice field reconcile reapplies saved overrides only when live DB drifts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-spicefield-reconcile-"));
  const fakeBin = join(dir, "bin");
  const generated = join(dir, "runtime", "generated");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(generated, { recursive: true });

  const overridesFile = join(generated, "spicefield-overrides.json");
  const sqlLog = join(generated, "sql.log");
  writeFileSync(overridesFile, JSON.stringify({
    schemaVersion: 1,
    overrides: {
      8: {
        spicefield_type_id: 8,
        max_globally_active: 2,
        max_globally_primed: 4,
        is_spawning_active: true,
        global_spawn_weight: 1.5
      }
    }
  }));

  writeExecutable(join(fakeBin, "docker"), [
    "#!/usr/bin/env bash",
    "if [ \"$1\" = ps ]; then echo dune-postgres; exit 0; fi",
    "sql=$(cat)",
    "printf '%s\\n---\\n' \"$sql\" >> \"$SQL_LOG\"",
    "if printf '%s' \"$sql\" | grep -q \"to_regclass('dune.spicefield_types')\"; then",
    "  printf 't\\n'",
    "elif printf '%s' \"$sql\" | grep -q 'drift_count'; then",
    "  printf '%s\\n' \"${FAKE_DRIFT_COUNT:-0}\"",
    "else",
    "  printf '%s\\n' \"${FAKE_CHANGED_ROWS:-0}\"",
    "fi"
  ].join("\n"));

  const commonEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    SPICEFIELD_OVERRIDES_FILE: overridesFile,
    SQL_LOG: sqlLog
  };

  const noDrift = spawnSync("bash", ["runtime/scripts/spicefield-overrides.sh", "reconcile"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...commonEnv, FAKE_DRIFT_COUNT: "0" }
  });
  assert.equal(noDrift.status, 0, noDrift.stderr || noDrift.stdout);
  assert.match(noDrift.stdout, /in sync/);
  assert.equal((readFileSync(sqlLog, "utf8").match(/drift_count/g) || []).length, 1);
  assert.equal(readFileSync(sqlLog, "utf8").includes("changed_rows"), false);

  writeFileSync(sqlLog, "");
  const drift = spawnSync("bash", ["runtime/scripts/spicefield-overrides.sh", "reconcile"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...commonEnv, FAKE_DRIFT_COUNT: "1", FAKE_CHANGED_ROWS: "1" }
  });
  assert.equal(drift.status, 0, drift.stderr || drift.stdout);
  assert.match(drift.stdout, /Detected Spice Field override drift/);
  const driftSql = readFileSync(sqlLog, "utf8");
  assert.equal((driftSql.match(/drift_count/g) || []).length, 1);
  assert.equal((driftSql.match(/changed_rows/g) || []).length, 1);
});

function writeExecutable(path, content) {
  writeFileSync(path, `${content}\n`);
  chmodSync(path, 0o700);
}
