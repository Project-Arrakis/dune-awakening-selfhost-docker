import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { intParam } from "../src/db.js";

// server.js is an entrypoint -- importing it starts a listener -- so the route
// handlers cannot be called directly. operationsPermissionMatrix.test.js sets
// the precedent of reading it as source instead. The guard's contract is real
// logic though, and that is the part these status codes depend on, so it is
// exercised for real below rather than string-matched.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSource = readFileSync(resolve(repoRoot, "console/api/src/server.js"), "utf8");

const ROUTES = ["baseWaterRoute", "baseInventoryRoute"];

function routeBody(name) {
  const start = serverSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in server.js`);
  const end = serverSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return serverSource.slice(start, end);
}

// The route's own guard is what makes a 500 in the catch honest. isFinite alone
// admits 4.5 and 1e20, both of which clear it and then throw inside intParam --
// so with the old guard a caller could provoke what would now be reported as a
// server fault. Anything intParam rejects must be rejected by the guard first.
test("the base route guard rejects everything intParam would", () => {
  const guard = (baseId) => Number.isInteger(baseId) && baseId >= 1 && baseId <= Number.MAX_SAFE_INTEGER;

  const cases = [4.5, 1e20, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, 1, 5, 1006, Number.MAX_SAFE_INTEGER];
  for (const baseId of cases) {
    let intParamAccepts = true;
    try { intParam(baseId, "base id", 1); } catch { intParamAccepts = false; }
    assert.equal(guard(baseId), intParamAccepts,
      `guard and intParam disagree on ${baseId}: guard=${guard(baseId)} intParam=${intParamAccepts}`);
  }
});

test("both base read routes use that guard, not a bare isFinite check", () => {
  for (const name of ROUTES) {
    const body = routeBody(name);
    assert.match(body, /!Number\.isInteger\(baseId\)[\s\S]*?baseId > Number\.MAX_SAFE_INTEGER/,
      `${name} must match intParam's contract before the try block`);
    assert.doesNotMatch(body, /Number\.isFinite\(baseId\) \|\| baseId < 1/,
      `${name} still uses the looser isFinite guard, so bad input can reach the catch`);
  }
});

// An unsupported schema returns 200 with supported:false, and bad input is
// rejected above -- so a throw here is a query or connection failure, which is
// ours, not the caller's.
test("both base read routes answer a genuine failure with 500, not 400", () => {
  for (const name of ROUTES) {
    const body = routeBody(name);
    const catchBlock = body.slice(body.indexOf("} catch (error) {"));
    assert.match(catchBlock, /json\(res, 500,/, `${name} must report a real failure as 500`);
    assert.doesNotMatch(catchBlock, /json\(res, 400,/, `${name} must not report a real failure as 400`);
    // The payload itself is unchanged: redacted, and still carrying both keys
    // the tab reads.
    assert.match(catchBlock, /supported: false/);
    assert.match(catchBlock, /error: redact\(/);
    assert.match(catchBlock, /reason: redact\(/);
  }
});

// The id check has to stay outside the try, or a rejected id would be counted
// as a server fault by the block above.
test("both base read routes keep id validation on 400, before the try", () => {
  for (const name of ROUTES) {
    const body = routeBody(name);
    const guardAt = body.indexOf("Invalid base ID");
    const tryAt = body.indexOf("try {");
    assert.notEqual(guardAt, -1, `${name} lost its invalid-id response`);
    assert.ok(guardAt < tryAt, `${name} must reject a bad id before the try block`);
    assert.match(body.slice(0, tryAt), /json\(res, 400, \{ error: "Invalid base ID" \}\)/);
  }
});
