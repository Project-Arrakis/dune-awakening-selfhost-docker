import test from "node:test";
import assert from "node:assert/strict";
import { parseRoleIdList, resolveRoleTier, resolveRoleTierDetailed, higherTier, mfaGateReason, roleTiersConfigured, parseTierList, TIER_ORDER, ROLE_MAPPABLE_TIERS, validateRoleNamesMap, encodeRoleNames, decodeRoleNamesSafe } from "../src/integrations/discord/roleTiers.js";

const R = { owner: ["100000000000000001"], admin: ["100000000000000002"], moderator: ["100000000000000003"], player: ["100000000000000004"] };

test("parseRoleIdList keeps only snowflakes, dedupes, never throws", () => {
  assert.deepEqual(parseRoleIdList(" 100000000000000001, nope, 100000000000000001 ,42"), ["100000000000000001"]);
  assert.deepEqual(parseRoleIdList(""), []);
  assert.deepEqual(parseRoleIdList(undefined), []);
});

test("resolveRoleTier returns the HIGHEST mapped tier the member holds", () => {
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000003"], R), "moderator");
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000001"], R), "player", "an 'owner' mapping is ignored: no role confers owner");
  assert.equal(resolveRoleTier(["100000000000000004"], R), "player");
});

test("resolveRoleTier denies when no held role is mapped, or no roles at all", () => {
  assert.equal(resolveRoleTier(["999999999999999999"], R), "");
  assert.equal(resolveRoleTier([], R), "");
  assert.equal(resolveRoleTier(["100000000000000001"], null), "");
});

test("precedence is explicit, not object-key order", () => {
  const shuffled = { player: R.player, moderator: R.moderator, admin: R.admin, owner: R.owner };
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000002"], shuffled), "admin");
  assert.deepEqual(TIER_ORDER, ["owner", "admin", "moderator", "player"]);
});

// ---- resolveRoleTierDetailed (F3, #573: display the deciding role's name) ----

test("resolveRoleTierDetailed reports which role ID decided the winning tier", () => {
  assert.deepEqual(resolveRoleTierDetailed(["100000000000000004", "100000000000000003"], R), { tier: "moderator", roleId: "100000000000000003" });
  assert.deepEqual(resolveRoleTierDetailed(["100000000000000004"], R), { tier: "player", roleId: "100000000000000004" });
});

test("resolveRoleTierDetailed picks the Admin role's ID, never the Moderator one, when both are held", () => {
  const both = { admin: ["100000000000000002"], moderator: ["100000000000000003"], player: [] };
  assert.deepEqual(resolveRoleTierDetailed(["100000000000000002", "100000000000000003"], both), { tier: "admin", roleId: "100000000000000002" });
});

test("resolveRoleTierDetailed: two role IDs mapped to the same tier, both held -- first-configured wins, deterministically", () => {
  const twoAdmins = { admin: ["100000000000000002", "100000000000000005"], moderator: [], player: [] };
  assert.deepEqual(resolveRoleTierDetailed(["100000000000000005", "100000000000000002"], twoAdmins), { tier: "admin", roleId: "100000000000000002" }, "config order decides, not the member's role-ID array order");
});

test("resolveRoleTierDetailed returns an empty roleId when no held role is mapped, or no roles at all", () => {
  assert.deepEqual(resolveRoleTierDetailed(["999999999999999999"], R), { tier: "", roleId: "" });
  assert.deepEqual(resolveRoleTierDetailed([], R), { tier: "", roleId: "" });
  assert.deepEqual(resolveRoleTierDetailed(["100000000000000001"], null), { tier: "", roleId: "" });
});

test("resolveRoleTier is a thin wrapper over resolveRoleTierDetailed -- same results as before this change", () => {
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000003"], R), resolveRoleTierDetailed(["100000000000000004", "100000000000000003"], R).tier);
  assert.equal(resolveRoleTier(["999999999999999999"], R), "");
});

test("higherTier picks the stronger tier; empty loses to anything", () => {
  assert.equal(higherTier("owner", "player"), "owner");
  assert.equal(higherTier("player", "admin"), "admin");
  assert.equal(higherTier("", "player"), "player");
  assert.equal(higherTier("", ""), "");
});

// Observer folded into player (live-testing decision) -- it was unreachable
// via Discord role mapping (ROLE_MAPPABLE_TIERS never included it) and a
// strict subset of player, so it added a tier with no real purpose.
test("observer is not a role-mappable tier, and higherTier treats it like any other unrecognized string", () => {
  assert.ok(!ROLE_MAPPABLE_TIERS.includes("observer"));
  assert.equal(higherTier("observer", "player"), "player");
});

test("mfaGateReason denies a gated tier without Discord 2FA, passes otherwise", () => {
  assert.equal(mfaGateReason("owner", false, ["owner", "admin"]), "mfa_required");
  assert.equal(mfaGateReason("admin", false, ["owner", "admin"]), "mfa_required");
  assert.equal(mfaGateReason("owner", true, ["owner", "admin"]), "");
  assert.equal(mfaGateReason("player", false, ["owner", "admin"]), "");
  assert.equal(mfaGateReason("owner", false, []), "", "empty list disables the gate");
  assert.equal(mfaGateReason("", false, ["owner"]), "", "no tier means nothing to gate");
});

test("roleTiersConfigured and parseTierList", () => {
  assert.equal(roleTiersConfigured(R), true);
  assert.equal(roleTiersConfigured({ owner: [], admin: [] }), false);
  assert.equal(roleTiersConfigured(null), false);
  assert.deepEqual(parseTierList("owner, Admin,bogus,admin"), ["owner", "admin"]);
});

// ---- separation of duties ----
import { roleTierConflicts, describeRoleTierConflicts } from "../src/integrations/discord/roleTiers.js";

// ---- role name map storage (F3, #573): validate, then base64url-encode
// before it ever touches the .env writer, so it round-trips through
// quoteEnv/parseEnvLine cleanly (base64url's alphabet is a strict subset of
// the charset quoteEnv already leaves unescaped -- this is the CRITICAL
// finding's fix from the L1 design audit). ----

test("validateRoleNamesMap: accepts a well-formed { roleId: name } map", () => {
  const r = validateRoleNamesMap({ "100000000000000002": "Heavy Bats" });
  assert.deepEqual(r, { ok: true, value: { "100000000000000002": "Heavy Bats" } });
});

test("validateRoleNamesMap: empty/absent input is valid -- an empty map", () => {
  assert.deepEqual(validateRoleNamesMap(null), { ok: true, value: {} });
  assert.deepEqual(validateRoleNamesMap(undefined), { ok: true, value: {} });
  assert.deepEqual(validateRoleNamesMap({}), { ok: true, value: {} });
});

test("validateRoleNamesMap: rejects non-plain-object input", () => {
  assert.equal(validateRoleNamesMap([]).ok, false);
  assert.equal(validateRoleNamesMap("nope").ok, false);
  assert.equal(validateRoleNamesMap(42).ok, false);
});

test("validateRoleNamesMap: rejects a non-snowflake key", () => {
  const r = validateRoleNamesMap({ "not-a-role-id": "Heavy Bats" });
  assert.equal(r.ok, false);
});

// Note: these three keys are also non-snowflakes, so the preceding snowflake
// check alone already rejects them today -- this test doesn't isolate the
// explicit denylist from that. The denylist is kept as defense in depth for a
// future loosening of the snowflake format, not because this test proves it
// load-bearing right now (verified via mutation: removing the denylist branch
// does not turn this test red).
test("validateRoleNamesMap: rejects prototype-pollution-adjacent keys (also non-snowflakes)", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.equal(validateRoleNamesMap({ [key]: "x" }).ok, false, `${key} must be rejected`);
  }
});

test("validateRoleNamesMap: rejects a non-string, empty, or overlong name", () => {
  assert.equal(validateRoleNamesMap({ "100000000000000002": 42 }).ok, false);
  assert.equal(validateRoleNamesMap({ "100000000000000002": "" }).ok, false);
  assert.equal(validateRoleNamesMap({ "100000000000000002": "x".repeat(101) }).ok, false);
  assert.equal(validateRoleNamesMap({ "100000000000000002": "x".repeat(100) }).ok, true, "exactly 100 chars is accepted");
});

test("validateRoleNamesMap: rejects a map with too many entries", () => {
  const huge = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`1000000000000000${String(i).padStart(2, "0")}`, "x"]));
  assert.equal(validateRoleNamesMap(huge).ok, false);
});

test("encodeRoleNames/decodeRoleNamesSafe round-trip, including names with quotes and unicode", () => {
  const map = { "100000000000000002": 'Heavy "Bats" 🦇' };
  const encoded = encodeRoleNames(map);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "must be pure base64url -- no characters quoteEnv would need to escape");
  assert.deepEqual(decodeRoleNamesSafe(encoded), map);
});

test("decodeRoleNamesSafe: fails safe to {} on any malformed input -- never throws", () => {
  assert.deepEqual(decodeRoleNamesSafe(""), {});
  assert.deepEqual(decodeRoleNamesSafe(undefined), {});
  assert.deepEqual(decodeRoleNamesSafe("not-valid-base64url-json!!!"), {});
  assert.deepEqual(decodeRoleNamesSafe(Buffer.from("not json").toString("base64url")), {});
  // Valid JSON, valid base64url, but fails the map's own validation (bad key)
  assert.deepEqual(decodeRoleNamesSafe(Buffer.from(JSON.stringify({ "bad-key": "x" })).toString("base64url")), {});
});

test("roleTierConflicts: a role under two tiers is reported with both tiers", () => {
  const dup = { admin: ["100000000000000002"], moderator: ["100000000000000002"], player: [] };
  assert.deepEqual(roleTierConflicts(dup), [{ roleId: "100000000000000002", tiers: ["admin", "moderator"] }]);
  assert.equal(describeRoleTierConflicts(roleTierConflicts(dup)), "role 100000000000000002 is mapped to admin and moderator");
});

test("roleTierConflicts: a sound mapping has none; the same role twice under ONE tier is not a conflict", () => {
  assert.deepEqual(roleTierConflicts(R), []);
  assert.deepEqual(roleTierConflicts({ admin: ["100000000000000002", "100000000000000002"] }), []);
  assert.deepEqual(roleTierConflicts(null), []);
});

test("resolveRoleTier would silently promote on a conflict -- which is why it must never see one", () => {
  const dup = { admin: ["100000000000000002"], moderator: ["100000000000000002"], player: [] };
  assert.equal(resolveRoleTier(["100000000000000002"], dup), "admin");
});
