import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAllPolicies, loadPolicies, policyRevision, setPolicies } from "../src/policy.js";

// Issue #1193: PUT /api/settings/iam/policy replaces the whole store, so two admins saving close
// together lost one change silently. A save may carry the revision it loaded; a stale one is refused.

const withAdmin = (action) => ({
  ...getAllPolicies(),
  admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: [action] }] }
});

test("revision is stable across reads, ignores key order, and changes when the store changes", () => {
  loadPolicies();
  const first = policyRevision();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(policyRevision(), first);
  const reordered = Object.fromEntries(Object.entries(getAllPolicies()).reverse());
  assert.equal(policyRevision(reordered), first, "key order must not look like a change");
  assert.equal(setPolicies(withAdmin("backups:create")).ok, true);
  assert.notEqual(policyRevision(), first);
});

test("a save with the current revision succeeds and returns the next revision", () => {
  loadPolicies();
  const result = setPolicies(withAdmin("backups:create"), null, { baseRevision: policyRevision() });
  assert.equal(result.ok, true);
  assert.equal(result.revision, policyRevision());
});

test("a stale revision is refused with the current store and nothing is written", () => {
  loadPolicies();
  const stale = policyRevision();
  assert.equal(setPolicies(withAdmin("backups:create")).ok, true, "another admin saves first");
  const current = policyRevision();
  const refused = setPolicies(withAdmin("backups:delete"), null, { baseRevision: stale });
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true);
  assert.equal(refused.revision, current);
  assert.deepEqual(refused.policies.admin.statements[0].Action, ["backups:create"], "carries what is enforced now");
  assert.equal(policyRevision(), current, "the store is untouched");
  assert.deepEqual(getAllPolicies().admin.statements[0].Action, ["backups:create"]);
});

test("a save without a revision keeps the old replace-the-store behaviour", () => {
  loadPolicies();
  assert.equal(setPolicies(withAdmin("backups:create")).ok, true);
  assert.equal(setPolicies(withAdmin("backups:delete"), null, {}).ok, true);
  assert.equal(setPolicies(withAdmin("backups:create"), null, { baseRevision: undefined }).ok, true);
});

test("an empty or wrong revision is a conflict, not a bypass", () => {
  loadPolicies();
  const before = policyRevision();
  assert.equal(setPolicies(withAdmin("backups:create"), null, { baseRevision: "" }).conflict, true);
  assert.equal(setPolicies(withAdmin("backups:create"), null, { baseRevision: "deadbeef" }).conflict, true);
  assert.equal(policyRevision(), before);
});

test("the route reads If-Match, answers 409 on a conflict, audits it, and GET returns the revision", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const put = server.slice(server.indexOf('path === "/api/settings/iam/policy" && req.method === "PUT"'));
  const handler = put.slice(0, put.indexOf('path === "/api/settings/api-keys/catalog"'));
  assert.match(handler, /req\.headers\["if-match"\]/);
  assert.match(handler, /baseRevision: ifMatch/);
  assert.match(handler, /result\.conflict[\s\S]*audit\(config, req, "iam\.policy-conflict"[\s\S]*json\(res, 409, result\)/);
  const get = server.slice(server.indexOf('path === "/api/settings/iam/policies" && req.method === "GET"'));
  assert.match(get.slice(0, get.indexOf('path === "/api/settings/iam/policy" && req.method === "PUT"')), /revision: policyRevision\(\)/);
});
