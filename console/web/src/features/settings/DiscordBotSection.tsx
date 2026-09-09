import { useEffect, useState } from "react";
import { discordAdapterSettingsApi, type DiscordBotSettingsState } from "../../api/discordAdapterSettings";
import { updatesApi } from "../../api/updates";
import { persistUpdateTask, loadPersistedUpdateTask } from "../updates/updateUtils";
import { ConfirmDialog, type ConfirmDialogRequest, type ConfirmDialogOutcome } from "../../components/common/ConfirmDialog";
import { copyText } from "../../lib/clipboard";

const TASK_KEY = "arrakis.discordAdapterEnableTask";
const CHOICE_KEY = "arrakis.discordAdapterChoice";
const POLL_INTERVAL_MS = 2000;

type Choice = "hosted" | "self-hosted" | null;
type Phase = "loading" | "disabled" | "enabling" | "enabled" | "failed";

// Same shape as loadPersistedUpdateTask/persistUpdateTask in updateUtils.ts
// (typeof-window guard, try/catch around localStorage access), just for a
// plain string value instead of a Task -- there's no shared helper for that
// shape, so this is a small, deliberately parallel pair rather than forcing
// `choice` through the Task-specific helpers.
function loadPersistedChoice(): Choice {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    return raw === "hosted" || raw === "self-hosted" ? raw : null;
  } catch {
    return null;
  }
}

function persistChoice(value: Choice) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(CHOICE_KEY, value);
    else window.localStorage.removeItem(CHOICE_KEY);
  } catch {
    // The visible page state still works if localStorage is unavailable.
  }
}

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
  // Seeded synchronously from localStorage, same convention as runId/phase
  // above -- otherwise the hosted/self-hosted token-destination instructions
  // (gated on `choice`) would vanish on every visit after the very first
  // Enable, since the backend's getState() never returns this (finding #1,
  // Layer 3 review).
  const [choice, setChoice] = useState<Choice>(() => loadPersistedChoice());
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
  const [tokenCopyResult, setTokenCopyResult] = useState("");
  // Shared "any action in flight" guard (finding #5, Layer 3 review) --
  // Enable/Save Role IDs/Regenerate Token never render at the same time as
  // each other except Save Role IDs and Regenerate Token, which is fine to
  // share since both mutate the same adapter config and shouldn't overlap
  // anyway.
  const [submitting, setSubmitting] = useState(false);

  function updateChoice(value: Choice) {
    setChoice(value);
    persistChoice(value);
  }

  async function refresh(options?: { preserveInputs?: boolean }) {
    const nextState = await discordAdapterSettingsApi.getState();
    setState(nextState);
    // The backend's persisted deploymentChoice (Task 2) is now authoritative
    // once available -- but only overwrite the localStorage-seeded choice
    // when the backend actually has a value; a null/undefined response
    // (nothing ever persisted server-side yet) must not clobber a value an
    // operator already set before this change shipped, or one already
    // selected in this session that hasn't been submitted yet.
    if (nextState.deploymentChoice) setChoice(nextState.deploymentChoice);
    // On a failed-attempt Retry, don't clobber role IDs the operator already
    // typed with the (still-disabled) server's stale values (finding #4,
    // Layer 3 review) -- only a genuine fresh mount-time load, or a refresh
    // after a confirmed success, should repopulate these fields.
    if (!options?.preserveInputs) {
      setPlayerRoleIds(nextState.roleIds.player.join(", "));
      setModeratorRoleIds(nextState.roleIds.moderator.join(", "));
      setAdminRoleIds(nextState.roleIds.admin.join(", "));
    }
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
      refresh().catch(() => {
        setError("Could not load Discord Bot settings.");
        // Without this, phase stays stuck at "loading" forever -- there is
        // no render branch for it and no way forward short of a full page
        // reload (finding #2, Layer 3 review). Scoped to this specific
        // initial-mount-load failure only: the persisted-in-flight-task
        // recovery path above skips this call entirely (runId is already
        // set), so it can never be overridden to "failed" by this catch.
        setPhase("failed");
      });
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
    // In-flight guard (finding #5, Layer 3 review): a rapid double-click
    // could otherwise fire two overlapping /enable calls, each independently
    // minting a token / queuing a task. Guard the whole handler, including
    // the confirm-dialog wait, not just the API call, so the trigger button
    // is disabled from the very first click.
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
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

      const { task, token } = await discordAdapterSettingsApi.enable({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds,
        deploymentChoice: choice
      });
      // token is absent (not just falsy) on the already-enabled/role-ids-
      // only path -- see the type's own comment in discordAdapterSettings.ts.
      // Don't overwrite a still-relevant earlier reveal with undefined here;
      // there is nothing new to show, so leave revealedToken as it was.
      if (token) {
        setRevealedToken(token);
        setTokenCopyResult("");
      }
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Save Role IDs, for an already-enabled adapter: a distinct handler and
  // route from handleEnable/enable() above -- see updateDiscordBotRoleIds()
  // in Task 8 for why sharing the enable path here would be a real bug
  // (silently rotating the live token on every role-ID edit). Now routed
  // through the same restart-warning ConfirmDialog Enable already uses
  // (finding #3, Layer 3 review) -- this also recreates/restarts the
  // console exactly like Enable does, and previously did so with zero
  // warning.
  async function handleUpdateRoleIds() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Save Discord Bot Role IDs",
          message: "The console will restart to apply this change. It will be briefly unreachable.",
          confirmLabel: "Save",
          cancelLabel: "Cancel",
          danger: false,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      const { task } = await discordAdapterSettingsApi.updateRoleIds({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds,
        deploymentChoice: choice
      });
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegenerate() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
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

      const { token } = await discordAdapterSettingsApi.regenerateToken();
      setRevealedToken(token);
      setTokenCopyResult("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyRevealedToken() {
    if (!revealedToken) return;
    try {
      await copyText(revealedToken);
      setTokenCopyResult("Copied");
    } catch {
      setTokenCopyResult("Copy failed. Select the token manually.");
    }
  }

  return (
    <div className="playerAdmin_toggleBody">
      <p className="muted">For bot commands and in-game data access — not console admin sign-in, see the Discord OAuth section above.</p>
      {error && <div className="confirm-modal-warning">{error}</div>}

      {/* Finding 4 (final review): hoisted above the phase-specific
          branches below so it renders whenever a token was just revealed,
          regardless of which phase the component is currently in --
          previously this only rendered inside phase === "enabled", so an
          Enable that succeeded but then failed its post-recreate health
          check (phase moves to "failed") left the one-time token
          permanently unreachable: Regenerate Token is owner-only, the
          token is never persisted (deliberate, Requirement 24), and a
          page reload discards it entirely. */}
      {revealedToken && (
        <div className="settings-token-reveal">
          <label>
            Your new token (copy it before leaving this page)
            <input readOnly type="text" value={revealedToken} />
            <button type="button" onClick={() => { void copyRevealedToken(); }}>Copy</button>
          </label>
          <p className="muted">Copy this now — it won't be shown again. Use Regenerate Token to get a new one if you lose it.</p>
          {tokenCopyResult && <span className="muted" role="status">{tokenCopyResult}</span>}
        </div>
      )}

      {phase === "disabled" && (
        <>
          <div className="settings-choice">
            <p>Which are you using?</p>
            <button className={choice === "hosted" ? "active" : ""} aria-pressed={choice === "hosted"} onClick={() => updateChoice("hosted")}>Hosted bot</button>
            <button className={choice === "self-hosted" ? "active" : ""} aria-pressed={choice === "self-hosted"} onClick={() => updateChoice("self-hosted")}>Self-hosting</button>
          </div>
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <button disabled={!choice || submitting} onClick={() => { void handleEnable(); }}>Enable Discord Bot Integration</button>
        </>
      )}

      {phase === "enabling" && <p>Applying settings and restarting the console…</p>}

      {/* On a failed-attempt Retry (task/enable failure), state is already
          non-null from an earlier successful load -- preserve whatever the
          operator typed rather than re-fetching stale server values over it
          (finding #4). On a genuine initial-mount-load failure, state is
          still null and there's nothing typed yet to preserve, so this
          Retry does a real fresh load (finding #2). */}
      {phase === "failed" && <button onClick={() => { void refresh({ preserveInputs: state !== null }); }}>Retry</button>}

      {phase === "enabled" && state && (
        <>
          <p>Enabled.</p>
          {/* The real, one-time reveal (plaintext value + Copy button) now
              lives in the hoisted block above, so it also survives a
              transition into phase === "failed" (Finding 4). This masked
              placeholder only covers the ordinary case: a normal page
              view/reload where nothing was revealed in this browser
              session, but the adapter does have a token configured. */}
          {!revealedToken && (
            <label>
              Token
              <input readOnly type="password" value="••••••••••••••••••••••••••••••••" />
            </label>
          )}
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} /></label>
          <button disabled={submitting} onClick={() => { void handleUpdateRoleIds(); }}>Save Role IDs</button>
          <button disabled={submitting} onClick={() => { void handleRegenerate(); }}>Regenerate Token</button>
          {choice === "hosted" && <p>Paste the token into <a href="https://mentat-link.darkdante.org/setup">mentat-link's setup form</a>.</p>}
          {choice === "self-hosted" && <p>Put the token in your bot's <code>.env</code> — see the <a href="https://github.com/Project-Arrakis/mentat/blob/main/docs/installation-guide.md">installation guide</a>.</p>}
        </>
      )}

      <ConfirmDialog request={confirmRequest} onClose={(outcome) => confirmRequest?.resolve(outcome)} />
    </div>
  );
}
