const DEFAULT_GUILD_MEMBER_LIMIT = 32;

export function parseEffectiveGuildMemberLimit(stdout) {
  const values = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }

  // The legacy DuneGameMode field has effective precedence when an Advanced Editor profile
  // contains both forms. Normal Console edits mirror it to the canonical GuildSettings field.
  const raw = values.get("max_guild_members_allowed")
    || values.get("guild_settings_max_guild_members_allowed")
    || String(DEFAULT_GUILD_MEMBER_LIMIT);
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) {
    throw new Error("The configured maximum guild member count is invalid.");
  }
  return limit;
}
