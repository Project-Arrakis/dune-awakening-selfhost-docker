import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { CommunityBlueprintBrowser } from "./CommunityBlueprintBrowser";

vi.mock("../../api/client", () => ({ api: vi.fn() }));

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Desert Keep",
  description: "A compact defensive base.",
  ownerName: "Chani",
  buildingSet: "CHOAM",
  tags: ["pve", "compact"],
  pieces: 42,
  placeables: 7,
  likes: 3,
  downloads: 5,
  version: 2,
  hasPreview: true,
  previewNight: false,
  updatedAt: "2026-09-14T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (String(path).endsWith("/install") && options?.method === "POST") return { ok: true, blueprintName: "Desert Keep", pieces: 42, placeables: 7 };
    return { rows: [row], total: 1, limit: 12, offset: 0 };
  });
});

describe("CommunityBlueprintBrowser", () => {
  it("shows public Blueprint images and details", async () => {
    render(<CommunityBlueprintBrowser dbPlayerId="42" playerName="Paul" confirmAction={vi.fn()} onInstalled={vi.fn()} />);
    expect(await screen.findByText("Desert Keep")).toBeInTheDocument();
    expect(screen.getByAltText("Preview of Desert Keep")).toHaveAttribute("src", expect.stringContaining(`${row.id}/preview?v=2-2026-09-14T00%3A00%3A00Z`));
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("A compact defensive base.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View Full 3D Blueprint/ })).toHaveAttribute("href", `https://blueprints.dunedocker.app/blueprint/${row.id}`);
  });

  it("confirms and installs the selected Blueprint for the selected player", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    const onInstalled = vi.fn();
    render(<CommunityBlueprintBrowser dbPlayerId="42" playerName="Paul" confirmAction={confirmAction} onInstalled={onInstalled} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Install$/ }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/blueprints/community/${row.id}/install`, {
      method: "POST",
      body: JSON.stringify({ playerId: "42" })
    }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Paul"), expect.objectContaining({ confirmLabel: "Install" }));
    expect(await screen.findByText("Blueprint Installed Successfully")).toBeInTheDocument();
    expect(onInstalled).toHaveBeenCalledOnce();
  });

  it("uses the standard first, previous, next, and last pagination controls", async () => {
    vi.mocked(api).mockResolvedValue({ rows: [row], total: 50, limit: 12, offset: 0 });
    render(<CommunityBlueprintBrowser dbPlayerId="42" playerName="Paul" confirmAction={vi.fn()} onInstalled={vi.fn()} />);
    expect(await screen.findByText("Page 1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("offset=12")));
    expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Rows" }), { target: { value: "24" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringMatching(/limit=24.*offset=0/)));
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });
});
