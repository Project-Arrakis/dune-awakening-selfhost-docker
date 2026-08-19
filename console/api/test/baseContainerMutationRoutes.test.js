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

// Every delete route must still check baseContainerDeleteSafety and refuse
// to mutate when it reports unsafe -- the same requirement
// deleteBaseContainerItem's own route already enforces
// (baseContainerItemDeleteRoute). baseContainerDeleteSafety itself no
// longer checks map liveness (removed 2026-08-19, see its own comment in
// server.js -- deletion does not require a stopped map, matching the
// standalone Storage tab's own delete route, which never required one); it
// still enforces the Storage-vs-Crafting/Refining group restriction, so
// this check remains real and load-bearing even though "map safety" is no
// longer part of what it verifies.
test("both new bulk-delete routes check baseContainerDeleteSafety before mutating", () => {
  for (const name of DELETE_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /await baseContainerDeleteSafety\(baseId\)/, `${name} must check deleteSafety`);
    assert.match(body, /if \(!safety\.safe\) throw new Error\(safety\.reason\)/, `${name} must refuse to mutate when unsafe`);
  }
});

// Give/Fill are pure inserts (no existing row is ever touched), so they
// have never required baseContainerDeleteSafety at all -- this distinction
// predates and is independent of the 2026-08-19 map-liveness-check removal
// above (see "Why Give/Fill do not require a stopped map" in
// docs/console/base-inventory.md), matching the same distinction
// fillItemToStorage/giveItemToStorage's existing standalone-Storage-tab
// routes already make.
test("give/fill routes do not require baseContainerDeleteSafety", () => {
  for (const name of GIVE_FILL_ROUTES) {
    const body = routeBody(name);
    assert.doesNotMatch(body, /baseContainerDeleteSafety/, `${name} must not require deleteSafety -- it never deletes a row`);
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

// Found during PR #349's own Layer 3 audit (Security hat): resolveCatalogItem/
// resolveItemVolume each do a synchronous readFileSync+JSON.parse of the
// full admin-items catalog per call -- validating the batch-size cap only
// inside giveMultipleItemsToStorage (after a .map() over the raw body had
// already resolved every item) let an oversized request force many seconds
// of synchronous, event-loop-blocking file I/O before ever being rejected.
// Fixed by checking body.items.length before any per-item processing, the
// same way the pre-existing giveItemsRoute (player give-items) already does
// two hundred lines away in this same file -- this test asserts the length
// check textually precedes the .map()/resolveCatalogItem call, not just
// that both exist somewhere in the function.
test("baseContainerGiveItemsRoute validates batch size before resolving any catalog item", () => {
  const body = routeBody("baseContainerGiveItemsRoute");
  const lengthCheckAt = body.search(/body\.items\.length/);
  const mapAt = body.search(/\.map\(/);
  // CORRECTED 2026-08-19 (issue #347 follow-up): this route now resolves
  // items through resolveFillableCatalogItem(), not resolveCatalogItem() --
  // Give/Give Multiple are restricted to raw_resource/refined_resource/
  // component only, matching Fill, after a real catalog item ("Robe of the
  // Sisterhood", clothing) showed up in the Give combobox. See
  // baseContainerGiveItemRoute's own comment for the full rationale.
  const resolveAt = body.search(/resolveFillableCatalogItem\(/);
  assert.notEqual(lengthCheckAt, -1, "must validate body.items.length");
  assert.notEqual(mapAt, -1, "must still map over items eventually");
  assert.notEqual(resolveAt, -1, "must still resolve each item's catalog entry");
  assert.ok(lengthCheckAt < mapAt, "length check must run before the per-item .map()");
  assert.ok(lengthCheckAt < resolveAt, "length check must run before any resolveFillableCatalogItem call");
  // Matches the existing 50-item cap giveMultipleItemsToStorage itself
  // enforces (duneDb.js) -- the route-level check exists to fail fast, not
  // to introduce a second, different limit.
  assert.match(body, /body\.items\.length < 1 \|\| body\.items\.length > 50/);
});
