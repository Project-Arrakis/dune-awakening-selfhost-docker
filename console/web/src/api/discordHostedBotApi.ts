import { api, post, ApiError } from "./client";

export type OwnedDiscordGuild = { id: string; name: string; owner: true };

// dune-awakening-selfhost-docker#853/mentat-link#183: the role-picker
// widget's own data shapes -- `color`/`position` come straight through from
// mentat's own guild.roles.cache mapping (setupServer.js), used for display
// ordering/swatches only, never for authorization.
export type HostedBotDiscordRole = { id: string; name: string; color: string; position: number };
export type HostedBotRolesResult = { roles: HostedBotDiscordRole[]; cacheStale: boolean };
export type HostedBotRoleTierConflict = { roleId?: string; currentTier?: string; requestedTier?: string } | null;
export type HostedBotSaveRolesResult =
  | { ok: true }
  | { ok: false; kind: "conflict"; conflict: HostedBotRoleTierConflict }
  | { ok: false; kind: "error"; message: string };

const OWNED_GUILDS_SESSION_STORAGE_KEY = "hostedBotOwnedGuilds";

export const discordHostedBotApi = {
  startOAuthUrl: () => "/api/integrations/discord/hosted-bot/oauth/start",
  // readOwnedGuilds: reads the owned-guilds list the OAuth callback page
  // (hostedBotOAuthReturnPage, hostedBotOAuth.js) stashed in sessionStorage
  // just before its own `window.location.replace("/")` navigation.
  // Renamed from readOwnedGuildsFromWindow (final integration review,
  // CRITICAL): that name and its `window.__hostedBotOwnedGuilds__` property
  // could never actually survive the real navigation -- a full document
  // navigation loads the SPA into a brand-new `window`, discarding whatever
  // property was set on the callback page's own window before this function
  // ever got a chance to read it. sessionStorage is scoped to the origin,
  // not to a `window` instance, so it survives. Single-read-then-clear
  // contract preserved: the key is removed as soon as it's read, so a
  // second call (e.g. a StrictMode double-invoke of a lazy initializer)
  // returns [] rather than replaying the same list.
  readOwnedGuilds: (): OwnedDiscordGuild[] => {
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(OWNED_GUILDS_SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(OWNED_GUILDS_SESSION_STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
  // guildName is included so Core can persist a human-readable label
  // alongside the registration (see adapterSettings.js's
  // persistHostedBotConnectedGuild) -- it is never used for authorization,
  // which is still decided server-side against the OAuth-verified
  // owned-guild id set, not against anything this call sends.
  register: (guildId: string, guildName: string, consoleUrl: string) => {
    return post<{ ok: boolean }>("/api/integrations/discord/hosted-bot/register", { guildId, guildName, consoleUrl });
  },
  // Phase 6 (dune-awakening-selfhost-docker#832/#865): kicks off the
  // fully-automated auto-invite flow. Returns the single Discord authorize
  // URL to open in a popup -- covering bot-install + ownership
  // re-verification in one consent screen, replacing the old flow's two
  // separate steps (Add to Discord, then Connect to hosted bot). Server
  // silently mints the adapter token / sets deploymentChoice on this call
  // (server.js's own comment), so there is no separate "Enable" step first.
  startAutoInvite: (consoleUrl: string) => {
    return post<{ authorizeUrl: string }>("/api/integrations/discord/hosted-bot/auto-invite/start", { consoleUrl });
  },
  // Round 4 (dune-awakening-selfhost-docker#876, design doc §13): the
  // completion-signal poll. Called repeatedly (every 10s) by
  // DiscordBotSection's own bounded polling loop while it shows "waiting
  // for owner" -- this is how Core ever learns the Discord owner actually
  // confirmed.
  pollConfirmationStatus: (confirmationId: string) => {
    return api<{ status: "pending" | "confirmed" | "denied" | "owner_changed" | "timed_out" | "not_found"; guildName?: string }>(
      `/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=${encodeURIComponent(confirmationId)}`
    );
  },
  // dune-awakening-selfhost-docker#853/mentat-link#183: the role-picker
  // widget's read side. `cacheStale: true` means the bot hasn't reconnected
  // to this guild's gateway cache yet -- the caller falls back to the
  // manual comma-separated-ID fields, never a blank/broken picker (design
  // doc §4.3/§6).
  fetchRoles: () => {
    return api<HostedBotRolesResult>("/api/integrations/discord/hosted-bot/roles");
  },
  // The write side. Unlike every other call in this module, this does NOT
  // use post() -- a 409 tier-conflict is a real, expected outcome the
  // picker must render as an inline validation error (design doc §4.7/§6),
  // and post()/api() collapse every non-2xx response into a generic thrown
  // Error, discarding the structured `conflict` body. Catches ApiError
  // specifically to recover it; any other thrown error (network failure,
  // 5xx, etc.) is surfaced as a generic message instead.
  saveRoles: async (roleIds: { playerRoleIds: string[]; moderatorRoleIds: string[]; adminRoleIds: string[] }): Promise<HostedBotSaveRolesResult> => {
    try {
      await post<{ applied: true }>("/api/integrations/discord/hosted-bot/roles", roleIds);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { conflict?: HostedBotRoleTierConflict } | null;
        return { ok: false, kind: "conflict", conflict: body?.conflict ?? null };
      }
      return { ok: false, kind: "error", message: err instanceof Error ? err.message : "Could not save this server's roles." };
    }
  }
};
