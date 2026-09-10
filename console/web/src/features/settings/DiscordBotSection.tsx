import { useEffect, useRef, useState } from "react";
import { discordAdapterSettingsApi, type DiscordBotSettingsState } from "../../api/discordAdapterSettings";
import { discordHostedBotApi, type OwnedDiscordGuild } from "../../api/discordHostedBotApi";
import { updatesApi } from "../../api/updates";
import { persistUpdateTask, loadPersistedUpdateTask } from "../updates/updateUtils";
import { ConfirmDialog, type ConfirmDialogRequest, type ConfirmDialogOutcome } from "../../components/common/ConfirmDialog";
import { copyText } from "../../lib/clipboard";
import { SecretInput } from "../../components/SecretInput";

const TASK_KEY = "arrakis.discordAdapterEnableTask";
const CHOICE_KEY = "arrakis.discordAdapterChoice";
const POLL_INTERVAL_MS = 2000;
// Real UAT finding: the existing "this will restart the console" confirm
// dialog is a single click, and the moment it's confirmed the actual
// restart fires immediately with no further warning -- it felt abrupt and
// uncontrolled. Mirrors this codebase's own game-server restart queue
// pattern (AdminToolsPanel's "Restart Now" button skipping a countdown),
// scaled down for a console self-restart: a short, visible countdown with
// an explicit "Restart Now" to skip the wait, rather than either an
// instant restart or a mandatory full wait.
const RESTART_COUNTDOWN_SECONDS = 10;
// Real UAT finding (2026-09-09): nothing in this wizard ever told the
// operator that inviting the hosted bot (Sahir Venn) to their own Discord
// server is a separate, required, external step -- "Connect to hosted
// bot" below only verifies guild ownership and registers with mentat, it
// can never add the bot to a guild itself (Discord's OAuth `bot` scope
// consent is the only mechanism that does that, and it's a completely
// different flow from the `identify guilds` scope this component's own
// OAuth round trip uses). This is the exact same invite link mentat-link's
// own marketing/docs site already uses -- same client ID, same scope,
// same fixed permissions=128 -- so an operator who already knows to visit
// mentat-link doesn't get a different link/flow than one who never leaves
// the console. Hardcoded (not configurable) deliberately: the "Hosted
// bot" choice this button lives under is already, by design, wired
// specifically to this org's own mentat/Sahir Venn service (see
// mentatBackendRegisterUrl in server.js's config), not a generic
// pluggable backend -- this is consistent with that, not a new pattern.
const MENTAT_BOT_INVITE_URL = "https://discord.com/oauth2/authorize?client_id=1546203607807041697&scope=bot%20applications.commands&permissions=128";

// openBotInviteWindow: a popup, not a full-page navigation, so the
// operator never loses their place in this wizard. Discord's own
// bot-invite consent flow needs no redirect_uri at all -- approving (or
// cancelling) lands on Discord's own confirmation page inside the popup,
// which the operator closes themselves. Polling `.closed` (there is no
// cross-origin way to observe the popup's own navigation or get a
// postMessage from Discord's page) is what lets the wizard notice the
// operator is back without requiring them to click anything else here.
function openBotInviteWindow(onClosed: () => void) {
  const popup = window.open(MENTAT_BOT_INVITE_URL, "discord-bot-invite", "width=500,height=800");
  if (!popup) return; // popup blocked -- the link below still works as a normal click-through
  const timer = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(timer);
      onClosed();
    }
  }, 500);
}

type Choice = "hosted" | "self-hosted" | null;
type Phase = "loading" | "disabled" | "enabling" | "enabled" | "failed";
// The first-time setup wizard's own step, independent of Phase above.
// Only meaningful while phase === "disabled" -- once genuinely enabled,
// the operator is in the ongoing-management view (existing Save Role
// IDs / Regenerate Token / hosted-connect UI below), not the wizard.
// Real UAT feedback (2026-09-09): the previous single flat form asked
// for Role IDs before any bot was even configured, with no guidance on
// what either choice meant until well after clicking Enable -- this
// wizard exists specifically to sequence those concerns instead of
// showing everything at once with no context.
type WizardStep = 1 | 2 | 3;

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
  // Real UAT finding (2026-09-09): an earlier version of this component
  // auto-skipped straight to step 2 whenever a choice was already
  // persisted from an earlier visit, on the theory that reloading
  // mid-setup shouldn't force re-picking hosted/self-hosted. In practice
  // this was actively confusing -- the operator never saw step 1 at all
  // and had no idea which choice, or why, had already been made for
  // them. The wizard now ALWAYS starts at step 1 on every fresh mount,
  // with no silent skip for any reason -- choice/role-ID VALUES are
  // still preserved across a reload (see loadPersistedChoice() above and
  // preserveInputs in refresh() below), only the wizard's own on-screen
  // step position is not.
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
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
  // Task 8 (hosted-bot console-initiated OAuth registration): seeded once,
  // synchronously, from sessionStorage -- the OAuth callback redirect back
  // to this page is expected to have stashed the operator's owned-guild
  // list there before this component mounts (see hostedBotOAuth.js's
  // hostedBotOAuthReturnPage(), and discordHostedBotApi.readOwnedGuilds(),
  // renamed from readOwnedGuildsFromWindow -- final integration review,
  // CRITICAL -- since a plain `window` property never actually survives the
  // callback page's own full-document `window.location.replace("/")`
  // navigation into this SPA's brand-new window; sessionStorage is scoped
  // to the origin, not to a `window` instance, so it does).
  // readOwnedGuilds() deletes the sessionStorage key as it reads it, which
  // makes the useState initializer below impure -- React.StrictMode
  // (main.tsx) deliberately double-invokes an impure lazy-initializer
  // function to surface exactly this hazard. Verified directly (fix-round-1
  // review, when this still read from `window`): a naive
  // `useState(() => readOwnedGuildsFromWindow())` genuinely calls the reader
  // TWICE per mount under StrictMode -- in the installed React 19 build the
  // DOM still happened to render the real guild list either way (which
  // call's result React keeps turned out to be an unspecified
  // implementation detail this component must not rely on), but the
  // destructive read/delete itself still fired twice, which is the real
  // defect: a second, silent, no-op read of a resource that's supposed to
  // be consumed exactly once. Cache the outcome of the *first* call in a
  // ref (created once; empirically confirmed to keep its mutated value
  // across both StrictMode invocations of this fiber's render) so the
  // underlying read only ever happens once, and every invocation of the
  // initializer -- however many times React makes it -- returns the same,
  // cached value. Same hazard class BaseWaterTab.tsx/BaseInventoryTab.tsx
  // guard against for their load effects (a ref-guard against StrictMode's
  // double-invoke), adapted here for a lazy initializer rather than an
  // effect. Covered by the "reads owned guilds exactly once under a
  // StrictMode double-invoke" test below, which asserts the call count
  // directly rather than relying on the DOM output that happens to look
  // correct either way.
  const ownedGuildsFromStorageRef = useRef<OwnedDiscordGuild[] | null | undefined>(undefined);
  const [ownedGuilds, setOwnedGuilds] = useState<OwnedDiscordGuild[] | null>(() => {
    if (ownedGuildsFromStorageRef.current === undefined) {
      const fromStorage = discordHostedBotApi.readOwnedGuilds();
      ownedGuildsFromStorageRef.current = fromStorage.length > 0 ? fromStorage : null;
    }
    return ownedGuildsFromStorageRef.current;
  });
  const [pickedGuild, setPickedGuild] = useState<OwnedDiscordGuild | null>(null);
  const [connectedGuildName, setConnectedGuildName] = useState<string | null>(null);
  // Set once the "Add to Discord" popup closes (see openBotInviteWindow
  // above) -- purely a UI acknowledgement so the operator gets some
  // feedback that they're back, since there's no reliable cross-origin
  // way to confirm the invite actually succeeded from here.
  const [botInviteWindowClosed, setBotInviteWindowClosed] = useState(false);
  // Independent UI/UX review (HIGH H1): "Add to Discord" (invites the bot)
  // and "Connect to hosted bot" (verifies guild ownership + registers) are
  // fully independent -- an operator can skip the invite entirely, still
  // successfully register a guild, and finish the whole wizard with a
  // registered-but-never-invited, non-functional bot integration, with
  // nothing anywhere telling them. This can't be verified for real from
  // here (no reliable cross-origin signal that the invite popup actually
  // completed, see openBotInviteWindow's own comment) -- an explicit
  // acknowledgement is the honest, lightweight mitigation: it doesn't
  // guarantee correctness, but it forces the operator to consciously
  // confirm the step rather than silently skip past it.
  const [botInviteAcknowledged, setBotInviteAcknowledged] = useState(false);
  // Real UAT finding (2026-09-09): "Connect to hosted bot" needs its own,
  // independent Discord Application -- deliberately separate from Settings
  // -> Discord OAuth's console-sign-in credentials ("we have OAuth without
  // bot and bot without OAuth"). oauthClientId/oauthRedirectUri are
  // pre-filled from refresh()'s fetched state (non-secret, safe to show
  // back); oauthSecret is always blank -- the server never returns it.
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthRedirectUri, setOAuthRedirectUri] = useState("");
  const [oauthSecret, setOAuthSecret] = useState("");
  const [oauthConfigured, setOAuthConfigured] = useState(false);
  const [oauthSaving, setOAuthSaving] = useState(false);
  const [oauthSaveResult, setOAuthSaveResult] = useState("");
  // Real UAT finding (2026-09-10): 3-step wizard redesign -- "Add bot to
  // Discord" is now step 1, ahead of role config and the restart, but
  // registering a guild with mentat requires the console's own adapter
  // token to already exist (tokenConfigured). Picking "Hosted bot" now
  // silently mints that token in the background (enable() already does
  // this without restarting, unchanged from the earlier fix) -- this
  // just gates step 1's Discord-connection UI behind that finishing,
  // instead of asking the operator to click a separate "Enable" first.
  const [silentEnabling, setSilentEnabling] = useState(false);
  // Real UAT finding (2026-09-09): handleEnable()/handleUpdateRoleIds()
  // used to fire their restart-triggering API call the instant the
  // ConfirmDialog above was confirmed, with no further warning -- the
  // console just went unreachable a moment later with no acknowledgement.
  // waitForRestartCountdown() adds a visible pause between confirmation
  // and the actual restart: a countdown notice with a "Restart Now"
  // button to skip the wait. It resolves either when the countdown
  // reaches zero (the ticking effect below) or when the operator clicks
  // "Restart Now" (finishRestartCountdown()), whichever comes first. The
  // resolver is stashed in a ref rather than state since it's a function,
  // not a value the render needs to read.
  const restartCountdownResolveRef = useRef<(() => void) | null>(null);
  const [restartCountdownSeconds, setRestartCountdownSeconds] = useState<number | null>(null);

  function waitForRestartCountdown(seconds: number) {
    return new Promise<void>((resolve) => {
      restartCountdownResolveRef.current = resolve;
      setRestartCountdownSeconds(seconds);
    });
  }

  function finishRestartCountdown() {
    restartCountdownResolveRef.current?.();
    restartCountdownResolveRef.current = null;
    setRestartCountdownSeconds(null);
  }

  useEffect(() => {
    if (restartCountdownSeconds === null) return;
    if (restartCountdownSeconds <= 0) {
      finishRestartCountdown();
      return;
    }
    const timer = setTimeout(() => {
      setRestartCountdownSeconds((seconds) => (seconds === null ? null : seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [restartCountdownSeconds]);

  function updateChoice(value: Choice) {
    setChoice(value);
    persistChoice(value);
  }

  // Picking a choice on the wizard's first step records it and, for
  // self-hosted, advances straight to role config -- unchanged. The choice
  // buttons in the ongoing-management view (phase === "enabled") use plain
  // updateChoice() instead, since that view isn't part of the step-1..3
  // wizard at all.
  //
  // Real UAT finding (2026-09-10): "Hosted bot" now STAYS on step 1 --
  // step 1's own content switches from the picker to "Add bot to Discord"
  // (see the render below), matching the operator's own requested step
  // order (add bot -> configure roles -> restart) instead of the previous
  // order (choice -> roles -> enable, with the Discord connection buried
  // in the post-enable management view). Persists deploymentChoice
  // server-side immediately (the hosted-bot OAuth routes' gate needs it)
  // and silently mints the adapter token in the background (Register
  // needs tokenConfigured -- see enable()'s own comment for why this
  // doesn't trigger a restart) so every button in step 1's Discord-connect
  // flow is immediately usable, with no separate "Enable" click first.
  async function chooseAndAdvance(value: Choice) {
    updateChoice(value);
    if (value === "self-hosted") {
      setWizardStep(2);
    }
    setError("");
    try {
      await discordAdapterSettingsApi.setChoice(value === "hosted" ? "hosted" : "self-hosted");
      if (value === "hosted" && !state?.tokenConfigured) {
        setSilentEnabling(true);
        // Independent UI/UX review (CRITICAL C2): this used to also call
        // setRevealedToken(), surfacing the full "copy this now, it will
        // never be shown again" one-time-secret banner the instant the
        // operator clicked a picker button -- alarming and unexplained,
        // with none of the self-hosted path's own handoff panel telling
        // them why. The hosted path never needs the operator to manually
        // handle this token at all (mentat's own registration call
        // forwards it server-side) -- deliberately discarded here rather
        // than revealed, unlike every other mint in this file.
        await discordAdapterSettingsApi.enable({
          playerRoleIds: "",
          moderatorRoleIds: "",
          adminRoleIds: "",
          deploymentChoice: "hosted"
        });
        // Deliberately NOT calling refresh() here -- the server genuinely
        // does report enabled: true now, and refresh() unconditionally
        // sets phase to match (see its own comment below), which would
        // drop straight to the post-setup management view before the
        // operator has even seen step 1's "Add bot to Discord" content.
        // Patch just the one field this step actually needs -- the rest
        // of the wizard's state (oauthConfigured, connectedGuildName,
        // ownedGuilds) already came from the real mount-time refresh()
        // and this silent enable doesn't touch any of it.
        setState((prev) => (prev ? { ...prev, enabled: true, tokenConfigured: true } : prev));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSilentEnabling(false);
    }
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
    // Final integration review (Important #5): the persisted hosted-bot
    // connection (adapterSettings.js's persistHostedBotConnectedGuild(),
    // written by the /register route on a successful mentat response) is
    // now the source of truth for "Connected to hosted bot for {name}"
    // across a page reload -- previously this was pure in-memory React
    // state, so a reload silently showed "Connect to hosted bot" again as
    // if the registration had never happened.
    //
    // Fix round 2 (Priority 2): unlike deploymentChoice/role IDs above,
    // this is unconditionally synced from the server on every refresh(),
    // not just set-when-truthy. handleRegisterGuild() sets it directly and
    // never goes through refresh() itself, so there's no "unsubmitted local
    // draft" here to protect the way there is for a text input or an
    // as-yet-unsaved choice toggle -- the server's value (persisted-or-
    // cleared) is always authoritative wherever refresh() IS called. This
    // matters concretely for handleRegenerate()'s own refresh() call: the
    // backend now clears the persisted connection when the token is
    // regenerated (adapterSettings.js's clearHostedBotConnectedGuild()),
    // and without syncing the "now empty" case here too, this component
    // would keep showing "Connected to hosted bot for {name}" using a
    // stale local value forever, with the Connect button permanently
    // hidden behind it.
    setConnectedGuildName(nextState.hostedBotConnectedGuildName || null);
    // On a failed-attempt Retry, don't clobber role IDs the operator already
    // typed with the (still-disabled) server's stale values (finding #4,
    // Layer 3 review) -- only a genuine fresh mount-time load, or a refresh
    // after a confirmed success, should repopulate these fields.
    if (!options?.preserveInputs) {
      setPlayerRoleIds(nextState.roleIds.player.join(", "));
      setModeratorRoleIds(nextState.roleIds.moderator.join(", "));
      setAdminRoleIds(nextState.roleIds.admin.join(", "));
      // Real UAT finding (2026-09-09): same reasoning as role IDs above --
      // don't clobber an in-progress edit of the hosted-bot connection's
      // own OAuth config on an unrelated refresh(). The client secret
      // itself is never returned by the server, so there's nothing to
      // repopulate there regardless.
      setOAuthClientId(nextState.hostedBotOAuthClientId || "");
      // Real UAT finding (2026-09-10): "why are we asking for Redirect URI
      // -- we're hosting the bot, we know the redirect URL." The PATH is
      // fixed by this route's own code; only the domain varies per
      // self-hosted install, and the browser's current origin already is
      // that domain in the overwhelming common case. Pre-fill with the
      // computed value instead of leaving this blank with just a
      // placeholder hint -- still a real, editable field (not hardcoded
      // outright), since an operator behind a reverse proxy or reachable
      // at a different public hostname than their browser's current
      // origin genuinely does need to override it, same as the existing
      // Settings -> Discord OAuth sign-in redirect URI field already
      // requires for the identical reason. Only defaults when nothing is
      // saved yet (hostedBotOAuthRedirectUri falsy) -- never overwrites a
      // real, already-configured value, including one that was
      // deliberately overridden away from this same computed default.
      setOAuthRedirectUri(nextState.hostedBotOAuthRedirectUri || `${window.location.origin}/api/integrations/discord/hosted-bot/oauth/callback`);
    }
    setOAuthConfigured(Boolean(nextState.hostedBotOAuthConfigured));
    // Never assume "never configured" -- always reflect real state
    // (Layer 1 audit finding #7, converged on by 3 independent hats).
    setPhase(nextState.enabled ? "enabled" : "disabled");
    // Landing back in the Disabled wizard via this refresh() -- a genuine
    // fresh mount, or a Retry after a failed enable -- always resets to
    // wizard step 1. An earlier version of this tried to skip ahead to
    // step 2 when a choice was already known, on the theory that it saved
    // a click on Retry -- real UAT found that same skip-ahead logic (also
    // present in the wizardStep useState initializer, see its own comment)
    // was confusing on a genuine fresh mount, so it's removed everywhere,
    // not just there, for one consistent, predictable rule: the wizard
    // always starts at step 1. `choice`/role-ID VALUES are still preserved
    // (see loadPersistedChoice()/preserveInputs above) -- an operator who
    // already picked "hosted" sees it already highlighted the moment they
    // reach step 1 again, they just aren't skipped past seeing it.
    if (!nextState.enabled) setWizardStep(1);
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

      // Real UAT finding (2026-09-09): persist config and reveal the
      // one-time token FIRST -- before the restart countdown, not after --
      // so the operator actually has a window to copy it while the console
      // is still fully reachable. enable() no longer triggers the restart
      // itself (see its own comment in discordAdapterSettings.ts); restart()
      // below is the explicit, separate call for that, made only once the
      // countdown resolves (by timeout or "Restart Now").
      const { token } = await discordAdapterSettingsApi.enable({
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

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

      const { task } = await discordAdapterSettingsApi.restart();
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

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

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

  // Real UAT finding (2026-09-09): "I see no path to remove the bot" --
  // this feature shipped Enable/Save Role IDs/Regenerate Token but no way
  // back to "never configured." Same countdown-before-restart pattern as
  // handleUpdateRoleIds() above (no token to reveal here, so no need for
  // Enable's reveal-before-restart split) -- disable() persists the reset,
  // then restart() (the same shared trigger Enable now uses) actually
  // recreates the console once the operator has acknowledged it.
  async function handleDisable() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Disable Discord Bot Integration",
          message: "This invalidates the current adapter token and clears your saved role mappings and hosted/self-hosted choice -- you'll go through setup again to re-enable it. The console will restart to apply this change. This cannot be undone.",
          confirmLabel: "Disable",
          cancelLabel: "Cancel",
          danger: true,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      await discordAdapterSettingsApi.disable();
      // Real UAT finding (2026-09-10): disable() clears deploymentChoice
      // server-side, but refresh()'s own sync deliberately never clobbers
      // this client-side value with a null/empty server response (that
      // protection exists to avoid wiping an unsaved in-progress choice
      // elsewhere) -- without resetting it here too, the next visit to
      // wizard step 1 would skip straight to "Add bot to Discord" (still
      // choice === "hosted" locally) instead of genuinely starting over
      // at the picker, even though the adapter really is back to
      // never-configured.
      updateChoice(null);

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

      const { task } = await discordAdapterSettingsApi.restart();
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Real UAT finding (2026-09-09): "we have OAuth without bot and bot
  // without OAuth" -- the hosted-bot connection's own, independent Discord
  // Application config, deliberately not routed through the restart-
  // countdown machinery above: this only takes effect after a restart
  // regardless (same convention as Settings -> Discord OAuth's own save
  // flow), but there's no live secret to reveal and no immediate outage to
  // warn about from this call alone -- the operator triggers the actual
  // restart separately, whenever they next Enable/Save Role IDs/Disable.
  async function handleSaveOAuthConfig() {
    setOAuthSaving(true);
    setOAuthSaveResult("");
    setError("");
    try {
      await discordAdapterSettingsApi.saveOAuthConfig({ clientId: oauthClientId, redirectUri: oauthRedirectUri });
      if (oauthSecret) {
        await discordAdapterSettingsApi.saveOAuthSecret(oauthSecret);
        setOAuthSecret("");
      }
      setOAuthSaveResult("Saved. Restart the console (Enable, Save Role IDs, or Disable will trigger one) for this to take effect.");
      await refresh({ preserveInputs: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOAuthSaving(false);
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

  // Same in-flight guard and ConfirmDialog promise pattern as
  // handleEnable/handleUpdateRoleIds/handleRegenerate above -- a real
  // confirm-before-navigate step, not an instant redirect, since this
  // hands the operator's Discord authorization off to an external OAuth
  // flow and there's no way back from that click short of the browser's
  // own back button.
  async function handleConnectToHostedBot() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Connect to hosted bot",
          message: "Your Discord authorization will be used once to verify you own this server, then sent to and independently verified by the hosted bot service (mentat), and discarded -- it is never stored.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
          danger: false,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;
      window.location.href = discordHostedBotApi.startOAuthUrl();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegisterGuild() {
    if (!pickedGuild || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await discordHostedBotApi.register(pickedGuild.id, pickedGuild.name, window.location.origin);
      setConnectedGuildName(pickedGuild.name);
      setOwnedGuilds(null);
      setPickedGuild(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Final integration review (Important #6): on failure (needsReauth,
      // a 502 from mentat, etc.), clear the picker too -- otherwise the
      // operator is stuck looking at a guild picker with an error message
      // telling them to "connect again," with no way to actually restart
      // the flow, since the "Connect to hosted bot" button only renders
      // when ownedGuilds is null.
      setOwnedGuilds(null);
      setPickedGuild(null);
    } finally {
      setSubmitting(false);
    }
  }

  // Real UAT finding (2026-09-10): shared between wizard step 1 ("Add bot
  // to Discord", first-time setup) and the post-setup management view
  // (phase === "enabled") -- operators need to redo this after initial
  // setup too (re-invite after being kicked, reconnect after
  // Regenerate Token clears the connection, change the Discord
  // Application's credentials). One rendering, two call sites, so they
  // can never drift out of sync with each other.
  function renderHostedBotConnection() {
    return (
      <>
        <div className="settings-hosted-bot-oauth-config">
          {/* Real UAT finding (2026-09-09): "we have OAuth without bot
              and bot without OAuth" -- this Discord Application is
              specific to the hosted-bot connection and deliberately
              independent of Settings -> Discord OAuth's console-sign-in
              app. Neither requires the other to be configured. */}
          <p className="muted">
            {oauthConfigured ? "Hosted bot connection: configured." : "Hosted bot connection: not yet configured."}{" "}
            This is its own Discord Application, separate from console sign-in (Settings → Discord OAuth) — you don't need one configured to use the other.
          </p>
          <label>Client ID<input disabled={oauthSaving} value={oauthClientId} onChange={(event) => setOAuthClientId(event.target.value)} placeholder="Discord application client ID" /></label>
          <label>Client Secret<SecretInput disabled={oauthSaving} value={oauthSecret} onChange={(event) => setOAuthSecret(event.target.value)} placeholder={oauthConfigured ? "Paste new to replace" : "Discord application client secret"} /></label>
          <label>
            Redirect URI
            <input disabled={oauthSaving} value={oauthRedirectUri} onChange={(event) => setOAuthRedirectUri(event.target.value)} />
          </label>
          <p className="muted">Pre-filled from this page's own address — register this exact value in your Discord Application's OAuth settings. Only change it if this console is reachable at a different public address than the one you're using right now (e.g. behind a reverse proxy).</p>
          <button type="button" disabled={oauthSaving} onClick={() => { void handleSaveOAuthConfig(); }}>{oauthSaving ? "Saving..." : "Save Hosted Bot Connection"}</button>
          {oauthSaveResult && <p className="muted" role="status">{oauthSaveResult}</p>}
        </div>
        {!ownedGuilds && !connectedGuildName && (
          <>
            <button type="button" onClick={() => openBotInviteWindow(() => setBotInviteWindowClosed(true))}>Add to Discord</button>
            <button disabled={submitting} onClick={() => { void handleConnectToHostedBot(); }}>Connect to hosted bot</button>
            {botInviteWindowClosed && <p className="muted" role="status">Welcome back — click Connect to hosted bot once you've invited the bot.</p>}
          </>
        )}
        {connectedGuildName && <p>Connected to hosted bot for {connectedGuildName}.</p>}
        {ownedGuilds && (
          <div className="settings-hosted-guild-picker">
            <p>Which server is this for?</p>
            <ul>
              {ownedGuilds.map((guild) => (
                <li key={guild.id}>
                  <button
                    className={pickedGuild?.id === guild.id ? "active" : ""}
                    aria-pressed={pickedGuild?.id === guild.id}
                    onClick={() => setPickedGuild(guild)}
                  >
                    {guild.name}
                  </button>
                </li>
              ))}
            </ul>
            {pickedGuild && <button disabled={submitting} onClick={() => { void handleRegisterGuild(); }}>Register</button>}
          </div>
        )}
      </>
    );
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

      {/* Hoisted for the same reason as revealedToken above -- this must
          render regardless of which phase-specific branch is active,
          since handleUpdateRoleIds() fires from phase === "enabled" while
          handleEnable() fires from phase === "disabled". */}
      {restartCountdownSeconds !== null && (
        <div className="settings-restart-countdown" role="status">
          <p>
            Restarting the console in <strong>{restartCountdownSeconds}s</strong> to apply this change. It will be briefly unreachable.
          </p>
          <button type="button" onClick={finishRestartCountdown}>Restart Now</button>
        </div>
      )}

      {phase === "disabled" && (
        <div className="settings-wizard">
          <p className="settings-wizard-step-indicator">Step {wizardStep} of 3</p>
          {/* Real UAT finding: landing directly on step 2 (a choice
              persisted from an earlier visit skips step 1 entirely, see
              the wizardStep useState initializer) gave no indication
              anywhere on this page of which choice was actually active --
              only the Back button on step 3's own "generates a token for
              your own bot" sentence hinted at it. Shown whenever a choice
              is active so it's never ambiguous which path is selected --
              including on step 1 itself once "Hosted bot" is picked
              (independent UI/UX review, CRITICAL C1): step 1's own content
              switches away from the picker the instant "Hosted bot" is
              picked (see below), with no other way back to it otherwise --
              an operator who picked it by mistake, or just wants to look
              at the other option, was stuck unless they completed a real
              Discord OAuth authorization just to escape. "Change" resets
              `choice` (not just wizardStep, which is already 1 here) so
              the picker genuinely re-renders regardless of which step
              this indicator appears on. */}
          {/* Suppressed specifically when the raw picker itself is what's
              on screen (self-hosted's step 1, which already shows both
              buttons with this one highlighted) -- redundant there, not
              wrong, but hosted's step 1 has no picker to fall back on
              (see above), which is exactly why this can't stay gated on
              wizardStep > 1 alone. */}
          {choice && !(wizardStep === 1 && choice === "self-hosted") && (
            <p className="settings-wizard-current-choice">
              Setting up: <strong>{choice === "hosted" ? "Hosted bot" : "Self-hosting"}</strong>{" "}
              <button type="button" onClick={() => { updateChoice(null); setWizardStep(1); }}>Change</button>
            </p>
          )}

          {/* Real UAT finding (2026-09-10): "wizard steps: 1) add bot to
              discord, 2) configure roles, 3) restart" -- step 1's own
              content now depends on `choice`, not just `wizardStep`:
              nothing picked yet shows the original picker; "Hosted bot"
              stays on step 1 and switches to the Discord-connection flow
              (chooseAndAdvance() above silently mints the adapter token in
              the background so every button here works immediately);
              "Self-hosting" has no bot to invite, so it still advances
              straight to step 2 as before. */}
          {wizardStep === 1 && choice !== "hosted" && (
            <div className="settings-wizard-step">
              <p>Which are you using?</p>
              <div className="settings-choice">
                {/* Never active/pressed in this branch -- reaching it at
                    all means choice !== "hosted" (see the outer condition
                    above); once "Hosted bot" is picked, the wizard step 1
                    && choice === "hosted" branch below takes over instead
                    of this picker re-rendering with it highlighted. */}
                <button aria-pressed={false} onClick={() => { void chooseAndAdvance("hosted"); }}>Hosted bot</button>
                <p className="muted">We run the bot for you. Invite it to your Discord server, connect it, then configure roles — no separate bot process to run.</p>
                <button className={choice === "self-hosted" ? "active" : ""} aria-pressed={choice === "self-hosted"} onClick={() => { void chooseAndAdvance("self-hosted"); }}>Self-hosting</button>
                <p className="muted">Run your own bot instance under your own Discord Application. We generate a secure adapter token for it; you deploy the bot itself.</p>
              </div>
            </div>
          )}

          {wizardStep === 1 && choice === "hosted" && (
            <div className="settings-wizard-step">
              <p>Add bot to Discord</p>
              {silentEnabling ? (
                <p className="muted">Setting up your console's connection…</p>
              ) : (
                <>
                  {/* Independent UI/UX review (MEDIUM M4): neither button
                      below names the bot -- an operator learned what
                      they were actually authorizing only once already
                      inside Discord's own consent screen. */}
                  <p className="muted">Invite Sahir Venn, the hosted bot, to your Discord server, then connect it to this console. Both are required before you can continue.</p>
                  {renderHostedBotConnection()}
                </>
              )}
              {/* Independent UI/UX review (HIGH H1): "Add to Discord" and
                  "Connect to hosted bot"/Register are fully independent --
                  an operator could register a guild without ever inviting
                  the bot to it, finish this wizard, and end up with a
                  registered-but-non-functional integration with no error
                  anywhere. There's no reliable way to verify the invite
                  actually completed from here (see openBotInviteWindow's
                  own comment) -- this is a lightweight, honest mitigation:
                  it doesn't guarantee correctness, but it stops Continue
                  from being reachable without a conscious confirmation. */}
              {connectedGuildName && (
                <label className="settings-wizard-invite-ack">
                  <input type="checkbox" checked={botInviteAcknowledged} onChange={(event) => setBotInviteAcknowledged(event.target.checked)} />
                  {" "}I've invited the bot to this Discord server
                </label>
              )}
              <button disabled={!connectedGuildName || !botInviteAcknowledged} onClick={() => setWizardStep(2)}>Continue</button>
              {!connectedGuildName && !silentEnabling && <p className="muted" role="status">Continue unlocks once the bot is connected above.</p>}
              {connectedGuildName && !botInviteAcknowledged && <p className="muted" role="status">Continue unlocks once you confirm you've invited the bot.</p>}
            </div>
          )}

          {wizardStep === 2 && (
            <div className="settings-wizard-step">
              <p>Configure roles</p>
              <p className="muted">Map Discord roles to console permission tiers (optional). You can skip this now and set it up later from this same page.</p>
              <label>Player role IDs (optional)<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <label>Moderator role IDs (optional)<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <label>Admin role IDs (optional)<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <button onClick={() => setWizardStep(1)}>Back</button>
              <button onClick={() => setWizardStep(3)}>Continue</button>
            </div>
          )}

          {wizardStep === 3 && choice === "hosted" && (
            <div className="settings-wizard-step">
              <p>Restart</p>
              {/* Independent UI/UX review (LOW L2): nothing on screen told
                  the operator why this step is worded differently from
                  the self-hosted path's "Enable Discord Bot Integration"
                  below -- the asymmetry could read as inconsistency
                  rather than the deliberate difference it is (the adapter
                  was already silently enabled back in step 1). */}
              <p className="muted">Your adapter and Discord connection were already set up in step 1 -- this just saves your role mappings and briefly restarts the console to apply them.</p>
              <button onClick={() => setWizardStep(2)}>Back</button>
              <button disabled={submitting} onClick={() => { void handleUpdateRoleIds(); }}>Save &amp; Restart</button>
            </div>
          )}

          {wizardStep === 3 && choice !== "hosted" && (
            <div className="settings-wizard-step">
              <p>Restart</p>
              <p className="muted">This generates a secure adapter token for your own bot to use and briefly restarts the console to apply it.</p>
              <button onClick={() => setWizardStep(2)}>Back</button>
              <button disabled={!choice || submitting} onClick={() => { void handleEnable(); }}>Enable Discord Bot Integration</button>
            </div>
          )}
        </div>
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
          {/* Final integration review (Important #2): this toggle used to
              render only in phase === "disabled", so a console that was
              already enabled before this branch shipped had no UI to ever
              set deploymentChoice server-side -- the client's `choice`
              state fell back to localStorage (which may be empty), and the
              server-side /oauth/start, /oauth/callback, and /register gates
              stayed closed forever unless the operator happened to also
              touch "Save Role IDs" with a `choice` already set some other
              way. Rendering it here too, wired to the same Save Role IDs
              submit (handleUpdateRoleIds already sends `deploymentChoice:
              choice`), lets an already-enabled operator set it
              retroactively and immediately see "Connect to hosted bot"
              appear once it's persisted as "hosted". */}
          <div className="settings-choice">
            <p>Which are you using?</p>
            <button className={choice === "hosted" ? "active" : ""} aria-pressed={choice === "hosted"} onClick={() => updateChoice("hosted")}>Hosted bot</button>
            <button className={choice === "self-hosted" ? "active" : ""} aria-pressed={choice === "self-hosted"} onClick={() => updateChoice("self-hosted")}>Self-hosting</button>
          </div>
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
          <button disabled={submitting} onClick={() => { void handleDisable(); }}>Disable Discord Bot Integration</button>
          {choice === "hosted" && renderHostedBotConnection()}
          {choice === "self-hosted" && (
            <div className="settings-self-hosted-handoff">
              <p>Your console side is ready. To finish, deploy your own bot instance under your own Discord Application:</p>
              <ol>
                <li>Create a Discord Application and bot at the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a> (if you haven't already)</li>
                <li>Deploy the bot software — see the <a href="https://github.com/Project-Arrakis/mentat/blob/main/docs/installation-guide.md" target="_blank" rel="noopener noreferrer">Installation Guide</a></li>
                <li>Configure it with:
                  <ul>
                    <li>Console URL: <code>{window.location.origin}</code></li>
                    <li>Adapter Token: the value shown above (use Regenerate Token if you need a fresh one)</li>
                  </ul>
                </li>
              </ol>
            </div>
          )}
        </>
      )}

      <ConfirmDialog request={confirmRequest} onClose={(outcome) => confirmRequest?.resolve(outcome)} />
    </div>
  );
}
