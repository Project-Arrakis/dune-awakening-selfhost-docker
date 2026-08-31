import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";
import { encodeRoleNamesForWire } from "./discordRoleNames";

// F3, #573: per-role-ID friendly labels in the Discord OAuth settings section.

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

const ADMIN_ROLE = "100000000000000002";
const MOD_ROLE = "100000000000000003";

function mockBackend(serverConfig: Record<string, string>) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: false } as never);
    return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig } as never);
  });
  mockPost.mockResolvedValue({ ok: true } as never);
}

async function openDiscordSection() {
  fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
}

describe("Discord OAuth settings: per-role-ID display names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders no naming section when no role IDs are configured", async () => {
    mockBackend({});
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    await openDiscordSection();
    await waitFor(() => expect(screen.getByLabelText("Admin Role (required)")).toBeInTheDocument());
    expect(screen.queryByText(/Name your Discord roles/)).not.toBeInTheDocument();
  });

  it("renders one label input per configured role ID, pre-filled from the decoded map, one per field even with multiple IDs in one field", async () => {
    mockBackend({
      DISCORD_CONSOLE_ADMIN_ROLE_IDS: `${ADMIN_ROLE},${MOD_ROLE}`,
      DISCORD_CONSOLE_ROLE_NAMES: encodeRoleNamesForWire({ [ADMIN_ROLE]: "Heavy Bats" })
    });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    await openDiscordSection();
    await waitFor(() => expect(screen.getByText(/Name your Discord roles/)).toBeInTheDocument());
    expect(screen.getByLabelText(ADMIN_ROLE)).toHaveValue("Heavy Bats");
    expect(screen.getByLabelText(MOD_ROLE)).toHaveValue("");
  });

  it("does not duplicate a role ID's input when the same ID is (invalidly) present in two fields", async () => {
    mockBackend({ DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE, DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    await openDiscordSection();
    await waitFor(() => expect(screen.getByText(/Name your Discord roles/)).toBeInTheDocument());
    expect(screen.getAllByLabelText(ADMIN_ROLE)).toHaveLength(1);
  });

  it("saves the edited map (pruned to currently-configured role IDs) as a plain object, not pre-encoded", async () => {
    mockBackend({
      DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE,
      DISCORD_CONSOLE_ROLE_NAMES: encodeRoleNamesForWire({ [ADMIN_ROLE]: "Old Name", "999999999999999999": "Stale, No Longer Mapped" })
    });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} />);
    await openDiscordSection();
    await waitFor(() => expect(screen.getByLabelText(ADMIN_ROLE)).toHaveValue("Old Name"));
    fireEvent.change(screen.getByLabelText(ADMIN_ROLE), { target: { value: "Heavy Bats" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Discord OAuth/ }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/write-oauth-config", expect.objectContaining({
      DISCORD_CONSOLE_ROLE_NAMES: { [ADMIN_ROLE]: "Heavy Bats" }
    })));
  });
});
