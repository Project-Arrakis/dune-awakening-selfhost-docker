import { api, post } from "./client";
import type { Task } from "./setup";

export type DiscordBotSettingsState = {
  enabled: boolean;
  roleIds: { player: string[]; moderator: string[]; admin: string[] };
  tokenConfigured: boolean;
  // Task 2 (hosted-bot console-initiated OAuth registration plan): the
  // real, persisted, server-readable source of truth for the hosted/
  // self-hosted `choice` toggle -- null when never set. Superset of what
  // the frontend used to hold only in localStorage.
  deploymentChoice?: "hosted" | "self-hosted" | null;
  // Final integration review (Important #5): persisted by the /register
  // route (server.js) on a successful mentat response, via
  // adapterSettings.js's persistHostedBotConnectedGuild() -- lets
  // DiscordBotSection show a real "Connected to hosted bot for {name}"
  // across a page reload instead of losing that state the moment the
  // in-memory React state is gone.
  hostedBotConnectedGuildId?: string | null;
  hostedBotConnectedGuildName?: string | null;
};

export const discordAdapterSettingsApi = {
  getState: () => api<DiscordBotSettingsState>("/api/settings/discord-bot"),
  // Real UAT finding (2026-09-09): enable() used to also trigger the
  // console restart in the same call, so a freshly-minted token could
  // only ever be shown at the exact moment the restart was already under
  // way. It now only persists config (.env + token file) and mints the
  // token -- restart() below is a separate, explicit call the frontend
  // makes only once the operator has had a chance to see/copy the token.
  // token is optional: the server omits it entirely when nothing was
  // minted (the already-enabled/role-ids-only path through
  // applyDiscordBotEnableRequest() -- see server.js's /enable handler,
  // which only sets `responseBody.token` when `result.tokenMinted`).
  enable: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ token?: string }>("/api/settings/discord-bot/enable", roleIds),
  updateRoleIds: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ task: Task }>("/api/settings/discord-bot/role-ids", roleIds),
  regenerateToken: () => post<{ ok: boolean; token: string }>("/api/settings/discord-bot/regenerate-token", {}),
  // Triggers the actual console restart that applies whatever /enable or
  // /role-ids just persisted -- see those handlers' own comments in
  // server.js for why this is now a separate call.
  restart: () => post<{ task: Task }>("/api/settings/discord-bot/restart", {})
};
