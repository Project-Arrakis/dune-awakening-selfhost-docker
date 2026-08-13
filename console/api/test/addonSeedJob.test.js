import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EDA_EXCHANGE_BOT_ADDON_ID, buildMarketSeedSql, loadMarketSeedPlan, normalizeSeedSchedule } from "../src/addonSeedJob.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const SEED_PLAN = {
  panel_version: "test",
  price_multiplier: 5,
  rows: [
    { template_id: "T6_Augment_Armor1", display_name: "Concussive Dampening", kind: "equippable", stack_size: 1, price: 28000000, category_mask: 2, category_depth: 2, quality_level: 3, listings: 2, durability_cur: 192, durability_max: 192 },
    { template_id: "T6_Augment_Mystery1", display_name: "Uncatalogued Augment", kind: "equippable", stack_size: 1, price: 19000000, category_mask: 2, category_depth: 2, quality_level: 1, listings: 2, durability_cur: 184, durability_max: 184 },
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

test("discounted augment pricing (the default) undercuts patterns in the seed SQL", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5 });
    // Half the 2.8M schematic at the same grade.
    assert.match(sql, /'T6_Augment_Armor1',1,1400000,/);
    // No pattern listed: the 19M item price falls back to the same 20x scale.
    assert.match(sql, /'T6_Augment_Mystery1',1,950000,/);
    // Schematics and non-augment rows keep their plan prices.
    assert.match(sql, /'T6_Augment_Armor1_Schematic',1,2800000,/);
    assert.match(sql, /'Sword',1,2000,/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("original augment pricing keeps the plan's augment item prices", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5, augmentPricing: "original" });
    assert.match(sql, /'T6_Augment_Armor1',1,28000000,/);
    assert.match(sql, /'T6_Augment_Mystery1',1,19000000,/);
    assert.match(sql, /'T6_Augment_Armor1_Schematic',1,2800000,/);
    // The stat roll pin is not a pricing choice: it applies in both modes.
    assert.match(sql, /"StatRolls":\[0\.2,0\.2\]/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("seed schedule normalizes the augment pricing choice", () => {
  assert.equal(normalizeSeedSchedule({}).augmentPricing, "discounted");
  assert.equal(normalizeSeedSchedule({ augmentPricing: "original" }).augmentPricing, "original");
  assert.equal(normalizeSeedSchedule({ augmentPricing: "junk" }).augmentPricing, "discounted");
  // Saves that omit the field (for example through the addon bridge) keep the stored choice.
  assert.equal(normalizeSeedSchedule({}, { augmentPricing: "original" }).augmentPricing, "original");
  assert.equal(normalizeSeedSchedule({ intervalMinutes: 20 }, { augmentPricing: "original" }).augmentPricing, "original");
});

test("bundled plan carries the original augment ladder with patterns to discount against", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const originalLadder = { 1: 19000000, 2: 23500000, 3: 28000000, 4: 33000000, 5: 37500000 };
  const schematics = new Set(
    plan.rows
      .filter((row) => row.kind === "schematic" && row.template_id.startsWith("T6_Augment"))
      .map((row) => `${row.template_id}:${row.quality_level}`)
  );
  let items = 0;
  const itemOnly = [];
  for (const row of plan.rows) {
    if (row.kind !== "equippable" || !row.template_id.startsWith("T6_Augment")) continue;
    assert.equal(row.price, originalLadder[row.quality_level], `${row.template_id} grade ${row.quality_level} should sit on the original ladder`);
    items += 1;
    if (!schematics.has(`${row.template_id}_Schematic:${row.quality_level}`)) itemOnly.push(row.template_id);
  }
  assert.ok(items >= 300, `expected hundreds of augment item rows, got ${items}`);
  // Everything except the known item-only augment discounts against its own pattern.
  assert.deepEqual([...new Set(itemOnly)], ["T6_Augment_Damage2"]);
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
