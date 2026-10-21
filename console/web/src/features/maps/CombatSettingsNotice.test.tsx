import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PartitionCombatStateRow } from "../../api/maps";
import { CombatSettingsNotice } from "./CombatSettingsNotice";

const row: PartitionCombatStateRow = {
  map: "DeepDesert_1", partitionId: "8", dimensionIndex: 0, databaseLabel: null,
  runtimeStatus: "RUNNING", serverDisplayName: null, configuredState: "PVP", materializedState: "PVP",
  source: "partition-pvp-selector", securityZonesEnabled: true, restartRequired: false, configurationDrift: false,
  customPvpMode: "NoPVP", customPvpModeSource: "profile", materializedCustomPvpMode: "NoPVP",
  warnings: ["UserGame selects PVP while Custom Settings specifies NoPVP. Priority is not verified."],
};

describe("Combat configuration explanation", () => {
  it("shows both conflicting systems without claiming a verified live mode", () => {
    render(<CombatSettingsNotice row={row} />);
    expect(screen.getByText("PvP")).toBeVisible();
    expect(screen.getByText("NoPVP")).toBeVisible();
    expect(screen.getByText(/not a live combat check/)).toBeVisible();
    expect(screen.getByText(/do not control separate north and south zones/)).toBeVisible();
    expect(screen.getByText(row.warnings[0])).toBeVisible();
  });
  it("distinguishes saved and written modes and labels unsaved edits", () => {
    render(<CombatSettingsNotice row={{ ...row, materializedCustomPvpMode: "FullPVP" }} hasUnsavedChanges />);
    expect(screen.getByText(/written to disk is FullPVP/)).toHaveTextContent(/does not confirm what a running map has loaded/);
    expect(screen.getByText(/excludes your unsaved edits/)).toBeVisible();
  });
  it("does not invent settings when a resolver result is unavailable", () => {
    render(<CombatSettingsNotice />);
    expect(screen.queryByRole("definition")).toBeNull();
    expect(screen.getByText(/priority inside the game is not verified/)).toBeVisible();
  });
  it("labels a default as a default rather than claiming it was written", () => {
    render(<CombatSettingsNotice row={{ ...row, customPvpMode: "Limited", customPvpModeSource: "default", materializedCustomPvpMode: null, warnings: [] }} />);
    expect(screen.getByText("Limited (Default)")).toBeVisible();
    expect(screen.queryByText(/written to disk is/)).toBeNull();
  });
});
