import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";
import { InfoTooltip, KeyValueGrid, StatusPill } from "../../components/common/DisplayPrimitives";
import { RecoveryCodesPanel } from "../auth/RecoveryCodesPanel";
import { firstDefined, formatUiSentence, friendlyColumnName } from "../../lib/display";

// Authenticator apps display codes as "123 456" and the server strips whitespace
// (auth/totp.js) precisely so a paste of that form validates. The inputs used to
// carry maxLength={6}, which truncated the paste to "123 45" before the server
// ever saw it -- and every resulting rejection spent rate-limiter budget (#526).
function stripCodeWhitespace(value: string) {
  return value.replace(/\s/g, "");
}

type SettingsTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type PublicDirectorySettings = {
  available?: boolean;
  enabled?: boolean;
  anonymousCountEnabled?: boolean;
  mode?: string;
  state?: string;
  lastSuccessAt?: string | null;
  error?: string | null;
  probeError?: string | null;
};

type SettingsPanelProps = {
  onPasswordChanged: () => Promise<void>;
  publicListingUrl?: string;
};

export function SettingsPanel({ onPasswordChanged, publicListingUrl }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordResult, setPasswordResult] = useState<SettingsTaskResult | null>(null);
  const [webPortResult, setWebPortResult] = useState<SettingsTaskResult | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [webPortSaving, setWebPortSaving] = useState(false);
  const [serverListingSaving, setServerListingSaving] = useState(false);
  const [anonymousCountSaving, setAnonymousCountSaving] = useState(false);
  const [serverListingError, setServerListingError] = useState("");
  const [publicProfileOpen, setPublicProfileOpen] = useState(false);
  const [publicProfileSaving, setPublicProfileSaving] = useState(false);
  const [publicProfileResult, setPublicProfileResult] = useState<SettingsTaskResult | null>(null);
  const [claimCode, setClaimCode] = useState("");
  const [loginPasswordOpen, setLoginPasswordOpen] = useState(false);
  const [webPortOpen, setWebPortOpen] = useState(false);
  const [discordOAuthOpen, setDiscordOAuthOpen] = useState(false);
  const [discordOAuthSaving, setDiscordOAuthSaving] = useState(false);
  const [discordOAuthResult, setDiscordOAuthResult] = useState<SettingsTaskResult | null>(null);
  const [discordClientId, setDiscordClientId] = useState("");
  const [discordRedirectUri, setDiscordRedirectUri] = useState("");
  const [discordClientSecret, setDiscordClientSecret] = useState("");
  const [discordHomeGuildId, setDiscordHomeGuildId] = useState("");
  const [discordOwnerAllowlist, setDiscordOwnerAllowlist] = useState("");
  const [discordBootstrap, setDiscordBootstrap] = useState(false);
  const [discordSecretSaved, setDiscordSecretSaved] = useState(false);
  const [webPort, setWebPort] = useState("");
  const [webPortRedirectUrl, setWebPortRedirectUrl] = useState("");
  const [webPortRedirectCountdown, setWebPortRedirectCountdown] = useState<number | null>(null);
  // Tier 3 credential state (#515/#512). secondFactorEnrolled is read from
  // /api/auth/me, never inferred from a failed request: the whole bug this
  // fixes was the server demanding an authenticator code the form had no field
  // for, which is only avoidable by knowing BEFORE submitting.
  const [secondFactorEnrolled, setSecondFactorEnrolled] = useState(false);
  // Distinct from "not enrolled" (#525): the store threw, so 2FA state is
  // unreadable. Hiding the controls here is the worst possible response --
  // that is exactly when the operator needs them.
  const [secondFactorUnavailable, setSecondFactorUnavailable] = useState(false);
  const [passwordTotpCode, setPasswordTotpCode] = useState("");
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const [regeneratePassword, setRegeneratePassword] = useState("");
  const [regenerateTotpCode, setRegenerateTotpCode] = useState("");
  const [regenerateSaving, setRegenerateSaving] = useState(false);
  const [regenerateResult, setRegenerateResult] = useState<SettingsTaskResult | null>(null);
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(null);
  const [regenerateAcknowledged, setRegenerateAcknowledged] = useState(false);
  async function refreshCredentialState() {
    // Read independently of /api/settings (#525): that await used to sit outside
    // any try/catch, so a transient failure there aborted refresh() before this
    // ran and silently left secondFactorEnrolled at its `false` initializer --
    // rendering the #515 dead end again, reached through a fail-open default.
    try {
      const me = await api<{ secondFactorEnrolled?: boolean; secondFactorUnavailable?: boolean }>("/api/auth/me");
      setSecondFactorEnrolled(Boolean(me.secondFactorEnrolled));
      setSecondFactorUnavailable(Boolean(me.secondFactorUnavailable));
    } catch {
      // Unknown, not "no". Treat it the same as an unreadable store so the
      // panel says so instead of quietly offering a form the server will reject.
      setSecondFactorUnavailable(true);
    }
  }
  async function refresh() {
    await refreshCredentialState();
    const nextSettings = await api<Record<string, unknown>>("/api/settings");
    setSettings(nextSettings);
    const config = (nextSettings.config as Record<string, unknown> | undefined) || {};
    const directory = (nextSettings.publicDirectory as PublicDirectorySettings | undefined) || {};
    const serverConfig = (nextSettings.serverConfig as Record<string, string> | undefined) || {};
    setWebPort(String(config.port || "8088"));
    setDiscordClientId(serverConfig["DISCORD_OAUTH_CLIENT_ID"] || "");
    setDiscordRedirectUri(serverConfig["DISCORD_OAUTH_REDIRECT_URI"] || "");
    setDiscordHomeGuildId(serverConfig["DISCORD_HOME_GUILD_ID"] || "");
    setDiscordOwnerAllowlist(serverConfig["DISCORD_OAUTH_OWNER_ALLOWLIST"] || "");
    setDiscordBootstrap(serverConfig["DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP"] === "1");
    setDiscordSecretSaved(Boolean(serverConfig["_discordOAuthSecretSaved"]));
  }
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);
  // Warn before a reload/close destroys codes the operator has not confirmed
  // saving (#524). They are shown once and only digests persist, so leaving this
  // page with them unacknowledged loses them for good -- and the previous sheet
  // is already dead. This covers reload/close; an in-app tab change unmounts the
  // panel and cannot be intercepted from here, which is why the acknowledgment
  // gate stays the primary protection.
  useEffect(() => {
    if (!regeneratedCodes || regenerateAcknowledged) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [regeneratedCodes, regenerateAcknowledged]);
  useEffect(() => {
    if (!passwordResult || passwordResult.status === "running") return;
    const id = window.setTimeout(() => setPasswordResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [passwordResult]);
  useEffect(() => {
    if (!webPortResult || webPortResult.status === "running" || webPortRedirectUrl) return;
    const id = window.setTimeout(() => setWebPortResult(null), 9000);
    return () => window.clearTimeout(id);
  }, [webPortRedirectUrl, webPortResult]);
  useEffect(() => {
    if (!publicProfileResult || publicProfileResult.status === "running") return;
    const id = window.setTimeout(() => setPublicProfileResult(null), 7000);
    return () => window.clearTimeout(id);
  }, [publicProfileResult]);
  useEffect(() => {
    if (!webPortRedirectUrl || webPortRedirectCountdown === null) return;
    if (webPortRedirectCountdown <= 0) {
      window.location.assign(webPortRedirectUrl);
      return;
    }
    const id = window.setTimeout(() => setWebPortRedirectCountdown((value) => value === null ? null : value - 1), 1000);
    return () => window.clearTimeout(id);
  }, [webPortRedirectCountdown, webPortRedirectUrl]);
  const passwordChecks = adminPasswordChecks(newPassword);
  const passwordMeetsRequirements = passwordChecks.every((check) => check.passed);
  const passwordStarted = newPassword.length > 0;
  const confirmStarted = confirmPassword.length > 0;
  const passwordsMatch = newPassword === confirmPassword;
  async function changeLoginPassword() {
    if (!currentPassword) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "Enter your current login password." });
      return;
    }
    if (!passwordMeetsRequirements) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "New password must meet all password requirements." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "New password and confirmation do not match." });
      return;
    }
    // RFC §2.3/§5: once a second factor is enrolled the server requires fresh
    // proof of it, not just the current password. Caught here so the operator
    // is told before a round-trip that burns a login-limiter attempt.
    if (secondFactorEnrolled && !passwordTotpCode.trim()) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "Enter your current authenticator code." });
      return;
    }
    setPasswordSaving(true);
    setPasswordResult({ status: "running", title: "Changing Login Password..." });
    try {
      await post("/api/settings/admin-password", secondFactorEnrolled
        ? { currentPassword, newPassword, totpCode: passwordTotpCode.trim() }
        : { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordTotpCode("");
      setPasswordResult({ status: "succeeded", title: "Login Password Changed", message: "Signing you out so you can log back in with the new password." });
      window.setTimeout(() => { void onPasswordChanged(); }, 1600);
    } catch (error) {
      // A rejected attempt consumes that authenticator code either way (the
      // server advances lastUsedCounter on a match, and a mismatch was never
      // valid), so clear it: the operator must read a fresh one off their
      // device rather than re-submitting the same digits.
      setPasswordTotpCode("");
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPasswordSaving(false);
    }
  }
  async function regenerateRecoveryCodes() {
    if (!regeneratePassword) {
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: "Enter your current login password." });
      return;
    }
    if (!regenerateTotpCode.trim()) {
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: "Enter your current authenticator code." });
      return;
    }
    setRegenerateSaving(true);
    setRegenerateResult({ status: "running", title: "Generating New Recovery Codes..." });
    try {
      const result = await post<{ ok: boolean; recoveryCodes: string[] }>(
        "/api/auth/2fa/recovery-codes/regenerate",
        { currentPassword: regeneratePassword, totpCode: regenerateTotpCode.trim() }
      );
      setRegeneratePassword("");
      setRegenerateTotpCode("");
      setRegenerateAcknowledged(false);
      // Shown exactly once -- only digests are stored server-side, so there is
      // no second chance to retrieve these.
      setRegeneratedCodes(result.recoveryCodes);
      setRegenerateResult(null);
    } catch (error) {
      setRegenerateTotpCode("");
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegenerateSaving(false);
    }
  }
  async function changeWebPort() {
    const port = Number(webPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setWebPortResult({ status: "failed", title: "Port Change Failed", message: "Enter a port number between 1 and 65535." });
      return;
    }
    setWebPortSaving(true);
    setWebPortRedirectUrl("");
    setWebPortRedirectCountdown(null);
    setWebPortResult({ status: "running", title: "Saving Web Console Port..." });
    try {
      const result = await post<{ ok: boolean; port: number; url: string; message?: string }>("/api/settings/web-port", { port });
      setWebPort(String(result.port));
      setWebPortRedirectUrl(result.url);
      setWebPortRedirectCountdown(10);
      setWebPortResult({
        status: "succeeded",
        title: "Web Console Port Saved",
        message: result.message || `The console is restarting now. You will be redirected to ${result.url}.`
      });
    } catch (error) {
      setWebPortRedirectUrl("");
      setWebPortRedirectCountdown(null);
      setWebPortResult({ status: "failed", title: "Port Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setWebPortSaving(false);
    }
  }
  async function changeServerListing(enabled: boolean) {
    setServerListingSaving(true);
    setServerListingError("");
    try {
      const result = await post<{ ok: boolean; publicDirectory: PublicDirectorySettings }>("/api/settings/public-directory", { enabled });
      setSettings((current) => current ? { ...current, publicDirectory: result.publicDirectory } : current);
    } catch (error) {
      setServerListingError(error instanceof Error ? error.message : String(error));
    } finally {
      setServerListingSaving(false);
    }
  }
  async function changeAnonymousCount(enabled: boolean) {
    setAnonymousCountSaving(true);
    setServerListingError("");
    try {
      const result = await post<{ ok: boolean; publicDirectory: PublicDirectorySettings }>("/api/settings/public-directory", { anonymousCountEnabled: enabled });
      setSettings((current) => current ? { ...current, publicDirectory: result.publicDirectory } : current);
    } catch (error) {
      setServerListingError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnonymousCountSaving(false);
    }
  }
  async function verifyListingClaim() {
    setPublicProfileSaving(true);
    setPublicProfileResult({ status: "running", title: "Verifying Listing Claim..." });
    try {
      const result = await post<{ ok: boolean; message: string }>("/api/settings/public-directory/claim", { code: claimCode });
      setClaimCode("");
      setPublicProfileResult({
        status: "succeeded",
        title: "Public Listing Claimed",
        message: result.message
      });
      window.dispatchEvent(new Event("public-directory-claim-changed"));
    } catch (error) {
      setPublicProfileResult({
        status: "failed",
        title: "Listing Claim Failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setPublicProfileSaving(false);
    }
  }
  async function saveDiscordOAuth() {
    setDiscordOAuthSaving(true);
    setDiscordOAuthResult({ status: "running", title: "Saving Discord OAuth config..." });
    try {
      await post<{ ok: boolean }>("/api/setup/write-oauth-config", {
        DISCORD_OAUTH_CLIENT_ID: discordClientId,
        DISCORD_OAUTH_REDIRECT_URI: discordRedirectUri,
        DISCORD_HOME_GUILD_ID: discordHomeGuildId,
        DISCORD_OAUTH_OWNER_ALLOWLIST: discordOwnerAllowlist,
        DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: discordBootstrap ? "1" : "0"
      });
      if (discordClientSecret) {
        await post<{ ok: boolean }>("/api/setup/save-oauth-secret", { secret: discordClientSecret });
        setDiscordClientSecret("");
        setDiscordSecretSaved(true);
      }
      setDiscordOAuthResult({ status: "succeeded", title: "Discord OAuth config saved. Restart console for changes to take effect." });
    } catch (error) {
      setDiscordOAuthResult({
        status: "failed",
        title: "Save failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setDiscordOAuthSaving(false);
    }
  }
  const config = (settings?.config as Record<string, unknown> | undefined) || {};
  const publicDirectory = (settings?.publicDirectory as PublicDirectorySettings | undefined) || {};
  const serverListingVisible = settings !== null && publicDirectory.available === true;
  const serverListingEnabled = publicDirectory.enabled === true;
  const anonymousCountEnabled = publicDirectory.anonymousCountEnabled !== false;
  const passwordEnvManaged = Boolean(config.adminPasswordEnvManaged);
  const currentPort = String(config.port || "8088");
  return <section className="panel">
    <div className="panel-title"><h2>Settings</h2><div className="action-row settings-title-actions">
      <div className="memory-feature-toggle settings-anonymous-count-control">
        <InfoTooltip id="anonymous-count-help" label="About Anonymous Count">Helps us understand how many Dune Docker servers are in use, including local and unlisted installations. Only anonymous server presence is reported—never your server name, IP address, players, or configuration. These statistics help demonstrate project usage and guide future development.</InfoTooltip>
        <label className={`switch-checkbox settings-anonymous-count-toggle ${anonymousCountEnabled ? "enabled" : "disabled"}`}>
          <input
            type="checkbox"
            disabled={anonymousCountSaving}
            checked={anonymousCountEnabled}
            onChange={(event) => { void changeAnonymousCount(event.target.checked); }}
          />
          <span className="switch-label">Anonymous Count:</span>
          <strong className="switch-state">{anonymousCountSaving ? "Saving" : anonymousCountEnabled ? "Enabled" : "Disabled"}</strong>
        </label>
      </div>
      {serverListingVisible && <label className={`switch-checkbox settings-server-listing-toggle ${serverListingEnabled ? "enabled" : "disabled"}`}>
        <input
          type="checkbox"
          disabled={serverListingSaving}
          checked={serverListingEnabled}
          onChange={(event) => { void changeServerListing(event.target.checked); }}
        />
        <span className="switch-label">Server Listing:</span>
        <strong className="switch-state">{serverListingSaving ? "Saving" : serverListingEnabled ? "Enabled" : "Disabled"}</strong>
      </label>}
      <button onClick={refresh}>Refresh</button>
    </div></div>
    {serverListingError && <p className="error settings-server-listing-error">{serverListingError}</p>}
    {serverListingVisible && serverListingEnabled && publicDirectory.probeError &&
      <p className="error settings-server-listing-error">Server listing issue: {publicDirectory.probeError}</p>}
    <div className="settings-section-stack">
      {serverListingVisible && <div className={`playerAdmin_toggle settings-public-profile-toggle ${publicProfileOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={publicProfileOpen ? "Collapse Public Listing Profile" : "Expand Public Listing Profile"} onClick={() => setPublicProfileOpen(!publicProfileOpen)}>
          {publicProfileOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          <span>Public Listing Profile</span>
        </button>
        {publicProfileOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Public descriptions, community links, recruitment details, and Player Portal settings are managed on DuneDocker.app. Generate a claim code from {publicListingUrl
            ? <a className="settings-server-page-link" href={publicListingUrl} target="_blank" rel="noreferrer">[Your Server Page]</a>
            : "[Your Server Page]"}, then paste it below.</p>
          <label className="settings-discord-field">
            <span className="field-label-row"><span className="settings-discord-label">Generated Claim Code</span></span>
            <input
              disabled={publicProfileSaving}
              value={claimCode}
              onChange={(event) => setClaimCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 14))}
              placeholder="ABCD-EF12-3456"
              autoComplete="off"
            />
          </label>
          <div className="action-row">
            <button disabled={publicProfileSaving || claimCode.replace(/[^A-Z0-9]/g, "").length !== 12} onClick={() => { void verifyListingClaim(); }}>
              {publicProfileSaving ? "Verifying..." : "Verify Generated Code"}
            </button>
            {publicProfileResult && <span className={`inline-task-result result-${publicProfileResult.status === "succeeded" ? "ok" : publicProfileResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={publicProfileResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(publicProfileResult.title, publicProfileResult.status === "running")}</strong>
              {publicProfileResult.message && <span className="inline-task-message">{formatResultMessage(publicProfileResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>}
      <RuntimeSettingsSummary settings={settings} />
      <div className={`playerAdmin_toggle settings-web-port-toggle ${webPortOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={webPortOpen ? "Collapse Web Console Port" : "Expand Web Console Port"} onClick={() => setWebPortOpen(!webPortOpen)}>{webPortOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Web Console Port</span></button>
        {webPortOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Change the browser port used by this web console.</p>
          <p className="attention-text">After saving, this page will stop responding on port {currentPort}. Open the new address shown in the result message.</p>
          <div className="settings-password-grid settings-web-port-grid">
            <label>Console Port<input disabled={webPortSaving} type="number" min="1" max="65535" step="1" value={webPort} onChange={(event) => setWebPort(event.target.value.replace(/[^\d]/g, "").slice(0, 5))} placeholder="8088" /></label>
          </div>
          <div className="action-row">
            <button disabled={webPortSaving || Boolean(webPortRedirectUrl) || !webPort || webPort === currentPort} onClick={() => { void changeWebPort(); }}>{webPortSaving ? "Saving..." : "Save And Restart Console"}</button>
            {webPortResult && <span className={`inline-task-result result-${webPortResult.status === "succeeded" ? "ok" : webPortResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={webPortResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(webPortResult.title, webPortResult.status === "running")}</strong>
              <span className="inline-task-message">{formatWebPortResultMessage(webPortResult, webPortRedirectUrl, webPortRedirectCountdown)}</span>
            </span>}
          </div>
        </div>}
      </div>
      <div className={`playerAdmin_toggle settings-login-password-toggle ${loginPasswordOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={loginPasswordOpen ? "Collapse Login Password" : "Expand Login Password"} onClick={() => setLoginPasswordOpen(!loginPasswordOpen)}>{loginPasswordOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Login Password</span></button>
        {loginPasswordOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Change the password used to sign in to this web console.</p>
          {passwordEnvManaged && <p className="attention-text">The login password is managed by <code>ADMIN_PASSWORD</code>. Update the environment value to change it.</p>}
          <div className="settings-password-grid">
            <label>Current Password<SecretInput disabled={passwordEnvManaged || passwordSaving} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" /></label>
            <label>New Password<SecretInput disabled={passwordEnvManaged || passwordSaving} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At Least 13 Characters" /></label>
            <label><span className="field-label-row"><span>Confirm New Password</span>{confirmStarted && <span className={`password-match-inline ${passwordsMatch ? "passed" : "missing"}`}>{passwordsMatch ? "Matches" : "Passwords do not match"}</span>}</span><SecretInput disabled={passwordEnvManaged || passwordSaving} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" /></label>
            {secondFactorEnrolled && <label>Authenticator Code<input
              disabled={passwordEnvManaged || passwordSaving}
              value={passwordTotpCode}
              onChange={(event) => setPasswordTotpCode(stripCodeWhitespace(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
            /></label>}
          </div>
          {secondFactorEnrolled && <p className="muted">Two-factor is enabled, so changing the password needs a current code from your authenticator as well.</p>}
          {passwordStarted && <div className="password-check-box">
            <strong>Password Requirements</strong>
            <ul className="password-requirements" aria-label="Password requirements">
              {passwordChecks.map((check) => <li className={check.passed ? "passed" : "missing"} key={check.label}>{check.label}</li>)}
            </ul>
          </div>}
          <div className="action-row">
            <button disabled={passwordEnvManaged || passwordSaving || !passwordMeetsRequirements || !passwordsMatch || (secondFactorEnrolled && !passwordTotpCode.trim())} onClick={() => { void changeLoginPassword(); }}>{passwordSaving ? "Saving..." : "Change Password"}</button>
            {passwordResult && <span className={`inline-task-result result-${passwordResult.status === "succeeded" ? "ok" : passwordResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={passwordResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(passwordResult.title, passwordResult.status === "running")}</strong>
              {passwordResult.message && <span className="inline-task-message">{formatResultMessage(passwordResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>
      {/* Rendered OUTSIDE the secondFactorEnrolled gate (#524). While these codes
          are on screen they are the ONLY copy that will ever exist -- the previous
          sheet is already invalidated server-side and only digests persist. Gating
          them on a flag that any /api/auth/me re-read can flip to false meant the
          panel's own Refresh button, sitting a few rows above, destroyed them. */}
      {regeneratedCodes && <div className="playerAdmin_toggle settings-two-factor-toggle open">
        <div className="playerAdmin_toggleBody">
          <div className="totp-recovery-codes-panel">
            <RecoveryCodesPanel
              codes={regeneratedCodes}
              heading="Save your new recovery codes"
              intro="These 10 codes replace your previous set, which no longer works. They are shown once, right now, and cannot be retrieved again."
              confirmLabel="Done"
              onConfirm={() => { setRegeneratedCodes(null); setRegenerateAcknowledged(false); }}
              acknowledged={regenerateAcknowledged}
              onAcknowledgedChange={setRegenerateAcknowledged}
            />
          </div>
        </div>
      </div>}
      {secondFactorUnavailable && <p className="attention-text">
        This console&apos;s two-factor state could not be read, so password changes and
        recovery-code regeneration are unavailable right now. Do not delete
        <code> runtime/generated/console-second-factor.json</code> &mdash; see the sign-in
        page&apos;s error for recovery guidance.
      </p>}
      {secondFactorEnrolled && !regeneratedCodes && <div className={`playerAdmin_toggle settings-two-factor-toggle ${twoFactorOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={twoFactorOpen ? "Collapse Two-Factor Authentication" : "Expand Two-Factor Authentication"} onClick={() => setTwoFactorOpen(!twoFactorOpen)}>{twoFactorOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Two-Factor Authentication</span></button>
        {twoFactorOpen && <div className="playerAdmin_toggleBody">
          <>
                <p className="muted">Generate a fresh set of 10 recovery codes. Your authenticator is unchanged, and you stay signed in everywhere.</p>
                <p className="attention-text">Your existing recovery codes stop working the moment new ones are issued.</p>
                <div className="settings-password-grid">
                  <label>Current Password<SecretInput disabled={regenerateSaving} value={regeneratePassword} onChange={(event) => setRegeneratePassword(event.target.value)} placeholder="Current password" /></label>
                  <label>Authenticator Code<input
                    disabled={regenerateSaving}
                    value={regenerateTotpCode}
                    onChange={(event) => setRegenerateTotpCode(stripCodeWhitespace(event.target.value))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                  /></label>
                </div>
                <div className="action-row">
                  <button disabled={regenerateSaving || !regeneratePassword || !regenerateTotpCode.trim()} onClick={() => { void regenerateRecoveryCodes(); }}>{regenerateSaving ? "Generating..." : "Regenerate Recovery Codes"}</button>
                  {regenerateResult && <span className={`inline-task-result result-${regenerateResult.status === "succeeded" ? "ok" : regenerateResult.status === "failed" ? "fail" : "running"}`}>
                    <strong className={regenerateResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(regenerateResult.title, regenerateResult.status === "running")}</strong>
                    {regenerateResult.message && <span className="inline-task-message">{formatResultMessage(regenerateResult.message)}</span>}
                  </span>}
                </div>
          </>
        </div>}
      </div>}
      <div className={`playerAdmin_toggle ${discordOAuthOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={discordOAuthOpen ? "Collapse Discord OAuth" : "Expand Discord OAuth"} onClick={() => setDiscordOAuthOpen(!discordOAuthOpen)}>{discordOAuthOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Discord OAuth</span></button>
        {discordOAuthOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Configure Discord sign-in for console administrators. Requires a Discord OAuth application. Leave blank for password-only auth.</p>
          <div className="settings-password-grid">
            <label>Client ID<input disabled={discordOAuthSaving} value={discordClientId} onChange={(event) => setDiscordClientId(event.target.value)} placeholder="Discord application client ID" /></label>
            <label>Redirect URI<input disabled={discordOAuthSaving} value={discordRedirectUri} onChange={(event) => setDiscordRedirectUri(event.target.value)} placeholder="https://your-host:8088/api/auth/discord/callback" /></label>
            <label>Client Secret{discordSecretSaved ? <span className="theme-note"> (saved)</span> : null}<SecretInput disabled={discordOAuthSaving} value={discordClientSecret} onChange={(event) => setDiscordClientSecret(event.target.value)} placeholder="Paste new to replace" /></label>
            <label>Home Guild ID<input disabled={discordOAuthSaving} value={discordHomeGuildId} onChange={(event) => setDiscordHomeGuildId(event.target.value)} placeholder="Discord server ID (snowflake)" /></label>
            <label>Owner Allowlist<input disabled={discordOAuthSaving} value={discordOwnerAllowlist} onChange={(event) => setDiscordOwnerAllowlist(event.target.value)} placeholder="Comma-separated Discord user IDs" /></label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" }}>
            <input type="checkbox" disabled={discordOAuthSaving} checked={discordBootstrap} onChange={(event) => setDiscordBootstrap(event.target.checked)} />
            <span>Allow owner bootstrap</span>
          </label>
          <div className="action-row" style={{ marginTop: "12px" }}>
            <button disabled={discordOAuthSaving || (!discordClientId && !discordRedirectUri && !discordClientSecret && !discordHomeGuildId && !discordOwnerAllowlist)} onClick={() => { void saveDiscordOAuth(); }}>
              {discordOAuthSaving ? "Saving..." : "Save OAuth Config"}
            </button>
            {discordOAuthResult && <span className={`inline-task-result result-${discordOAuthResult.status === "succeeded" ? "ok" : discordOAuthResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={discordOAuthResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(discordOAuthResult.title, discordOAuthResult.status === "running")}</strong>
              {discordOAuthResult.message && <span className="inline-task-message">{formatResultMessage(discordOAuthResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>
    </div>
  </section>;
}

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

function formatWebPortResultMessage(result: SettingsTaskResult, redirectUrl: string, countdown: number | null) {
  if (result.status === "succeeded" && redirectUrl && countdown !== null) {
    return `The console is restarting now. Redirecting in ${countdown} second${countdown === 1 ? "" : "s"}.`;
  }
  return result.message ? formatResultMessage(result.message) : "";
}

function adminPasswordChecks(password: string) {
  return [
    { label: "At Least 13 Characters", passed: password.length >= 13 },
    { label: "Lowercase Letter", passed: /[a-z]/.test(password) },
    { label: "Uppercase Letter", passed: /[A-Z]/.test(password) },
    { label: "Number", passed: /\d/.test(password) },
    { label: "Special Character", passed: /[^A-Za-z0-9]/.test(password) }
  ];
}

function RuntimeSettingsSummary({ settings }: { settings: Record<string, unknown> | null }) {
  const config = (settings?.config as Record<string, unknown> | undefined) || {};
  const files = (settings?.files as Record<string, unknown> | undefined) || {};
  return <div className="action-sections">
    <section className="action-section">
      <h4>Runtime Configuration</h4>
      <KeyValueGrid items={[
        ["App Name", firstDefined(config.appName, config.app_name, "Dune Docker Console")],
        ["Repo Root", config.repoRoot],
        ["Auth", config.authEnabled === false ? "Disabled" : "Enabled"],
        ["Secure Cookies", booleanLabel(config.secureCookies)],
        ["Host Bootstrap", booleanLabel(config.allowHostBootstrap)],
        ["Mock Mode", booleanLabel(config.mockMode)],
        ["Runtime path", config.runtimePath],
        ["Task retention", config.taskRetention]
      ]} />
    </section>
    <section className="action-section">
      <h4>Files Checklist</h4>
      <div className="check-grid">{Object.entries(files).map(([key, value]) => <article className="check-card" key={key}><div><strong>{friendlyFileLabel(key)}</strong><p>{value ? "Found" : "Missing"}</p></div><StatusPill value={value ? "Ready" : "Attention Needed"} /></article>)}</div>
      {!Object.keys(files).length && <p>Runtime file checks have not loaded yet.</p>}
    </section>
  </div>;
}

function booleanLabel(value: unknown) {
  if (value === true) return "Enabled";
  if (value === false) return "Disabled";
  return value ?? "Unknown";
}

function friendlyFileLabel(value: string) {
  return {
    env: "Environment File",
    token: "Auth Token",
    battlegroup: "Battlegroup",
    duneScript: "Dune Script"
  }[value] || friendlyColumnName(value);
}
