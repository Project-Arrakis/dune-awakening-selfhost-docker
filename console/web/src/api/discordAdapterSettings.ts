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
};

export const discordAdapterSettingsApi = {
  getState: () => api<DiscordBotSettingsState>("/api/settings/discord-bot"),
  // token is optional: the server omits it entirely when nothing was
  // minted (the already-enabled/role-ids-only path through
  // applyDiscordBotEnableRequest() -- see server.js's /enable handler,
  // which only sets `responseBody.token` when `result.tokenMinted`).
  enable: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ task: Task; token?: string }>("/api/settings/discord-bot/enable", roleIds),
  updateRoleIds: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ task: Task }>("/api/settings/discord-bot/role-ids", roleIds),
  regenerateToken: () => post<{ ok: boolean; token: string }>("/api/settings/discord-bot/regenerate-token", {})
};
