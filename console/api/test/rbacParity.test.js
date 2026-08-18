// Dispatcher parity test — statically parses server.js's handleApi if/else
// chain and asserts that every route branch has an IAM action assignment
// in actions.js (ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD).
// A new route without an action fails this test.
//
// This is the load-bearing gate from §8.1 of the RBAC design doc.
// Updated 2026-08-07: now checks actions.js instead of rbac.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { actionForRoute, ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN } from "../src/actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, "../src/server.js"), "utf8");

// Extract all path+method combinations from the handleApi if/else chain.
// The function starts with "async function handleApi(req, res)" and uses
// flat if/else by path. We look for patterns like:
//   if (path === "/api/foo") return ...
//   if (path === "/api/foo" && req.method === "GET") return ...
function extractRoutes(source) {
  const routes = [];

  // find handleApi body — from "async function handleApi" to end of function
  const funcMatch = source.match(/async function handleApi\(req,\s*res\)\s*\{/);
  if (!funcMatch) return routes;
  const start = funcMatch.index + funcMatch[0].length;

  // Extract the function body by tracking brace depth
  let depth = 1;
  let end = start;
  for (let i = start; i < source.length && depth > 0; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) { end = i; break; }
  }
  const body = source.slice(start, end);

  // Match route patterns in the if/else chain
  // Pattern 1: if (path === "PATH") return ...
  // Pattern 2: if (path === "PATH" && req.method === "METHOD") return ...
  const pathMethodRegex = /path\s*===\s*"([^"]+)"\s*(?:&&\s*req\.method\s*===\s*"([^"]+)")?/g;
  let match;
  while ((match = pathMethodRegex.exec(body)) !== null) {
    const path = match[1];
    const method = match[2] || "*";
    routes.push({ path, method });
  }

  // Also match template literal paths: path === `/api/logs/${service}`
  const templateRegex = /path\s*===\s*`([^`]+)`/g;
  while ((match = templateRegex.exec(body)) !== null) {
    const path = match[1];
    // template literal with ${...} means regex pattern
    if (path.includes("${")) {
      // Extract base prefix before any ${}
      const prefix = path.split("${")[0] || "/api/";
      routes.push({ path: prefix.endsWith("/") ? prefix : prefix + "/", method: "*", isPrefix: true });
    } else {
      routes.push({ path, method: "*" });
    }
  }

  // Also match `path.startsWith("/api/...")` patterns
  const startsWithRegex = /path\.startsWith\("([^"]+)"\)/g;
  while ((match = startsWithRegex.exec(body)) !== null) {
    const prefix = match[1];
    routes.push({ path: prefix.endsWith("/") ? prefix : prefix + "/", method: "*", isPrefix: true });
  }

  // Also match `path.match(/regex/)` patterns (added per L1 audit finding
  // L1-H2 -- Architect hat found this extractor previously had NO branch
  // for regex-declared routes at all, meaning every regex-dispatched route
  // in server.js -- there are ~100 of them, e.g. /api/bases/{id},
  // /api/guilds/{id}/members -- was silently invisible to this parity
  // test's coverage check, not just the new IAM routes this design adds.
  // Each matched regex source is converted into one concrete, coverable
  // synthetic path by substituting every capture/character-class
  // placeholder ([^/]+, (...), .+) with a literal placeholder segment, so
  // isCovered() below can run it through the real actionForRoute()/regex
  // tables exactly as a live request path would be.
  const matchRegexRegex = /path\.match\(\/(.*?)\/\)\s*(?:&&\s*req\.method\s*===\s*"([^"]+)")?/g;
  while ((match = matchRegexRegex.exec(body)) !== null) {
    const regexSource = match[1];
    const method = match[2] || "*";
    const syntheticPath = regexSourceToSyntheticPath(regexSource);
    if (syntheticPath) routes.push({ path: syntheticPath, method });
  }

  return routes;
}

// Converts a server.js route regex's source (e.g.
// "^\/api\/bases\/[^/]+\/containers\/[^/]+$") into one concrete path this
// test can actually feed through actionForRoute()/the regex tables, by
// replacing every placeholder segment with the literal string "x" (an
// arbitrary value satisfying [^/]+, (...), or .+ -- what the placeholder
// actually contains does not matter for coverage-checking purposes, only
// that the resulting path has the right number/shape of segments to match
// against actionForRoute()'s own REGEX_ACTIONS_BY_METHOD_PATTERN table).
function regexSourceToSyntheticPath(regexSource) {
  let path = regexSource
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\]\+\)/g, "x")   // ([^/]+) -- captured
    .replace(/\[\^\/\]\+/g, "x")        // [^/]+ -- uncaptured
    .replace(/\.\+/g, "x");             // .+ -- catch-all (e.g. content/.+)
  if (path.includes("[") || path.includes("(") || path.includes("+")) return null; // unrecognized construct -- skip rather than guess
  return path;
}

const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];

function methodsToCheck(route) {
  if (route.method && route.method !== "*") return [route.method];
  return ALL_METHODS;
}

function isCovered(route) {
  // Discord adapter routes are handled separately, outside the IAM model
  const DISCORD_PREFIX = "/api/integrations/discord/";
  if (route.path.startsWith(DISCORD_PREFIX)) return true;

  // Public routes return null from actionForRoute — those are expected
  const PUBLIC_EXACT = ["/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/characters", "/api/auth/discord/start", "/api/auth/discord/callback", "/api/auth/discord/exchange"];
  if (PUBLIC_EXACT.includes(route.path)) return true;

  for (const method of methodsToCheck(route)) {
    // Check exact match first
    const action = actionForRoute(route.path, method);
    if (action) return true;

    // Check method-aware regex patterns
    for (const [key] of Object.entries(REGEX_ACTIONS_BY_METHOD)) {
      const [m, prefix] = key.split(" ", 2);
      if (method === m && route.path.startsWith(prefix)) return true;
    }

    // Check method-agnostic regex patterns
    for (const [prefix] of REGEX_ACTIONS) {
      if (route.path.startsWith(prefix)) return true;
    }
  }
  return false;
}

test("parity: every non-adapter route in handleApi has an IAM action", () => {
  const routes = extractRoutes(serverSrc);

  assert.ok(routes.length > 50, `Expected >50 routes, found ${routes.length}`);

  const uncovered = [];

  for (const route of routes) {
    if (!isCovered(route)) {
      uncovered.push(`${route.method} ${route.path}`);
    }
  }

  if (uncovered.length > 0) {
    const message = [
      `${uncovered.length} route(s) have no IAM action assignment:\n  ${uncovered.join('\n  ')}`,
      `\nactions.js ROUTE_ACTIONS must be updated when routes are added.`,
    ].join('\n');
    assert.fail(message);
  }
});

test("parity: all IAM actions reference known namespaces", () => {
  const validNamespaces = new Set([
    "setup", "server", "logs", "backups", "database", "updates", "settings",
    "players", "guilds", "bases", "maps", "sietches", "deepdesert", "admin",
    "landsraad", "addons", "carepackage", "storage", "blueprints", "vehicles",
    "exchange"
  ]);
  for (const action of Object.values(ROUTE_ACTIONS)) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in action: ${action}`);
  }
});

test("parity: all REGEX_ACTIONS entries reference known namespaces", () => {
  const validNamespaces = new Set([
    "setup", "server", "logs", "backups", "database", "updates", "settings",
    "players", "guilds", "bases", "maps", "sietches", "deepdesert", "admin",
    "landsraad", "addons", "carepackage", "storage", "blueprints", "vehicles",
    "exchange"
  ]);
  for (const [, action] of REGEX_ACTIONS) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in regex action: ${action}`);
  }
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in method action: ${action}`);
  }
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in pattern action: ${action}`);
  }
});

test("parity: DELETE /api/bases/{baseId} resolves to bases:delete, distinct from other bases DELETE routes", () => {
  assert.equal(actionForRoute("/api/bases/12858", "DELETE"), "bases:delete");
  // Sibling sub-resource DELETEs must stay in the shared, reversible bucket
  // -- only the base delete itself gets its own action.
  assert.equal(actionForRoute("/api/bases/12858/queued-delete", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/12858/queued-refill", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/12858/queued-water-refill", "DELETE"), "bases:mutate");
});
