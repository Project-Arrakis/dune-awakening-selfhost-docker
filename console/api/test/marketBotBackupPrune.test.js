import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// A docker stub that answers exactly the calls backup_db() makes, so the real
// runtime/scripts/db.sh backup path runs end to end without a database.
const DOCKER_STUB = `#!/usr/bin/env bash
cmd="\${1:-}"; shift || true
case "$cmd" in
  ps) echo "dune-postgres"; exit 0 ;;
  cp)
    src="\${1:-}"; dest="\${2:-}"
    case "$src" in
      dune-postgres:*) printf 'fake-pg-dump-archive' > "$dest" ;;
    esac
    exit 0
    ;;
  exec)
    shift # container name
    prog="\${1:-}"; shift || true
    case "$prog" in
      pg_dump|rm) exit 0 ;;
      pg_restore)
        echo "123; 2615 16385 SCHEMA - dune postgres"
        echo "124; 1259 16386 TABLE dune world_partition postgres"
        echo "125; 0 16386 TABLE DATA dune world_partition postgres"
        exit 0
        ;;
      psql)
        sql="$*"
        case "$sql" in
          *"select distinct map"*) echo "hagga_basin" ;;
          *string_agg*) echo "hagga_basin" ;;
          *"count(*) from dune.world_partition"*) echo "3" ;;
          *) echo "" ;;
        esac
        exit 0
        ;;
    esac
    exit 0
    ;;
esac
exit 0
`;

function makeFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "dune-market-bot-backup-"));
  const scripts = join(fixture, "runtime/scripts");
  const bin = join(fixture, "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(fixture, "runtime/backups/db"), { recursive: true });
  cpSync(resolve(repoRoot, "runtime/scripts/db.sh"), join(scripts, "db.sh"));
  cpSync(resolve(repoRoot, "runtime/scripts/env-file.sh"), join(scripts, "env-file.sh"));
  writeFileSync(join(bin, "docker"), DOCKER_STUB);
  chmodSync(join(bin, "docker"), 0o755);
  return { fixture, bin, backupDir: join(fixture, "runtime/backups/db") };
}

function seedBackup(backupDir, name, origin) {
  writeFileSync(join(backupDir, name), "fake-backup");
  if (origin !== null) {
    writeFileSync(join(backupDir, `${name}.yaml`), `artifact_id: test\nbackup_origin: ${origin}\ndatabase: dune\n`);
  }
}

function backupNames(backupDir) {
  return readdirSync(backupDir).filter((name) => name.endsWith(".backup")).sort();
}

function runDb(fixture, bin, args, env = {}) {
  return spawnSync("bash", ["runtime/scripts/db.sh", ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
  });
}

test("market bot backups carry their origin in the filename and prune to the newest five", () => {
  const { fixture, bin, backupDir } = makeFixture();
  try {
    // Six pre-existing market-bot backups: four unlabeled names written by
    // older releases and two labeled ones. With the new backup that makes
    // seven; the oldest two must be pruned to hold the cap of five.
    seedBackup(backupDir, "dune-db-all_maps-20260809-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-all_maps-20260810-000001.backup", "market-bot-seed");
    seedBackup(backupDir, "dune-db-all_maps-20260811-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-all_maps-20260812-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-market-bot-seed-all_maps-20260813-000001.backup", "market-bot-seed");
    seedBackup(backupDir, "dune-db-market-bot-buyback-all_maps-20260814-000001.backup", "market-bot-buyback");
    // Never prune candidates, whatever their age or count.
    seedBackup(backupDir, "dune-db-all_maps-20200101-000001.backup", "manual");
    seedBackup(backupDir, "dune-db-all_maps-20200102-000001.backup", "automatic");
    seedBackup(backupDir, "dune-db-all_maps-20200103-000001.backup", null); // no sidecar

    const result = runDb(fixture, bin, ["backup"], { DB_BACKUP_ORIGIN: "market-bot-buyback" });
    assert.equal(result.status, 0, `backup must succeed (stderr: ${result.stderr})`);

    const names = backupNames(backupDir);
    const created = names.find((name) => /^dune-db-market-bot-buyback-hagga_basin-\d{8}-\d{6}\.backup$/.test(name));
    assert.ok(created, `new backup is labeled with its market-bot origin (got: ${names.join(", ")})`);
    const sidecar = readFileSync(join(backupDir, `${created}.yaml`), "utf8");
    assert.match(sidecar, /^backup_origin: market-bot-buyback$/m);

    // Cap of five market-bot backups: the two oldest are gone, the newest
    // four pre-existing ones plus the fresh backup remain.
    assert.ok(!names.includes("dune-db-all_maps-20260809-000001.backup"), "oldest market-bot backup pruned");
    assert.ok(!names.includes("dune-db-all_maps-20260810-000001.backup"), "second-oldest market-bot backup pruned");
    assert.ok(!existsSync(join(backupDir, "dune-db-all_maps-20260810-000001.backup.yaml")), "pruned sidecar removed too");
    assert.ok(names.includes("dune-db-all_maps-20260811-000001.backup"));
    assert.ok(names.includes("dune-db-all_maps-20260812-000001.backup"));
    assert.ok(names.includes("dune-db-market-bot-seed-all_maps-20260813-000001.backup"));
    assert.ok(names.includes("dune-db-market-bot-buyback-all_maps-20260814-000001.backup"));
    assert.equal(names.filter((name) => !/2020010\d/.test(name)).length, 5, "exactly five market-bot backups remain");

    // Manual, automatic, and sidecar-less backups are untouched.
    assert.ok(names.includes("dune-db-all_maps-20200101-000001.backup"));
    assert.ok(names.includes("dune-db-all_maps-20200102-000001.backup"));
    assert.ok(names.includes("dune-db-all_maps-20200103-000001.backup"));

    assert.match(result.stdout, /Pruned 2 Market Bot backup\(s\); the newest 5 are kept\./);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("manual and automatic backups keep their unlabeled names and trigger no market-bot prune", () => {
  const { fixture, bin, backupDir } = makeFixture();
  try {
    for (let day = 1; day <= 7; day += 1) {
      seedBackup(backupDir, `dune-db-all_maps-2026080${day}-000001.backup`, "market-bot-buyback");
    }

    const result = runDb(fixture, bin, ["backup"], { DB_BACKUP_ORIGIN: "manual" });
    assert.equal(result.status, 0, `backup must succeed (stderr: ${result.stderr})`);

    const names = backupNames(backupDir);
    const created = names.find((name) => /^dune-db-hagga_basin-\d{8}-\d{6}\.backup$/.test(name));
    assert.ok(created, `manual backup keeps the plain scope name (got: ${names.join(", ")})`);
    // A manual backup never prunes market-bot backups, even past the cap.
    assert.equal(names.length, 8, "all seven market-bot backups plus the manual one remain");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("prune keeps the newest five by embedded timestamp across labeled and legacy names", () => {
  const { fixture, bin, backupDir } = makeFixture();
  try {
    const wrapper = join(fixture, "runtime/scripts/prune-wrapper.sh");
    writeFileSync(wrapper, `#!/usr/bin/env bash
source "$(dirname "$0")/db.sh" help >/dev/null
prune_market_bot_backups "$1" "$2"
`);
    chmodSync(wrapper, 0o755);

    // Interleave labeled and legacy names so ordering must come from the
    // embedded timestamp, not the name prefix.
    seedBackup(backupDir, "dune-db-market-bot-unseed-all_maps-20260801-000001.backup", "market-bot-unseed");
    seedBackup(backupDir, "dune-db-all_maps-20260802-000001.backup", "market-bot-seed");
    seedBackup(backupDir, "dune-db-market-bot-seed-all_maps-20260803-000001.backup", "market-bot-seed");
    seedBackup(backupDir, "dune-db-all_maps-20260804-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-market-bot-buyback-all_maps-20260805-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-all_maps-20260806-000001.backup", "market-bot-buyback");
    seedBackup(backupDir, "dune-db-all_maps-20260807-000001.backup", "market-bot-seed");
    seedBackup(backupDir, "dune-db-all_maps-20260931-000001.backup", "manual");

    const result = spawnSync("bash", [wrapper, join(fixture, "runtime/backups/db"), "5"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}` }
    });
    assert.equal(result.status, 0, `prune must succeed (stderr: ${result.stderr})`);

    const names = backupNames(backupDir);
    assert.ok(!names.includes("dune-db-market-bot-unseed-all_maps-20260801-000001.backup"), "oldest pruned");
    assert.ok(!names.includes("dune-db-all_maps-20260802-000001.backup"), "second-oldest pruned");
    assert.ok(names.includes("dune-db-market-bot-seed-all_maps-20260803-000001.backup"));
    assert.ok(names.includes("dune-db-all_maps-20260807-000001.backup"));
    assert.ok(names.includes("dune-db-all_maps-20260931-000001.backup"), "manual backup untouched");
    assert.equal(names.length, 6, "five market-bot backups plus the manual one remain");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
