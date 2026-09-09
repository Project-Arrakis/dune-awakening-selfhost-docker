import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { DiscordBotSection } from "./DiscordBotSection";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);
const TASK_KEY = "arrakis.discordAdapterEnableTask";

describe("DiscordBotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
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
    expect(screen.queryByText(/Which are you using/i)).toBeNull();
    expect(screen.getByDisplayValue("111111111111111111")).toBeInTheDocument();
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

  it("persists the hosted/self-hosted choice to localStorage so token-destination instructions survive a reload (finding 1)", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    const { unmount } = render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
    expect(window.localStorage.getItem("arrakis.discordAdapterChoice")).toBe("hosted");
    unmount();

    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.getByText(/mentat-link's setup form/i)).toBeInTheDocument();
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
});
