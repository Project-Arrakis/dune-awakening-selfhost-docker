import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTO_START_BATTLEGROUP_DEFAULT,
  readServerStartupSettings,
  resolveAutoStartBattlegroup,
  saveServerStartupSettings,
  serverStartupSettingsView
} from "../src/services/serverStartupSettings.js";

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "server-startup-settings-"));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("server startup defaults to starting the Battlegroup", () => withRoot((root) => {
  assert.equal(AUTO_START_BATTLEGROUP_DEFAULT, true);
  assert.equal(resolveAutoStartBattlegroup(root, {}), true);
  assert.deepEqual(serverStartupSettingsView(root, {}), {
    settings: { autoStartBattlegroup: true },
    defaults: { autoStartBattlegroup: true },
    source: "default"
  });
}));

test("legacy environment opt-out remains supported until a Console choice is saved", () => withRoot((root) => {
  assert.equal(resolveAutoStartBattlegroup(root, { ADMIN_AUTO_START_STACK_ON_BOOT: "0" }), false);
  assert.equal(serverStartupSettingsView(root, { ADMIN_AUTO_START_STACK_ON_BOOT: "0" }).source, "environment");
  saveServerStartupSettings(root, { autoStartBattlegroup: true });
  assert.equal(resolveAutoStartBattlegroup(root, { ADMIN_AUTO_START_STACK_ON_BOOT: "0" }), true);
}));

test("server startup saves both choices atomically with private permissions", () => withRoot((root) => {
  let result = saveServerStartupSettings(root, { autoStartBattlegroup: false });
  assert.equal(result.settings.autoStartBattlegroup, false);
  assert.equal(result.source, "console");
  assert.deepEqual(readServerStartupSettings(root), { autoStartBattlegroup: false });

  result = saveServerStartupSettings(root, { autoStartBattlegroup: true });
  assert.equal(result.settings.autoStartBattlegroup, true);
  const file = join(root, "runtime/generated/server-startup-settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { autoStartBattlegroup: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
}));

test("server startup rejects malformed settings and ignores corrupt persisted state", () => withRoot((root) => {
  for (const payload of [null, [], {}, { autoStartBattlegroup: 0 }, { autoStartBattlegroup: "false" }]) {
    assert.throws(() => saveServerStartupSettings(root, payload), /object|true or false/);
  }
  const dir = join(root, "runtime/generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server-startup-settings.json"), "{broken", "utf8");
  assert.deepEqual(readServerStartupSettings(root), {});
  assert.equal(resolveAutoStartBattlegroup(root, {}), true);
}));
