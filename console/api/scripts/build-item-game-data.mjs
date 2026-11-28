#!/usr/bin/env node
// Builds runtime/data/item-game-data.json (unit volume and stack limit of every
// item) from JSON dumps of the game's item tables. It reads only those dumps;
// making them takes a reader of the game's content files, which is not part of
// this repository. See runtime/data/item-game-data.PROVENANCE.md.
//
// Usage: node console/api/scripts/build-item-game-data.mjs <dump dir> <game build> <read date> [out file]
//
// The dump directory holds one JSON file per table, named "...<table>.json": the
// composite table CDT_BaseItems and every table it lists.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dumpDir, gameBuild, readDate, outArgument] = process.argv.slice(2);
if (!dumpDir || !/^\d+$/.test(gameBuild || "") || !/^\d{4}-\d{2}-\d{2}$/.test(readDate || "")) {
  console.error("Usage: build-item-game-data.mjs <dump dir> <game build> <read date YYYY-MM-DD> [out file]");
  process.exit(2);
}
const outFile = outArgument || resolve(dirname(fileURLToPath(import.meta.url)), "../../../runtime/data/item-game-data.json");
const files = readdirSync(dumpDir);

function readTable(name) {
  const matches = files.filter((file) => file === `${name}.json` || file.endsWith(`__${name}.json`));
  if (matches.length !== 1) throw new Error(`Expected one dump of ${name}, found ${matches.length}`);
  return JSON.parse(readFileSync(join(dumpDir, matches[0]), "utf8"));
}

const parents = readTable("CDT_BaseItems")
  .flatMap((entry) => entry.Properties?.ParentTables || [])
  .map((parent) => /'([^'.]+)'/.exec(parent.ObjectName)?.[1]);
if (parents.length === 0 || parents.some((name) => !name)) throw new Error("CDT_BaseItems lists no readable parent tables");

// The game applies the parent tables in order, so a later row replaces an
// earlier one with the same id.
const rows = new Map();
for (const table of parents) {
  for (const entry of readTable(table)) {
    for (const [id, row] of Object.entries(entry.Rows || {})) {
      const override = row.StaticData?.ItemSizeOverride;
      const volume = override >= 0 ? override : row.StaticData?.ItemSize;
      const maxStack = row.StackAndDurability?.MaxStackSize;
      if (!Number.isFinite(volume) || volume < 0 || !Number.isInteger(maxStack) || maxStack < 1) {
        throw new Error(`${table} ${id}: unusable volume ${volume} or stack size ${maxStack}`);
      }
      // Table dumps carry single-precision floats: 0.699999988 is the game's 0.7.
      rows.set(id, { volume: Number(volume.toFixed(4)), maxStack });
    }
  }
}

const ids = [...rows.keys()].sort();
const section = (key) => Object.fromEntries(ids.map((id) => [id, rows.get(id)[key]]));
const output = {
  source: { gameBuild, read: readDate, compositeTable: "CDT_BaseItems", tables: parents },
  volume: section("volume"),
  maxStack: section("maxStack")
};
writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`${ids.length} items from ${parents.length} tables -> ${outFile}`);
