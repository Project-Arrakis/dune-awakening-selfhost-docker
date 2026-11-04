import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminApi, type CharacterTransferSettings } from "../../api/admin";
import { setupApi } from "../../api/setup";
import { AdminToolsPanel } from "./AdminToolsPanel";

vi.mock("../../api/admin", () => ({ adminApi: {
  characterTransferSettings: vi.fn(), saveCharacterTransferSettings: vi.fn(), restoreCharacterTransferSettings: vi.fn(),
  history: vi.fn(async () => ({ stdout: "" })),
  messageOfTheDay: vi.fn(async () => ({ settings: { enabled: false, title: "", message: "", deliveryMode: "login" }, status: {} })),
  playerAnnouncements: vi.fn(async () => ({ settings: { joinEnabled: false, joinMessage: "", leaveEnabled: false, leaveMessage: "" } }))
} }));
vi.mock("../../api/setup", () => ({ setupApi: { task: vi.fn() } }));
vi.mock("../../api/players", () => ({ playersApi: { listAll: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../api/liveMap", () => ({ liveMapApi: { services: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../api/maps", () => ({ mapsApi: { deferredRestartPending: vi.fn(async () => ({ pending: false })) } }));
vi.mock("../../api/server", () => ({ serverApi: {
  restartSchedule: vi.fn(async () => ({})),
  restartQueue: vi.fn(async () => ({ state: { entries: [] }, settings: { defaultCountdownMinutes: 5, broadcastCheckpoints: [] } })),
  ipChangeRestart: vi.fn(async () => ({})), shutdownProtection: vi.fn(async () => ({}))
} }));

const settings: CharacterTransferSettings = {
  ShouldDeleteOriginCharactersDuringTransfers: true, AcceptOutgoingCharacterTransfers: true,
  IncomingCharacterTransfers: 0, ExportCharacterTimeout: 900, ImportCharacterTimeout: 900,
  FreeToTransferCharactersFrom: true, FreeToTransferCharactersTo: true,
  ValidateBeforeImportCharacterTimeout: 180, ForceIsWorldClosed: false, ForceIsWorldClosingSoon: false
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminApi.characterTransferSettings).mockResolvedValue({ settings, defaults: settings, policies: [{ value: 0, label: "Accept All Incoming" }], customized: false, path: "test.ini", applied: true });
});

async function openSettings() {
  const confirmAction = vi.fn(async (_message: string) => true);
  render(<AdminToolsPanel onError={vi.fn()} confirmAction={confirmAction} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Character Transfer Settings" }));
  await screen.findByLabelText("Export timeout, seconds");
  const panel = screen.getByLabelText("Export timeout, seconds").closest(".playerAdmin_toggleBody") as HTMLElement;
  return { panel: within(panel), confirmAction };
}

describe("Character transfer live settings", () => {
  it("applies changed settings directly without polling a restart task", async () => {
    const next = { ...settings, ExportCharacterTimeout: 1800 };
    vi.mocked(adminApi.saveCharacterTransferSettings).mockResolvedValue({ ok: true, settings: next, applied: true });
    const { panel } = await openSettings();
    fireEvent.change(panel.getByLabelText("Export timeout, seconds"), { target: { value: "1800" } });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    await panel.findByText("Character Transfer Settings Applied.");
    expect(adminApi.saveCharacterTransferSettings).toHaveBeenCalledWith(next);
    expect(setupApi.task).not.toHaveBeenCalled();
    expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("allows an unchanged retry and displays the saved-but-not-applied error", async () => {
    vi.mocked(adminApi.characterTransferSettings).mockResolvedValue({ settings, defaults: settings, policies: [], customized: true, path: "test.ini", applied: null });
    vi.mocked(adminApi.saveCharacterTransferSettings).mockRejectedValueOnce(new Error("Settings were saved, but Director did not confirm live application."));
    const { panel } = await openSettings();
    const save = panel.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await panel.findByRole("alert")).toHaveTextContent("Settings were saved");
    expect(save).toBeEnabled();
    vi.mocked(adminApi.saveCharacterTransferSettings).mockResolvedValue({ ok: true, settings, applied: true });
    fireEvent.click(save);
    await panel.findByText("Character Transfer Settings Applied.");
    expect(save).toBeDisabled();
  });

  it("restores defaults live and keeps them as the retry payload if application fails", async () => {
    vi.mocked(adminApi.characterTransferSettings).mockResolvedValue({ settings: { ...settings, ExportCharacterTimeout: 1800 }, defaults: settings, policies: [], customized: true, path: "test.ini", applied: true });
    vi.mocked(adminApi.restoreCharacterTransferSettings).mockRejectedValue(new Error("Settings were saved, but Director did not confirm live application."));
    const { panel, confirmAction } = await openSettings();
    fireEvent.click(panel.getByRole("button", { name: "Restore Defaults" }));
    await panel.findByRole("alert");
    expect(confirmAction.mock.calls[0][0]).toContain("No services will be restarted");
    vi.mocked(adminApi.saveCharacterTransferSettings).mockResolvedValue({ ok: true, settings, applied: true });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    await panel.findByText("Character Transfer Settings Applied.");
    expect(adminApi.saveCharacterTransferSettings).toHaveBeenCalledWith(settings);
    expect(setupApi.task).not.toHaveBeenCalled();
  });
});
