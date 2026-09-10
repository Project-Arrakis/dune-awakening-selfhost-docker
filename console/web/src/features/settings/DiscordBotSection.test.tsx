import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { api, post } from "../../api/client";
import { discordHostedBotApi } from "../../api/discordHostedBotApi";
import { DiscordBotSection } from "./DiscordBotSection";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);
const TASK_KEY = "arrakis.discordAdapterEnableTask";

// Final integration review (CRITICAL): seeds the owned-guilds list the way
// the REAL OAuth callback page now does -- via sessionStorage, under the
// exact key discordHostedBotApi.readOwnedGuilds() reads -- instead of the
// old, broken `window.__hostedBotOwnedGuilds__` property, which a real
// browser navigation would have already destroyed by the time this
// component mounts. See discordHostedBotApi.test.ts for the test that
// exercises the real hostedBotOAuthReturnPage() -> readOwnedGuilds()
// round trip across an actual navigation boundary.
function seedOwnedGuilds(guilds: Array<{ id: string; name: string; owner: true }>) {
  window.sessionStorage.setItem("hostedBotOwnedGuilds", JSON.stringify(guilds));
}

describe("DiscordBotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("renders the Disabled state's wizard step 1 (hosted-or-self-hosted) before anything else, with no Enable button visible yet", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    // The Enable button now lives on wizard step 3, not step 1 -- it must
    // not exist at all yet, not merely be disabled, matching the real UAT
    // complaint this wizard exists to fix (asked for role IDs/enable before
    // any choice was even made).
    expect(screen.queryByRole("button", { name: /Enable Discord Bot Integration/i })).toBeNull();
  });

  it("shows each choice's guidance immediately, before either is picked, and advances to the role-IDs step once one is", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    // Real UAT finding: clicking Self-hosting used to show zero guidance
    // until well after Enable. Both explanations must be visible up front,
    // not gated behind a click.
    expect(screen.getByText(/We run the bot for you/i)).toBeInTheDocument();
    expect(screen.getByText(/Run your own bot instance under your own Discord Application/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    expect(screen.getByLabelText(/Player role IDs \(optional\)/i)).toBeInTheDocument();
  });

  // Real UAT finding: an earlier version of this wizard silently skipped
  // step 1 whenever a choice was already persisted from an earlier visit
  // -- the operator never saw the "which are you using" prompt at all on
  // a fresh page load, with no indication anywhere of which choice had
  // already been made for them. The wizard must now ALWAYS show step 1
  // first on a fresh mount, with no silent skip for any reason -- the
  // persisted choice only shows up as that button already being
  // highlighted, never as a skipped step.
  it("always shows step 1 first on a fresh mount, even when a choice was already persisted from an earlier visit -- with that choice already highlighted", async () => {
    window.localStorage.setItem("arrakis.discordAdapterChoice", "self-hosted");
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    expect(screen.getByRole("button", { name: /Self-hosting/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Role mappings/i)).toBeNull();
  });

  // The "Setting up: X (Change)" indicator itself is still needed once the
  // operator actually reaches step 2 or 3 -- via normal navigation, not a
  // skip -- since a returning session could still lose track of which
  // choice they're mid-setup with (e.g. a Retry, which also now resets to
  // step 1 -- see the dedicated Retry test below -- so this covers the
  // plain forward-navigation case directly).
  it("shows a Setting up indicator once step 2 is actually reached via normal navigation", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    expect(screen.getByText(/Setting up:/i)).toBeInTheDocument();
    expect(screen.getByText("Self-hosting")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));
    await screen.findByText(/Which are you using/i);
  });

  it("renders the Enabled state directly, with existing role IDs populated, when the adapter is already configured -- never a false Disabled (audit finding #7)", async () => {
    mockApi.mockResolvedValue({
      enabled: true,
      roleIds: { player: ["111111111111111111"], moderator: [], admin: [] },
      tokenConfigured: true
    } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    // The Disabled-phase-only "Enable Discord Bot Integration" action must
    // never appear once genuinely enabled -- that's the real finding #7
    // guarantee this test exists for. It no longer also asserts "Which are
    // you using?" is absent: the final integration review (Important #2)
    // deliberately made that hosted/self-hosted toggle render in the
    // Enabled phase too (wired to Save Role IDs), so an already-enabled
    // console has a way to set deploymentChoice retroactively -- see the
    // dedicated test for that below.
    expect(screen.queryByRole("button", { name: /Enable Discord Bot Integration/i })).toBeNull();
    expect(screen.getByDisplayValue("111111111111111111")).toBeInTheDocument();
  });

  // Final integration review (Important #2): an operator whose console was
  // already enabled before this branch shipped previously had NO UI to
  // ever set deploymentChoice server-side once past the Disabled phase --
  // the toggle only rendered there. Confirms it now renders in Enabled
  // too, and that picking "Hosted bot" there and saving persists it the
  // same way the Disabled-phase toggle already does (via
  // handleUpdateRoleIds' own deploymentChoice: choice payload).
  it("renders the hosted/self-hosted toggle in the Enabled phase too, and Save Role IDs persists a choice made there", async () => {
    mockApi.mockResolvedValue({
      enabled: true,
      roleIds: { player: [], moderator: [], admin: [] },
      tokenConfigured: true,
      deploymentChoice: null
    } as never);
    mockPost.mockResolvedValue({ task: { id: "task-1", state: "running" } } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByText(/Which are you using/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save Role IDs/i }));
    await screen.findByText(/restart to apply this change/i);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/discord-bot/role-ids",
      expect.objectContaining({ deploymentChoice: "hosted" })
    ));
  });

  it("shows a disambiguating note distinguishing this section from Discord OAuth", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/not console admin sign-in/i);
  });

  it("regenerating the token shows a real confirm dialog before calling the API, and never launches a recreate (no /enable call)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Token/i }));
    await screen.findByText(/cannot be undone/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/regenerate-token", {}));
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything());
  });

  // Fix round 2 (final-review re-review, Priority 2): before this fix,
  // adapterSettings.js persisted the hosted-bot connection but never
  // cleared it, and this component's own refresh() only ever SET
  // connectedGuildName from the server, never cleared it back to null --
  // so regenerating the token (which invalidates the very adapter token
  // mentat's registration is keyed to) left "Connected to hosted bot for
  // X" showing forever, with the only button that could start a fresh
  // registration permanently hidden behind it. This drives the real
  // handleRegenerate() -> refresh() sequence with the backend's SECOND
  // response reporting the connection already cleared (matching what
  // regenerateDiscordBotToken()/clearHostedBotConnectedGuild() now do
  // server-side) and asserts the UI actually reflects that.
  it("regenerating the token clears a persisted hosted-bot connection and re-shows Connect to hosted bot", async () => {
    mockApi
      .mockResolvedValueOnce({
        enabled: true,
        roleIds: { player: [], moderator: [], admin: [] },
        tokenConfigured: true,
        deploymentChoice: "hosted",
        hostedBotConnectedGuildId: "111111111111111111",
        hostedBotConnectedGuildName: "My Test Guild"
      } as never)
      .mockResolvedValueOnce({
        enabled: true,
        roleIds: { player: [], moderator: [], admin: [] },
        tokenConfigured: true,
        deploymentChoice: "hosted",
        hostedBotConnectedGuildId: null,
        hostedBotConnectedGuildName: null
      } as never);
    mockPost.mockResolvedValue({ ok: true, token: "new-token-value" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Connected to hosted bot for My Test Guild/i);
    expect(screen.queryByRole("button", { name: /Connect to hosted bot/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Regenerate Token/i }));
    await screen.findByText(/cannot be undone/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate$/i }));

    await waitFor(() => expect(screen.queryByText(/Connected to hosted bot for My Test Guild/i)).toBeNull());
    expect(screen.getByRole("button", { name: /Connect to hosted bot/i })).toBeInTheDocument();
  });

  it("recovers a persisted in-flight enable across a reload: shows the enabling/restarting UI immediately (not the live-fetched Disabled state) and polls stack-progress -- reproduces the mount-time race fixed in this component (audit finding #9)", async () => {
    const persistedTask = {
      id: "task-recover-1",
      type: "discordAdapterApply",
      operation: "enable",
      status: "running",
      currentStep: "Restarting console",
      progressMessage: "",
      logLines: [],
      warnings: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorMessage: null
    };
    window.localStorage.setItem(TASK_KEY, JSON.stringify(persistedTask));

    mockApi.mockImplementation((path: string) => {
      if (path.startsWith("/api/updates/stack-progress")) {
        return Promise.resolve({ runId: persistedTask.id, state: "running", stage: "Restarting", percent: 50, message: "" } as never);
      }
      // If this were ever called on mount, the live GET reports Disabled --
      // proving the enabling UI asserted below came from the persisted task
      // being seeded synchronously, not from this call racing it.
      return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    });

    vi.useFakeTimers();
    render(<DiscordBotSection />);

    // Must be showing the enabling/restarting UI on the very first render --
    // no Disabled hosted/self-hosted picker, even before any promise settles.
    expect(screen.getByText(/Applying settings and restarting the console/i)).toBeInTheDocument();
    expect(screen.queryByText(/Which are you using/i)).toBeNull();

    // Confirm polling actually started against the persisted task's runId,
    // and -- the actual symptom of the race this test guards against -- that
    // the enabling UI is STILL showing afterward, not silently reverted to
    // the Disabled hosted/self-hosted picker by a stray initial-GET response
    // racing the persisted-task recovery.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockApi).toHaveBeenCalledWith(expect.stringContaining("/api/updates/stack-progress?runId=task-recover-1"), expect.anything());
    expect(screen.queryByText(/Which are you using/i)).toBeNull();
    expect(screen.getByText(/Applying settings and restarting the console/i)).toBeInTheDocument();
  });

  it("shows a Retry action when the applied recreate reports a failed health check, not a dead end", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings/discord-bot") {
        return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
      }
      return Promise.resolve({ runId: "test-run", state: "succeeded", stage: "complete", percent: 100, message: "", discordHealthOk: false } as never);
    });
    mockPost.mockResolvedValue({ task: { id: "test-run", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null } } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await screen.findByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument(), { timeout: 5000 });
  });

  // Finding 4 (final review): the one-time revealed token must not be lost
  // when Enable succeeds but the post-recreate health check fails. Before
  // this fix, the token block only rendered inside phase === "enabled" --
  // a transition to phase === "failed" left it permanently unreachable
  // (Regenerate Token is owner-only, the token is never persisted, and a
  // reload discards it), so a non-owner admin could be left with the
  // adapter enabled and literally no one holding the token.
  it("keeps the one-time revealed token visible and copyable after Enable succeeds but the post-recreate health check fails (finding 4)", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings/discord-bot") {
        return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
      }
      return Promise.resolve({ runId: "test-run", state: "succeeded", stage: "complete", percent: 100, message: "", discordHealthOk: false } as never);
    });
    mockPost.mockResolvedValue({
      task: { id: "test-run", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null },
      token: "freshly-minted-token-shown-once"
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await screen.findByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument(), { timeout: 5000 });

    // The token must still be visible and copyable in the resulting
    // "failed"-phase render, not silently dropped.
    expect(screen.getByDisplayValue("freshly-minted-token-shown-once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("freshly-minted-token-shown-once"));
  });

  it("persists the hosted/self-hosted choice to localStorage so the hosted-bot connect affordance survives a reload (finding 1)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    const { unmount } = render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    expect(window.localStorage.getItem("arrakis.discordAdapterChoice")).toBe("hosted");
    unmount();

    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByRole("button", { name: /Connect to hosted bot/i })).toBeInTheDocument();
  });

  it("shows a Retry action (not a permanent stuck loading screen) when the initial settings fetch fails (finding 2)", async () => {
    mockApi.mockRejectedValue(new Error("network down"));
    render(<DiscordBotSection />);
    await screen.findByText(/Could not load Discord Bot settings/i);
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("never lets the initial-mount-load failure handling interfere with a persisted in-flight task's recovery, even when the status poll itself fails transiently (finding 2 non-interference)", async () => {
    const persistedTask = {
      id: "task-recover-2",
      type: "discordAdapterApply",
      operation: "enable",
      status: "running",
      currentStep: "Restarting console",
      progressMessage: "",
      logLines: [],
      warnings: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorMessage: null
    };
    window.localStorage.setItem(TASK_KEY, JSON.stringify(persistedTask));

    // Both getState() (which the mount effect deliberately skips calling
    // when a persisted task exists) and stack-progress reject here -- if
    // finding #2's initial-mount-load failure handling were not correctly
    // scoped to skip when runId is already set, or if a transient
    // stack-progress failure incorrectly flipped phase to "failed", the
    // enabling/restarting UI below would disappear.
    mockApi.mockRejectedValue(new Error("network down"));

    vi.useFakeTimers();
    render(<DiscordBotSection />);

    expect(screen.getByText(/Applying settings and restarting the console/i)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(screen.getByText(/Applying settings and restarting the console/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  });

  it("does not clobber typed role IDs when Retry is clicked after a failed enable task (finding 4)", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings/discord-bot") {
        return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
      }
      return Promise.resolve({ runId: "test-run", state: "failed", stage: "failed", percent: 100, message: "boom" } as never);
    });
    mockPost.mockResolvedValue({
      task: { id: "test-run", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null },
      token: "abc"
    } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.change(screen.getByLabelText(/Player role IDs/i), { target: { value: "999999999999999999" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await screen.findByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    // Retry now always resets to wizard step 1 (real UAT finding -- no
    // silent skip, ever), but the CHOICE itself is preserved and already
    // highlighted, so getting back to step 2 to see the preserved role ID
    // is just re-confirming the same choice, not re-deciding it.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Self-hosting$/i })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: /^Self-hosting$/i }));
    await waitFor(() => expect(screen.getByDisplayValue("999999999999999999")).toBeInTheDocument());
  });

  it("points the OAuth disambiguation note in the correct direction (finding 6)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/not console admin sign-in/i);
    expect(screen.queryByText(/see discord oauth below/i)).toBeNull();
  });

  it("asks for confirmation before Save Role IDs restarts the console (finding 3)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    mockPost.mockResolvedValue({
      task: { id: "role-task", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }
    } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Save Role IDs/i }));
    await screen.findByText(/restart/i);
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/role-ids", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/role-ids", expect.anything()));
    // Save Role IDs must call updateRoleIds (/role-ids), never enable
    // (/enable) -- sharing the enable path here would silently rotate the
    // live token on every role-ID edit (see updateDiscordBotRoleIds()'s own
    // comment in adapterSettings.js for why these are deliberately separate
    // functions/routes).
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything());
  });

  it("disables the Enable button while its confirm dialog is open, guarding against a rapid double-click (finding 5)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    const enableButton = await screen.findByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(enableButton);
    await screen.findByText(/will restart to apply this change/i);
    expect(enableButton).toBeDisabled();
  });

  it("disables Save Role IDs and Regenerate Token while one action's confirm dialog is open (finding 5)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    const saveButton = screen.getByRole("button", { name: /Save Role IDs/i });
    const regenButton = screen.getByRole("button", { name: /Regenerate Token/i });
    fireEvent.click(saveButton);
    await screen.findByText(/restart/i);
    expect(saveButton).toBeDisabled();
    expect(regenButton).toBeDisabled();
  });

  it("re-enables the trigger button after the confirm dialog is cancelled (finding 5 cancel path)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    const enableButton = await screen.findByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(enableButton);
    await screen.findByText(/will restart to apply this change/i);
    expect(enableButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => expect(enableButton).not.toBeDisabled());
    // Self-hosting's own choice-persist call (a legitimate side effect of
    // picking it earlier in this test) is expected -- cancelling the
    // confirm dialog must specifically never reach /enable.
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything());
  });

  it("offers a Copy button for the one-time revealed token (finding 7)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    mockPost.mockResolvedValue({ ok: true, token: "the-plaintext-token" } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Token/i }));
    await screen.findByText(/cannot be undone/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate$/i }));
    await screen.findByDisplayValue("the-plaintext-token");

    fireEvent.click(screen.getByRole("button", { name: /^Copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the-plaintext-token"));
  });

  // Real UAT finding (2026-09-10): 3-step wizard redesign -- picking
  // "Hosted bot" now persists deploymentChoice AND silently mints the
  // adapter token immediately (no separate step-3 "Enable" click for the
  // hosted path at all -- step 3 is "Save & Restart" instead, see the
  // dedicated test below), so /oauth/start's gate and /register's
  // tokenConfigured precondition are both already satisfied by the time
  // step 1's "Add bot to Discord" content renders.
  it("persists the choice and silently mints the adapter token the moment Hosted bot is picked, with no restart or confirm dialog", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/choice", { deploymentChoice: "hosted" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/discord-bot/enable",
      expect.objectContaining({ deploymentChoice: "hosted", playerRoleIds: "", moderatorRoleIds: "", adminRoleIds: "" })
    ));
    // No confirm dialog and no restart countdown for this silent mint --
    // unlike step 3's own Enable/Save & Restart actions.
    expect(screen.queryByText(/will restart to apply this change/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Restart Now$/i })).toBeNull();
    await screen.findByText(/Add bot to Discord/i);
  });

  it("does not re-mint the token if Hosted bot is already configured (e.g. returning to step 1 via Change)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: null } as never);
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/choice", { deploymentChoice: "hosted" }));
    await screen.findByText(/Add bot to Discord/i);
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything());
  });

  it("exposes wizard step 1's hosted/self-hosted buttons' initial unselected state to assistive tech via aria-pressed (finding 8)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    // The wizard now advances off step 1 the moment a choice is picked, so
    // there's no "pressed" state to observe on these particular buttons
    // afterward -- confirmed unpressed here; the toggle that stays mounted
    // long enough to show a "true" transition is the Enabled-phase one,
    // covered by the test below.
    expect(screen.getByRole("button", { name: /Hosted bot/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Self-hosting/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("exposes the Enabled-phase hosted/self-hosted toggle's selected state to assistive tech via aria-pressed (finding 8)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: null } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    const hostedButton = screen.getByRole("button", { name: /^Hosted bot$/i });
    const selfHostedButton = screen.getByRole("button", { name: /Self-hosting/i });
    expect(hostedButton).toHaveAttribute("aria-pressed", "false");
    expect(selfHostedButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hostedButton);
    expect(hostedButton).toHaveAttribute("aria-pressed", "true");
    expect(selfHostedButton).toHaveAttribute("aria-pressed", "false");
  });

  it("shows Connect to hosted bot only when choice is hosted, never for self-hosted", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "self-hosted" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.queryByRole("button", { name: /Connect to hosted bot/i })).toBeNull();
  });

  it("clicking Connect to hosted bot navigates to the OAuth start route after an explicit disclosure confirm", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    const originalLocation = window.location;
    // @ts-expect-error -- test-only reassignment
    delete window.location;
    // @ts-expect-error -- test-only reassignment
    window.location = { ...originalLocation, href: "" };
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Connect to hosted bot/i }));
    await screen.findByText(/independently verified/i);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    await waitFor(() => expect(window.location.href).toBe("/api/integrations/discord/hosted-bot/oauth/start"));
    // @ts-expect-error -- test-only restoration, same reassignment pattern as above
    window.location = originalLocation;
  });

  it("renders the owned-guilds picker from sessionStorage on mount when present", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    render(<DiscordBotSection />);
    await screen.findByText(/Which server is this for/i);
    expect(screen.getByText("My Test Guild")).toBeInTheDocument();
  });

  // discordHostedBotApi.readOwnedGuilds() (Task 7; renamed from
  // readOwnedGuildsFromWindow in the final integration review's CRITICAL
  // fix) deletes the sessionStorage key as a side effect of reading it,
  // which makes the ownedGuilds useState lazy initializer impure.
  // React.StrictMode (main.tsx) deliberately double-invokes an impure
  // initializer to surface exactly this hazard -- a naive implementation's
  // first invocation would read and delete the real list, and a second
  // invocation would read nothing, silently losing the guild list. Same
  // hazard class BaseWaterTab.test.tsx/BaseInventoryTab.test.tsx guard
  // against for their load effects via a StrictMode-wrapped render.
  it("survives a StrictMode double-invoke of the owned-guilds lazy initializer without losing the real guild list", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    render(<StrictMode><DiscordBotSection /></StrictMode>);
    await screen.findByText(/Which server is this for/i);
    expect(screen.getByText("My Test Guild")).toBeInTheDocument();
  });

  // The DOM-only assertion above is not, by itself, reliable RED/GREEN
  // evidence for this hazard: verified directly (a throwaway diagnostic
  // build against the pre-fix code, since removed) that in this specific
  // React 19 build, StrictMode's double-invoke of the lazy initializer
  // happens to keep the *first* call's result -- so a naive, unguarded
  // `useState(() => readOwnedGuilds())` still renders the real guild list
  // here, purely by call-order luck that is an implementation detail, not
  // a documented guarantee. What IS guaranteed, and what this asserts
  // directly: readOwnedGuilds() -- which deletes the sessionStorage key as
  // it reads it (Task 7) -- must be invoked exactly once per mount, never
  // twice, regardless of how many times React calls the surrounding
  // initializer. A naive implementation fails this (calls it twice --
  // confirmed against the pre-fix code during this fix round); the
  // ref-cache guard passes it.
  it("reads the owned-guilds sessionStorage key exactly once under a StrictMode double-invoke, even though the DOM would look correct either way", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    const readSpy = vi.spyOn(discordHostedBotApi, "readOwnedGuilds");
    render(<StrictMode><DiscordBotSection /></StrictMode>);
    await screen.findByText(/Which server is this for/i);
    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("does not navigate when the Connect to hosted bot disclosure is cancelled, and re-enables the button afterward", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    const originalLocation = window.location;
    // @ts-expect-error -- test-only reassignment
    delete window.location;
    // @ts-expect-error -- test-only reassignment
    window.location = { ...originalLocation, href: "" };
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);

    const connectButton = screen.getByRole("button", { name: /Connect to hosted bot/i });
    fireEvent.click(connectButton);
    await screen.findByText(/independently verified/i);
    expect(connectButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => expect(connectButton).not.toBeDisabled());
    expect(window.location.href).toBe("");
    expect(mockPost).not.toHaveBeenCalled();

    // @ts-expect-error -- test-only restoration, same reassignment pattern as above
    window.location = originalLocation;
  });

  it("registering a picked guild calls discordHostedBotApi.register (including the guild name for Core's own persisted-display record) and shows Connected status immediately", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which server is this for/i);
    fireEvent.click(screen.getByText("My Test Guild"));
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/integrations/discord/hosted-bot/register",
      expect.objectContaining({ guildId: "111111111111111111", guildName: "My Test Guild" })
    ));
    await screen.findByText(/Connected to hosted bot for My Test Guild/i);
  });

  // Final integration review (Important #5): the "Connected" status must be
  // real across a page reload, not just immediately after a successful
  // Register click above -- this simulates a fresh mount (a reload) where
  // the backend's own GET already reports a previously-persisted
  // connection (adapterSettings.js's persistHostedBotConnectedGuild(),
  // written by a PRIOR successful /register call in an earlier session),
  // with no register interaction in this test at all.
  it("shows Connected status on a fresh mount when the backend reports a previously-persisted hosted-bot connection", async () => {
    mockApi.mockResolvedValue({
      enabled: true,
      roleIds: { player: [], moderator: [], admin: [] },
      tokenConfigured: true,
      deploymentChoice: "hosted",
      hostedBotConnectedGuildId: "111111111111111111",
      hostedBotConnectedGuildName: "My Test Guild"
    } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Connected to hosted bot for My Test Guild/i);
    expect(screen.queryByRole("button", { name: /Connect to hosted bot/i })).toBeNull();
  });

  // Final integration review (Important #6): after a /register failure
  // (needsReauth, a 502 from mentat, etc.), the guild picker used to stay
  // rendered forever with only an error message and no way to restart the
  // flow, since "Connect to hosted bot" only renders when ownedGuilds is
  // null. A failure must clear it so the operator can try again.
  it("clears the guild picker and re-shows Connect to hosted bot after a /register failure", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    mockPost.mockRejectedValue(new Error("Reconnecting to Discord to confirm this is still you -- go back to Settings and connect to the hosted bot again."));
    render(<DiscordBotSection />);
    await screen.findByText(/Which server is this for/i);
    fireEvent.click(screen.getByText("My Test Guild"));
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    await screen.findByText(/Reconnecting to Discord/i);
    expect(screen.queryByText(/Which server is this for/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Connect to hosted bot/i })).toBeInTheDocument();
  });

  // Real UAT finding (2026-09-09): "step 3 generated the token and just
  // restarted without my input or acknowledge[ment] -- I think it should
  // pause, let user know that a restart is needed and start a timer to
  // restart as well as provide a button to restart." Follow-up UAT finding,
  // same day: minting the token and restarting used to happen in the same
  // request, so the token could only ever appear at the exact moment the
  // restart was already under way -- no real window to copy it first.
  // /enable now only persists config + mints the token; a separate
  // /restart call (triggered by the countdown/button) does the actual
  // restart. These four tests cover: the token appears immediately, the
  // restart itself is what's gated behind the countdown, the automatic
  // expiry, and the skip-ahead button -- for the Enable path specifically.
  // The identical countdown mechanism on Save Role IDs (no token to show
  // first, so no reordering needed there) is already exercised by the
  // "Restart Now" click threaded through the existing role-ids tests above.
  it("reveals the token immediately after confirming Enable, before the restart countdown even starts", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything()));
    expect(await screen.findByDisplayValue("abc")).toBeInTheDocument();
  });

  it("pauses with a restart countdown notice after the token is shown, and does not trigger the restart until the countdown resolves", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ task: { id: "t1", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

    await screen.findByRole("button", { name: /^Restart Now$/i });
    expect(screen.getByText(/Restarting the console in/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("abc")).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/restart", expect.anything());
  });

  it("automatically proceeds with the restart once the countdown reaches zero, with no click required", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ task: { id: "t1", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }, token: "abc" } as never);
    // Fake timers throughout, and plain getBy*/act flushes instead of
    // findBy*/waitFor: the latter poll on a real setInterval, which never
    // fires once fake timers are active unless the clock is advanced by
    // hand -- the DOM updates here all come from resolved mock promises
    // (microtasks), not timers, so a manual act-flush is enough.
    vi.useFakeTimers();
    render(<DiscordBotSection />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Which are you using/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    expect(screen.getByText(/Configure roles/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    expect(screen.getByText(/will restart to apply this change/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Enable$/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText(/Restarting the console in/i)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/restart", expect.anything());

    for (let i = 0; i < 10; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    }
    expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/restart", {});
  });

  it("clicking Restart Now skips the wait and proceeds immediately", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ task: { id: "t1", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Self-hosting/i }));
    await screen.findByText(/Configure roles/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/will restart to apply this change/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/restart", {}));
    expect(screen.queryByRole("button", { name: /^Restart Now$/i })).toBeNull();
  });

  // Real UAT finding (2026-09-09): "I see no path to remove the bot" -- this
  // feature had Enable/Save Role IDs/Regenerate Token but no way back to
  // "never configured." These three tests cover the confirm gate, the
  // countdown-then-restart sequencing (same pattern as Save Role IDs -- no
  // token to reveal here, so no reordering benefit the way Enable needed),
  // and that a successful disable really does land back on a fresh wizard.
  it("shows a real confirm dialog before disabling, and does not call /disable until confirmed", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Disable Discord Bot Integration/i }));
    await screen.findByText(/you'll go through setup again to re-enable it/i);
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/disable", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/you'll go through setup again to re-enable it/i)).toBeNull());
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("disabling persists first, then pauses for the restart countdown before calling /restart, and lands back on a fresh wizard", async () => {
    mockApi
      .mockResolvedValueOnce({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never)
      .mockImplementation((path: string) => {
        if (path.startsWith("/api/updates/stack-progress")) {
          return Promise.resolve({ runId: "disable-task", state: "succeeded", stage: "complete", percent: 100, message: "", discordHealthOk: true } as never);
        }
        return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
      });
    mockPost.mockResolvedValue({ ok: true, task: { id: "disable-task", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null } } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Disable Discord Bot Integration/i }));
    await screen.findByText(/you'll go through setup again to re-enable it/i);
    fireEvent.click(screen.getByRole("button", { name: /^Disable$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/disable", {}));
    await screen.findByRole("button", { name: /^Restart Now$/i });
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/restart", {});

    fireEvent.click(screen.getByRole("button", { name: /^Restart Now$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/restart", {}));

    await waitFor(() => expect(screen.getByText(/Which are you using/i)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/Enable Discord Bot Integration/i)).toBeNull();
  });

  // Real UAT finding (2026-09-09): "why can't we add [inviting the bot] to
  // the wizard? click the button, a window pops, add to discord happens,
  // window closes and back to wizard?" -- nothing in this wizard ever told
  // the operator that inviting the bot to their Discord server is a
  // separate, required, external step ("Connect to hosted bot" only
  // verifies ownership and registers with mentat -- it can never add the
  // bot to a guild itself, since that needs Discord's `bot` OAuth scope,
  // not the `identify guilds` scope this component's own OAuth round trip
  // uses). These tests cover the popup opening with the real invite link,
  // and the "welcome back" acknowledgement once the operator closes it --
  // in both the wizard's step 1 and the already-enabled management view.
  // Real UAT finding (2026-09-10): "Add to Discord" now lives inside wizard
  // step 1's "Add bot to Discord" content (choice === "hosted"), not on the
  // raw picker -- reaching it requires picking "Hosted bot" first, which
  // silently persists the choice and mints the adapter token in the
  // background before this content renders.
  it("opens the real Discord bot-invite link in a popup from wizard step 1's Add bot to Discord content, and shows a welcome-back message once it closes", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    const fakePopup = { closed: false };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakePopup as never);
    vi.useFakeTimers();

    render(<DiscordBotSection />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Which are you using/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {}); // flush the silent enable() call's own await chain
    expect(screen.getByText(/Add bot to Discord/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Add to Discord$/i }));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://discord.com/oauth2/authorize?client_id="),
      "discord-bot-invite",
      expect.any(String)
    );
    expect(screen.queryByText(/Welcome back/i)).toBeNull();

    fakePopup.closed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(/Welcome back/i)).toBeInTheDocument();
  });

  it("also offers Add to Discord alongside Connect to hosted bot once the adapter is enabled", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
    const fakePopup = { closed: false };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakePopup as never);
    vi.useFakeTimers();

    render(<DiscordBotSection />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: /Connect to hosted bot/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Add to Discord$/i }));
    expect(openSpy).toHaveBeenCalled();

    fakePopup.closed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(/Welcome back/i)).toBeInTheDocument();
  });

  // Real UAT finding (2026-09-09): "we have OAuth without bot and bot
  // without OAuth" -- the hosted-bot connection's own, independent
  // Discord Application config, shown whenever choice === "hosted",
  // deliberately separate from Settings -> Discord OAuth.
  it("shows the hosted-bot connection's own OAuth config form, pre-filled from server state, and saves config + secret separately", async () => {
    mockApi.mockResolvedValue({
      enabled: true,
      roleIds: { player: [], moderator: [], admin: [] },
      tokenConfigured: true,
      deploymentChoice: "hosted",
      hostedBotOAuthConfigured: false,
      hostedBotOAuthClientId: "999999999999999999",
      hostedBotOAuthRedirectUri: "https://example.com/callback"
    } as never);
    mockPost.mockResolvedValue({ ok: true } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByText(/Hosted bot connection: not yet configured/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("999999999999999999")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://example.com/callback")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Discord application client secret/i), { target: { value: "a-real-looking-client-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save Hosted Bot Connection$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/discord-bot/oauth-config",
      { clientId: "999999999999999999", redirectUri: "https://example.com/callback" }
    ));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/discord-bot/oauth-secret",
      { secret: "a-real-looking-client-secret-value" }
    ));
    await screen.findByText(/Restart the console/i);
    // The secret field clears after a successful save -- it's never
    // echoed back, so nothing should linger in the input either.
    expect(screen.queryByDisplayValue("a-real-looking-client-secret-value")).toBeNull();
  });

  // Real UAT finding (2026-09-10): the wizard redesign moved "Add bot to
  // Discord" to step 1 -- this now confirms the same independence a
  // different way: reaching step 1's Discord-connection content (and its
  // Add to Discord / Connect to hosted bot buttons) never requires the
  // OAuth app to already be configured. An unconfigured app shows as
  // "not yet configured" text, not a gate blocking the rest of the step.
  it("never requires the hosted-bot OAuth config to be filled in before the Discord-connection buttons are reachable -- the two are independent", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await screen.findByText(/Add bot to Discord/i);
    expect(await screen.findByText(/Hosted bot connection: not yet configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add to Discord$/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Connect to hosted bot/i })).not.toBeDisabled();
  });

  // Real UAT finding (2026-09-10): end-to-end coverage of the redesigned
  // 3-step order the operator asked for directly -- "1) add bot to
  // discord, 2) configure roles, 3) restart" -- as one continuous flow,
  // not just its individual pieces.
  it("Continue on step 1 stays disabled until a guild is actually registered, then unlocks the rest of the 3-step flow", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);

    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await screen.findByText(/Which server is this for/i);
    // Continue is disabled -- no guild registered yet.
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();

    fireEvent.click(screen.getByText("My Test Guild"));
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    await screen.findByText(/Connected to hosted bot for My Test Guild/i);

    const continueButton = screen.getByRole("button", { name: /^Continue$/i });
    // Independent UI/UX review (HIGH H1): Continue also requires an
    // explicit "I've invited the bot" acknowledgement, not just a
    // registered guild -- the two are otherwise independent actions.
    expect(continueButton).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /invited the bot/i }));
    expect(continueButton).not.toBeDisabled();
    fireEvent.click(continueButton);

    await screen.findByText(/Configure roles/i);
    fireEvent.change(screen.getByLabelText(/Player role IDs/i), { target: { value: "222222222222222222" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Step 3 for the hosted path: "Save & Restart" (updateRoleIds), not
    // "Enable Discord Bot Integration" -- the adapter was already silently
    // enabled back in step 1.
    const finishButton = await screen.findByRole("button", { name: /^Save & Restart$/i });
    expect(screen.queryByRole("button", { name: /Enable Discord Bot Integration/i })).toBeNull();
    fireEvent.click(finishButton);
    await screen.findByText(/restart to apply this change/i);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restart Now$/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/discord-bot/role-ids",
      expect.objectContaining({ playerRoleIds: "222222222222222222", deploymentChoice: "hosted" })
    ));
  });

  // Independent UI/UX hat review (2026-09-10, CRITICAL C1): picking
  // "Hosted bot" used to be a one-way door -- step 1's own content
  // switched away from the picker with no way back to it short of
  // actually completing a real Discord OAuth authorization. Confirms
  // "Change" now genuinely re-shows the picker from step 1's own hosted
  // content, not just from steps 2/3 (already covered by the "Setting up
  // indicator" tests above, which only exercise the self-hosted path).
  it("Change on step 1's Add bot to Discord content genuinely returns to the picker, not just steps 2/3", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await screen.findByText(/Add bot to Discord/i);
    expect(screen.getByText(/Setting up:/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));

    await screen.findByText(/Which are you using/i);
    expect(screen.queryByText(/Add bot to Discord/i)).toBeNull();
  });

  // Independent UI/UX hat review (2026-09-10, CRITICAL C2): the silent
  // hosted-path token mint used to also reveal the full one-time-secret
  // "copy it before leaving this page" banner the instant "Hosted bot"
  // was clicked -- alarming and unexplained, unlike the self-hosted
  // path's own handoff panel that actually tells the operator what to do
  // with it. The hosted path never needs the operator to see this token
  // at all (mentat's own registration call forwards it server-side).
  it("does not reveal the token banner for the silent hosted-path mint", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    mockPost.mockResolvedValue({ ok: true, token: "should-not-be-shown" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));

    await screen.findByText(/Add bot to Discord/i);
    expect(screen.queryByDisplayValue("should-not-be-shown")).toBeNull();
    expect(screen.queryByText(/copy it before leaving this page/i)).toBeNull();
  });

  // Real UAT finding (2026-09-10): "why are we asking for Redirect URI --
  // we're hosting the bot, we know the redirect URL." The path is fixed by
  // the route's own code; only the domain varies per self-hosted install,
  // and the browser's current origin already is that domain in the common
  // case -- pre-fill instead of leaving this blank.
  it("pre-fills the hosted-bot Redirect URI field from the page's own origin when nothing is saved yet", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted", hostedBotOAuthRedirectUri: null } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByDisplayValue(`${window.location.origin}/api/integrations/discord/hosted-bot/oauth/callback`)).toBeInTheDocument();
  });

  it("does not override an already-saved hosted-bot Redirect URI with the computed default", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted", hostedBotOAuthRedirectUri: "https://reverse-proxy.example.com/api/integrations/discord/hosted-bot/oauth/callback" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByDisplayValue("https://reverse-proxy.example.com/api/integrations/discord/hosted-bot/oauth/callback")).toBeInTheDocument();
  });
});
