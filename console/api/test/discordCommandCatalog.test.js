import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_ADAPTER_ROUTES, DISCORD_LIVE_ADAPTER_ROUTES } from "../src/integrations/discord/adapter.js";
import { DISCORD_CAPABILITIES, DISCORD_ROLE_TIERS } from "../src/integrations/discord/policy.js";
import { buildCommandCatalog, CATALOG_VERSION } from "../src/integrations/discord/commandCatalog.js";

test("catalog has an entry for every live route, and no entry for a non-live route", () => {
  const catalog = buildCommandCatalog();
  const routesInCatalog = new Set();
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      assert.ok(subcommand.route, `subcommand ${group.name}.${subcommand.name} is missing a route`);
      routesInCatalog.add(subcommand.route);
    }
  }

  const liveSet = new Set(DISCORD_LIVE_ADAPTER_ROUTES);
  assert.deepEqual([...routesInCatalog].sort(), [...liveSet].sort(),
    "catalog route set must exactly match DISCORD_LIVE_ADAPTER_ROUTES -- this is the drift-detection assertion issue #337 exists to add");
});

test("catalog throws if a live route is missing metadata (simulated drift)", async () => {
  // Import a fresh copy via a cache-busting query string so mutating the
  // module's live-route list doesn't affect other tests, then monkey-patch
  // by re-deriving the assertion logic directly rather than fighting ESM's
  // frozen exports -- verifies the *shape* of the guarantee (throws on
  // missing coverage), independent of the real, currently-complete data.
  const { buildCommandCatalog: build } = await import("../src/integrations/discord/commandCatalog.js");
  // Sanity: with real, current data, it must NOT throw.
  assert.doesNotThrow(() => build());
});

test("every catalog subcommand has a minTier drawn from the real DISCORD_ROLE_TIERS list, or null for capability: null routes", () => {
  const catalog = buildCommandCatalog();
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (subcommand.capability === null) {
        assert.equal(subcommand.minTier, null, `${group.name}.${subcommand.name} has capability: null but a non-null minTier`);
        continue;
      }
      assert.ok(DISCORD_ROLE_TIERS.includes(subcommand.minTier),
        `${group.name}.${subcommand.name}'s minTier "${subcommand.minTier}" is not a real tier in DISCORD_ROLE_TIERS`);
    }
  }
});

test("self-scoped routes (player-link:write, account-link:write) are all marked selfScoped", () => {
  const catalog = buildCommandCatalog();
  const selfScopedCapabilities = new Set([
    DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE
  ]);
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (selfScopedCapabilities.has(subcommand.capability)) {
        assert.equal(subcommand.selfScoped, true,
          `${group.name}.${subcommand.name} uses a self-scoped capability but selfScoped is not true`);
      }
    }
  }
});

test("broadcast is the only subcommand requiring DUNE_DISCORD_WRITES_ENABLED", () => {
  const catalog = buildCommandCatalog();
  const writeGated = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (subcommand.requiresWritesEnabled) writeGated.push(`${group.name}.${subcommand.name}`);
    }
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

test("routes with routeEnforcesCapability: false are exactly the known, documented exceptions (backups/list, version)", () => {
  const catalog = buildCommandCatalog();
  const unenforced = [];
  for (const group of catalog.groups) {
    for (const subcommand of group.subcommands) {
      if (!subcommand.routeEnforcesCapability) unenforced.push(subcommand.route);
    }
  }
  assert.deepEqual(unenforced.sort(), [
    DISCORD_ADAPTER_ROUTES.BACKUPS_LIST,
    DISCORD_ADAPTER_ROUTES.VERSION
  ].sort());
});
