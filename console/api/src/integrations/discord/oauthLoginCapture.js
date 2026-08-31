// #643 follow-up (live-testing finding): a normal (non-setup) Discord login
// that resolves to owner already proved guild ownership -- resolveOAuthTier()
// derives "owner" from this same identity.guilds[].owner flag -- so carry it
// forward as pendingDiscordSetup (identical shape to the setup-mode round-
// trip's own capture in server.js's handleOAuthCallback) instead of
// discarding it, letting /api/setup/discord-identity and
// discordSetupFinalize work without a second Discord round-trip. Any other
// tier gets null: settings:read/write are owner-only regardless (crown
// jewel), so there is nothing for a non-owner session to reuse this for.
//
// Deliberately its own module, not a function inside server.js: server.js
// starts listening on a real port as an unconditional side effect of being
// imported (`createServer(...).listen(config.port, ...)`), so it cannot be
// imported directly by a unit test without also starting a live server.
// Extracting this here lets the decision itself be unit-tested directly,
// rather than only proven indirectly through the settings:read route gate
// (which predates this change and would mask a regression here).
export function deriveLoginPendingDiscordSetup(tier, identity) {
  if (tier !== "owner") return null;
  return { userId: identity.userId, username: identity.username, mfaEnabled: identity.mfaEnabled, guilds: identity.guilds.filter((g) => g.owner), capturedAt: Date.now() };
}
