import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDb,
  databaseRestoreMaintenanceActive,
  databaseRestoreMaintenanceFile
} from "../src/db.js";

test("database access pauses while a backup restore owns the maintenance marker", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-db-restore-maintenance-"));
  const marker = databaseRestoreMaintenanceFile(repoRoot, {});
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "restore in progress\n", { mode: 0o600 });
  const db = createDb({ repoRoot });

  try {
    assert.equal(databaseRestoreMaintenanceActive(repoRoot, {}), true);
    await assert.rejects(db.query("select 1"), /Database restore is in progress/);
    await assert.rejects(db.transaction(async () => {}), /Database restore is in progress/);
  } finally {
    await db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
