import test from "node:test";
import assert from "node:assert/strict";
import { parseEffectivePermissionLimit } from "../src/services/permissionSettings.js";

// Precedence here is deliberately the reverse of the guild limit's. The shipped
// DefaultGame.ini defines m_MaxPermissionsPerActor=32 only under
// [/Script/DuneSandbox.PermissionSettings] and carries no DuneGameMode form, so
// the canonical field is the one the server enforces. Reading the legacy field
// first would inherit its 20 and cap rosters below what the game allows.
test("permission limit prefers the canonical PermissionSettings value over the legacy field", () => {
  assert.equal(parseEffectivePermissionLimit([
    "max_permissions_per_actor\t20",
    "permission_max_permissions_per_actor\t36"
  ].join("\n")), 36);
});

test("permission limit falls back to the legacy field when the canonical one is absent", () => {
  assert.equal(parseEffectivePermissionLimit("max_permissions_per_actor\t20\n"), 20);
});

test("permission limit defaults to the shipped 32 when neither field is set", () => {
  assert.equal(parseEffectivePermissionLimit(""), 32);
});

test("permission limit rejects malformed values", () => {
  assert.throws(() => parseEffectivePermissionLimit("permission_max_permissions_per_actor\t0\n"), /invalid/);
  assert.throws(() => parseEffectivePermissionLimit("permission_max_permissions_per_actor\tnot-a-number\n"), /invalid/);
  assert.throws(() => parseEffectivePermissionLimit("permission_max_permissions_per_actor\t-4\n"), /invalid/);
});
