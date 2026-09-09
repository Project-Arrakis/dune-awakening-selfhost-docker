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
});
