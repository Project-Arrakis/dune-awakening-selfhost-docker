import { useEffect, useState } from "react";
import { discordAdapterSettingsApi, type DiscordBotSettingsState } from "../../api/discordAdapterSettings";
import { updatesApi } from "../../api/updates";
import { persistUpdateTask, loadPersistedUpdateTask } from "../updates/updateUtils";
import { ConfirmDialog, type ConfirmDialogRequest, type ConfirmDialogOutcome } from "../../components/common/ConfirmDialog";

const TASK_KEY = "arrakis.discordAdapterEnableTask";
const POLL_INTERVAL_MS = 2000;

type Choice = "hosted" | "self-hosted" | null;
type Phase = "loading" | "disabled" | "enabling" | "enabled" | "failed";

export function DiscordBotSection() {
  const [state, setState] = useState<DiscordBotSettingsState | null>(null);
  // Seed runId/phase synchronously from localStorage, the same way
  // UpdatesPanel.tsx's gameUpdateTask/stackUpdateTask state does
  // (`useState<Task | null>(() => loadPersistedUpdateTask(...))`), instead of
  // setting them from inside the mount effect below. This closes a real
  // mount-time race (Layer 2 review finding, 2026-09-08): refresh() suspends
  // at its first await, yields back to the effect body, and its continuation
  // used to land *after* the effect body had already set phase="enabling",
  // unconditionally overwriting it with whatever the live GET reported at
  // that instant -- silently dropping reload-recovery (audit finding #9)
  // whenever the initial GET happened to succeed before the persisted task
  // finished. Seeding here means a persisted in-flight task is already
  // reflected in state before refresh() is even called (see the mount
  // effect below, which now skips refresh() entirely when runId is already
  // set on the first render).
  const [runId, setRunId] = useState<string | null>(() => loadPersistedUpdateTask(TASK_KEY)?.id ?? null);
  const [phase, setPhase] = useState<Phase>(() => (loadPersistedUpdateTask(TASK_KEY)?.id ? "enabling" : "loading"));
  const [choice, setChoice] = useState<Choice>(null);
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [error, setError] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  // Transient, in-memory only -- never persisted to localStorage or logged
  // (Requirement 24). Holds the plaintext token exactly once, immediately
  // after Enable/Regenerate, since the backend never returns it again on
  // a later GET (Design §3.1's "masked, with reveal/copy" requirement).
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  async function refresh() {
    const nextState = await discordAdapterSettingsApi.getState();
    setState(nextState);
    setPlayerRoleIds(nextState.roleIds.player.join(", "));
    setModeratorRoleIds(nextState.roleIds.moderator.join(", "));
    setAdminRoleIds(nextState.roleIds.admin.join(", "));
    // Never assume "never configured" -- always reflect real state
    // (Layer 1 audit finding #7, converged on by 3 independent hats).
    setPhase(nextState.enabled ? "enabled" : "disabled");
  }

  useEffect(() => {
    // A persisted in-flight task is already reflected in phase/runId via the
    // useState initializers above -- don't call refresh() here too, or its
    // async continuation would overwrite "enabling" with a stale
    // disabled/enabled snapshot the moment the initial GET resolves (see the
    // comment on the runId/phase state above). The polling effect below owns
    // this task from here: only its own completion handler clears the
    // persisted entry and calls refresh().
    if (!runId) {
      refresh().catch(() => setError("Could not load Discord Bot settings."));
    }
  }, []);

  useEffect(() => {
    if (phase !== "enabling" || !runId) return undefined;
    const interval = setInterval(async () => {
      try {
        const progress = await updatesApi.stackProgress(runId);
        if (progress.state === "succeeded") {
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          setRunId(null);
          if (progress.discordHealthOk === false) {
            setPhase("failed");
            setError("The console restarted, but the Discord adapter did not respond to a health check. Check the console's logs.");
          } else {
            await refresh();
          }
        } else if (progress.state === "failed") {
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          setRunId(null);
          setPhase("failed");
          setError(progress.message || "Applying Discord Bot settings failed.");
        }
      } catch {
        // The console is mid-recreate and briefly unreachable -- keep polling.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [phase, runId]);

  async function handleEnable() {
    setError("");
    const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
      setConfirmRequest({
        title: "Enable Discord Bot Integration",
        message: "The console will restart to apply this change. It will be briefly unreachable.",
        confirmLabel: "Enable",
        cancelLabel: "Cancel",
        danger: false,
        resolve
      });
    });
    setConfirmRequest(null);
    if (outcome !== "confirm") return;

    try {
      const { task, token } = await discordAdapterSettingsApi.enable({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds
      });
      setRevealedToken(token);
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Save Role IDs, for an already-enabled adapter: a distinct handler and
  // route from handleEnable/enable() above -- see updateDiscordBotRoleIds()
  // in Task 8 for why sharing the enable path here would be a real bug
  // (silently rotating the live token on every role-ID edit).
  async function handleUpdateRoleIds() {
    setError("");
    try {
      const { task } = await discordAdapterSettingsApi.updateRoleIds({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds
      });
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerate() {
    setError("");
    const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
      setConfirmRequest({
        title: "Regenerate Discord Bot Token",
        message: "This immediately invalidates the current token. Your bot will stop working until you paste the new token wherever it's configured. This cannot be undone.",
        confirmLabel: "Regenerate",
        cancelLabel: "Cancel",
        danger: true,
        resolve
      });
    });
    setConfirmRequest(null);
    if (outcome !== "confirm") return;

    try {
      const { token } = await discordAdapterSettingsApi.regenerateToken();
      setRevealedToken(token);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="playerAdmin_toggleBody">
      <p className="muted">For bot commands and in-game data access — not console admin sign-in, see Discord OAuth below.</p>
      {error && <div className="confirm-modal-warning">{error}</div>}

      {phase === "disabled" && (
        <>
          <div className="settings-choice">
            <p>Which are you using?</p>
            <button className={choice === "hosted" ? "active" : ""} onClick={() => setChoice("hosted")}>Hosted bot</button>
            <button className={choice === "self-hosted" ? "active" : ""} onClick={() => setChoice("self-hosted")}>Self-hosting</button>
          </div>
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <button disabled={!choice} onClick={() => { void handleEnable(); }}>Enable Discord Bot Integration</button>
        </>
      )}

      {phase === "enabling" && <p>Applying settings and restarting the console…</p>}

      {phase === "failed" && <button onClick={() => { void refresh(); }}>Retry</button>}

      {phase === "enabled" && state && (
        <>
          <p>Enabled.</p>
          <label>
            Token
            {/* Not SecretInput: that component hardcodes type="password" (verified against
                every existing usage in this codebase, all write-only secret-entry fields) and
                would keep the real, freshly-generated token permanently dot-masked even when
                revealedToken holds the plaintext. A plain input, switched to type="text" only
                while a real value is present, is the correct one-time-reveal control here. */}
            <input readOnly type={revealedToken ? "text" : "password"} value={revealedToken ?? "••••••••••••••••••••••••••••••••"} />
          </label>
          {revealedToken && <p className="muted">Copy this now — it won't be shown again. Use Regenerate Token to get a new one if you lose it.</p>}
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} /></label>
          <button onClick={() => { void handleUpdateRoleIds(); }}>Save Role IDs</button>
          <button onClick={() => { void handleRegenerate(); }}>Regenerate Token</button>
          {choice === "hosted" && <p>Paste the token into <a href="https://mentat-link.darkdante.org/setup">mentat-link's setup form</a>.</p>}
          {choice === "self-hosted" && <p>Put the token in your bot's <code>.env</code> — see the <a href="https://github.com/Project-Arrakis/mentat/blob/main/docs/installation-guide.md">installation guide</a>.</p>}
        </>
      )}

      <ConfirmDialog request={confirmRequest} onClose={(outcome) => confirmRequest?.resolve(outcome)} />
    </div>
  );
}
