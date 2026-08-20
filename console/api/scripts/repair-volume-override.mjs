#!/usr/bin/env node
// One-time data repair for a real, confirmed live bug (2026-08-19): every
// dune.items row inserted by the console's Base Inventory "Give"/"Give
// Multiple"/"Fill" actions (giveItemToStorage, fillItemToStorage,
// giveMultipleItemsToStorage in src/duneDb.js) stored volume_override as the
// stack's TOTAL volume (per-unit volume * stack_size) instead of the
// per-unit volume the live game engine actually expects there. The engine
// itself multiplies a non-null volume_override by stack_size to compute the
// value it displays -- confirmed directly against dune.item_audit_log, where
// every genuinely in-game-created item (never touched by the console)
// always has volume_override = NULL. Storing the pre-multiplied total made
// the engine multiply by stack_size a second time, inflating the displayed
// volume by a factor of stack_size (a real, live example: a 9540-unit Mouse
// Corpse stack with volume_override wrongly stored as 47700 displayed
// in-game as 47700 * 9540 ~= 455 million). See
// docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md for the
// full writeup and docs/console/base-inventory.md for the corrected
// volume_override convention going forward.
//
// This script finds every dune.items row with a non-null volume_override,
// looks up that item's real per-unit volume in the current
// runtime/data/admin-items.json catalog, and corrects the stored value to
// catalogVolume (previously it was catalogVolume * stack_size, or in a few
// older rows, some other now-abandoned convention -- this script does not
// try to reverse-engineer the old value, it recomputes from the catalog
// directly, which is correct regardless of which prior convention produced
// the bad value).
//
// A row whose template_id is no longer in the catalog (a removed/renamed
// item) is left untouched and reported separately -- there is nothing safe
// to recompute it to.
//
// Usage:
//   node scripts/repair-volume-override.mjs            (dry run, default)
//   node scripts/repair-volume-override.mjs --apply     (writes changes)
//
// Run from console/api/ inside the console container (or with
// DUNE_DOCKER_DIR/RUNTIME_DIR pointed at the repo root), e.g.:
//   docker exec dune-console-api node scripts/repair-volume-override.mjs
//   docker exec dune-console-api node scripts/repair-volume-override.mjs --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const repoRoot = resolve(process.env.DUNE_DOCKER_DIR || process.env.RUNTIME_DIR || process.cwd());

const catalog = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
const volumeByTemplateId = new Map();
for (const item of catalog) {
  if (item && item.id) volumeByTemplateId.set(String(item.id), Number(item.volume) || 0);
}

const db = createDb({ repoRoot });

try {
  const result = await db.query(`
    select id, template_id, stack_size, volume_override
    from dune.items
    where volume_override is not null
    order by id`);

  let correct = 0;
  let toFix = 0;
  let unknownTemplate = 0;
  const changes = [];

  for (const row of result.rows) {
    const templateId = String(row.template_id || "");
    const catalogVolume = volumeByTemplateId.get(templateId);
    if (catalogVolume === undefined) {
      unknownTemplate += 1;
      console.warn(`SKIP  id=${row.id} template_id=${templateId} -- not found in admin-items.json, leaving volume_override=${row.volume_override} untouched`);
      continue;
    }
    const current = Number(row.volume_override);
    if (Math.abs(current - catalogVolume) < 1e-6) {
      correct += 1;
      continue;
    }
    toFix += 1;
    changes.push({ id: row.id, templateId, stackSize: row.stack_size, from: current, to: catalogVolume });
  }

  console.log(`Scanned ${result.rows.length} rows with a non-null volume_override.`);
  console.log(`  Already correct (matches catalog per-unit volume): ${correct}`);
  console.log(`  Unknown template_id (left untouched): ${unknownTemplate}`);
  console.log(`  To correct: ${toFix}`);

  if (toFix === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  for (const change of changes) {
    const displayedBefore = change.from * change.stackSize;
    const displayedAfter = change.to * change.stackSize;
    console.log(
      `  id=${change.id} template_id=${change.templateId} stack_size=${change.stackSize} ` +
      `volume_override ${change.from} -> ${change.to} ` +
      `(engine-displayed volume ${displayedBefore} -> ${displayedAfter})`
    );
  }

  if (!apply) {
    console.log("\nDry run only -- no changes written. Re-run with --apply to write these corrections.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const change of changes) {
      await tx.query("update dune.items set volume_override = $1 where id = $2", [change.to, change.id]);
    }
  });
  console.log(`\nApplied ${changes.length} correction(s).`);
} finally {
  await db.close?.();
}
