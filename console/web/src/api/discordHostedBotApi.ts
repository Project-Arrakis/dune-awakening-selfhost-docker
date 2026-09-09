export type OwnedDiscordGuild = { id: string; name: string; owner: true };

export const discordHostedBotApi = {
  startOAuthUrl: () => "/api/integrations/discord/hosted-bot/oauth/start",
  readOwnedGuildsFromWindow: (): OwnedDiscordGuild[] => {
    const w = window as unknown as { __hostedBotOwnedGuilds__?: OwnedDiscordGuild[] };
    const guilds = w.__hostedBotOwnedGuilds__ ?? [];
    delete w.__hostedBotOwnedGuilds__;
    return guilds;
  },
  register: (guildId: string, consoleUrl: string) => {
    return import("./client").then(({ post }) => post<{ ok: boolean }>("/api/integrations/discord/hosted-bot/register", { guildId, consoleUrl }));
  }
};
