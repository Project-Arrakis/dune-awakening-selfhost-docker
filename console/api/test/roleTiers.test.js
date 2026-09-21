import test from "node:test";
import assert from "node:assert/strict";
import { parseRoleIdList, resolveRoleTier, higherTier, mfaGateReason, roleTiersConfigured, parseTierList, TIER_ORDER, ROLE_MAPPABLE_TIERS } from "../src/integrations/discord/roleTiers.js";

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

// --- console vs. bot-capability mapping drift (#620) ------------------------
import { roleTierDrift, describeRoleTierDrift, botRoleTier, BOT_TIER_ORDER, BOT_PRIVILEGED_TIERS } from "../src/integrations/discord/roleTiers.js";

const ADMIN_ROLE = "200000000000000001";
const MOD_ROLE = "200000000000000002";
const OBSERVER_ROLE = "200000000000000003";
const OWNER_ROLE = "200000000000000004";
const bot = (over = {}) => ({ ownerRoleIds: [], adminRoleIds: [], moderatorRoleIds: [], observerRoleIds: [], ...over });

test("#620: a role revoked from the console mapping still holding bot admin is reported", () => {
  // The exact hazard: the operator cut a departed admin's role out of
  // DISCORD_CONSOLE_ADMIN_ROLE_IDS; DISCORD_ADMIN_ROLE_IDS was never touched.
  const drift = roleTierDrift({ admin: [], moderator: [], player: [] }, bot({ adminRoleIds: [ADMIN_ROLE] }));
  assert.deepEqual(drift, [{ roleId: ADMIN_ROLE, botTier: "admin", consoleTier: "" }]);
  assert.equal(describeRoleTierDrift(drift), `role ${ADMIN_ROLE} is admin to the Discord bot but has no console access`);
});

test("drift: a demotion that only landed on the console side is reported with both tiers", () => {
  const drift = roleTierDrift({ admin: [], moderator: [ADMIN_ROLE], player: [] }, bot({ adminRoleIds: [ADMIN_ROLE] }));
  assert.deepEqual(drift, [{ roleId: ADMIN_ROLE, botTier: "admin", consoleTier: "moderator" }]);
  assert.equal(describeRoleTierDrift(drift), `role ${ADMIN_ROLE} is admin to the Discord bot but only moderator on the console`);
});

test("drift: mappings that agree, or grant the console MORE, are not drift", () => {
  assert.deepEqual(roleTierDrift({ admin: [ADMIN_ROLE] }, bot({ adminRoleIds: [ADMIN_ROLE] })), []);
  assert.deepEqual(roleTierDrift({ moderator: [MOD_ROLE] }, bot({ moderatorRoleIds: [MOD_ROLE] })), []);
  assert.deepEqual(roleTierDrift({ admin: [MOD_ROLE] }, bot({ moderatorRoleIds: [MOD_ROLE] })), [], "console admin outranks bot moderator");
});

test("drift: a bot OWNER role always outranks the console, which never confers owner by role", () => {
  assert.deepEqual(
    roleTierDrift({ admin: [OWNER_ROLE] }, bot({ ownerRoleIds: [OWNER_ROLE] })),
    [{ roleId: OWNER_ROLE, botTier: "owner", consoleTier: "admin" }]
  );
});

test("drift: bot observer is never reported -- read-only asymmetry, not stale privilege", () => {
  assert.deepEqual(roleTierDrift({}, bot({ observerRoleIds: [OBSERVER_ROLE] })), []);
  assert.deepEqual(BOT_PRIVILEGED_TIERS, ["owner", "admin", "moderator"]);
  assert.deepEqual(BOT_TIER_ORDER, ["owner", "admin", "moderator", "observer"]);
});

test("drift: a role under two bot tiers is reported once, at the higher one", () => {
  const mapping = bot({ adminRoleIds: [ADMIN_ROLE], moderatorRoleIds: [ADMIN_ROLE] });
  assert.equal(botRoleTier(ADMIN_ROLE, mapping), "admin");
  assert.deepEqual(roleTierDrift({}, mapping), [{ roleId: ADMIN_ROLE, botTier: "admin", consoleTier: "" }]);
});

test("drift: absent/empty mappings never throw and report nothing", () => {
  assert.deepEqual(roleTierDrift(null, null), []);
  assert.deepEqual(roleTierDrift({}, bot()), []);
  assert.deepEqual(roleTierDrift({ admin: [ADMIN_ROLE] }, undefined), []);
  assert.equal(botRoleTier("", bot({ adminRoleIds: [""] })), "");
  assert.equal(describeRoleTierDrift([]), "");
});

test("drift: role ids are compared trimmed, as both mappings store them", () => {
  assert.equal(botRoleTier(` ${ADMIN_ROLE} `, bot({ adminRoleIds: [` ${ADMIN_ROLE} `] })), "admin");
});
