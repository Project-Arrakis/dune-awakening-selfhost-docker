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

  it("renders the Disabled state and asks hosted-or-self-hosted before enabling, when nothing is configured yet", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    expect(screen.getByRole("button", { name: /Enable Discord Bot Integration/i })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/restart/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/restart/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    fireEvent.change(screen.getByLabelText(/Player role IDs/i), { target: { value: "999999999999999999" } });
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/restart/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));

    const enableButton = screen.getByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(enableButton);
    await screen.findByText(/restart/i);
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
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));

    const enableButton = screen.getByRole("button", { name: /Enable Discord Bot Integration/i });
    fireEvent.click(enableButton);
    await screen.findByText(/restart/i);
    expect(enableButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => expect(enableButton).not.toBeDisabled());
    expect(mockPost).not.toHaveBeenCalled();
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

  it("sends the current choice to the backend when enabling", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    mockPost.mockResolvedValue({ task: { id: "t1", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }, token: "abc" } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
    await screen.findByText(/restart/i);
    fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.objectContaining({ deploymentChoice: "hosted" })));
  });

  it("exposes the hosted/self-hosted toggle's selected state to assistive tech via aria-pressed (finding 8)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    const hostedButton = screen.getByRole("button", { name: /Hosted bot/i });
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
});
