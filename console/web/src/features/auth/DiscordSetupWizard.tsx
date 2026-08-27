import { useEffect, useState } from "react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";

// Guided Discord sign-in setup (docs/rfc-console-auth.md §2.1.1).
//
// Reached only by the console owner (admin password first -- otherwise anyone
// who owns some Discord server could point this console at it). From there the
// operator AUTHENTICATES; they do not create anything: Continue with Discord ->
// everything Discord can tell us is filled in (who you are, your servers, the
// one you own = Owner) -> type the role IDs -> confirm with the admin password
// as fresh proof. The Discord application is deployment configuration (like a
// bot's); it is mentioned only when the install has none yet.

type Guild = { id: string; name: string; owner: boolean };
type Identity = { user: { id: string; username: string; mfaEnabled: boolean }; guilds: Guild[]; requiresPassword?: boolean };
type Props = { appConfigured: boolean; onDone: () => void; onCancel: () => void };

const SNOWFLAKE = /^\d{17,19}$/;

export function DiscordSetupWizard({ appConfigured, onDone, onCancel }: Props) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [guildId, setGuildId] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [requireMfa, setRequireMfa] = useState(true);
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ guild: string; owner: string } | null>(null);
  // Prerequisite fallback (install with no application configured; owner only).
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri] = useState(`${window.location.origin}/api/auth/discord/callback`);
  const [appSaved, setAppSaved] = useState(appConfigured);

  // What the host already has (client ID / redirect / a saved secret), so the
  // one-time step asks only for what is actually missing -- normally nothing,
  // or just the secret.
  const [have, setHave] = useState<{ clientId: string; redirectUri: string; secretSaved: boolean } | null>(null);
  useEffect(() => {
    if (appConfigured) return;
    api<{ serverConfig?: Record<string, string> }>("/api/settings")
      .then((res) => {
        const c = res.serverConfig || {};
        setHave({ clientId: c["DISCORD_OAUTH_CLIENT_ID"] || "", redirectUri: c["DISCORD_OAUTH_REDIRECT_URI"] || "", secretSaved: Boolean(c["_discordOAuthSecretSaved"]) });
        if (c["DISCORD_OAUTH_CLIENT_ID"]) setClientId(c["DISCORD_OAUTH_CLIENT_ID"]);
      })
      .catch(() => setHave({ clientId: "", redirectUri: "", secretSaved: false }));
  }, [appConfigured]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("discordSetup")) return;
    api<Identity>("/api/setup/discord-identity")
      .then((res) => { setIdentity(res); const owned = res.guilds.find((g) => g.owner); if (owned) setGuildId(owned.id); })
      .catch(() => setError("Discord did not hand back an identity. Click Continue with Discord again."));
    window.history.replaceState({}, "", "/");
  }, []);

  async function saveApp() {
    setBusy(true); setError("");
    try {
      if (!SNOWFLAKE.test(clientId.trim())) throw new Error("Client ID should be the 17-19 digit application ID.");
      if (!clientSecret) throw new Error("Paste the client secret.");
      const patch: Record<string, string> = {};
      if (clientId.trim() !== (have?.clientId || "")) patch.DISCORD_OAUTH_CLIENT_ID = clientId.trim();
      if (!have?.redirectUri) patch.DISCORD_OAUTH_REDIRECT_URI = redirectUri;
      if (Object.keys(patch).length) await post("/api/setup/write-oauth-config", patch);
      await post("/api/setup/save-oauth-secret", { secret: clientSecret, overwrite: true });
      setClientSecret(""); setAppSaved(true);
      setError("Saved. The console reads this at startup: run `dune console restart` on the host, then come back here and click Continue with Discord.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function finalize() {
    setBusy(true); setError("");
    try {
      if (!SNOWFLAKE.test(guildId)) throw new Error("Choose your Discord server.");
      if (!adminRoleIds.trim()) throw new Error("Map an Admin role, or only you (the server owner) will be able to use the console through Discord.");
      const bad = [adminRoleIds, moderatorRoleIds, playerRoleIds].flatMap((v) => v.split(",").map((x) => x.trim()).filter(Boolean)).filter((x) => !SNOWFLAKE.test(x));
      if (bad.length) throw new Error(`Not a Discord role ID: ${bad.join(", ")}`);
      if (!adminPassword) throw new Error("Enter the admin password to confirm.");
      const res = await post<{ ok: boolean; guild: { name: string }; owner: { username: string } }>("/api/setup/discord-finalize", {
        adminPassword, guildId, adminRoleIds: adminRoleIds.trim(), moderatorRoleIds: moderatorRoleIds.trim(), playerRoleIds: playerRoleIds.trim(), requireMfa
      });
      setAdminPassword("");
      setDone({ guild: res.guild.name, owner: res.owner.username });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const chosen = identity?.guilds.find((g) => g.id === guildId) || null;
  const owned = identity?.guilds.filter((g) => g.owner) || [];

  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">
        <h1>Set up Discord sign-in</h1>

        {!appSaved && have && (
          <>
            {have.clientId && have.redirectUri ? (
              <p className="muted">This console already knows its Discord application (client ID <code>{have.clientId}</code>{"\u2009"}&mdash; the same one your bot uses). It just has not been given the application&apos;s <strong>client secret</strong> yet. Paste it once here, or put it on the host at <code>runtime/secrets/discord-oauth-client-secret.txt</code> and restart.</p>
            ) : (
              <p className="attention-text">This console has not been told which Discord application it belongs to. It is the same application your bot uses (or any application whose OAuth2 redirect list includes <code>{redirectUri}</code> <button type="button" className="login-password-toggle" onClick={() => { void navigator.clipboard?.writeText(redirectUri); }}>copy</button>). This is a one-time deployment detail, like a bot token: set <code>DISCORD_OAUTH_CLIENT_ID</code>, <code>DISCORD_OAUTH_CLIENT_SECRET</code> and <code>DISCORD_OAUTH_REDIRECT_URI</code> in <code>.env</code> and restart, or enter them here once.</p>
            )}
            {!(have.clientId) && <label htmlFor="wiz-client-id">Client ID<input id="wiz-client-id" name="wiz-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Application ID" disabled={busy} inputMode="numeric" /></label>}
            <label htmlFor="wiz-client-secret">Client secret<SecretInput id="wiz-client-secret" name="wiz-client-secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" disabled={busy} /></label>
            <button type="button" disabled={busy} onClick={() => { void saveApp(); }}>{busy ? "Saving..." : "Save and continue"}</button>
          </>
        )}
        {!appSaved && !have && <p className="loading-dots">Checking this console&apos;s Discord configuration</p>}

        {appSaved && !identity && !done && (
          <>
            <p className="muted">Authenticate with Discord. The console will learn who you are and which servers you are in; the server you own makes you its Owner. Nothing is signed in yet.</p>
            <a className="login-discord-button login-discord-button-primary" href="/api/auth/discord/start?setup=1">Continue with Discord</a>
          </>
        )}

        {identity && !done && (
          <>
            <p className="muted">Signed in to Discord as <strong>{identity.user.username}</strong>{identity.user.mfaEnabled ? "" : " — this Discord account has no two-factor authentication; enable it in Discord before requiring it below."}</p>

            <h2 className="recovery-codes-heading">Your server</h2>
            {owned.length === 0 && <p className="attention-text">You do not own any of the servers you are in. Only a server's owner can connect it to this console.</p>}
            <label htmlFor="wiz-guild">Discord server<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={busy}>
              <option value="">Choose…</option>
              {identity.guilds.map((g) => <option key={g.id} value={g.id} disabled={!g.owner}>{g.name}{g.owner ? " — you own this server" : " — not yours"}</option>)}
            </select></label>
            {chosen?.owner && <p className="muted">You own <strong>{chosen.name}</strong>, so you are the console <strong>Owner</strong>. Everyone else's access comes from the roles below.</p>}

            <h2 className="recovery-codes-heading">Who gets which access</h2>
            <p className="muted">Copy role IDs from Discord with Developer Mode on (User Settings &rarr; Advanced), then right-click a role &rarr; Copy Role ID. One or more per field, comma-separated. Owner is not a role — it is you, the server&apos;s owner.</p>
            <label htmlFor="wiz-admin">Admin Role <em>(required)</em><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-moderator">Moderator Role <em>(optional)</em><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-player">Player Role <em>(recommended)</em><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label className="totp-ack-checkbox" htmlFor="wiz-mfa"><input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={busy} /> Require two-factor on the Discord account for Owner and Admin (recommended)</label>

            <h2 className="recovery-codes-heading">Confirm</h2>
            <label htmlFor="wiz-password">Admin password again <em>(fresh proof, as when changing it)</em><SecretInput id="wiz-password" name="wiz-password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Admin password" disabled={busy} /></label>
            <button type="button" disabled={busy || !chosen?.owner} onClick={() => { void finalize(); }}>{busy ? "Saving..." : "Turn on Discord sign-in"}</button>
          </>
        )}

        {done && (
          <p className="attention-text">Done. <strong>{done.guild}</strong> is connected and <strong>{done.owner}</strong> is the Owner. Run <code>dune console restart</code> on the host; after it comes back, the sign-in page shows <strong>Sign in with Discord</strong>, with the admin password beneath it as the way back in.</p>
        )}

        {error && <p className="error">{error}</p>}
        <button type="button" className="login-password-toggle" onClick={done ? onDone : onCancel}>{done ? "Back to sign in" : "Cancel"}</button>
      </section>
    </main>
  );
}
