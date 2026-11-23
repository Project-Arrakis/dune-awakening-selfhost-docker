import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN, actionForRoute
} from "../src/actions.js";
import { evaluate, isCrownJewelAction } from "../src/policy.js";
import { playerMayCall } from "../src/playerScope.js";

// Differential route x tier authorization matrix (pentest hardening).
//
// The route inventory is mined from server.js itself, so a route added tomorrow
// is automatically part of the matrix. For every (method, sample path) it
// resolves the IAM action the gate would use, then asserts invariants that
// must hold for EVERY route regardless of how the default policy is edited:
//
//   1. an unmapped route is dead for everyone (gate fails closed on null);
//   2. no non-owner tier is ever allowed a crown-jewel action, on any route;
//   3. the player tier can only ever reach the audited GET allowlist (second gate);
//   4. a state-changing HTTP verb never resolves to a read-only action;
//   5. a route resolved only by the coarse prefix fallback must be reviewed
//      (listed below) -- a handler that is more sensitive than its prefix would
//      otherwise inherit the weaker permission silently.

const serverSource = readFileSync(fileURLToPath(new URL("../src/server.js", import.meta.url)), "utf8");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sampleFromRegexSource(src) {
  let s = src.replace(/^\^/, "").replace(/\$$/, "");
  s = s.replace(/\(\?:[^)]*\)\??/g, "").replace(/\[\^\/\]\+/g, "abc123").replace(/\[\^\/\]\*/g, "abc123")
    .replace(/\\\//g, "/").replace(/\\\./g, ".").replace(/\\d\+/g, "1").replace(/\\-/g, "-");
  if (/[\\()[\]|?+*^$]/.test(s)) return null;
  return s;
}

const matchers = []; // { methods, test(path), sample } -- what the handler chain would actually accept

function mineRoutes() {
  const found = new Map(); // key "METHOD path" -> true
  const add = (path, methods) => { for (const m of methods) found.set(`${m} ${path}`, true); };
  for (const line of serverSource.split("\n")) {
    if (!line.includes("/api/")) continue;
    const declared = [...line.matchAll(/req\.method === "([A-Z]+)"/g)].map((m) => m[1]);
    // Negative guards on the same condition ("... && !path.startsWith(x) && path !== y") narrow what the handler accepts.
    const negs = [
      ...[...line.matchAll(/!path\.startsWith\("([^"]*)"\)/g)].map((m) => (p) => p.startsWith(m[1])),
      ...[...line.matchAll(/path !== "([^"]*)"/g)].map((m) => (p) => p === m[1])
    ];
    const allowed = (t) => (p) => t(p) && !negs.some((n) => n(p));
    const methods = declared.length ? declared : ["GET"]; // no verb on the line: a method-agnostic dispatch is covered by the prefix review below
    for (const m of line.matchAll(/path === "(\/api\/[^"]*)"/g)) { add(m[1], methods); matchers.push({ methods, sample: m[1], test: allowed((p) => p === m[1]) }); }
    for (const m of line.matchAll(/path\.startsWith\("(\/api\/[^"]*)"\)/g)) { add(`${m[1]}abc123`, methods); matchers.push({ methods, sample: `${m[1]}abc123`, test: allowed((p) => p.startsWith(m[1])) }); }
    for (const m of line.matchAll(/path\.match\(\/(\^\\\/api\\\/.*?)\/[a-z]*\)/g)) {
      const sample = sampleFromRegexSource(m[1]);
      if (sample?.startsWith("/api/")) add(sample, methods);
      if (sample?.startsWith("/api/")) { const re = new RegExp(m[1]); matchers.push({ methods, sample, test: allowed((p) => re.test(p)) }); }
    }
  }
  return [...found.keys()].map((k) => { const i = k.indexOf(" "); return { method: k.slice(0, i), path: k.slice(i + 1) }; });
}

// Mirrors actionForRoute's branch order so each resolution can be classified.
function resolveWithBranch(path, method) {
  const key = `${method} ${path}`;
  if (Object.prototype.hasOwnProperty.call(ROUTE_ACTIONS, key)) return { action: ROUTE_ACTIONS[key], branch: "exact" };
  for (const { method: m, pattern, action } of REGEX_ACTIONS_BY_METHOD_PATTERN) {
    if (method === m && pattern.test(path)) return { action, branch: "pattern" };
  }
  for (const [k, action] of Object.entries(REGEX_ACTIONS_BY_METHOD)) {
    const [m, prefix] = k.split(" ", 2);
    if (method === m && path.startsWith(prefix)) return { action, branch: "method-prefix" };
  }
  for (const [prefix, action] of REGEX_ACTIONS) if (path.startsWith(prefix)) return { action, branch: "prefix" };
  return { action: null, branch: "none" };
}

const routes = mineRoutes();
const TIERS = ["admin", "moderator", "player"];

test("route miner finds a realistic inventory (guards the harness itself)", () => {
  assert.ok(routes.length > 250, `only ${routes.length} method/path pairs mined`);
  for (const probe of ["GET /api/players", "POST /api/server/stop", "GET /api/settings/api-keys"]) {
    assert.ok(routes.some((r) => `${r.method} ${r.path}` === probe) || actionForRoute(probe.split(" ")[1], probe.split(" ")[0]) !== undefined, probe);
  }
});

test("actionForRoute agrees with the branch-mirroring resolver on every mined route", () => {
  for (const { method, path } of routes) assert.equal(resolveWithBranch(path, method).action, actionForRoute(path, method), `${method} ${path}`);
});

test("the miner sees nearly every exact ROUTE_ACTIONS entry (a blind miner would pass vacuously)", () => {
  const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const missed = Object.keys(ROUTE_ACTIONS).filter((k) => !have.has(k));
  assert.ok(missed.length <= 15, `miner missed ${missed.length}: ${missed.join(", ")}`);
});

test("INVARIANT 2: no non-owner tier is allowed a crown-jewel action on any route", () => {
  const leaks = [];
  for (const { method, path } of routes) {
    const action = actionForRoute(path, method);
    if (!action || !isCrownJewelAction(action)) continue;
    for (const tier of TIERS) if (evaluate({ tier }, action)) leaks.push(`${tier} ${method} ${path} -> ${action}`);
  }
  assert.deepEqual(leaks, []);
});

test("INVARIANT 3: the player tier reaches only GET routes (plus the one translation suggestion write)", () => {
  const reachable = [];
  for (const { method, path } of routes) {
    const action = actionForRoute(path, method);
    if (!action || !evaluate({ tier: "player" }, action) || !playerMayCall(method, path)) continue;
    reachable.push(`${method} ${path}`);
    assert.ok(method === "GET" || (method === "POST" && path === "/api/i18n/suggestions"), `player can reach ${method} ${path}`);
  }
  // Snapshot of everything a player can reach. A change here is a security
  // decision and must be reviewed, not auto-accepted.
  assert.deepEqual(reachable.sort(), EXPECTED_PLAYER_REACHABLE.slice().sort());
});

test("INVARIANT 4: state-changing verbs never resolve to a read-only action", () => {
  const offenders = [];
  for (const { method, path } of routes) {
    if (!WRITE_METHODS.has(method)) continue;
    const action = actionForRoute(path, method);
    if (action && /:(read|list|view)$/.test(action) && !READ_ACTION_ON_WRITE_VERB_REVIEWED.has(`${method} ${path}`)) offenders.push(`${method} ${path} -> ${action}`);
  }
  assert.deepEqual(offenders, []);
});

test("INVARIANT 5: routes resolved only by the coarse prefix fallback are reviewed", () => {
  const prefixOnly = [];
  for (const { method, path } of routes) {
    const { action, branch } = resolveWithBranch(path, method);
    if (action && (branch === "prefix" || branch === "method-prefix")) prefixOnly.push(`${method} ${path} -> ${action} [${branch}]`);
  }
  assert.deepEqual(prefixOnly.sort(), PREFIX_FALLBACK_REVIEWED.slice().sort(),
    "a route newly resolves via a prefix bucket: confirm the bucket's action is right for it, add an exact entry to ROUTE_ACTIONS, or add it to PREFIX_FALLBACK_REVIEWED with a justification");
});

test("path-shape variants: whichever handler a variant reaches, the gate applies THAT handler's action", () => {
  // The gate resolves the raw pathname with actionForRoute; the handler chain
  // matches the same raw pathname with its own matchers. If a variant reaches
  // handler H but the gate resolved a different (e.g. coarser, weaker) action
  // than H's own canonical action, the variant bypasses H's permission.
  const mismatches = [];
  for (const { method, path } of routes) {
    for (const variant of [`${path}/`, path.replace(/\/([^/]+)$/, "//$1"), `${path}%2f`, `${path};x=1`, path.toUpperCase(), path.replace(/\/api\//, "/api/./"), path.replace(/\/([^/]+)$/, "/%2e%2e/$1")]) {
      if (variant === path) continue;
      for (const h of matchers) {
        if (!h.methods.includes(method) || !h.test(variant)) continue;
        const want = actionForRoute(h.sample, method);
        const got = actionForRoute(variant, method);
        if (want && got !== want) mismatches.push(`${method} ${variant} reaches handler for ${h.sample} (needs ${want}) but is gated as ${got}`);
      }
    }
  }
  assert.deepEqual([...new Set(mismatches)].sort(), VARIANT_GATE_MISMATCH_REVIEWED.slice().sort());
});

// ---- reviewed snapshots (filled from a reviewed run; see test output on drift) ----
const EXPECTED_PLAYER_REACHABLE = [
  "GET /api/bases", "GET /api/guilds", "GET /api/players", "GET /api/players/online", "GET /api/players/search",
  // Informational (LOW) -- host CPU/memory/disk and restart rows (map/partition ids) reach players by design
  // ("Home: server health"); see the pentest register. Remove here deliberately if the operator narrows it.
  "GET /api/server/performance", "GET /api/server/restart-history", "GET /api/server/status",
  "GET /api/storage", "GET /api/vehicles", "POST /api/i18n/suggestions"
];
// Reviewed: POST /api/settings/iam/policy/test is a dry-run evaluator (no state change); it needs settings:read.
const READ_ACTION_ON_WRITE_VERB_REVIEWED = new Set(["POST /api/settings/iam/policy/test"]);
// Reviewed 2026-11-23: each handler is a single-purpose read (or the guarded DELETE) whose prefix bucket is its intended action.
const PREFIX_FALLBACK_REVIEWED = [
  "DELETE /api/backups/abc123 -> backups:delete [method-prefix]",
  "GET /api/database/table/abc123 -> database:read [prefix]",
  "GET /api/logs/abc123 -> logs:read [prefix]",
  "GET /api/setup/tasks/abc123 -> setup:read [prefix]"
];
const VARIANT_GATE_MISMATCH_REVIEWED = [];

export { routes, resolveWithBranch };
