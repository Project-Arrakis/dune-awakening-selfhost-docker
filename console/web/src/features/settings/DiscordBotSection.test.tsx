import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { DiscordBotSection } from "./DiscordBotSection";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

describe("DiscordBotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
