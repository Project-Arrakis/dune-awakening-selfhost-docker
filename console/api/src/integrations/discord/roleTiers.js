// Console-native Discord role -> tier resolution (rfc-console-auth.md §2.1.1).
//
// The operator maps guild role IDs to console tiers in Settings (or .env);
// at sign-in the console reads the member's own roles for the home guild via
// the user's OAuth token (guilds.members.read) and takes the highest mapped
// tier. Pure functions, no I/O, so the precedence and parsing rules are
// testable in isolation and the resolver in oauth.js stays small.

export const TIER_ORDER = ["owner", "admin", "moderator", "player"];
// Tiers a Discord ROLE may map to. Owner is deliberately absent: it is derived
// from Discord guild ownership (rfc-console-auth.md §2.1.1), never from a role,
// so no mapping can ever make an admin an owner.
export const ROLE_MAPPABLE_TIERS = ["admin", "moderator", "player"];
const SNOWFLAKE_RE = /^\d{17,19}$/;

// "123, 456" -> ["123","456"]; anything that is not a snowflake is dropped,
// never an error: a typo in .env must not take Discord sign-in down, it must
// simply not grant that role's tier.
export function parseRoleIdList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter((item) => SNOWFLAKE_RE.test(item)))];
}

// { owner: [...], admin: [...], moderator: [...], player: [...] } -> true when
// at least one tier has at least one role mapped.
export function roleTiersConfigured(roleTiers) {
  return ROLE_MAPPABLE_TIERS.some((tier) => Array.isArray(roleTiers?.[tier]) && roleTiers[tier].length > 0);
}

// Highest tier whose mapped roles intersect the member's roles, or "" when
// none do. Order is explicit and never derived from object key order.
export function resolveRoleTier(memberRoleIds, roleTiers) {
  const held = new Set(Array.isArray(memberRoleIds) ? memberRoleIds.map(String) : []);
  if (!held.size) return "";
  for (const tier of ROLE_MAPPABLE_TIERS) {
    const mapped = roleTiers?.[tier] || [];
    if (mapped.some((id) => held.has(String(id)))) return tier;
  }
  return "";
}

// Of two tiers, the higher one ("" loses to anything).
export function higherTier(a, b) {
  const ia = TIER_ORDER.indexOf(a); const ib = TIER_ORDER.indexOf(b);
  if (ia === -1) return ib === -1 ? "" : b;
  if (ib === -1) return a;
  return ia <= ib ? a : b;
}

// Discord-account 2FA gate. `requireMfaTiers` is the operator's list; a tier
// in it is denied unless the Discord account itself has 2FA enabled
// (`mfa_enabled` from the identify scope). Returns "" when the gate passes,
// otherwise the reason code for the audit log.
export function mfaGateReason(tier, mfaEnabled, requireMfaTiers = []) {
  if (!tier) return "";
  if (!requireMfaTiers.includes(tier)) return "";
  return mfaEnabled ? "" : "mfa_required";
}

export function parseTierList(value) {
  return [...new Set(String(value || "").split(",").map((t) => t.trim().toLowerCase()).filter((t) => TIER_ORDER.includes(t)))];
}

// Separation of duties: one Discord role may map to ONE console tier. A role
// listed under two tiers (Sentinel's own data has the same role as both owner
// and admin) would silently make every holder the higher tier -- with the
// resolver's highest-wins rule, every admin becomes an owner. Returns one entry
// per offending role: { roleId, tiers: [...] }. Empty when the mapping is sound.
export function roleTierConflicts(roleTiers) {
  const seen = new Map();
  for (const tier of ROLE_MAPPABLE_TIERS) {
    for (const id of roleTiers?.[tier] || []) {
      const key = String(id);
      if (!seen.has(key)) seen.set(key, []);
      if (!seen.get(key).includes(tier)) seen.get(key).push(tier); // twice under one tier is redundancy, not a conflict
    }
  }
  return [...seen.entries()].filter(([, tiers]) => tiers.length > 1).map(([roleId, tiers]) => ({ roleId, tiers }));
}

export function describeRoleTierConflicts(conflicts) {
  return conflicts.map((c) => `role ${c.roleId} is mapped to ${c.tiers.join(" and ")}`).join("; ");
}

// ---------------------------------------------------------------------------
// Console sign-in vs. bot-capability mapping drift (#620).
//
// Two independent Discord role -> tier mappings live in this one process:
//   * this file's console mapping (DISCORD_CONSOLE_*_ROLE_IDS), which decides
//     who may sign in to the web console, and at what tier; and
//   * policy.js's bot-capability mapping (DISCORD_OBSERVER/MODERATOR/ADMIN/
//     OWNER_ROLE_IDS), which decides what a Discord user may do through the
//     bot.
// They are edited independently -- only the console one has a Settings UI --
// so revoking a departed admin's role from the console mapping cuts off console
// sign-in while leaving that role's holders their bot capability. That is the
// stale-authorization hazard #620 is about.
//
// Neither mapping is derived from the other, deliberately: they have different
// tier vocabularies (the console has no observer/public and forbids role ->
// owner outright; the bot has no player and allows it), different blast radii,
// and rewriting one from the other would silently change live authorization on
// upgrade. The drift is made loud instead -- reported at boot and in Settings,
// never auto-resolved.

// Bot tiers in highest-first order, as policy.js's discordActorTier() resolves
// them. "public" is absent: it is the no-role fallback, not something a role
// can be mapped to.
export const BOT_TIER_ORDER = ["owner", "admin", "moderator", "observer"];

// Bot tiers that grant more than the public status read. moderator is the
// lowest of them: policy.js's CAPABILITY_BY_TIER gives it player-link:write
// plus the backup/inventory/storage reads. observer is status/readiness/
// services only, so a role holding it without console access is asymmetry,
// not stale privilege, and would only make this warning noisy.
export const BOT_PRIVILEGED_TIERS = ["owner", "admin", "moderator"];

// policy.js's normalizeRoleMapping() key for each bot tier.
const BOT_TIER_ROLE_IDS_KEY = { owner: "ownerRoleIds", admin: "adminRoleIds", moderator: "moderatorRoleIds", observer: "observerRoleIds" };

// The console tier each bot tier is the counterpart of, so the two can be
// ranked against each other on TIER_ORDER. The console folded observer into
// player (it was unreachable via role mapping and a strict subset), so the
// bot's observer compares as the console's player.
const BOT_TIER_AS_CONSOLE_TIER = { owner: "owner", admin: "admin", moderator: "moderator", observer: "player" };

// Highest bot tier the given role is mapped to, or "" when it is mapped to
// none. Mirrors discordActorTier()'s highest-wins precedence.
export function botRoleTier(roleId, botRoleMapping) {
  const wanted = String(roleId || "").trim();
  if (!wanted) return "";
  for (const tier of BOT_TIER_ORDER) {
    const mapped = botRoleMapping?.[BOT_TIER_ROLE_IDS_KEY[tier]] || [];
    if (mapped.some((id) => String(id || "").trim() === wanted)) return tier;
  }
  return "";
}

// Rank on TIER_ORDER, where "" (no access) always loses to a real tier.
function tierRank(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

// Roles whose BOT capability outranks the console access the same role grants.
// One entry per offending role: { roleId, botTier, consoleTier }, consoleTier
// "" meaning the console grants that role nothing at all -- the revoked-admin
// case. Empty when the two mappings are consistent.
//
// Only privileged bot tiers are reported (see BOT_PRIVILEGED_TIERS): a warning
// that fires for every read-only community role would be ignored, and being
// ignored is how the real one gets missed.
export function roleTierDrift(consoleRoleTiers, botRoleMapping) {
  const seen = new Set();
  const drift = [];
  for (const botTier of BOT_PRIVILEGED_TIERS) {
    for (const id of botRoleMapping?.[BOT_TIER_ROLE_IDS_KEY[botTier]] || []) {
      const roleId = String(id || "").trim();
      if (!roleId || seen.has(roleId)) continue;
      seen.add(roleId);
      // Re-resolve rather than trusting the loop's tier: a role listed under
      // both admin and moderator holds admin, and must be reported as such.
      const effectiveBotTier = botRoleTier(roleId, botRoleMapping);
      if (!BOT_PRIVILEGED_TIERS.includes(effectiveBotTier)) continue;
      const consoleTier = resolveRoleTier([roleId], consoleRoleTiers);
      if (tierRank(BOT_TIER_AS_CONSOLE_TIER[effectiveBotTier]) < tierRank(consoleTier)) {
        drift.push({ roleId, botTier: effectiveBotTier, consoleTier });
      }
    }
  }
  return drift;
}

export function describeRoleTierDrift(drift) {
  return drift.map((d) => (
    d.consoleTier
      ? `role ${d.roleId} is ${d.botTier} to the Discord bot but only ${d.consoleTier} on the console`
      : `role ${d.roleId} is ${d.botTier} to the Discord bot but has no console access`
  )).join("; ");
}
