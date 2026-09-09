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

  // Mirror the two values every other part of this feature reads directly
  // from process.env into the RUNNING process too. Writing .env on disk
  // does NOT change what an already-running Node process sees -- .env is
  // only ever re-read at container start; a write to the file alone has
  // no effect here until the queued recreate task (launched by the route
  // handler, after this function returns) finishes.
  //
  // Audit finding #1 residual gap (second review round): without mirroring
  // `enabled`, discordAdapterEnabled() keeps evaluating false in THIS
  // process until that recreate completes, so a second /enable POST
  // arriving in the race window before it still mints a SECOND fresh
  // token -- reproducing finding #1's original bug inside a narrower
  // window instead of closing it.
  //
  // Audit finding #4 residual gap: without mirroring the cleared direct
  // token, readDiscordBotApiToken() (which also reads process.env
  // directly) keeps returning a stale, already-loaded direct value in
  // this process until that same recreate completes.
  //
  // Found while adding route-level integration coverage: the same
  // staleness applies to the token FILE PATH itself. readDiscordBotApiToken()
  // reads process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE directly, so without
  // mirroring it here too, a fresh install's first-ever enable would write
  // the path to .env on disk but leave THIS process's own process.env
  // without it -- readDiscordBotSettingsState() would keep reporting
  // tokenConfigured:false (and the live adapter route would keep reporting
  // the credential as not configured) until a restart, even though the
  // token file was just written. Mirror the resolved ABSOLUTE path (the
  // same `tokenFile` this function just wrote to), not the relative
  // DEFAULT_TOKEN_FILE constant written to .env -- readDiscordBotApiToken()
  // reads this value with a bare readFileSync(), no resolve() against
  // repoRoot, so a relative value here would only work by accident of the
  // process's current working directory happening to already be repoRoot.
  //
  // Same reasoning applies to the 3 role-ID keys: discordRoleMappingFromEnv()
  // (adapter.js) also reads process.env directly. Without mirroring them
  // here, a GET of the settings state in this same process, in the window
  // before the queued console restart completes, would report the role IDs
  // from BEFORE this call, not what was just submitted.
  process.env[MANAGED_ENV_KEYS.enabled] = "true";
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  process.env[MANAGED_ENV_KEYS.tokenFile] = tokenFile;
  process.env[MANAGED_ENV_KEYS.player] = (roleIdsByTier.player || []).join(",");
  process.env[MANAGED_ENV_KEYS.moderator] = (roleIdsByTier.moderator || []).join(",");
  process.env[MANAGED_ENV_KEYS.admin] = (roleIdsByTier.admin || []).join(",");

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
  // Mirror into the RUNNING process too, for the same reason
  // enableDiscordBotAdapter() does -- discordRoleMappingFromEnv() reads
  // process.env directly, so without this a GET of the settings state in
  // this same process, in the window before the queued console restart
  // completes, would report the role IDs from before this save. This is
  // the function an admin editing role IDs on an already-live adapter
  // actually goes through, so it's the more commonly hit path in practice.
  process.env[MANAGED_ENV_KEYS.player] = (roleIdsByTier.player || []).join(",");
  process.env[MANAGED_ENV_KEYS.moderator] = (roleIdsByTier.moderator || []).join(",");
  process.env[MANAGED_ENV_KEYS.admin] = (roleIdsByTier.admin || []).join(",");
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
  // Mirror into the RUNNING process too -- see enableDiscordBotAdapter()'s
  // equivalent comment above for why. This function deliberately never
  // triggers a container recreate (the token file's content is read fresh
  // per request, so no recreate should be needed), which means NOTHING
  // else will ever refresh process.env for this var. Without this line,
  // an operator who previously set DUNE_DISCORD_ADAPTER_TOKEN directly
  // would have the newly-shown token silently ignored forever by this
  // already-running process (audit finding #4 residual gap).
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  return { ok: true, token };
}

// applyDiscordBotEnableRequest: the token-safety fix for the /enable
// route -- audit finding #1 (CRITICAL). A bare POST to /enable used to
// call enableDiscordBotAdapter() unconditionally, which always mints a
// fresh token, regardless of whether the adapter was already enabled.
// /enable is gated by updates:apply (admin-reachable), while token
// regeneration is deliberately scoped to the owner-only
// settings:discord-bot-regenerate-token action specifically because
// rotation is disruptive/irreversible -- an admin re-POSTing /enable
// (e.g. the frontend's "Save" on an already-enabled adapter) could
// silently re-mint the live token, achieving the exact effect that gate
// exists to reserve for owner.
//
// Once the adapter is already enabled, this routes the request through
// updateDiscordBotRoleIds() (the token-safe function) instead --
// repeat calls to /enable then behave exactly like /role-ids: safe,
// idempotent, no silent token rotation. A genuine first-time enable
// (from disabled) still goes through enableDiscordBotAdapter() and
// mints a token. tokenMinted tells the route handler whether to include
// `token` in its response.
export function applyDiscordBotEnableRequest(config, roleIdsByTier = {}) {
  if (discordAdapterEnabled(config)) {
    const result = updateDiscordBotRoleIds(config, roleIdsByTier);
    return { ok: result.ok, tokenMinted: false };
  }
  const result = enableDiscordBotAdapter(config, roleIdsByTier);
  return { ok: result.ok, tokenMinted: true, token: result.token, tokenFile: result.tokenFile };
}

// discordAdminRoleIdsChanged: order-independent set comparison used by
// the /enable and /role-ids route handlers to decide whether a request
// is attempting to change which Discord roles map to the "admin"
// bot-command tier -- audit finding #2 (HIGH). Per policy.js, that tier
// grants nearly every non-self-scoped bot capability; before this
// feature, DISCORD_ADMIN_ROLE_IDS was read-only from .env (no route
// ever wrote it), so an admin-tier console operator could not
// previously grant Discord-bot-admin capability to an arbitrary Discord
// role. A request that only touches player/moderator role IDs (this
// returns false) remains admin-reachable as before.
export function discordAdminRoleIdsChanged(currentAdminRoleIds, requestedAdminRoleIds) {
  const current = new Set((currentAdminRoleIds || []).map(String));
  const requested = new Set((requestedAdminRoleIds || []).map(String));
  if (current.size !== requested.size) return true;
  for (const id of requested) {
    if (!current.has(id)) return true;
  }
  return false;
}
