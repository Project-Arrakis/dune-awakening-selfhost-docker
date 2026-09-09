import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateEnvFileValues } from "../src/services/envFile.js";

test("updateEnvFileValues writes multiple keys in a single pass, updating existing keys and appending new ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING_KEY=old-value\nOTHER_KEY=untouched\n");

  updateEnvFileValues(dir, [
    ["EXISTING_KEY", "new-value"],
    ["DUNE_DISCORD_ADAPTER_ENABLED", "true"],
    ["DISCORD_PLAYER_ROLE_IDS", "111111111111111111,222222222222222222"]
  ]);

  const content = readFileSync(join(dir, ".env"), "utf8");
  assert.match(content, /^EXISTING_KEY=new-value$/m);
  assert.match(content, /^OTHER_KEY=untouched$/m);
  assert.match(content, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
  assert.match(content, /^DISCORD_PLAYER_ROLE_IDS="111111111111111111,222222222222222222"$/m);
});

test("updateEnvFileValues creates .env from scratch when it does not exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-envfile-fresh-"));
  updateEnvFileValues(dir, [["DUNE_DISCORD_ADAPTER_ENABLED", "true"]]);
  const content = readFileSync(join(dir, ".env"), "utf8");
  assert.match(content, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
});
