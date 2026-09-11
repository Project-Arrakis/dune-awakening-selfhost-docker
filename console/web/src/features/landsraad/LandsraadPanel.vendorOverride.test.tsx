import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi, type LandsraadHouseFactionCatalogEntry, type LandsraadVendorCatalogEntry } from "../../api/admin";
import { mapsApi } from "../../api/maps";
import { playersApi } from "../../api/players";
import { LandsraadPanel } from "./LandsraadPanel";
import type { RestartGate } from "../server/restartQueueGuard";

vi.mock("../../api/admin", () => ({
  adminApi: {
    landsraad: vi.fn(),
    landsraadMilestonePreset: vi.fn(),
    landsraadVendorOverride: vi.fn(),
    saveLandsraadVendorOverride: vi.fn(),
    revertLandsraadVendorOverride: vi.fn(),
    setLandsraadTaskGoal: vi.fn(),
    setLandsraadTermTaskGoals: vi.fn(),
    saveLandsraadMilestonePreset: vi.fn(),
    setLandsraadRewardTier: vi.fn(),
    setLandsraadPlayerContribution: vi.fn()
  }
}));

vi.mock("../../api/maps", () => ({
  mapsApi: {
    userSettingsValues: vi.fn(),
    userSettingsRestartPending: vi.fn(),
    saveUserSettings: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: { listAll: vi.fn() }
}));

vi.mock("../../api/server", () => ({ serverApi: { restart: vi.fn() } }));
vi.mock("../../api/setup", () => ({ setupApi: { task: vi.fn() } }));

const OVERVIEW = {
  capabilities: { landsraad: true, decrees: true, rewards: false, factionContributions: false, playerContributions: false, guildContributions: false },
  term: { term_id: "73", start_time: "", end_time: "", active_decree: "", elected_decree: "", winning_faction: "" },
  decrees: [],
  tasks: [],
  rewards: []
};

const MILESTONE_PRESET = { enabled: false, goalAmount: 0, thresholds: [], lastAppliedTermId: null, lastAppliedAt: "", lastResult: "" };

const VENDOR_CATALOG: LandsraadVendorCatalogEntry[] = [
  { key: "vehicles", decreeName: "SpecialVendorActive_Vehicles" },
  { key: "weapons", decreeName: "SpecialVendorActive_Weapons" },
  { key: "armor", decreeName: "SpecialVendorActive_Armor" },
  { key: "utilities", decreeName: "SpecialVendorActive_Utilities" }
];

const VENDOR_PRESET = { enabled: false, mode: "fixed" as const, vendorKeys: [], houseFaction: null, lastAppliedTermId: null, lastAppliedAt: "", lastResult: "" };
const HOUSE_CATALOG: LandsraadHouseFactionCatalogEntry[] = [
  { key: "atreides", name: "Atreides" },
  { key: "harkonnen", name: "Harkonnen" }
];

function renderPanel(overrides: { overview?: typeof OVERVIEW } & Partial<Parameters<typeof LandsraadPanel>[0]> = {}) {
  const { overview, ...propOverrides } = overrides;
  const props = {
    confirmAction: vi.fn().mockResolvedValue(true),
    onError: vi.fn(),
    restartGate: vi.fn<RestartGate>(),
    ...propOverrides
  };
  vi.mocked(adminApi.landsraad).mockResolvedValue(overview ?? OVERVIEW);
  vi.mocked(adminApi.landsraadMilestonePreset).mockResolvedValue({ preset: MILESTONE_PRESET });
  vi.mocked(adminApi.landsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, catalog: VENDOR_CATALOG, houseCatalog: HOUSE_CATALOG });
  vi.mocked(playersApi.listAll).mockResolvedValue({ rows: [], totalCount: 0 });
  vi.mocked(mapsApi.userSettingsValues).mockResolvedValue({ stdout: "" });
  vi.mocked(mapsApi.userSettingsRestartPending).mockResolvedValue({ pending: false });
  render(<LandsraadPanel {...props} />);
  return props;
}

// The "Special Vendor Override" heading itself renders unconditionally on
// first mount, before the async adminApi.landsraadVendorOverride() catalog
// fetch resolves -- waiting on that text alone is a real race (passed
// reliably locally, failed in CI's different scheduling). Wait for the
// actual checkbox instead, which only renders once vendorCatalog is populated.
async function waitForVendorSection() {
  await screen.findByLabelText("Vehicle Vendor");
}

describe("LandsraadPanel Special Vendor Override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables Force Now until at least one vendor type is selected", async () => {
    renderPanel();
    await waitForVendorSection();

    expect(screen.getByRole("button", { name: "Force Now" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    expect(screen.getByRole("button", { name: "Force Now" })).toBeEnabled();
  });

  it("shows the per-house-gating caveat note", async () => {
    renderPanel();
    await waitForVendorSection();

    expect(screen.getByText(/gated on which house is recorded as winning this term/)).toBeInTheDocument();
  });

  it("uses the bypass-the-win-requirement confirm copy on an unresolved term, and sends overrideResolvedTerm: false", async () => {
    const { confirmAction } = renderPanel();
    await waitForVendorSection();
    vi.mocked(adminApi.saveLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true, decreeKey: "vehicles", decreeName: "SpecialVendorActive_Vehicles", termId: "73" } });

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("This bypasses the normal win requirement"),
      expect.objectContaining({ title: "Force Landsraad Vendor Override", confirmLabel: "Force Now", danger: false })
    ));
    await waitFor(() => expect(adminApi.saveLandsraadVendorOverride).toHaveBeenCalledWith(
      expect.objectContaining({ vendorKeys: ["vehicles"], overrideResolvedTerm: false })
    ));
  });

  it("uses the already-resolved confirm copy and sends overrideResolvedTerm: true when the term has an elected decree", async () => {
    const resolvedOverview = { ...OVERVIEW, term: { ...OVERVIEW.term, elected_decree: "SpecialVendorActive_Weapons" } };
    const { confirmAction } = renderPanel({ overview: resolvedOverview });
    await waitForVendorSection();
    vi.mocked(adminApi.saveLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true } });

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("already resolved"),
      expect.objectContaining({ danger: true })
    ));
    await waitFor(() => expect(adminApi.saveLandsraadVendorOverride).toHaveBeenCalledWith(
      expect.objectContaining({ overrideResolvedTerm: true })
    ));
  });

  it("reverts behind its own confirm dialog", async () => {
    const { confirmAction } = renderPanel();
    await waitForVendorSection();
    vi.mocked(adminApi.revertLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true } });

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("Revert the Landsraad vendor override"),
      expect.objectContaining({ title: "Revert Landsraad Vendor Override" })
    ));
    await waitFor(() => expect(adminApi.revertLandsraadVendorOverride).toHaveBeenCalled());
    expect(adminApi.saveLandsraadVendorOverride).not.toHaveBeenCalled();
  });

  it("does not apply when the confirm dialog is declined", async () => {
    const { confirmAction } = renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    await waitForVendorSection();

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(adminApi.saveLandsraadVendorOverride).not.toHaveBeenCalled();
  });

  // -- v2 (design doc §8): Target House --

  it("selecting a house forces danger styling, a warning naming the risks, and details, even on an unresolved term", async () => {
    const { confirmAction } = renderPanel();
    await waitForVendorSection();
    vi.mocked(adminApi.saveLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true } });

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.change(screen.getByLabelText(/Target House/), { target: { value: "atreides" } });
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("set Atreides as this term's winning house"),
      expect.objectContaining({
        danger: true,
        warning: expect.stringContaining("real Landsraad rewards"),
        details: [{ label: "Vendor", value: "Vehicle Vendor" }, { label: "Target House", value: "Atreides", tone: "danger" }]
      })
    ));
    await waitFor(() => expect(adminApi.saveLandsraadVendorOverride).toHaveBeenCalledWith(
      expect.objectContaining({ houseFaction: "atreides" })
    ));
  });

  it("the confirm warning names the organic-win-masking risk", async () => {
    const { confirmAction } = renderPanel();
    await waitForVendorSection();
    vi.mocked(adminApi.saveLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true } });

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.change(screen.getByLabelText(/Target House/), { target: { value: "harkonnen" } });
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ warning: expect.stringContaining("silently prevent any house's real, organic Landsraad win") })
    ));
  });

  it("omitting the target house keeps the plain vendor-only payload (no houseFaction)", async () => {
    renderPanel();
    await waitForVendorSection();
    vi.mocked(adminApi.saveLandsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, result: { applied: true } });

    fireEvent.click(screen.getByLabelText("Vehicle Vendor"));
    fireEvent.click(screen.getByRole("button", { name: "Force Now" }));

    await waitFor(() => expect(adminApi.saveLandsraadVendorOverride).toHaveBeenCalledWith(
      expect.objectContaining({ houseFaction: null })
    ));
  });

  it("hides the Target House dropdown entirely when no install-eligible houses are found", async () => {
    vi.mocked(adminApi.landsraad).mockResolvedValue(OVERVIEW);
    vi.mocked(adminApi.landsraadMilestonePreset).mockResolvedValue({ preset: MILESTONE_PRESET });
    vi.mocked(adminApi.landsraadVendorOverride).mockResolvedValue({ preset: VENDOR_PRESET, catalog: VENDOR_CATALOG, houseCatalog: [] });
    vi.mocked(playersApi.listAll).mockResolvedValue({ rows: [], totalCount: 0 });
    vi.mocked(mapsApi.userSettingsValues).mockResolvedValue({ stdout: "" });
    vi.mocked(mapsApi.userSettingsRestartPending).mockResolvedValue({ pending: false });
    render(<LandsraadPanel confirmAction={vi.fn().mockResolvedValue(true)} onError={vi.fn()} restartGate={vi.fn<RestartGate>()} />);
    await waitForVendorSection();

    expect(screen.queryByLabelText(/Target House/)).not.toBeInTheDocument();
  });
});
