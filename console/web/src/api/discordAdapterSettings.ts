import { api, post } from "./client";
import type { Task } from "./setup";

export type DiscordBotSettingsState = {
  enabled: boolean;
  roleIds: { player: string[]; moderator: string[]; admin: string[] };
  tokenConfigured: boolean;
};

export const discordAdapterSettingsApi = {
  getState: () => api<DiscordBotSettingsState>("/api/settings/discord-bot"),
  enable: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string }) =>
    post<{ task: Task; token: string }>("/api/settings/discord-bot/enable", roleIds),
  updateRoleIds: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string }) =>
    post<{ task: Task }>("/api/settings/discord-bot/role-ids", roleIds),
  regenerateToken: () => post<{ ok: boolean; token: string }>("/api/settings/discord-bot/regenerate-token")
};
