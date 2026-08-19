import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCORD_ADAPTER_ROUTES, DISCORD_LIVE_ADAPTER_ROUTES } from "../src/integrations/discord/adapter.js";
import { DISCORD_ROLE_TIERS } from "../src/integrations/discord/policy.js";
import { buildCommandCatalog, CATALOG_VERSION, COMMAND_METADATA } from "../src/integrations/discord/commandCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(join(__dirname, "../src/integrations/discord/routes.js"), "utf8");

// Flattens the fan-out catalog shape (subcommand.routes[]) into one entry
// per real backing route, for tests that only care about per-route
// properties (capability, params, etc.) and don't need the grouping shape
// itself. Kept local to this test file rather than exported from
// commandCatalog.js -- production code (routes.js) has no need to flatten,
// only tests do.
function flattenRoutes(catalog) {
  const flat = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      for (const route of subcommand.routes) {
        flat.push({ group: group.name, name: subcommand.name, ...route });
      }
    }
  }
  return flat;
}

test("catalog has an entry for every live route, and no entry for a non-live route", () => {
  const catalog = buildCommandCatalog();
  const routesInCatalog = new Set();
  for (const entry of flattenRoutes(catalog)) {
    assert.ok(entry.route, `subcommand ${entry.group}.${entry.name} has a route entry missing its own route`);
    routesInCatalog.add(entry.route);
  }

  const liveSet = new Set(DISCORD_LIVE_ADAPTER_ROUTES);
  assert.deepEqual([...routesInCatalog].sort(), [...liveSet].sort(),
    "catalog route set must exactly match DISCORD_LIVE_ADAPTER_ROUTES -- this is the drift-detection assertion this file exists to add");
});

test("catalog throws when a live route is genuinely missing metadata (real simulated drift)", () => {
  // Genuinely reproduces the drift scenario: a route that IS in the live
  // list but has NO corresponding metadata entry. buildCommandCatalog()'s
  // optional liveRoutes/metadata parameters exist specifically so this test
  // can inject a deliberately mismatched pair without touching the real,
  // frozen production data -- see buildCommandCatalog()'s own comment.
  const fakeLiveRoutes = [DISCORD_ADAPTER_ROUTES.HEALTH, "/api/integrations/discord/not-a-real-route"];
  const fakeMetadata = {
    [DISCORD_ADAPTER_ROUTES.HEALTH]: { group: "server", subcommand: "health", description: "x", capability: null, params: [] }
    // deliberately no entry for "/api/integrations/discord/not-a-real-route"
  };
  assert.throws(
    () => buildCommandCatalog(fakeLiveRoutes, fakeMetadata),
    /1 live route\(s\) missing catalog metadata: \/api\/integrations\/discord\/not-a-real-route/
  );
});

test("catalog throws when a metadata entry references a route no longer live (real simulated staleness)", () => {
  // The inverse drift scenario: a route was retired from the live list but
  // its metadata entry was left behind. Also genuinely reproduced, not
  // just asserted by reading the code.
  const fakeLiveRoutes = [DISCORD_ADAPTER_ROUTES.HEALTH];
  const fakeMetadata = {
    [DISCORD_ADAPTER_ROUTES.HEALTH]: { group: "server", subcommand: "health", description: "x", capability: null, params: [] },
    "/api/integrations/discord/retired-route": { group: "server", subcommand: "retired", description: "x", capability: null, params: [] }
  };
  assert.throws(
    () => buildCommandCatalog(fakeLiveRoutes, fakeMetadata),
    /1 catalog entry\(ies\) reference route\(s\) no longer in DISCORD_LIVE_ADAPTER_ROUTES: \/api\/integrations\/discord\/retired-route/
  );
});

test("catalog does not throw with the real, current, consistent production data", () => {
  assert.doesNotThrow(() => buildCommandCatalog());
});

test("production catalog is memoized -- repeated zero-argument calls return the identical cached object", () => {
  const first = buildCommandCatalog();
  const second = buildCommandCatalog();
  assert.strictEqual(first, second, "two zero-argument calls should return the same cached object, not recompute");
});

test("injected test data is never cached across calls, even with the same shape as production", () => {
  const fakeLiveRoutes = [DISCORD_ADAPTER_ROUTES.HEALTH];
  const fakeMetadata = { [DISCORD_ADAPTER_ROUTES.HEALTH]: { group: "server", subcommand: "health", description: "x", capability: null, params: [] } };
  const first = buildCommandCatalog(fakeLiveRoutes, fakeMetadata);
  const second = buildCommandCatalog(fakeLiveRoutes, fakeMetadata);
  assert.notStrictEqual(first, second, "injected-data calls must recompute every time, never share the production cache or each other's result");
  // Also confirms the production cache itself is unaffected by injected calls.
  const prod = buildCommandCatalog();
  assert.ok(prod.groups.length > 1, "production catalog must still have its real, full group set, not the 1-route fake data");
});

test("every catalog route entry has a minTier drawn from the real DISCORD_ROLE_TIERS list, or null for capability: null routes", () => {
  const catalog = buildCommandCatalog();
  for (const entry of flattenRoutes(catalog)) {
    if (entry.capability === null) {
      assert.equal(entry.minTier, null, `${entry.group}.${entry.name} (${entry.route}) has capability: null but a non-null minTier`);
      continue;
    }
    assert.ok(DISCORD_ROLE_TIERS.includes(entry.minTier),
      `${entry.group}.${entry.name} (${entry.route})'s minTier "${entry.minTier}" is not a real tier in DISCORD_ROLE_TIERS`);
  }
});

test("every catalog route entry's route is a real member of DISCORD_ADAPTER_ROUTES (no typo'd/invented route strings)", () => {
  const catalog = buildCommandCatalog();
  const realRoutes = new Set(Object.values(DISCORD_ADAPTER_ROUTES));
  for (const entry of flattenRoutes(catalog)) {
    assert.ok(realRoutes.has(entry.route),
      `${entry.group}.${entry.name}'s route "${entry.route}" is not a real DISCORD_ADAPTER_ROUTES value`);
  }
});

test("broadcast is the only route entry requiring DUNE_DISCORD_WRITES_ENABLED", () => {
  const catalog = buildCommandCatalog();
  const writeGated = [];
  for (const entry of flattenRoutes(catalog)) {
    if (entry.requiresWritesEnabled) writeGated.push(`${entry.group}.${entry.name}`);
  }
  assert.deepEqual(writeGated, ["admin.broadcast"]);
});

test("catalog version matches the exported CATALOG_VERSION constant", () => {
  const catalog = buildCommandCatalog();
  assert.equal(catalog.version, CATALOG_VERSION);
  assert.equal(typeof CATALOG_VERSION, "number");
});

test("DISCORD_ADAPTER_ROUTES.CATALOG is not itself in DISCORD_LIVE_ADAPTER_ROUTES (metadata about routes, not a data route)", () => {
  assert.ok(!DISCORD_LIVE_ADAPTER_ROUTES.includes(DISCORD_ADAPTER_ROUTES.CATALOG));
});

test("route entries with routeEnforcesCapability: false are exactly the known, documented exceptions (health, backups/list, version)", () => {
  const catalog = buildCommandCatalog();
  const unenforced = [];
  for (const entry of flattenRoutes(catalog)) {
    if (!entry.routeEnforcesCapability) unenforced.push(entry.route);
  }
  // HEALTH added by an L3 integration audit (issue tracked in PR #171) --
  // discordAdapterHealth() never calls requireDiscordCapability(), so it
  // was already unenforced in practice; this entry's routeEnforcesCapability
  // had incorrectly defaulted to true because no explicit override was set.
  assert.deepEqual(unenforced.sort(), [
    DISCORD_ADAPTER_ROUTES.HEALTH,
    DISCORD_ADAPTER_ROUTES.BACKUPS_LIST,
    DISCORD_ADAPTER_ROUTES.VERSION
  ].sort());
});

// Found by an independent Layer 2 re-audit of this same catalog on the
// author's fork (yacketrj/dune-awakening-selfhost-docker#342): one entry's
// description was accidentally copy-pasted verbatim from an unrelated
// route describing a similarly-named but functionally different command.
// A future editor of COMMAND_METADATA copy-pasting an entry as a starting
// point and forgetting to update its description text would reproduce this
// silently -- this test catches that class of mistake generically, not
// just the one specific instance that was found.
test("no two catalog route entries share a verbatim-identical description (would indicate an accidentally copy-pasted/borrowed description)", () => {
  const catalog = buildCommandCatalog();
  const descriptions = flattenRoutes(catalog).map((entry) => entry.description);
  const uniqueDescriptions = new Set(descriptions);
  assert.equal(uniqueDescriptions.size, descriptions.length,
    "two catalog entries share an identical description -- verify neither was accidentally copy-pasted from an unrelated route");
});

// --- Findings from upstream PR #171's review (Red-Blink), 2026-08-18 ---

// Finding 1: the player group had 3 duplicate (group, subcommand) pairs
// (inventory, storage, find), each silently colliding two backing routes
// with different capabilities into what looked like one flat entry. Fixed
// by grouping route entries under their shared (group, subcommand) pair
// into a routes[] array instead of one array element per route -- this
// test asserts that grouping is exhaustive: no (group, subcommand) pair is
// ever represented by more than one top-level subcommand object.
test("no (group, subcommand) pair appears as more than one top-level subcommand entry", () => {
  const catalog = buildCommandCatalog();
  const seen = new Map();
  const duplicates = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      const key = `${group.name}.${subcommand.name}`;
      if (seen.has(key)) {
        duplicates.push({ key, first: seen.get(key), second: subcommand.routes.map((r) => r.route) });
      } else {
        seen.set(key, subcommand.routes.map((r) => r.route));
      }
    }
  }
  assert.deepEqual(duplicates, [],
    "a (group, subcommand) pair was split across two separate top-level subcommand entries instead of being merged into one subcommand.routes[] array");
});

// The inverse of the above: a genuine fan-out (two routes sharing one
// (group, subcommand) pair) must still produce exactly the 3 documented
// pairs, not more or fewer -- catches both a regression (a 4th route
// accidentally merged into an existing pair) and someone "fixing" the fan
// out by incorrectly re-splitting it back into duplicates.
test("exactly the 3 documented (group, subcommand) pairs fan out to more than one route", () => {
  const catalog = buildCommandCatalog();
  const fannedOut = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (subcommand.routes.length > 1) fannedOut.push(`${group.name}.${subcommand.name}`);
    }
  }
  assert.deepEqual(fannedOut.sort(), ["player.find", "player.inventory", "player.storage"]);
});

// Finding 2 (part A): declared param names must match the real body field
// routes.js actually reads for that route, via each param's `bodyField`
// (defaulting to the param's own `name` when not overridden). Cross-checks
// against a mechanical extraction of routes.js's real body.<field> reads
// per route -- not a hardcoded re-assertion of the same mapping a second
// time, which would only catch a typo in this test, not a real drift
// between the two files.
//
// Known, documented scope limit: only catches literal `body.<field>` read
// expressions. A future refactor of a route handler to destructure the
// body (`const { characterName } = body`) would need this regex extended,
// and would silently stop being checked here until someone notices --
// this is a real limitation of a source-text-regex approach (the same
// approach rbacParity.test.js already uses elsewhere in this suite), not
// something this test can detect about itself.
//
// Also does not cover the opsRoutes lookup-table dispatch (OPS_ACTIVITY,
// OPS_COMBAT, etc.), which doesn't use the `path === DISCORD_ADAPTER_ROUTES.X`
// literal pattern this extraction looks for. Safe today because none of
// those routes declare any params in COMMAND_METADATA (verified below) --
// flagged explicitly so a future ops-route param addition doesn't silently
// go unchecked.
// True if the character at routesSrc[index] is a JS identifier character
// ([A-Za-z0-9_]) -- used below to reject a marker match that's actually a
// PREFIX of a longer route constant name (e.g. "PLAYERS_LINK" is a true
// string prefix of "PLAYERS_LINK_VERIFY"; a bare indexOf() without this
// boundary check would silently match the wrong route's block if file
// order ever put the longer name's block first -- found during this fix's
// own Layer 2 QA audit, verified with a live repro before being fixed
// here, not a hypothetical concern).
function isIdentifierChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function extractBodyFieldsForRoute(routeConstantName) {
  // Find the specific `if (path === DISCORD_ADAPTER_ROUTES.<NAME>` marker
  // via a plain, fixed-string search (not a dynamically-built RegExp --
  // routeConstantName always comes from this file's own
  // Object.entries(DISCORD_ADAPTER_ROUTES) iteration, never external input,
  // but a hardcoded-pattern-only approach sidesteps the ReDoS-shaped-code
  // flag entirely rather than relying on that always being true), then walk
  // forward to the block's opening `{` and track brace depth to the
  // matching closing `}` -- mirroring rbacParity.test.js's own technique
  // for extracting handleApi's body, just scoped per-route-block here
  // instead of per-function.
  //
  // Scans ALL occurrences of the base marker, not just the first, and
  // requires the character immediately following routeConstantName to NOT
  // be an identifier character -- otherwise a marker for "PLAYERS_LINK"
  // would also match inside "PLAYERS_LINK_VERIFY"'s own marker text,
  // silently extracting the wrong route's body-field block if the two
  // constants were ever declared/dispatched in a different order than
  // today's file happens to have them in.
  const marker = `if (path === DISCORD_ADAPTER_ROUTES.${routeConstantName}`;
  let markerIndex = -1;
  let searchFrom = 0;
  while (searchFrom <= routesSrc.length) {
    const candidate = routesSrc.indexOf(marker, searchFrom);
    if (candidate === -1) break;
    const nextChar = routesSrc[candidate + marker.length];
    if (!isIdentifierChar(nextChar)) { markerIndex = candidate; break; }
    searchFrom = candidate + marker.length; // skip this false-prefix match, keep scanning
  }
  if (markerIndex === -1) return null;
  const braceStart = routesSrc.indexOf("{", markerIndex);
  if (braceStart === -1) return null;
  let depth = 1;
  let end = braceStart + 1;
  for (let i = braceStart + 1; i < routesSrc.length && depth > 0; i++) {
    const ch = routesSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) { end = i; break; }
  }
  const block = routesSrc.slice(braceStart, end);
  const fields = new Set();
  const fieldRegex = /body\.([A-Za-z0-9_]+)/g;
  let match;
  while ((match = fieldRegex.exec(block)) !== null) fields.add(match[1]);
  return fields;
}

test("every param's real body field (bodyField, or its own name when unset) is actually read by routes.js's real handler for that route", () => {
  const routeConstantByPath = Object.fromEntries(
    Object.entries(DISCORD_ADAPTER_ROUTES).map(([constName, path]) => [path, constName])
  );
  const checked = [];
  for (const [route, meta] of Object.entries(COMMAND_METADATA)) {
    if (!meta.params || meta.params.length === 0) continue;
    const constName = routeConstantByPath[route];
    const realFields = extractBodyFieldsForRoute(constName);
    if (realFields === null) {
      // Route doesn't use the literal `path === DISCORD_ADAPTER_ROUTES.X`
      // dispatch pattern (e.g. the opsRoutes lookup table) -- out of scope
      // for this extraction technique. Assert it has no params today, so a
      // future param addition to one of these routes fails loudly instead
      // of silently skipping this check forever.
      assert.equal(meta.params.length, 0,
        `${route} has params but is not dispatched via the literal "path === DISCORD_ADAPTER_ROUTES.X" pattern this test's extraction depends on -- extend extractBodyFieldsForRoute() or the opsRoutes-specific dispatch before adding params here`);
      continue;
    }
    for (const param of meta.params) {
      const expectedField = param.bodyField || param.name;
      assert.ok(realFields.has(expectedField),
        `${route}'s param "${param.name}" expects routes.js to read body.${expectedField}, but the real handler for this route only reads: ${[...realFields].join(", ") || "(nothing)"}`);
      checked.push(`${route}.${param.name}`);
    }
  }
  assert.ok(checked.length > 0, "this test found zero params to check -- COMMAND_METADATA may have changed shape");
});

// Finding 2 (part B): every param's OUTPUT bodyField (post-buildCommandCatalog(),
// after the default-to-name fallback is applied) must also be a real field,
// covering the case where a future param is added with no explicit
// bodyField and no matching real body field either -- the case above
// checks COMMAND_METADATA directly; this one checks the real catalog
// output a consumer would actually receive.
test("every catalog route entry's params[].bodyField is present on the output (never silently undefined)", () => {
  const catalog = buildCommandCatalog();
  for (const entry of flattenRoutes(catalog)) {
    for (const param of entry.params) {
      assert.ok(typeof param.bodyField === "string" && param.bodyField.length > 0,
        `${entry.group}.${entry.name}'s param "${param.name}" has no resolved bodyField in the catalog output`);
    }
  }
});

// Finding 3: a metadata field defined on a COMMAND_METADATA entry
// (diagnosticCapability on STATUS was the real, found case) must never be
// silently dropped from buildCommandCatalog()'s real output. Generalized
// so it protects ANY future metadata field, not just this one field name --
// iterates the real, live COMMAND_METADATA object's own keys per entry
// rather than a hardcoded field-name list, so a newly-added field is
// automatically covered without a test edit.
//
// Deliberately checks the catalog's real JSON-serialized output (the wire
// shape routes.js actually sends), not the bare in-memory return value --
// routes.js does `json(res, 200, { ..., catalog: buildCommandCatalog() })`,
// and JSON.stringify silently drops undefined-valued keys, which is
// correct behavior for a field genuinely left undefined but would mask a
// real drop if this test only inspected the in-memory object.
const RENAMED_METADATA_FIELDS = new Set(["group", "subcommand"]);

test("every non-renamed COMMAND_METADATA field for a route reaches that route's real catalog JSON output, unchanged", () => {
  const wireJson = JSON.parse(JSON.stringify(buildCommandCatalog()));
  const outputByRoute = new Map();
  for (const group of wireJson.groups) {
    for (const subcommand of group.subcommands) {
      for (const routeEntry of subcommand.routes) {
        outputByRoute.set(routeEntry.route, routeEntry);
      }
    }
  }

  let fieldsChecked = 0;
  for (const [route, meta] of Object.entries(COMMAND_METADATA)) {
    const outputEntry = outputByRoute.get(route);
    assert.ok(outputEntry, `no output route entry found for live route ${route}`);
    for (const key of Object.keys(meta)) {
      if (RENAMED_METADATA_FIELDS.has(key)) continue;
      if (meta[key] === undefined) continue; // JSON correctly drops undefined -- not a bug to check for
      // params/requiresWritesEnabled/routeEnforcesCapability/method are
      // deliberately transformed (defaulted/coerced/normalized) between
      // metadata and output, not passed through byte-for-byte -- checked
      // by their own dedicated tests elsewhere in this file/routes.js's
      // coverage, not here.
      if (["params", "requiresWritesEnabled", "routeEnforcesCapability", "method"].includes(key)) continue;
      assert.ok(key in outputEntry,
        `COMMAND_METADATA field "${key}" on route ${route} was silently dropped from the catalog's real JSON output`);
      assert.deepEqual(outputEntry[key], meta[key],
        `COMMAND_METADATA field "${key}" on route ${route} reached the catalog output with a different value than declared`);
      fieldsChecked++;
    }
  }
  assert.ok(fieldsChecked > 0, "this test found zero fields to check -- COMMAND_METADATA may have changed shape");
});

test("STATUS's diagnosticCapability specifically reaches the real catalog output (the exact field upstream PR #171 found silently dropped)", () => {
  const catalog = buildCommandCatalog();
  const statusEntry = flattenRoutes(catalog).find((entry) => entry.route === DISCORD_ADAPTER_ROUTES.STATUS);
  assert.ok(statusEntry, "STATUS route entry not found in catalog");
  assert.equal(statusEntry.diagnosticCapability, COMMAND_METADATA[DISCORD_ADAPTER_ROUTES.STATUS].diagnosticCapability);
  assert.equal(statusEntry.diagnosticMinTier, "admin",
    "the catalog must expose the conditional capability's effective tier so consumers do not need a private copy of Core's policy table");
});

test("every fanned-out route entry (routes.length > 1) has a selector, and exactly one route per pair has selector: null (the default)", () => {
  const catalog = buildCommandCatalog();
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (subcommand.routes.length <= 1) continue;
      const defaults = subcommand.routes.filter((r) => r.selector === null);
      assert.equal(defaults.length, 1,
        `${group.name}.${subcommand.name} has ${subcommand.routes.length} fanned-out routes but ${defaults.length} default (selector: null) routes -- expected exactly 1`);
      for (const route of subcommand.routes) {
        if (route.selector === null) continue;
        assert.ok(route.selector && typeof route.selector === "object" && "param" in route.selector,
          `${group.name}.${subcommand.name}'s non-default route ${route.route} has an invalid selector shape`);
      }
    }
  }
});
