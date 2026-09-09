import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { discordAdapterEnabled, discordRoleMappingFromEnv } from "./adapter.js";
import { readDiscordBotApiToken } from "./routes.js";
import { updateEnvFileValues } from "../../services/envFile.js";

const SNOWFLAKE_PATTERN = /^\d{15,21}$/;
const DEFAULT_TOKEN_FILE = "runtime/secrets/discord-adapter-token.txt";

// Global Constraint: this is the server-side hardcoded set of .env keys
// this feature is ever allowed to write. The env-key name is never derived
// from a request-body field name (Layer 1 Security Architect audit finding).
const MANAGED_ENV_KEYS = Object.freeze({
  enabled: "DUNE_DISCORD_ADAPTER_ENABLED",
  tokenFile: "DUNE_DISCORD_ADAPTER_TOKEN_FILE",
  // directToken: readDiscordBotApiToken() (routes.js) checks this direct
  // value BEFORE the token file -- a real, documented manual-setup path.
  // Audit finding #4 (HIGH): enableDiscordBotAdapter()/
  // regenerateDiscordBotToken() must clear it whenever they mint a fresh
  // file-based token, or an operator who set it directly would be shown a
  // fresh, plausible-looking token that the live adapter never actually
  // authenticates against, because the untouched direct var keeps winning.
  directToken: "DUNE_DISCORD_ADAPTER_TOKEN",
  player: "DISCORD_PLAYER_ROLE_IDS",
  moderator: "DISCORD_MODERATOR_ROLE_IDS",
  admin: "DISCORD_ADMIN_ROLE_IDS"
});

export function validateDiscordRoleIds(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return { ok: true, roleIds: [] };
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = parts.filter((part) => !SNOWFLAKE_PATTERN.test(part));
  if (invalid.length) return { ok: false, error: `Invalid Discord role ID(s): ${invalid.join(", ")}. Expected 15-21 digit numeric IDs.` };
  return { ok: true, roleIds: parts };
}

export function readDiscordBotSettingsState(config) {
  const mapping = discordRoleMappingFromEnv();
  const token = readDiscordBotApiToken(config);
  return {
    enabled: discordAdapterEnabled(config),
    roleIds: {
      player: mapping.playerRoleIds,
      moderator: mapping.moderatorRoleIds,
      admin: mapping.adminRoleIds
    },
    tokenConfigured: Boolean(token)
  };
}

// enableDiscordBotAdapter: validates role IDs, generates a fresh token
// (Layer 1 Security Architect audit finding -- "Enable" always overwrites,
// never conditionally reuses an abandoned manual attempt's file), writes
// the secret file, then flushes every managed .env key in one atomic
// updateEnvFileValues() call. Does NOT launch the recreate helper itself --
// the caller (the route handler) does that via tasks.create(), after this
// function returns successfully, matching the "write everything, then
// launch" ordering the design requires. Returns the plaintext token so the
// route handler can hand it to the frontend exactly once, immediately
// after generation (Design §3.1's "masked, with reveal/copy" requirement)
// -- readDiscordBotSettingsState() never returns it on subsequent reads,
// since the token file's own content is the only persistent copy.
export function enableDiscordBotAdapter(config, roleIdsByTier = {}) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}

  updateEnvFileValues(repoRoot, [
    [MANAGED_ENV_KEYS.enabled, "true"],
    [MANAGED_ENV_KEYS.tokenFile, DEFAULT_TOKEN_FILE],
    // Clear any direct manual-setup token -- see MANAGED_ENV_KEYS.directToken's
    // own comment for why (audit finding #4).
    [MANAGED_ENV_KEYS.directToken, ""],
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ]);

  return { ok: true, tokenFile: DEFAULT_TOKEN_FILE, token };
}

// updateDiscordBotRoleIds: writes ONLY the 3 role-ID env keys, via the
// same atomic updateEnvFileValues() call, and never touches the token file
// or the enabled flag. This is deliberately a separate function from
// enableDiscordBotAdapter() above, not a code path inside it -- an admin
// editing role IDs on an already-enabled adapter must never, as a side
// effect, mint a fresh token and silently break the live bot (found during
// this plan's own self-review: the first draft had the frontend's "Save
// Role IDs" button call the same enable path, which would have rotated the
// token on every role-ID edit). Still triggers the recreate helper (the
// caller does that, same as enableDiscordBotAdapter) because role IDs are
// only read from the environment at container start.
export function updateDiscordBotRoleIds(config, roleIdsByTier = {}) {
  updateEnvFileValues(config.repoRoot, [
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ]);
  return { ok: true };
}

// regenerateDiscordBotToken: rewrites the token FILE (its content only --
// the file PATH in .env is untouched, no recreate helper launched; Layer 1
// Cloud Security + Security Architect audit finding -- the token file's
// CONTENT is read fresh on every request by readDiscordBotApiToken(), so a
// container recreate is never needed for this specific operation), and
// ALSO clears any direct DUNE_DISCORD_ADAPTER_TOKEN value in .env (audit
// finding #4, HIGH -- see MANAGED_ENV_KEYS.directToken's comment: without
// this, an operator who set that var manually would be shown a fresh
// token that never actually becomes authoritative, because the untouched
// direct var still wins in readDiscordBotApiToken()'s precedence order).
// Returns the plaintext token for the same one-time-display reason as
// enableDiscordBotAdapter() above.
export function regenerateDiscordBotToken(config) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  if (!existsSync(dirname(tokenFile))) mkdirSync(dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}
  updateEnvFileValues(repoRoot, [[MANAGED_ENV_KEYS.directToken, ""]]);
  return { ok: true, token };
}
