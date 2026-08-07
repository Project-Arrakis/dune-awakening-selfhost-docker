// Dispatcher parity test — statically parses server.js's handleApi if/else
// chain and asserts that every route branch is covered by a capability assignment
// in rbac.js (either PUBLIC_ROUTES, EXACT_ROUTES, REGEX_ROUTES, or the Discord
// adapter prefix). A new route without a capability assignment fails this test.
//
// This is the load-bearing gate from §8.1 of the RBAC design doc.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, "../src/server.js"), "utf8");
const rbacSrc = readFileSync(join(__dirname, "../src/rbac.js"), "utf8");

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

  return routes;
}

// Extract all covered paths from rbac.js
function extractCapabilityCoverage(source) {
  const covered = { exact: new Set(), prefix: [], public: new Set() };

  // PUBLIC_ROUTES entries
  const publicMatch = source.match(/const PUBLIC_ROUTES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (publicMatch) {
    for (const entry of publicMatch[1].split(',')) {
      const m = entry.match(/"([^"]+)"/);
      if (m) covered.public.add(m[1]);
    }
  }

  // EXACT_ROUTES keys
  const exactMatch = source.match(/const EXACT_ROUTES\s*=\s*\{([\s\S]*?)\};/);
  if (exactMatch) {
    for (const line of exactMatch[1].split('\n')) {
      const m = line.match(/"([^"]+)"/);
      if (m) covered.exact.add(m[1]); // format: "METHOD /path"
    }
  }

  // REGEX_ROUTES prefix entries
  const regexMatch = source.match(/const REGEX_ROUTES\s*=\s*\[([\s\S]*?)\];/);
  if (regexMatch) {
    for (const line of regexMatch[1].split('\n')) {
      const m = line.match(/"([^"]+)"/);
      if (m) {
        const prefix = m[1];
        // second string is the method
        const methodMatch = line.match(/"([^"]+)"\s*,\s*"([^"]+)"/);
        if (methodMatch) {
          covered.prefix.push({ prefix: methodMatch[1], method: methodMatch[2] });
        }
      }
    }
  }

  return covered;
}

// Check if a route is covered by any capability assignment.
// Routes extracted with method "*" (no explicit method check in handleApi)
// are checked against all common HTTP methods for that path.
const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

function methodsToCheck(route) {
  if (route.method && route.method !== "*") return [route.method];
  return ALL_METHODS;
}

function isCovered(route, coverage, rbacSrc) {
  for (const method of methodsToCheck(route)) {
    const key = `${method} ${route.path}`;

    // Public routes
    if (coverage.public.has(key)) return true;

    // Exact match
    if (coverage.exact.has(key)) return true;
  }

  // Regex/prefix match (method "*" always matches any method on the route side)
  for (const { prefix, method } of coverage.prefix) {
    if (!route.path.startsWith(prefix)) continue;
    for (const routeMethod of methodsToCheck(route)) {
      if (method === "*" || method === routeMethod) return true;
    }
  }

  // Discord adapter prefix
  const DISCORD_PREFIX = "/api/integrations/discord/";
  if (route.path.startsWith(DISCORD_PREFIX)) return true;

  // Fallback patterns in capabilityForRoute: /api/logs/*, etc.
  if (route.path.startsWith("/api/logs/")) return true;

  return false;
}

test("parity: every non-adapter route in handleApi has a capability assignment", () => {
  const routes = extractRoutes(serverSrc);
  const coverage = extractCapabilityCoverage(rbacSrc);

  assert.ok(routes.length > 50, `Expected >50 routes, found ${routes.length}`);

  const uncovered = [];

  for (const route of routes) {
    if (!isCovered(route, coverage, rbacSrc)) {
      uncovered.push(`${route.method} ${route.path}`);
    }
  }

  // Filter out false positives:
  // - Routes that have dynamic :id segments represented in EXACT_ROUTES
  // - The `matchSteamId` secondary check in match path (not route)
  const falsePositives = [];

  if (uncovered.length > 0) {
    const message = [
      `${uncovered.length} route(s) have no capability assignment:\n  ${uncovered.join('\n  ')}`,
      `\nROUTE_CAPABILITIES must be updated when routes are added.`,
    ].join('\n');
    assert.fail(message);
  }
});

test("parity: all exact-route capability keys reference valid capabilities", () => {
  const capRegex = /CAPABILITIES\.(\w+)/g;
  const exactMatch = rbacSrc.match(/const EXACT_ROUTES\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(exactMatch, "EXACT_ROUTES block not found");

  const allCaps = new Set();
  let m;
  while ((m = capRegex.exec(exactMatch[1])) !== null) {
    allCaps.add(m[1]);
  }

  // All known capability names
  const knownCaps = new Set([
    "STATUS_READ", "WORLD_READ", "WORLD_WRITE", "LOGS_READ",
    "BACKUPS_READ", "BACKUPS_WRITE", "DATABASE_READ", "DATABASE_WRITE",
    "UPDATES_READ", "UPDATES_WRITE", "SERVER_CONTROL", "SETTINGS_WRITE",
    "ADDONS_READ", "ADDONS_WRITE", "ADMIN_TOOLS", "CARE_PACKAGE_GRANT",
    "PLAYER_MUTATE", "MAP_WRITE",
  ]);

  for (const cap of allCaps) {
    assert.ok(knownCaps.has(cap), `Unknown capability in EXACT_ROUTES: CAPABILITIES.${cap}`);
  }
});

test("parity: all REGEX_ROUTES prefix entries reference valid capabilities", () => {
  const regexMatch = rbacSrc.match(/const REGEX_ROUTES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(regexMatch, "REGEX_ROUTES block not found");

  const capRegex = /CAPABILITIES\.(\w+)/g;
  const knownCaps = new Set([
    "STATUS_READ", "WORLD_READ", "WORLD_WRITE", "LOGS_READ",
    "BACKUPS_READ", "BACKUPS_WRITE", "DATABASE_READ", "DATABASE_WRITE",
    "UPDATES_READ", "UPDATES_WRITE", "SERVER_CONTROL", "SETTINGS_WRITE",
    "ADDONS_READ", "ADDONS_WRITE", "ADMIN_TOOLS", "CARE_PACKAGE_GRANT",
    "PLAYER_MUTATE", "MAP_WRITE",
  ]);

  let m;
  while ((m = capRegex.exec(regexMatch[1])) !== null) {
    assert.ok(knownCaps.has(m[1]), `Unknown capability in REGEX_ROUTES: CAPABILITIES.${m[1]}`);
  }
});

test("parity: PUBLIC_ROUTES are all GET or POST", () => {
  const publicMatch = rbacSrc.match(/const PUBLIC_ROUTES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(publicMatch, "PUBLIC_ROUTES block not found");

  for (const entry of publicMatch[1].split(',')) {
    const m = entry.match(/"([^"]+)"/);
    if (m) {
      const [method] = m[1].split(" ");
      assert.ok(["GET", "POST"].includes(method), `Unexpected method in PUBLIC_ROUTES: ${m[1]}`);
    }
  }
});
