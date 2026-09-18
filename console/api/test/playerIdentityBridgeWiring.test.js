import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverSource = readFileSync(join(import.meta.dirname, "../src/server.js"), "utf8");

test("players.identity.list is gated by the addon's players:read approval", () => {
  const actionAt = serverSource.indexOf('if (action === "players.identity.list")');
  assert.ok(actionAt > 0, "players.identity.list bridge action is not registered");
  const actionBlock = serverSource.slice(actionAt, actionAt + 500);
  assert.ok(
    actionBlock.includes('assertInstalledAddonPermission(config, id, "players:read")'),
    "players.identity.list is not protected by players:read"
  );
  assert.ok(
    actionBlock.indexOf('assertInstalledAddonPermission(config, id, "players:read")') <
      actionBlock.indexOf("addonPlayerIdentities(db)"),
    "identity data is read before addon permission is checked"
  );
});
