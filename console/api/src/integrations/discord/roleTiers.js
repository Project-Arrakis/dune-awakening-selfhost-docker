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
  return resolveRoleTierDetailed(memberRoleIds, roleTiers).tier;
}

// Same precedence as resolveRoleTier, but also reports which role ID decided
// the winning tier (F3, #573: the console shows that role's operator-given
// name next to the tier). If two role IDs under the same tier are both held,
// the one listed first in that tier's config wins -- deterministic, since
// Discord gives no natural priority between two same-tier roles.
export function resolveRoleTierDetailed(memberRoleIds, roleTiers) {
  const held = new Set(Array.isArray(memberRoleIds) ? memberRoleIds.map(String) : []);
  if (!held.size) return { tier: "", roleId: "" };
  for (const tier of ROLE_MAPPABLE_TIERS) {
    const mapped = roleTiers?.[tier] || [];
    const roleId = mapped.map(String).find((id) => held.has(id));
    if (roleId) return { tier, roleId };
  }
  return { tier: "", roleId: "" };
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

// ---- Role display names (F3, #573) ----
//
// An operator-typed { roleId: name } label map, keyed by role ID (not tier --
// a tier field may map several role IDs, per ROLE_MAPPABLE_TIERS above, and
// each needs its own label). Stored as base64url in DISCORD_CONSOLE_ROLE_NAMES
// deliberately: a raw JSON object literal does not round-trip through this
// codebase's .env quoting (services/envFile.js's quoteEnv escapes quote
// characters that parseEnvLine's reader does not unescape -- reproduced
// directly during the L1 design audit). Base64url's alphabet is a strict
// subset of what quoteEnv already leaves unescaped, so it passes through
// unchanged.
export const MAX_ROLE_NAME_LENGTH = 100;
export const MAX_ROLE_NAMES_ENTRIES = 50;
const DANGEROUS_ROLE_NAME_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Write-time validation: used both to reject a bad Settings-UI submission
// (400, actionable reason) and, via decodeRoleNamesSafe below, to re-validate
// whatever is already on disk at read time.
export function validateRoleNamesMap(value) {
  if (value === null || value === undefined || value === "") return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "must be a JSON object mapping Discord role IDs to names" };
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ROLE_NAMES_ENTRIES) {
    return { ok: false, reason: `at most ${MAX_ROLE_NAMES_ENTRIES} role names are allowed` };
  }
  const clean = {};
  for (const [roleId, name] of entries) {
    // Explicit denylist, even though SNOWFLAKE_RE below already rejects these
    // three (none are all-digit 17-19 char strings) -- defense in depth against
    // a future loosening of the snowflake check, not load-bearing today.
    if (DANGEROUS_ROLE_NAME_KEYS.has(roleId)) return { ok: false, reason: `invalid role id key: ${roleId}` };
    if (!SNOWFLAKE_RE.test(roleId)) return { ok: false, reason: `invalid Discord role id: ${roleId}` };
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_ROLE_NAME_LENGTH) {
      return { ok: false, reason: `role name for ${roleId} must be 1-${MAX_ROLE_NAME_LENGTH} characters` };
    }
    clean[roleId] = name;
  }
  return { ok: true, value: clean };
}

export function encodeRoleNames(map) {
  return Buffer.from(JSON.stringify(map || {}), "utf8").toString("base64url");
}

// Read-time (config load): fails safe to {} on ANY error -- decode failure,
// malformed JSON, or a shape that fails validateRoleNamesMap -- a corrupted
// or hand-edited value must never crash console boot (L1 audit, Security
// Architect HIGH finding: this is a purely cosmetic feature and must never
// be riskier than what it replaces).
export function decodeRoleNamesSafe(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    const result = validateRoleNamesMap(parsed);
    return result.ok ? result.value : {};
  } catch {
    return {};
  }
}
