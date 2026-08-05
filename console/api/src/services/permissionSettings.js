// The game caps how many permission entries one actor (a base's claim totem)
// can hold. Read it from live server config rather than hardcoding: raising the
// cap must be a settings edit, not a code change.
//
// Precedence is deliberately the OPPOSITE of parseEffectiveGuildMemberLimit.
// The guild limit's legacy DuneGameMode field wins because an Advanced Editor
// profile can carry both forms. Here the shipped DefaultGame.ini defines
// m_MaxPermissionsPerActor=32 under [/Script/DuneSandbox.PermissionSettings] and
// carries no such key in the DuneGameMode section at all, so the canonical
// PermissionSettings field is the one the server actually enforces. Reading the
// legacy field first would inherit its 20 as the default and silently cap
// rosters below what the server permits.
const DEFAULT_MAX_PERMISSIONS_PER_ACTOR = 32;

export function parseEffectivePermissionLimit(stdout) {
  const values = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }

  const raw = values.get("permission_max_permissions_per_actor")
    || values.get("max_permissions_per_actor")
    || String(DEFAULT_MAX_PERMISSIONS_PER_ACTOR);
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) {
    throw new Error("The configured maximum permissions per base is invalid.");
  }
  return limit;
}

export { DEFAULT_MAX_PERMISSIONS_PER_ACTOR };
