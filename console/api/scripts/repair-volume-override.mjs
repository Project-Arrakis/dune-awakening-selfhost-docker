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
// SECOND PASS (added 2026-08-20, post-merge review of upstream PR #182):
// every Give/Fill insert site also had a related bug where an item with NO
// catalogued volume at all (not a stale/wrong value -- genuinely never had
// one) got volume_override stored as the number 0 instead of SQL NULL. Per
// this same script's header comment above, the live engine NEVER itself
// writes a non-null volume_override -- so any row with volume_override = 0
// (exactly, not just non-null) is presumptively a console-inserted row from
// this bug, safe to correct to NULL universally without needing to trace
// which specific route created it. This pass finds every such row and
// clears it to NULL, regardless of whether template_id is in today's
// catalog (a 0 for a catalogued item with a real non-zero catalog volume is
// still wrong -- correcting to NULL, not to the catalog value, matches the
// insert-side fix: NULL, not a recomputed number, is what a fresh insert
// would write today).
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
  if (!item || !item.id) continue;
  // Only set a Map entry when this item actually HAS a catalogued volume --
  // `Number(item.volume) || 0` (the previous version of this line) could
  // not distinguish "no volume field at all" (NaN, uncatalogued) from a
  // real, explicit `volume: 0` entry, both collapsing to 0. That made the
  // first pass below "correct" an uncatalogued item's real stored
  // volume_override to 0 instead of leaving it alone -- reproduced live
  // against dune-dev (issue #413): two real items with no `volume` field
  // (Combat_Heavy_Unique_PowerEfficient_Gloves_06,
  // Combat_Heavy_Unique_PowerIncrease_Top_06) had their real, non-zero
  // stored volume_override values flagged for silent overwrite to 0 -- the
  // exact bug class #396 exists to fix, reintroduced by this repair script
  // itself. Leaving no Map entry for an uncatalogued item makes `.get()`
  // correctly return `undefined`, routing it into the existing
  // "unknownTemplate, leave untouched" path below instead.
  const volume = Number(item.volume);
  if (Number.isFinite(volume) && volume >= 0) volumeByTemplateId.set(String(item.id), volume);
}

const db = createDb({ repoRoot });

try {
  const result = await db.query(`
    select id, template_id, stack_size, volume_override
    from dune.items
    where volume_override is not null
      and volume_override <> 0
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

  // Second pass (2026-08-20): rows with volume_override exactly 0, from the
  // uncatalogued-item Give/Fill insert bug fixed alongside this pass -- see
  // this file's header comment. Scanned separately from the pass above
  // because these rows need no catalog lookup at all: a stored 0 is never
  // correct regardless of what the catalog says (a fresh insert today would
  // write NULL, not a recomputed number), so every such row is corrected to
  // NULL unconditionally.
  const zeroRows = await db.query(`
    select id, template_id, stack_size
    from dune.items
    where volume_override = 0
    order by id`);

  console.log(`\nScanned ${zeroRows.rows.length} row(s) with volume_override = 0 (the separate NULL-vs-0 bug).`);

  if (toFix === 0 && zeroRows.rows.length === 0) {
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
  for (const row of zeroRows.rows) {
    console.log(`  id=${row.id} template_id=${row.template_id} stack_size=${row.stack_size} volume_override 0 -> NULL`);
  }

  if (!apply) {
    console.log("\nDry run only -- no changes written. Re-run with --apply to write these corrections.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const change of changes) {
      await tx.query("update dune.items set volume_override = $1 where id = $2", [change.to, change.id]);
    }
    if (zeroRows.rows.length > 0) {
      await tx.query(
        "update dune.items set volume_override = null where id = any($1::bigint[]) and volume_override = 0",
        [zeroRows.rows.map((row) => String(row.id))]
      );
    }
  });
  console.log(`\nApplied ${changes.length + zeroRows.rows.length} correction(s) (${changes.length} recomputed, ${zeroRows.rows.length} cleared to NULL).`);
} finally {
  await db.close?.();
}
