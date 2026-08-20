import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCORD_ADAPTER_ROUTES, DISCORD_LIVE_ADAPTER_ROUTES } from "../src/integrations/discord/adapter.js";
import { DISCORD_CAPABILITIES, DISCORD_ROLE_TIERS } from "../src/integrations/discord/policy.js";
import { buildCommandCatalog, CATALOG_VERSION, COMMAND_METADATA } from "../src/integrations/discord/commandCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(join(__dirname, "../src/integrations/discord/routes.js"), "utf8");

// Flattens the fan-out catalog shape (subcommand.routes[]) into one entry
// per real backing route, for tests that only care about per-route
// properties (capability, params, etc.) and don't need the grouping shape
// itself.
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
    "catalog route set must exactly match DISCORD_LIVE_ADAPTER_ROUTES -- this is the drift-detection assertion issue #337 exists to add");
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

test("self-scoped routes (player-link:write, account-link:write) are all marked selfScoped", () => {
  const catalog = buildCommandCatalog();
  const selfScopedCapabilities = new Set([
    DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE
  ]);
  for (const entry of flattenRoutes(catalog)) {
    if (selfScopedCapabilities.has(entry.capability)) {
      assert.equal(entry.selfScoped, true,
        `${entry.group}.${entry.name} (${entry.route}) uses a self-scoped capability but selfScoped is not true`);
    }
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
  // HEALTH added per issue #360, porting the same L3-audit finding already
  // fixed on the upstream PR #171 branch (issue #358) -- main's
  // discordAdapterHealth() never calls requireDiscordCapability() either.
  assert.deepEqual(unenforced.sort(), [
    DISCORD_ADAPTER_ROUTES.HEALTH,
    DISCORD_ADAPTER_ROUTES.BACKUPS_LIST,
    DISCORD_ADAPTER_ROUTES.VERSION
  ].sort());
});

// Issue #342: an independent re-audit of #337/PR #341 found 3 catalog
// entries describing Core routes that are genuinely live but have no
// current bot-side caller in arrakis-control-panel, one of which
// (PLAYERS_ACCOUNTS_SET_DEFAULT) had a description verbatim-borrowed from
// the bot's real, but entirely different and separately-routed, "/dune
// player default" command. This test locks the routeHasNoCurrentBotCaller
// flag to exactly the known set so a future addition/removal must be a
// deliberate, reviewed change to this test, not a silent catalog edit.
test("routes with routeHasNoCurrentBotCaller: true are exactly the known, documented exceptions (#342)", () => {
  const catalog = buildCommandCatalog();
  const unwired = [];
  for (const entry of flattenRoutes(catalog)) {
    if (entry.routeHasNoCurrentBotCaller) unwired.push(entry.route);
  }
  assert.deepEqual(unwired.sort(), [
    DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK,
    DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY,
    DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_SET_DEFAULT
  ].sort());
});

test("no two catalog route entries share a verbatim-identical description (would indicate an accidentally copy-pasted/borrowed description)", () => {
  const catalog = buildCommandCatalog();
  const descriptions = flattenRoutes(catalog).map((entry) => entry.description);
  const uniqueDescriptions = new Set(descriptions);
  assert.equal(uniqueDescriptions.size, descriptions.length,
    "two catalog entries share an identical description -- verify neither was accidentally copy-pasted from an unrelated route (see issue #342)");
});

// --- Findings from issue #360 (porting upstream PR #171's fixes to main,
// which has 3 additional multi-account-specific duplicate pairs beyond
// what that upstream branch has) ---

// Finding 1: 6 duplicate (group, subcommand) pairs existed before this
// fix -- 3 shared with the upstream PR #171 branch (storage/find/inventory,
// genuine live fan-outs) plus 3 specific to this fork's multi-account
// routes (link/verify/unlink). Of those 3, only "unlink" is a genuine live
// fan-out (verified against arrakis-control-panel's real commands.js:
// "/dune player unlink <character>" calls PLAYERS_ACCOUNTS_UNLINK when a
// playerControllerId is given, else PLAYERS_UNLINK) -- "link"/"verify"
// collided with PLAYERS_ACCOUNTS_LINK/LINK_VERIFY, which have NO live bot
// caller at all (confirmed via routeHasNoCurrentBotCaller, unchanged from
// #342), so those two were renamed (link-account/verify-account) rather
// than fanned out, since there is no real single subcommand picking
// between them and their single-account counterpart.
// NOTE on this test's real detection scope (found during issue #360's own
// Layer 2 QA audit): buildCommandCatalog()'s grouping is Map-keyed by
// (group, subcommand), so two metadata entries sharing a key are ALWAYS
// merged into one subcommand.routes[] array by construction -- they can
// never produce two separate top-level entries with the same key. This
// test therefore cannot, by itself, catch "route X and route Y should not
// have been merged" (that's what the dedicated fan-out-count test below,
// and the PLAYERS_ACCOUNTS_LINK-specific rename test, are for) -- it only
// guards the grouping invariant itself (no key ever appears twice at the
// top level), which would only break if a future refactor of the Map
// construction logic itself regressed. Kept as a structural invariant
// check, not a stand-alone regression catch for the #360 rename/fan-out
// design decisions.
test("no (group, subcommand) pair appears as more than one top-level subcommand entry (structural invariant of the Map-based grouping)", () => {
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
    "a (group, subcommand) pair was split across two separate top-level subcommand entries instead of being merged into one subcommand.routes[] array (or given a distinct name, for the two dead multi-account routes with no genuine fan-out behind them)");
});

test("exactly the 4 documented (group, subcommand) pairs fan out to more than one route", () => {
  const catalog = buildCommandCatalog();
  const fannedOut = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (subcommand.routes.length > 1) fannedOut.push(`${group.name}.${subcommand.name}`);
    }
  }
  assert.deepEqual(fannedOut.sort(), ["player.find", "player.inventory", "player.storage", "player.unlink"]);
});

test("PLAYERS_ACCOUNTS_LINK and PLAYERS_ACCOUNTS_LINK_VERIFY (no live bot caller) were renamed, not fanned out, and don't collide with their single-account counterparts", () => {
  const catalog = buildCommandCatalog();
  // Find each route's OWNING subcommand (not just the flattened route
  // entry) so we can check the real routes[] array length on the
  // subcommand itself, not the per-route flattened object (which has no
  // `routes` property of its own).
  function findSubcommandForRoute(route) {
    for (const group of catalog.groups) {
      for (const subcommand of group.subcommands) {
        if (subcommand.routes.some((r) => r.route === route)) return subcommand;
      }
    }
    return null;
  }
  const linkAccountSub = findSubcommandForRoute(DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK);
  const verifyAccountSub = findSubcommandForRoute(DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY);
  assert.ok(linkAccountSub, "PLAYERS_ACCOUNTS_LINK missing from catalog");
  assert.ok(verifyAccountSub, "PLAYERS_ACCOUNTS_LINK_VERIFY missing from catalog");
  assert.notEqual(linkAccountSub.name, "link", "PLAYERS_ACCOUNTS_LINK must not reuse the live 'link' subcommand name");
  assert.notEqual(verifyAccountSub.name, "verify", "PLAYERS_ACCOUNTS_LINK_VERIFY must not reuse the live 'verify' subcommand name");
  assert.equal(linkAccountSub.routes.length, 1, "PLAYERS_ACCOUNTS_LINK has no genuine fan-out partner");
  assert.equal(verifyAccountSub.routes.length, 1, "PLAYERS_ACCOUNTS_LINK_VERIFY has no genuine fan-out partner");
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
// and would silently stop being checked here until someone notices.
//
// Also does not cover the opsRoutes lookup-table dispatch (OPS_ACTIVITY,
// OPS_COMBAT, etc.), which doesn't use the `path === DISCORD_ADAPTER_ROUTES.X`
// literal pattern this extraction looks for. Safe today because none of
// those routes declare any params in COMMAND_METADATA (verified below).
function isIdentifierChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function extractBodyFieldsForRoute(routeConstantName) {
  // Find the specific `if (path === DISCORD_ADAPTER_ROUTES.<NAME>` marker
  // via a plain, fixed-string search (not a dynamically-built RegExp --
  // avoids a real, blocking semgrep ReDoS-shaped-code finding found and
  // fixed on the upstream PR #171 branch's version of this test), then
  // walk forward to the block's opening `{` and track brace depth to the
  // matching closing `}`. Scans ALL occurrences of the base marker, not
  // just the first, and requires the character immediately following
  // routeConstantName to NOT be an identifier character -- otherwise a
  // marker for "PLAYERS_LINK" would also match inside
  // "PLAYERS_LINK_VERIFY"'s own marker text (a real bug found and fixed
  // during issue #358's own Layer 2 audit, ported here rather than
  // reintroduced).
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
// (diagnosticCapability on STATUS, and disabledPendingSecurityReview on
// PLAYERS_ACCOUNTS_LINK_STEAM -- the latter specific to this fork's
// superset, doesn't exist at all on the upstream PR #171 branch) must
// never be silently dropped from buildCommandCatalog()'s real output.
// Generalized so it protects ANY future metadata field, not just these
// two -- iterates the real, live COMMAND_METADATA object's own keys per
// entry rather than a hardcoded field-name list.
const RENAMED_METADATA_FIELDS = new Set(["group", "subcommand"]);

test("every non-renamed/non-transformed COMMAND_METADATA field for a route reaches that route's real catalog JSON output, unchanged", () => {
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
      // params/selfScoped/requiresWritesEnabled/routeEnforcesCapability/
      // routeHasNoCurrentBotCaller/method are deliberately transformed
      // (defaulted/coerced/normalized) between metadata and output, not
      // passed through byte-for-byte -- checked by their own dedicated
      // tests elsewhere in this file, not here.
      if (["params", "selfScoped", "requiresWritesEnabled", "routeEnforcesCapability", "routeHasNoCurrentBotCaller", "method"].includes(key)) continue;
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
});

// Issue #370: STATUS's diagnosticCapability implies a second capability
// the primary minTier computation doesn't cover -- a bot has no other way
// to know what tier "logs:read" requires without private knowledge of
// Core's policy table. Ports Red-Blink's post-merge fix on the upstream
// PR #171 branch (commit 144aa84d) to main's copy of this function.
test("STATUS's diagnosticMinTier is derived from diagnosticCapability, so consumers don't need a private copy of Core's policy table", () => {
  const catalog = buildCommandCatalog();
  const statusEntry = flattenRoutes(catalog).find((entry) => entry.route === DISCORD_ADAPTER_ROUTES.STATUS);
  assert.ok(statusEntry, "STATUS route entry not found in catalog");
  assert.equal(statusEntry.diagnosticMinTier, "admin",
    "the catalog must expose the conditional capability's effective tier so consumers do not need a private copy of Core's policy table");
});

test("PLAYERS_ACCOUNTS_LINK_STEAM's disabledPendingSecurityReview specifically reaches the real catalog output (main-only field, doesn't exist on the upstream PR #171 branch)", () => {
  const catalog = buildCommandCatalog();
  const linkSteamEntry = flattenRoutes(catalog).find((entry) => entry.route === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_STEAM);
  assert.ok(linkSteamEntry, "PLAYERS_ACCOUNTS_LINK_STEAM route entry not found in catalog");
  assert.equal(linkSteamEntry.disabledPendingSecurityReview, true);
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
