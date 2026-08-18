// Structural tests for the base container give/fill/bulk-delete routes
// added alongside the raw-resource catalog work (issue #347). server.js is
// an entrypoint -- importing it starts a listener -- so, following
// baseRouteStatus.test.js's precedent, these routes are read as source and
// their real guard logic is asserted against the actual regex/string
// literals in the file, not re-implemented and tested in isolation (which
// would only prove the test's own copy is correct, not the shipped route).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSource = readFileSync(resolve(repoRoot, "console/api/src/server.js"), "utf8");

const DELETE_ROUTES = ["baseContainerItemsDeleteRoute", "baseContainerAllItemsDeleteRoute"];
const GIVE_FILL_ROUTES = ["baseContainerGiveItemRoute", "baseContainerGiveItemsRoute", "baseContainerFillItemRoute"];
const ALL_MUTATION_ROUTES = [...DELETE_ROUTES, ...GIVE_FILL_ROUTES];

function routeBody(name) {
  const start = serverSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in server.js`);
  const end = serverSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return serverSource.slice(start, end);
}

test("every new base container mutation route is dispatched from handleApi", () => {
  const dispatchPatterns = {
    baseContainerItemsDeleteRoute: /containers\\\/\[\^\/\]\+\\\/items\$.*&&.*"DELETE".*baseContainerItemsDeleteRoute/,
    baseContainerAllItemsDeleteRoute: /containers\\\/\[\^\/\]\+\\\/all-items\$.*&&.*"DELETE".*baseContainerAllItemsDeleteRoute/,
    baseContainerGiveItemRoute: /containers\\\/\[\^\/\]\+\\\/give-item\$.*&&.*"POST".*baseContainerGiveItemRoute/,
    baseContainerGiveItemsRoute: /containers\\\/\[\^\/\]\+\\\/give-items\$.*&&.*"POST".*baseContainerGiveItemsRoute/,
    baseContainerFillItemRoute: /containers\\\/\[\^\/\]\+\\\/fill-item\$.*&&.*"POST".*baseContainerFillItemRoute/
  };
  for (const [name, pattern] of Object.entries(dispatchPatterns)) {
    assert.match(serverSource, pattern, `${name} must be wired into the handleApi dispatch chain`);
  }
});

// Deletes are irreversible with no live-sync path, so every delete route
// must refuse to run when the base's map is not known to be safely stopped
// -- the same requirement deleteBaseContainerItem's own route already
// enforces (baseContainerItemDeleteRoute).
test("both new bulk-delete routes check baseContainerDeleteSafety before mutating", () => {
  for (const name of DELETE_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /await baseContainerDeleteSafety\(baseId\)/, `${name} must check map safety`);
    assert.match(body, /if \(!safety\.safe\) throw new Error\(safety\.reason\)/, `${name} must refuse to mutate when unsafe`);
  }
});

// Give/Fill are pure inserts (no existing row is ever touched), so unlike
// the delete routes they must NOT require the map-safety check -- requiring
// it would block an otherwise-safe insert for no real live-sync reason,
// contradicting the same distinction fillItemToStorage/giveItemToStorage's
// existing standalone-Storage-tab routes already make.
test("give/fill routes do not require baseContainerDeleteSafety", () => {
  for (const name of GIVE_FILL_ROUTES) {
    const body = routeBody(name);
    assert.doesNotMatch(body, /baseContainerDeleteSafety/, `${name} must not require map-safety -- it never deletes a row`);
  }
});

// Every mutation route must still honor the base-level pending-delete and
// backed-up guards every other base mutation route already applies -- a
// base queued for deletion, or picked up into a backup and no longer
// claimed, must not be modifiable through this new surface either.
test("every new mutation route checks baseDeletePending and baseBackedUp", () => {
  for (const name of ALL_MUTATION_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /baseDeletePending\(baseId\)/, `${name} must check baseDeletePending`);
    assert.match(body, /await baseBackedUp\(baseId\)/, `${name} must check baseBackedUp`);
  }
});

// Ownership must be re-verified through the base+placeable pair on every
// give/fill route -- these must never accept a bare storage/inventory id
// from the caller the way the standalone Storage tab's routes do, since
// that shape has no base-ownership check at all.
test("give/fill routes resolve the storage id through base+placeable ownership, not a bare body field", () => {
  for (const name of GIVE_FILL_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /baseContainerOwnedStorageId\(baseId, placeableId\)/, `${name} must verify ownership via baseContainerOwnedStorageId`);
  }
});

// baseContainerOwnedStorageId itself must reject anything that is not a
// storage-group container -- this is what keeps Give/Fill off Refining and
// Crafting inventories when reached through the Bases surface, mirroring
// deleteBaseContainerItem's own group_key check.
test("baseContainerOwnedStorageId rejects non-storage-group containers", () => {
  const start = serverSource.indexOf("async function baseContainerOwnedStorageId(");
  assert.notEqual(start, -1, "baseContainerOwnedStorageId not found in server.js");
  const end = serverSource.indexOf("\n}\n", start);
  const body = serverSource.slice(start, end);
  assert.match(body, /slots\.group !== "storage"/);
  assert.match(body, /Crafting and Refining contents are read-only/);
});

// Every mutation route must be phrase-gated via directDbMutation -- an
// un-gated route here would let a single click, without confirmation,
// give/fill/delete-all a container's contents.
test("every new mutation route requires a confirmation phrase via directDbMutation", () => {
  const expectedPhrases = {
    baseContainerItemsDeleteRoute: "DELETE ITEMS",
    baseContainerAllItemsDeleteRoute: "DELETE ALL ITEMS",
    baseContainerGiveItemRoute: "GIVE ITEM TO STORAGE",
    baseContainerGiveItemsRoute: "GIVE ITEMS TO STORAGE",
    baseContainerFillItemRoute: "FILL ITEM TO STORAGE"
  };
  for (const [name, phrase] of Object.entries(expectedPhrases)) {
    const body = routeBody(name);
    assert.match(body, new RegExp(`directDbMutation\\(req, res, "[^"]+", "${phrase}"`), `${name} must require the phrase "${phrase}"`);
  }
});

// Path segments must be validated the same way every other base+container
// route already validates them (parseBaseContainerPath, shared with
// baseContainerItemDeleteRoute's own inline equivalent) -- an invalid id
// must 400 before any query runs, not fall through to a 500 later.
test("every new mutation route validates its path segments before mutating", () => {
  for (const name of ALL_MUTATION_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /parseBaseContainerPath\(path\)/, `${name} must validate its base/container path segments`);
    assert.match(body, /if \(!parsed\) return json\(res, 400,/, `${name} must reject an invalid path with 400`);
  }
});
