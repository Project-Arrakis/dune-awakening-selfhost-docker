import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseBackupError, BaseBackupTimeoutError, baseBackupHttpError, classifyTimeout, importBaseBackup,
  listBaseBackups, parseBaseBackupFile, validateBaseBackupFile, versionComparison
} from "../src/baseBackups.js";
import { parseAppManifestBuildId, readSteamBuildId, steamAppId } from "../src/services/steamBuild.js";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

function minimalFile(overrides = {}) {
  return {
    format: "dune-base-backup",
    version: 1,
    ownerPlaceholderTransferId: 1,
    game: { build: "2036754", patchesChecksum: "abc" },
    entries: [
      { id: 1, kind: "act", data: {} },
      { id: 2, kind: "act", data: { class: "BP_Totem_C" } },
      { id: 3, kind: "BaseBackup", data: { player_id: 1 } },
      { id: 4, kind: "BaseBackupLinkedActor", data: { id: 3, actor_id: 2 } },
      { id: 5, kind: "Totem", data: { id: 2 } }
    ],
    ...overrides
  };
}

function withEntries(mutate) {
  const file = minimalFile();
  mutate(file.entries);
  return file;
}

test("validateBaseBackupFile accepts a minimal well-formed export", () => {
  const result = validateBaseBackupFile(minimalFile());
  assert.equal(result.placeholderTransferId, 1);
  assert.equal(result.counts.act, 2);
});

test("validateBaseBackupFile rejects malformed or unsafe files", () => {
  const cases = [
    [null, /not a base backup export/],
    [[], /not a base backup export/],
    [minimalFile({ format: "blueprint" }), /unknown format/],
    [minimalFile({ version: 2 }), /Unsupported base backup file version 2/],
    [minimalFile({ entries: [] }), /has no entries/],
    [minimalFile({ ownerPlaceholderTransferId: undefined }), /owner placeholder/],
    [minimalFile({ ownerPlaceholderTransferId: 99 }), /owner placeholder/],
    [withEntries((e) => e.push({ id: 5, kind: "Totem", data: {} })), /repeats entry id 5/],
    [withEntries((e) => e.push({ id: 6, kind: "Character", data: {} })), /unsupported entry kind: Character/],
    [withEntries((e) => e.push({ id: 6, kind: "BaseBackup", data: {} })), /exactly one backup record/],
    [withEntries((e) => e.splice(4, 1)), /has no totem/],
    [withEntries((e) => { e[3].data.id = 99; }), /BaseBackupLinkedActor 4 id outside the base/],
    [withEntries((e) => { e[3].data.actor_id = 42; }), /BaseBackupLinkedActor 4 actor_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "act", data: {} })), /not part of the backup/],
    [withEntries((e) => { e[1].data = "x"; }), /has no data/],
    [withEntries((e) => { e[0].data = { class: "x" }; }), /owner placeholder carries data/],
    // References must stay inside the base: nothing may hang off the receiving player.
    [withEntries((e) => e.push({ id: 6, kind: "inv", data: { actor_id: 1 } })), /inv 6 actor_id at the receiving player/],
    [withEntries((e) => e.push({ id: 6, kind: "PermissionActorRank", data: { permission_actor_id: 1, player_id: 1 } })), /permission_actor_id at the receiving player/],
    [withEntries((e) => { e[4].data.id = 1; }), /Totem 5 id at the receiving player/],
    [withEntries((e) => { e[2].data.player_id = 2; }), /BaseBackup 3 player_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "itm", data: { inventory_id: 99 } })), /itm 6 inventory_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "Placeable", data: { id: 2, owner_entity_id: 77 } })), /Placeable 6 owner_entity_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "Totem", data: {} })), /missing Totem 6 id/],
    [withEntries((e) => e.push({ id: 6, kind: "inv", data: { actor_id: 2 } }, { id: 7, kind: "itm", data: { inventory_id: 6 } },
      { id: 8, kind: "bbp", data: { item_id: 7, player_id: 1 } })), /sets bbp 8 player_id/]
  ];
  for (const [file, pattern] of cases) {
    assert.throws(() => validateBaseBackupFile(file), (error) => {
      assert.ok(error instanceof BaseBackupError, `expected BaseBackupError for ${pattern}`);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.throws(() => parseBaseBackupFile("{not json"), /could not be read as JSON/);
});

test("validateBaseBackupFile accepts the references a real export carries", () => {
  const file = withEntries((e) => e.push(
    { id: 6, kind: "fgl", data: { actor_id: 2 } },
    { id: 7, kind: "Placeable", data: { id: 2, owner_entity_id: 6 } },
    { id: 8, kind: "Placeable", data: { id: 2, owner_entity_id: null } },
    { id: 9, kind: "PermissionActor", data: { actor_id: 2 } },
    { id: 10, kind: "PermissionActorRank", data: { permission_actor_id: 2, player_id: 1 } },
    { id: 11, kind: "inv", data: { actor_id: 2 } },
    { id: 12, kind: "itm", data: { inventory_id: 11, stats: { Ref: "!!act@1" } } },
    { id: 13, kind: "bbp", data: { item_id: 12 } },
    { id: 14, kind: "BuildingBlueprintInstance", data: { building_blueprint_id: 13 } }
  ));
  assert.equal(validateBaseBackupFile(file).counts.Placeable, 2);
});

test("versionComparison caps what it copies from the file", () => {
  const detail = versionComparison({ patchesChecksum: "x".repeat(5000), build: "y".repeat(5000), steamBuildId: { nested: true } }, { patchesChecksum: "a" }, "1");
  assert.ok(detail.file.patchesChecksum.length <= 67);
  assert.ok(detail.file.build.length <= 67);
  assert.equal(typeof detail.file.steamBuildId, "string");
});

test("versionComparison flags a patches-checksum difference, not a build label alone", () => {
  assert.equal(versionComparison({ patchesChecksum: "a", build: "1" }, { patchesChecksum: "a" }, "2").mismatch, false);
  assert.equal(versionComparison({ patchesChecksum: "a" }, { patchesChecksum: "b" }, "1").mismatch, true);
  assert.equal(versionComparison({}, { patchesChecksum: "b" }, "1").mismatch, true);
  const detail = versionComparison({ patchesChecksum: "a", build: "1", appliedPatchesCount: 5 }, { patchesChecksum: "b", appliedPatchesCount: 6 }, "2");
  assert.deepEqual(detail.file, { build: "1", steamBuildId: null, patchesChecksum: "a", appliedPatchesCount: 5 });
  assert.deepEqual(detail.server, { build: "2", patchesChecksum: "b", appliedPatchesCount: 6 });
});

test("classifyTimeout tells server and client timeouts apart", () => {
  assert.equal(classifyTimeout({ code: "57014" }), "server_timeout");
  assert.equal(classifyTimeout(new Error("canceling statement due to statement timeout")), "server_timeout");
  assert.equal(classifyTimeout(new Error("Query read timeout")), "client_timeout");
  assert.equal(classifyTimeout(new Error("duplicate key value")), null);
});

test("BaseBackupTimeoutError names the step, the elapsed time and the limit", () => {
  const slow = new BaseBackupTimeoutError({ operation: "import", step: "inserting building pieces", kind: "server_timeout", elapsedMs: 15230, limitMs: 15000 });
  assert.equal(slow.message, "Base backup import timed out after 15.2s while inserting building pieces (limit 15s). Nothing was changed: the import was rolled back.");
  const fast = new BaseBackupTimeoutError({ operation: "export", step: "exporting stored items", kind: "client_timeout", elapsedMs: 61, limitMs: 60 });
  assert.equal(fast.message, "Base backup export timed out after 61ms while exporting stored items (limit 60ms). No file was produced.");
  assert.equal(fast.statusCode, 504);
  assert.equal(fast.code, "timeout");
});

test("baseBackupHttpError maps failures to the statuses and bodies the UI reads", () => {
  const timeout = baseBackupHttpError(new BaseBackupTimeoutError({ operation: "import", step: "loading the file", kind: "server_timeout", elapsedMs: 2000, limitMs: 1000 }));
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.code, "timeout");
  assert.equal(timeout.body.step, "loading the file");
  assert.equal(timeout.body.operation, "import");
  assert.equal(timeout.body.limitMs, 1000);
  assert.match(timeout.body.error, /Nothing was changed/);

  const mismatch = baseBackupHttpError(new BaseBackupError("different version", {
    statusCode: 409, code: "version_mismatch", details: { file: { build: "1" }, server: { build: "2" } }
  }));
  assert.deepEqual(mismatch, { status: 409, body: { ok: false, code: "version_mismatch", error: "different version", file: { build: "1" }, server: { build: "2" } } });

  assert.equal(baseBackupHttpError(Object.assign(new Error("nope"), { unsupported: true })).status, 501);
  assert.equal(baseBackupHttpError(Object.assign(new Error("Player not found"), { statusCode: 404 })).status, 404);
  assert.equal(baseBackupHttpError(new Error("Invalid player id")).status, 400);
  assert.equal(baseBackupHttpError(new Error("boom")).status, 500);
  assert.ok(baseBackupHttpError(new Error("x".repeat(50000))).body.error.length <= 1003);
});

// A fake db shaped like db.js: its transaction() rethrows a plain Error with
// only the message, exactly as db.js does, so the timeout classification is
// tested through the same information loss production has.
const ALL_KINDS = ["act", "fgl", "inv", "itm", "bbp", "PermissionActor", "PermissionActorRank", "ActorInventory", "Building",
  "BuildingInstance", "Placeable", "Totem", "BaseBackup", "BaseBackupLinkedActor", "LandclaimSegment", "TaxInvoice", "Sinkchart",
  "BuildingBlueprintInstance", "BuildingBlueprintPlaceable", "BuildingBlueprintPentashield"];

function fakeDb({
  online = false, failOn = null, failWith = null, missingFunction = null, kinds = ALL_KINDS,
  columnRows = [
    { table_name: "building_instances", column_name: "transform", column_type: "real[]", is_array: true },
    { table_name: "building_instances", column_name: "last_placed_by_player_id", column_type: "bigint", is_array: false },
    { table_name: "actors", column_name: "partition_id", column_type: "bigint", is_array: false },
    { table_name: "actors", column_name: "state", column_type: "text", is_array: false }
  ]
} = {}) {
  const calls = { transaction: 0, txSql: [] };
  const db = {
    calls,
    async query(sql, params = []) {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ exists: params[0] !== missingFunction }] };
      if (sql.includes("to_regtype")) return { rows: [{ kinds }] };
      if (sql.includes("from dune.actors a") && sql.includes("player_state")) {
        return { rows: [{ actor_id: 21, account_id: 2, controller_id: 20, player_state_id: 1, online_status: online ? "Online" : "Offline" }] };
      }
      if (sql.includes("_get_patches_checksum")) return { rows: [{ checksum: "abc", patch_count: 3, latest: ["P3"] }] };
      if (sql.includes("from pg_attribute")) return { rows: columnRows };
      return { rows: [] };
    },
    async transaction(fn) {
      calls.transaction++;
      const tx = {
        async query(sql) {
          calls.txSql.push(sql);
          if (failOn && failOn(sql)) throw failWith;
          if (sql.includes("where kind = 'BaseBackup'")) return { rows: [{ id: 77 }] };
          return { rows: [] };
        }
      };
      try {
        return await fn(tx);
      } catch (error) {
        throw new Error(error.message);
      }
    }
  };
  return db;
}

test("importBaseBackup refuses a version mismatch before touching the database", async () => {
  const db = fakeDb();
  const text = JSON.stringify(minimalFile({ game: { patchesChecksum: "other", build: "1" } }));
  await assert.rejects(importBaseBackup(db, 21, text, { serverBuild: "2" }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "version_mismatch");
    assert.equal(error.details.file.patchesChecksum, "other");
    assert.equal(error.details.server.patchesChecksum, "abc");
    return true;
  });
  assert.equal(db.calls.transaction, 0);

  const allowed = await importBaseBackup(db, 21, text, { allowVersionMismatch: true, serverBuild: "2" });
  assert.equal(allowed.backupId, 77);
  assert.match(allowed.warning, /version mismatch/);
});

test("importBaseBackup warns, but does not refuse, when the receiving player is online", async () => {
  const result = await importBaseBackup(fakeDb({ online: true }), 21, JSON.stringify(minimalFile()));
  assert.equal(result.ok, true);
  assert.equal(result.online, true);
  assert.match(result.warning, /online/);
});

test("importBaseBackup restores per-row array bounds, cast to the column's own type", async () => {
  const db = fakeDb();
  await importBaseBackup(db, 21, JSON.stringify(minimalFile()));
  const rebase = db.calls.txSql.find((sql) => sql.includes('set r."transform"') && sql.includes("::real[]"));
  assert.ok(rebase, "staged building pieces get their recorded bounds back, cast to real[]");
  assert.match(rebase, /where lb \? \$1 and \(lb ->> \$1\) in \('0', '1'\)/, "only a 0 or 1 bound from the file is applied");
  await assert.rejects(
    importBaseBackup(fakeDb({ columnRows: [{ table_name: "building_instances", column_name: "transform", column_type: "real[]; drop table x", is_array: true }] }), 21, JSON.stringify(minimalFile())),
    /Unexpected array column type/);
});

test("importBaseBackup forces imported actors out of any partition and remaps player ids", async () => {
  const db = fakeDb();
  await importBaseBackup(db, 21, JSON.stringify(minimalFile()));
  assert.ok(db.calls.txSql.some((sql) => sql.includes("r.partition_id = null") && sql.includes("r.state = 'BaseBackup'")));
  assert.ok(db.calls.txSql.some((sql) => sql.includes('r."last_placed_by_player_id" = case when')));
});

test("importBaseBackup reports a server-side statement timeout with the step that ran out", async () => {
  const db = fakeDb({
    failOn: (sql) => sql.includes("insert into dune.building_instances"),
    failWith: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
  });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.ok(error instanceof BaseBackupTimeoutError);
    assert.equal(error.details.step, "inserting building pieces");
    assert.equal(error.details.timeoutKind, "server_timeout");
    assert.equal(error.details.limitMs, 120000);
    assert.equal(baseBackupHttpError(error).status, 504);
    return true;
  });
});

test("importBaseBackup reports a client-side query timeout too", async () => {
  const db = fakeDb({ failOn: (sql) => sql.includes("_data_table_load"), failWith: new Error("Query read timeout") });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.ok(error instanceof BaseBackupTimeoutError);
    assert.equal(error.details.step, "loading the file");
    assert.equal(error.details.timeoutKind, "client_timeout");
    assert.equal(error.details.limitMs, 15000);
    return true;
  });
});

test("importBaseBackup passes other database errors through unchanged", async () => {
  const db = fakeDb({ failOn: (sql) => sql.includes("insert into dune.totems"), failWith: new Error("duplicate key value") });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.equal(error instanceof BaseBackupTimeoutError, false);
    assert.match(error.message, /duplicate key value/);
    return true;
  });
});

test("an older game build without every entry kind reads as unsupported", async () => {
  const result = await listBaseBackups(fakeDb({ kinds: ALL_KINDS.filter((kind) => kind !== "Sinkchart") }));
  assert.equal(result.supported, false);
  assert.ok(result.missing.includes("dune._charactertransferentrykind 'Sinkchart'"));
});

test("listBaseBackups reports unsupported when any helper function is missing", async () => {
  const signature = "dune._character_transfer_data_table_save()";
  const result = await listBaseBackups(fakeDb({ missingFunction: signature }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.rows, []);
  assert.ok(result.missing.includes(signature));
});

test("steam build id is read from the appmanifest and fails soft to null", async () => {
  assert.equal(parseAppManifestBuildId('"AppState"\n{\n\t"appid"\t\t"4754530"\n\t"buildid"\t\t"2036754"\n}'), "2036754");
  assert.equal(parseAppManifestBuildId("garbage"), null);
  assert.equal(steamAppId("/nonexistent", { STEAM_APP_ID: "123" }), "123");
  assert.equal(steamAppId("/nonexistent", {}), "4754530");

  const fakeSpawn = (code, output) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (output) child.stdout.emit("data", Buffer.from(output));
      child.emit("close", code);
    });
    return child;
  };
  assert.equal(await readSteamBuildId({ spawnImpl: fakeSpawn(0, '"buildid"  "999"'), useCache: false }), "999");
  assert.equal(await readSteamBuildId({ spawnImpl: fakeSpawn(1, ""), useCache: false }), null);
  assert.equal(await readSteamBuildId({ spawnImpl: () => { throw new Error("no docker"); }, useCache: false }), null);
});

test("base backup routes resolve to their own actions, and import is admin-only by default", () => {
  assert.equal(actionForRoute("/api/base-backups", "GET"), "bases:read");
  assert.equal(actionForRoute("/api/base-backups/7/export", "GET"), "bases:read");
  assert.equal(actionForRoute("/api/base-backups/import", "POST"), "bases:import-backup");
  // Nothing else under the path resolves, so it fails closed.
  assert.equal(actionForRoute("/api/base-backups/7", "DELETE"), null);
  assert.equal(actionForRoute("/api/base-backups/7/export", "POST"), null);
  for (const tier of ["owner", "admin"]) assert.equal(evaluate({ tier }, "bases:import-backup"), true);
  for (const tier of ["moderator", "player", "observer"]) {
    assert.equal(evaluate({ tier }, "bases:import-backup"), false);
    assert.equal(evaluate({ tier }, "bases:read"), true);
  }
  // A hand-authored policy granting bases:mutate must not gain import.
  const policies = { moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate"] }] } };
  assert.equal(evaluate({ tier: "moderator" }, "bases:import-backup", policies), false);
});

// Documented but not forwarded is the same as not configurable: the console
// container only sees what docker-compose.web.yml passes through.
test("the documented base backup statement timeout reaches the console container", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const compose = readFileSync(resolve(repoRoot, "docker-compose.web.yml"), "utf8");
  const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
  assert.match(compose, /^\s+ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS:\s+"\$\{ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS:-120000\}"$/m);
  assert.match(envExample, /^ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS=120000$/m);
});
