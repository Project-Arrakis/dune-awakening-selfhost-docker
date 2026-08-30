import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";

// #643 (embed the guided Discord setup wizard into Settings). QA HIGH
// finding: the old manual accordion had ZERO test coverage at the
// SettingsPanel integration level (confirmed via grep before this file
// existed) -- replacing it with the embedded wizard must not ship with the
// same gap. This suite covers the mount/onCancel/onDone wiring specifically;
// DiscordSetupWizard's own internals are covered by its own test file.
vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

function stubHttps() {
  Object.defineProperty(window, "location", {
    value: { ...window.location, protocol: "https:", origin: "https://console.example.org", search: "" },
    writable: true,
  });
}

function mockBackend(overrides: { serverConfig?: Record<string, string>; discordIdentity?: unknown } = {}) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: true } as never);
    if (path === "/api/settings") return Promise.resolve({ config: { port: 8088, discordOAuthAppConfigured: false }, publicDirectory: {}, serverConfig: overrides.serverConfig || {} } as never);
    if (path === "/api/setup/discord-identity") {
      if (overrides.discordIdentity) return Promise.resolve(overrides.discordIdentity as never);
      return Promise.reject(new Error("not signed in with Discord yet"));
    }
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
}

describe("SettingsPanel: embedded Discord setup wizard (#643)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(); });

  it("opening the Discord OAuth accordion mounts the guided wizard", async () => {
    mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    expect(await screen.findByText("Set up Discord sign-in")).toBeInTheDocument();
    expect(screen.getByText("I already have a Discord application")).toBeInTheDocument();
  });

  it("Cancel inside the wizard collapses the accordion", async () => {
    mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    await screen.findByText("Set up Discord sign-in");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Set up Discord sign-in")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Expand Discord OAuth")).toBeInTheDocument();
  });

  it("finishing the wizard (onDone) collapses the accordion and re-probes Settings' own config", async () => {
    mockBackend({
      serverConfig: { DISCORD_OAUTH_CLIENT_ID: "id", DISCORD_OAUTH_REDIRECT_URI: "uri" },
      discordIdentity: { user: { id: "u1", username: "operator", mfaEnabled: true }, guilds: [{ id: "999999999999999999", name: "My Server", owner: true }] },
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/discord-finalize") return Promise.resolve({ ok: true, guild: { name: "My Server" }, owner: { username: "operator" } } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "111111111111111111" } });
    fireEvent.click(screen.getByText("Turn on Discord sign-in"));
    const settingsCallsBeforeDone = mockApi.mock.calls.filter(([p]) => p === "/api/settings").length;

    fireEvent.click(await screen.findByText("Back to Settings"));

    expect(screen.queryByText("Set up Discord sign-in")).not.toBeInTheDocument();
    await waitFor(() => {
      const settingsCallsAfterDone = mockApi.mock.calls.filter(([p]) => p === "/api/settings").length;
      expect(settingsCallsAfterDone).toBeGreaterThan(settingsCallsBeforeDone);
    });
  });
});
