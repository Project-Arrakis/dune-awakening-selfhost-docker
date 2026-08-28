import { useCallback, useEffect, useState } from "react";
import { api, post } from "../../api/client";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ guild: string; owner: string } | null>(null);
  const [restarting, setRestarting] = useState(false);

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
  }, [guildId]);

  useEffect(() => { void probe(); }, []); // eslint-disable-line react-hooks/exhaustive-deps


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

  async function restartNow() {
    setRestarting(true); setError("");
    try {
      await post("/api/setup/discord-restart", {});
    } catch { /* the container may drop the connection mid-response; that is expected */ }
    // Poll /api/auth/state until the NEW process reports Discord configured, then
    // reload. Keying on discordOAuthConfigured (not on the connection dropping)
    // is what makes this robust behind a reverse proxy/tunnel: while the
    // container recreates the proxy returns 502 *responses* (fetch resolves,
    // never throws), so a "did we see it go down" gate would never fire. The
    // pre-restart process reports discordOAuthConfigured=false; only the
    // restarted one reports true, so this cannot reload early.
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch("/api/auth/state", { cache: "no-store" });
        if (res.ok && (await res.json()).config?.discordOAuthConfigured) { window.location.replace("/"); return; }
      } catch { /* container mid-recreate; keep polling */ }
    }
    setRestarting(false);
    setError("The console is taking longer than expected to restart. Give it another minute and reload this page, or run `dune console restart` on the host.");
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

        {step === "connect" && (
          <>
            <p className="muted">Discord sign-in is not set up on this server yet. Connecting the server to a Discord application is a one-time deployment step done by whoever runs the server &mdash; not something you do here, and not something a person signing in ever sees.</p>
            <p className="muted">On the host, set these in <code>.env</code> from the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a> (OAuth2 tab), then restart the console:</p>
            <ul className="discord-setup-envlist">
              <li><code>DISCORD_OAUTH_CLIENT_ID</code> &mdash; the application&apos;s Client ID</li>
              <li><code>DISCORD_OAUTH_CLIENT_SECRET</code> &mdash; its Client Secret (or a <code>runtime/secrets/discord-oauth-client-secret.txt</code> file, 0600)</li>
              <li><code>DISCORD_OAUTH_REDIRECT_URI</code> &mdash; <code>{redirectUri}</code> <button type="button" className="login-password-toggle" onClick={() => { void navigator.clipboard?.writeText(redirectUri); }}>copy</button>, which must also be in the application&apos;s OAuth2 redirect list</li>
            </ul>
            <p className="muted">Tip: use a <strong>dedicated</strong> Discord application for the console, not your bot&apos;s. The application&apos;s <strong>name and icon are what people see on the Discord sign-in screen</strong>, so name it for your server or console and give it an icon &mdash; reusing the bot&apos;s application makes sign-in look like logging into the bot.</p>
            <p className="muted">Once that is done, this becomes a single <strong>Continue with Discord</strong> button &mdash; no IDs to type.</p>
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

            <h2 className="auth-step-heading">Your server</h2>
            {identity.guilds.length === 0
              ? <p className="attention-text">You do not own any Discord server. Only a server&apos;s owner can connect it to this console &mdash; ownership is what makes you the console Owner.</p>
              : identity.guilds.length === 1
                ? <p className="muted">Connecting <strong>{identity.guilds[0].name}</strong>, which you own. That makes you the console <strong>Owner</strong>; everyone else&apos;s access comes from the roles below.</p>
                : <label htmlFor="wiz-guild">Which of your servers<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={busy}>
                    <option value="">Choose…</option>
                    {identity.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>}

            <h2 className="auth-step-heading">Who gets which access</h2>
            <p className="muted">Copy role IDs from Discord with Developer Mode on (User Settings &rarr; Advanced), then right-click a role &rarr; Copy Role ID. One or more per field, comma-separated. Owner is not a role — it is you, the server&apos;s owner.</p>
            <label htmlFor="wiz-admin">Admin Role <em>(required)</em><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-moderator">Moderator Role <em>(optional)</em><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-player">Player Role <em>(recommended)</em><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label className="discord-mfa-option" htmlFor="wiz-mfa">
              <input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={busy} />
              <span className="discord-mfa-text">
                <span className="discord-mfa-title">Require two-factor for Owner and Admin <span className="discord-mfa-tag">recommended</span></span>
                <span className="muted">Uses each person&apos;s own Discord-account 2FA &mdash; not the console password.</span>
              </span>
            </label>

            <button type="button" className="login-primary-button" disabled={busy || !guildId} onClick={() => { void finalize(); }}>{busy ? "Saving..." : "Turn on Discord sign-in"}</button>
          </>
        )}

        {step === "done" && done && (
          <>
            <p className="attention-text">Done. <strong>{done.guild}</strong> is connected and <strong>{done.owner}</strong> is the Owner. One restart applies it — then the sign-in page shows <strong>Sign in with Discord</strong>, with the admin password beneath it as the way back in.</p>
            {restarting
              ? <p className="loading-dots">Restarting the console — this page will reconnect shortly</p>
              : <button type="button" className="login-primary-button" onClick={() => { void restartNow(); }}>Restart the console now</button>}
            <p className="muted">Prefer to do it yourself? Run <code>dune console restart</code> on the host instead.</p>
          </>
        )}

        {error && <p className="error">{error}</p>}
        {!restarting && <button type="button" className="login-password-toggle" onClick={done ? onDone : onCancel}>{done ? "Back to sign in" : "Cancel"}</button>}
      </section>
    </main>
  );
}
