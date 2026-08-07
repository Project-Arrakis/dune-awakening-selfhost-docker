import { api, post } from "./client";

type GuildMutationResult = { supported: boolean; result?: Record<string, unknown>; reason?: string };

export const guildsApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page !== undefined) search.set("page", String(params.page));
    if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<{ rows: Record<string, unknown>[]; totalCount: number; totalGuilds: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/guilds${qs ? `?${qs}` : ""}`);
  },
  members: (guildId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/guilds/${encodeURIComponent(guildId)}/members`),
  promote: (guildId: string, playerId: string) =>
    post<GuildMutationResult>(`/api/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(playerId)}/promote`),
  demote: (guildId: string, playerId: string) =>
    post<GuildMutationResult>(`/api/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(playerId)}/demote`),
  addMember: (guildId: string, playerId: string, roleId: number) =>
    post<GuildMutationResult>(`/api/guilds/${encodeURIComponent(guildId)}/members`, { playerId, roleId }),
  removeMember: (guildId: string, playerId: string) =>
    api<GuildMutationResult>(`/api/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(playerId)}`, { method: "DELETE" }),
  disband: (guildId: string, confirmation: string) =>
    api<GuildMutationResult>(`/api/guilds/${encodeURIComponent(guildId)}`, { method: "DELETE", body: JSON.stringify({ confirmation }) })
};
