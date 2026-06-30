import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistSpicefieldOverride } from "../src/services/spicefieldOverrides.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-spicefield-test-"));
  return {
    spicefieldOverridesFile: join(root, "runtime", "generated", "spicefield-overrides.json")
  };
}

test("spice field override persistence stores only replayable settings", () => {
  const cfg = config();
  const result = persistSpicefieldOverride(cfg, {
    spicefield_type_id: 8,
    map_name: "DeepDesert",
    field_type: "Large",
    dimension_index: 0,
    max_globally_active: 2,
    max_globally_primed: 4,
    current_globally_active: 1,
    current_globally_primed: 3,
    is_spawning_active: true,
    global_spawn_weight: 1.5
  });

  assert.equal(result.overrideCount, 1);
  const saved = JSON.parse(readFileSync(cfg.spicefieldOverridesFile, "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.overrides["8"].max_globally_active, 2);
  assert.equal(saved.overrides["8"].max_globally_primed, 4);
  assert.equal(saved.overrides["8"].is_spawning_active, true);
  assert.equal(saved.overrides["8"].global_spawn_weight, 1.5);
  assert.equal(Object.hasOwn(saved.overrides["8"], "current_globally_active"), false);
  assert.equal(Object.hasOwn(saved.overrides["8"], "current_globally_primed"), false);
});

test("spice field override persistence merges existing overrides", () => {
  const cfg = config();
  persistSpicefieldOverride(cfg, {
    spicefield_type_id: 8,
    max_globally_active: 2,
    max_globally_primed: 4,
    is_spawning_active: true,
    global_spawn_weight: 1.5
  });
  persistSpicefieldOverride(cfg, {
    spicefield_type_id: 9,
    max_globally_active: 0,
    max_globally_primed: 1,
    is_spawning_active: false,
    global_spawn_weight: 0
  });

  const saved = JSON.parse(readFileSync(cfg.spicefieldOverridesFile, "utf8"));
  assert.deepEqual(Object.keys(saved.overrides).sort(), ["8", "9"]);
  assert.equal(saved.overrides["8"].max_globally_active, 2);
  assert.equal(saved.overrides["9"].is_spawning_active, false);
});
