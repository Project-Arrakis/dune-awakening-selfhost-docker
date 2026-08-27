import { useCallback, useEffect, useState } from "react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";

// Guided Discord sign-in setup (docs/rfc-console-auth.md §2.1.1). Reached only
// by the console owner (the admin password was entered to start it), so from
// here the operator AUTHENTICATES with Discord and does not enter the password
// again -- the owner session is the proof. The step is derived from live data,
// never frozen, so returning from the Discord round-trip (or refreshing) always
// resumes at the right place instead of dropping back to the start.

type Guild = { id: string; name: string; owner: boolean };
type Identity = { user: { id: string; username: string; mfaEnabled: boolean }; guilds: Guild[] };
type HostApp = { clientId: string; redirectUri: string; secretSaved: boolean; configured: boolean };
type Props = { onDone: () => void; onCancel: () => void };

const SNOWFLAKE = /^\d{17,19}$/;

export function DiscordSetupWizard({ onDone, onCancel }: Props) {
  const redirectUri = `${window.location.origin}/api/auth/discord/callback`;
  const [app, setApp] = useState<HostApp | null>(null);       // what the host already has
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [probed, setProbed] = useState(false);                // both probes have resolved
  const [guildId, setGuildId] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [requireMfa, setRequireMfa] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState<{ guild: string; owner: string } | null>(null);

  // Learn the host's state on mount, and every time it might have changed. Both
  // probes are unconditional -- NOT gated on a URL param -- so a refresh at any
  // point re-derives where we are.
  const probe = useCallback(async () => {
    const [settings, id] = await Promise.allSettled([
      api<{ serverConfig?: Record<string, string>; config?: { discordOAuthAppConfigured?: boolean } }>("/api/settings"),
      api<Identity>("/api/setup/discord-identity"),
    ]);
    if (settings.status === "fulfilled") {
      const c = settings.value.serverConfig || {};
      setApp({
        clientId: c["DISCORD_OAUTH_CLIENT_ID"] || "",
        redirectUri: c["DISCORD_OAUTH_REDIRECT_URI"] || "",
        secretSaved: Boolean(c["_discordOAuthSecretSaved"]),
        configured: Boolean(settings.value.config?.discordOAuthAppConfigured),
      });
      if (c["DISCORD_OAUTH_CLIENT_ID"] && !clientId) setClientId(c["DISCORD_OAUTH_CLIENT_ID"]);
    } else {
      setApp({ clientId: "", redirectUri: "", secretSaved: false, configured: false });
    }
    if (id.status === "fulfilled") {
      setIdentity(id.value);
      const owned = id.value.guilds.find((g) => g.owner);
      if (owned && !guildId) setGuildId(owned.id);
    }
    setProbed(true);
    // A stray ?discordSetup marker in the URL has done its job; drop it so a
    // manual refresh is clean.
    if (new URLSearchParams(window.location.search).has("discordSetup")) window.history.replaceState({}, "", "/");
  }, [clientId, guildId]);

  useEffect(() => { void probe(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveApp() {
    setBusy(true); setError(""); setNotice("");
    try {
      if (!SNOWFLAKE.test(clientId.trim())) throw new Error("Client ID should be the 17-19 digit application ID.");
      if (!clientSecret) throw new Error("Paste the client secret.");
      const patch: Record<string, string> = {};
      if (clientId.trim() !== (app?.clientId || "")) patch.DISCORD_OAUTH_CLIENT_ID = clientId.trim();
      if (!app?.redirectUri) patch.DISCORD_OAUTH_REDIRECT_URI = redirectUri;
      if (Object.keys(patch).length) await post("/api/setup/write-oauth-config", patch);
      await post("/api/setup/save-oauth-secret", { secret: clientSecret, overwrite: true });
      setClientSecret("");
      setNotice("Saved. The console reads this at startup — run `dune console restart` on the host, then reopen this page and click Continue with Discord.");
      await probe();
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
      const res = await post<{ ok: boolean; guild: { name: string }; owner: { username: string } }>("/api/setup/discord-finalize", {
        guildId, adminRoleIds: adminRoleIds.trim(), moderatorRoleIds: moderatorRoleIds.trim(), playerRoleIds: playerRoleIds.trim(), requireMfa
      });
      setDone({ guild: res.guild.name, owner: res.owner.username });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  // Derived step -- the fix for the loop. identity present => map; else app
  // ready => authorize; else connect the application.
  const step: "loading" | "connect" | "authorize" | "map" | "done" =
    done ? "done" : !probed ? "loading" : identity ? "map" : (app?.configured ? "authorize" : "connect");
  const chosen = identity?.guilds.find((g) => g.id === guildId) || null;

  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">
        <h1>Set up Discord sign-in</h1>

        {step === "loading" && <p className="loading-dots">Checking this console&apos;s Discord configuration</p>}

        {step === "connect" && app && (
          <>
            {app.clientId ? (
              <p className="muted">This console already knows its Discord application (client ID <code>{app.clientId}</code>). It just needs the application&apos;s <strong>client secret</strong>. Paste it once here, or put it on the host at <code>runtime/secrets/discord-oauth-client-secret.txt</code> and restart.</p>
            ) : (
              <p className="muted">Point this console at a Discord application — the same one your bot uses, or any application whose OAuth2 redirect list includes <code>{redirectUri}</code> <button type="button" className="login-password-toggle" onClick={() => { void navigator.clipboard?.writeText(redirectUri); }}>copy</button>. This is a one-time deployment detail, like a bot token; it can also live in <code>.env</code>.</p>
            )}
            {!app.clientId && <label htmlFor="wiz-client-id">Client ID<input id="wiz-client-id" name="wiz-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Application ID" disabled={busy} inputMode="numeric" /></label>}
            <label htmlFor="wiz-client-secret">Client secret<SecretInput id="wiz-client-secret" name="wiz-client-secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" disabled={busy} /></label>
            <button type="button" disabled={busy} onClick={() => { void saveApp(); }}>{busy ? "Saving..." : "Save and continue"}</button>
          </>
        )}

        {step === "authorize" && (
          <>
            <p className="muted">Sign in with Discord. The console will learn who you are and which servers you are in; the server you own makes you its Owner. Your admin password is not needed again — it stays as the way back in if Discord is ever unavailable.</p>
            <a className="login-discord-button login-discord-button-primary" href="/api/auth/discord/start?setup=1">Continue with Discord</a>
          </>
        )}

        {step === "map" && identity && (
          <>
            <p className="muted">Signed in with Discord as <strong>{identity.user.username}</strong>.{identity.user.mfaEnabled ? "" : " This Discord account has no two-factor authentication; enable it in Discord if you turn on the requirement below."}</p>

            <h2 className="recovery-codes-heading">Your server</h2>
            {identity.guilds.every((g) => !g.owner) && <p className="attention-text">You do not own any of the servers you are in. Only a server&apos;s owner can connect it to this console.</p>}
            <label htmlFor="wiz-guild">Discord server<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={busy}>
              <option value="">Choose…</option>
              {identity.guilds.map((g) => <option key={g.id} value={g.id} disabled={!g.owner}>{g.name}{g.owner ? " — you own this server" : " — not yours"}</option>)}
            </select></label>
            {chosen?.owner && <p className="muted">You own <strong>{chosen.name}</strong>, so you are the console <strong>Owner</strong>. Everyone else&apos;s access comes from the roles below.</p>}

            <h2 className="recovery-codes-heading">Who gets which access</h2>
            <p className="muted">Copy role IDs from Discord with Developer Mode on (User Settings &rarr; Advanced), then right-click a role &rarr; Copy Role ID. One or more per field, comma-separated. Owner is not a role — it is you, the server&apos;s owner.</p>
            <label htmlFor="wiz-admin">Admin Role <em>(required)</em><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-moderator">Moderator Role <em>(optional)</em><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-player">Player Role <em>(recommended)</em><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label className="totp-ack-checkbox" htmlFor="wiz-mfa"><input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={busy} /> Require two-factor <strong>on each person&apos;s Discord account</strong> before granting Owner or Admin (recommended). This is Discord&apos;s own 2FA, not the console password.</label>

            <button type="button" disabled={busy || !chosen?.owner} onClick={() => { void finalize(); }}>{busy ? "Saving..." : "Turn on Discord sign-in"}</button>
          </>
        )}

        {step === "done" && done && (
          <p className="attention-text">Done. <strong>{done.guild}</strong> is connected and <strong>{done.owner}</strong> is the Owner. Run <code>dune console restart</code> on the host; after it comes back, the sign-in page shows <strong>Sign in with Discord</strong>, with the admin password beneath it as the way back in.</p>
        )}

        {notice && <p className="muted">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <button type="button" className="login-password-toggle" onClick={done ? onDone : onCancel}>{done ? "Back to sign in" : "Cancel"}</button>
      </section>
    </main>
  );
}
