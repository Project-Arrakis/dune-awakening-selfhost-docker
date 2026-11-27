import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/build-item-game-data.mjs");

const row = (ItemSize, MaxStackSize, ItemSizeOverride = -1) => ({ StaticData: { ItemSize, ItemSizeOverride }, StackAndDurability: { MaxStackSize } });
const table = (rows) => [{ Rows: rows }];

function build(t, tables, order) {
  const dir = mkdtempSync(join(tmpdir(), "dune-build-item-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parents = order.map((name) => ({ ObjectName: `DataTable'${name}'` }));
  writeFileSync(join(dir, "Items__CDT_BaseItems.json"), JSON.stringify([{ Properties: { ParentTables: parents } }]));
  for (const [name, rows] of Object.entries(tables)) writeFileSync(join(dir, `Items__${name}.json`), JSON.stringify(table(rows)));
  const out = join(dir, "out.json");
  const run = spawnSync(process.execPath, [script, dir, "123", "2026-01-02", out], { encoding: "utf8", windowsHide: true });
  return { run, read: () => JSON.parse(readFileSync(out, "utf8")) };
}

test("a later table replaces an earlier row, and an override replaces the size", (t) => {
  const { run, read } = build(t, {
    DT_BaseItems_Placeables: { Thumper: row(0, 1), Ore: row(0.699999988, 500), Crate: row(4, 1, 2) },
    DT_BaseItems_Weapons: { Thumper: row(2, 1) }
  }, ["DT_BaseItems_Placeables", "DT_BaseItems_Weapons"]);
  assert.equal(run.status, 0, run.stderr);
  const data = read();
  assert.deepEqual(data.volume, { Crate: 2, Ore: 0.7, Thumper: 2 });
  assert.deepEqual(data.maxStack, { Crate: 1, Ore: 500, Thumper: 1 });
  assert.deepEqual(data.source, { gameBuild: "123", read: "2026-01-02", compositeTable: "CDT_BaseItems", tables: ["DT_BaseItems_Placeables", "DT_BaseItems_Weapons"] });
});

test("an unusable value or a missing table stops the build", (t) => {
  const bad = build(t, { DT_BaseItems_Weapons: { Sword: row(2, 0) } }, ["DT_BaseItems_Weapons"]);
  assert.notEqual(bad.run.status, 0);
  assert.match(bad.run.stderr, /Sword: unusable/);
  const missing = build(t, {}, ["DT_BaseItems_Weapons"]);
  assert.notEqual(missing.run.status, 0);
  assert.match(missing.run.stderr, /Expected one dump of DT_BaseItems_Weapons/);
});
