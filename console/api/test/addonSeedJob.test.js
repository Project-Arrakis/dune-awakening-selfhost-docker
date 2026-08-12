import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EDA_EXCHANGE_BOT_ADDON_ID, buildMarketSeedSql, loadMarketSeedPlan } from "../src/addonSeedJob.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const SEED_PLAN = {
  panel_version: "test",
  price_multiplier: 5,
  rows: [
    { template_id: "T6_Augment_Armor1", display_name: "Concussive Dampening", kind: "equippable", stack_size: 1, price: 1400000, category_mask: 2, category_depth: 2, quality_level: 3, listings: 2, durability_cur: 192, durability_max: 192 },
    { template_id: "T6_Augment_Mystery1", display_name: "Uncatalogued Augment", kind: "equippable", stack_size: 1, price: 950000, category_mask: 2, category_depth: 2, quality_level: 1, listings: 2, durability_cur: 184, durability_max: 184 },
    { template_id: "T6_Augment_Armor1_Schematic", display_name: "Concussive Dampening", kind: "schematic", stack_size: 1, price: 2800000, category_mask: 3, category_depth: 2, quality_level: 3, listings: 2, durability_cur: 192, durability_max: 192 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2000, category_mask: 2, category_depth: 2, quality_level: 0, listings: 2, durability_cur: 110, durability_max: 110 }
  ]
};

const AUGMENT_CATALOG = {
  augments: {
    T6_Augment_Armor1: {
      name: "Concussive Dampening",
      gradeEffects: {
        1: ["Concussive Mitigation +1.75% - +2.25%", "Energy Mitigation -1%"],
        3: ["Concussive Mitigation +3.25% - +4%", "Energy Mitigation -1%"]
      }
    }
  }
};

function makeRepoRoot({ plan = SEED_PLAN, catalog = AUGMENT_CATALOG } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-seed-job-"));
  const webDir = join(repoRoot, "runtime/addons/installed", EDA_EXCHANGE_BOT_ADDON_ID, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "market-seed-plan.json"), JSON.stringify(plan));
  if (catalog) {
    mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
    writeFileSync(join(repoRoot, "runtime/data/augment-compatibility.json"), JSON.stringify(catalog));
  }
  return repoRoot;
}

function statsByTemplate(plan) {
  return new Map(plan.rows.map((row) => [`${row.templateId}:${row.kind}`, JSON.parse(row.itemStats)]));
}

test("pins bot-sold augment items to bottom-20% stat rolls", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const stats = statsByTemplate(plan);

    // Roll count follows the widest gradeEffects list in the catalog (2 lines).
    assert.deepEqual(stats.get("T6_Augment_Armor1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2, 0.2], AppliedEffectIndices: [] }]);
    // Catalog miss still pins a single bottom-of-range roll.
    assert.deepEqual(stats.get("T6_Augment_Mystery1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2], AppliedEffectIndices: [] }]);
    // Schematics and non-augment items carry durability stats only.
    assert.equal(stats.get("T6_Augment_Armor1_Schematic:schematic").FAugmentItemStats, undefined);
    assert.equal(stats.get("Sword:equippable").FAugmentItemStats, undefined);
    for (const parsed of stats.values()) {
      assert.ok(Array.isArray(parsed.FItemStackAndDurabilityStats));
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("pins a single bottom-20% roll when the augment catalog is missing", () => {
  const repoRoot = makeRepoRoot({ catalog: null });
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const stats = statsByTemplate(plan);
    assert.deepEqual(stats.get("T6_Augment_Armor1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2], AppliedEffectIndices: [] }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("seed SQL embeds the pinned augment roll payload", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5 });
    assert.match(sql, /"StatRolls":\[0\.2,0\.2\]/);
    assert.match(sql, /"FItemStackAndDurabilityStats"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("bundled plan sells augment items cheaper than their schematics", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const schematicPrices = new Map();
  for (const row of plan.rows) {
    if (row.kind === "schematic" && row.template_id.startsWith("T6_Augment")) {
      schematicPrices.set(`${row.template_id.replace(/_Schematic$/, "")}:${row.quality_level}`, row.price);
    }
  }
  let compared = 0;
  for (const row of plan.rows) {
    if (row.kind !== "equippable" || !row.template_id.startsWith("T6_Augment")) continue;
    const schematicPrice = schematicPrices.get(`${row.template_id}:${row.quality_level}`);
    if (schematicPrice === undefined) continue; // item-only augments have no pattern listed
    assert.ok(row.price < schematicPrice, `${row.template_id} grade ${row.quality_level}: item ${row.price} should undercut schematic ${schematicPrice}`);
    compared += 1;
  }
  assert.ok(compared >= 300, `expected to compare hundreds of augment rows, got ${compared}`);
});

test("bundled plan lists two full stacks of iodine pills", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const rows = plan.rows.filter((row) => row.template_id === "AntiRadiationPill");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "consumable");
  assert.equal(rows[0].listings, 2);
  assert.equal(rows[0].stack_size, 20);
  assert.equal(rows[0].price, 800);
});
