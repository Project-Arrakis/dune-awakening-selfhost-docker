// Console-native Discord role -> tier resolution (rfc-console-auth.md §2.1.1).
//
// The operator maps guild role IDs to console tiers in Settings (or .env);
// at sign-in the console reads the member's own roles for the home guild via
// the user's OAuth token (guilds.members.read) and takes the highest mapped
// tier. Pure functions, no I/O, so the precedence and parsing rules are
// testable in isolation and the resolver in oauth.js stays small.

export const TIER_ORDER = ["owner", "admin", "moderator", "player", "observer"];
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
  return TIER_ORDER.some((tier) => Array.isArray(roleTiers?.[tier]) && roleTiers[tier].length > 0);
}

// Highest tier whose mapped roles intersect the member's roles, or "" when
// none do. Order is explicit and never derived from object key order.
export function resolveRoleTier(memberRoleIds, roleTiers) {
  const held = new Set(Array.isArray(memberRoleIds) ? memberRoleIds.map(String) : []);
  if (!held.size) return "";
  for (const tier of TIER_ORDER) {
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
