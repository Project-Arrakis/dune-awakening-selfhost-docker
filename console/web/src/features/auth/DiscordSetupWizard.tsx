import { useEffect, useState } from "react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";

// First-run Discord sign-in setup (docs/rfc-console-auth.md §2.1.1). Five steps
// on one screen, gated in order: connect the application, authorize with
// Discord (setup mode -- mints no session), choose the server, map roles, save.
// Owner is never chosen here: it is whoever Discord says owns the chosen server.

type Guild = { id: string; name: string; owner: boolean };
type Identity = { user: { id: string; username: string; mfaEnabled: boolean }; guilds: Guild[] };
type Props = { onDone: () => void; onCancel: () => void; initialClientId?: string; initialRedirectUri?: string; secretSaved?: boolean };

const SNOWFLAKE = /^\d{17,19}$/;

export function DiscordSetupWizard({ onDone, onCancel, initialClientId = "", initialRedirectUri = "", secretSaved = false }: Props) {
  const defaultRedirect = `${window.location.origin}/api/auth/discord/callback`;
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(initialRedirectUri || defaultRedirect);
  const [appSaved, setAppSaved] = useState(Boolean(initialClientId && initialRedirectUri && secretSaved));
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [guildId, setGuildId] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [requireMfa, setRequireMfa] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Returning from the Discord round-trip: pick up the captured identity.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("discordSetup")) return;
    api<Identity>("/api/setup/discord-identity")
      .then((res) => { setIdentity(res); setAppSaved(true); const owned = res.guilds.find((g) => g.owner); if (owned) setGuildId(owned.id); })
      .catch(() => setError("Discord did not hand back an identity. Click Continue with Discord again."));
    window.history.replaceState({}, "", "/");
  }, []);

  async function saveApp() {
    setBusy(true); setError("");
    try {
      if (!SNOWFLAKE.test(clientId.trim())) throw new Error("Client ID should be the 17-19 digit application ID from the Developer Portal.");
      await post("/api/setup/write-oauth-config", { DISCORD_OAUTH_CLIENT_ID: clientId.trim(), DISCORD_OAUTH_REDIRECT_URI: redirectUri.trim() });
      if (clientSecret) { await post("/api/setup/save-oauth-secret", { secret: clientSecret, overwrite: true }); setClientSecret(""); }
      else if (!secretSaved) throw new Error("Paste the Client Secret from the Developer Portal.");
      setAppSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function saveMapping() {
    setBusy(true); setError("");
    try {
      if (!SNOWFLAKE.test(guildId)) throw new Error("Choose the Discord server.");
      const bad = [adminRoleIds, moderatorRoleIds, playerRoleIds].flatMap((v) => v.split(",").map((x) => x.trim()).filter(Boolean)).filter((x) => !SNOWFLAKE.test(x));
      if (bad.length) throw new Error(`Not a Discord role ID: ${bad.join(", ")}`);
      if (!adminRoleIds.trim()) throw new Error("Map an Admin role, or only the server owner will be able to use the console through Discord.");
      await post("/api/setup/write-oauth-config", {
        DISCORD_HOME_GUILD_ID: guildId,
        DISCORD_CONSOLE_ADMIN_ROLE_IDS: adminRoleIds.trim(),
        DISCORD_CONSOLE_MODERATOR_ROLE_IDS: moderatorRoleIds.trim(),
        DISCORD_CONSOLE_PLAYER_ROLE_IDS: playerRoleIds.trim(),
        DISCORD_OAUTH_REQUIRE_MFA_TIERS: requireMfa ? "owner,admin" : "",
        DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0"
      });
      setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const chosen = identity?.guilds.find((g) => g.id === guildId) || null;
  const iAmOwner = Boolean(chosen?.owner);

  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">
        <h1>Set up Discord sign-in</h1>
        <p className="muted">People will sign in with Discord and get console access from their roles in your server. The server's owner is automatically the console owner. Your admin password keeps working as the way back in.</p>

        <h2 className="recovery-codes-heading">1. Connect the Discord application</h2>
        <p className="muted">Create one at <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a> (or reuse the one your bot uses). Under <strong>OAuth2</strong>, add this exact Redirect URI, then copy the Client ID and a Client Secret.</p>
        <label htmlFor="wiz-redirect">Redirect URI to register<span className="field-label-row"><input id="wiz-redirect" name="wiz-redirect" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} disabled={busy || appSaved} /><button type="button" className="login-password-toggle" onClick={() => { void navigator.clipboard?.writeText(redirectUri); }}>copy</button></span></label>
        <label htmlFor="wiz-client-id">Client ID<input id="wiz-client-id" name="wiz-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Application ID" disabled={busy || appSaved} inputMode="numeric" /></label>
        <label htmlFor="wiz-client-secret">Client Secret{secretSaved && !clientSecret ? <span className="theme-note"> (saved)</span> : null}<SecretInput id="wiz-client-secret" name="wiz-client-secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={secretSaved ? "Paste a new one to replace" : "Client secret"} disabled={busy || appSaved} /></label>
        {!appSaved ? <button type="button" disabled={busy} onClick={() => { void saveApp(); }}>{busy ? "Saving..." : "Save application"}</button>
          : <p className="muted">Application saved. <button type="button" className="login-password-toggle" onClick={() => setAppSaved(false)}>edit</button></p>}

        <h2 className="recovery-codes-heading">2. Continue with Discord</h2>
        <p className="muted">Discord will ask you to authorize the application so the console can see who you are, which servers you are in, and your roles in the one you pick. Nothing is signed in yet.</p>
        {identity
          ? <p className="muted">Connected as <strong>{identity.user.username}</strong>{identity.user.mfaEnabled ? "" : " — this Discord account has no two-factor authentication; if you require it for owners below, enable it in Discord before signing in."}</p>
          : <a className={`login-discord-button login-discord-button-primary${appSaved ? "" : " disabled"}`} href={appSaved ? "/api/auth/discord/start?setup=1" : undefined} aria-disabled={!appSaved}>Continue with Discord</a>}

        <h2 className="recovery-codes-heading">3. Choose the server</h2>
        <label htmlFor="wiz-guild">Discord server<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={!identity || busy || saved}>
          <option value="">{identity ? "Choose…" : "Continue with Discord first"}</option>
          {identity?.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}{g.owner ? " — you own this server" : ""}</option>)}
        </select></label>
        {chosen && (iAmOwner
          ? <p className="muted">You own <strong>{chosen.name}</strong>, so you will be the console <strong>Owner</strong> when you sign in with Discord.</p>
          : <p className="attention-text">You do not own <strong>{chosen.name}</strong>. Its owner will be the console Owner; you will get whatever your roles map to below.</p>)}

        <h2 className="recovery-codes-heading">4. Map roles to access levels</h2>
        <p className="muted">Copy role IDs from Discord with Developer Mode on (User Settings &rarr; Advanced), then right-click a role &rarr; Copy Role ID. One or more per field, comma-separated. A person with several mapped roles gets the highest. <strong>Owner is not a role</strong> — it is the server&apos;s owner.</p>
        <label htmlFor="wiz-admin">Admin Role <em>(required)</em><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord role ID" disabled={!identity || busy || saved} /></label>
        <label htmlFor="wiz-moderator">Moderator Role <em>(optional)</em><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord role ID" disabled={!identity || busy || saved} /></label>
        <label htmlFor="wiz-player">Player Role <em>(recommended)</em><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord role ID" disabled={!identity || busy || saved} /></label>
        <label className="totp-ack-checkbox" htmlFor="wiz-mfa"><input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={!identity || busy || saved} /> Require two-factor on the Discord account for Owner and Admin (recommended)</label>

        <h2 className="recovery-codes-heading">5. Save and restart</h2>
        {!saved
          ? <button type="button" disabled={!identity || busy} onClick={() => { void saveMapping(); }}>{busy ? "Saving..." : "Save Discord sign-in"}</button>
          : <p className="attention-text">Saved. Run <code>dune console restart</code> on the host. After it comes back, the sign-in page shows <strong>Sign in with Discord</strong>, with the admin password underneath as the way back in.</p>}
        {error && <p className="error">{error}</p>}
        <button type="button" className="login-password-toggle" onClick={saved ? onDone : onCancel}>{saved ? "Back to sign in" : "Cancel"}</button>
      </section>
    </main>
  );
}
