import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, getAllPolicies, loadPolicies, policyRevision, setPolicies } from "../src/policy.js";

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

test("a property that is undefined does not change the revision (the saved file drops it too)", () => {
  loadPolicies();
  const base = getAllPolicies();
  const withUndefined = { ...base, admin: { ...base.admin, extra: undefined } };
  assert.equal(policyRevision(withUndefined), policyRevision(base));
});

// Review #1197 (B1): the policy in force must stay the saved one when the disk write fails.
test("a failed disk write leaves the enforced policy and revision untouched and reports it", () => {
  loadPolicies();
  const before = policyRevision();
  const root = mkdtempSync(join(tmpdir(), "iam-persist-fail-"));
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime", "generated"), "a file where the directory should be");
  const loosened = { ...getAllPolicies(), admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["*"] }] } };
  const result = setPolicies(loosened, root);
  assert.equal(result.ok, false);
  assert.equal(result.persistFailed, true);
  assert.equal(policyRevision(), before, "the store did not change");
  assert.equal(evaluate({ tier: "admin" }, "settings:write"), false, "the loosened policy is not live");
});

// Review #1197 (B2): a hand-edited file whose owner cannot write settings must not load.
test("a saved file whose owner cannot write settings falls back to the defaults, with a reason", () => {
  const root = mkdtempSync(join(tmpdir(), "iam-owner-lockout-"));
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  const store = { ...getAllPolicies(), owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: ["players:read"] }] } };
  writeFileSync(join(root, "runtime", "generated", "iam-policies.json"), JSON.stringify(store));
  const result = loadPolicies(root);
  assert.equal(result.source, "defaults");
  assert.equal(result.invalid, true);
  assert.match(result.reason, /settings:write/);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "the owner can open the editor again");
  loadPolicies();
});

test("a saved file with a working owner still loads", () => {
  const root = mkdtempSync(join(tmpdir(), "iam-owner-ok-"));
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  writeFileSync(join(root, "runtime", "generated", "iam-policies.json"), JSON.stringify(getAllPolicies()));
  assert.equal(loadPolicies(root).source, "file");
  loadPolicies();
});
