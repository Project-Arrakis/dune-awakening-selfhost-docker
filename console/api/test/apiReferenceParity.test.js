import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_ACTIONS } from "../src/actions.js";

// Every authorized route must appear in the operator-facing API reference.
//
// Docs asserting behaviour that does not exist -- or omitting behaviour that
// does -- has been a recurring, hand-audited defect in this area (#515, #530).
// Hand-auditing caught each instance one at a time and missed the next; the
// same PR that corrected three stale claims deferred two more absences it had
// just introduced. rbacParity.test.js already proves the shape of this check
// works for route/action coverage, so this is the same idea pointed at the docs.
//
// This asserts PRESENCE, not accuracy -- a row can still describe a route
// wrongly. It closes the "nobody wrote it down at all" hole, which is the one
// that has actually recurred.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REFERENCE = join(repoRoot, "docs", "console", "API-REFERENCE.md");

test("every ROUTE_ACTIONS route is documented in API-REFERENCE.md", () => {
  const reference = readFileSync(REFERENCE, "utf8");
  const missing = Object.keys(ROUTE_ACTIONS)
    .map((key) => key.split(" ").slice(1).join(" ")) // "POST /api/x" -> "/api/x"
    .filter((path, i, all) => all.indexOf(path) === i)
    .filter((path) => !reference.includes(path))
    .sort();

  assert.deepStrictEqual(
    missing, [],
    `these authorized routes have no row in docs/console/API-REFERENCE.md:\n  ${missing.join("\n  ")}\n\n` +
    "Add a row when you add a route -- the reference is the only operator-facing " +
    "description of the console API, and a route absent from it is one nobody " +
    "outside this repo can discover."
  );
});
