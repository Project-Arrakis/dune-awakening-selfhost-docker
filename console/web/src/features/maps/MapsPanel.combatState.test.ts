import { describe, it, expect } from "vitest";
import { deepDesertPartitionName, isPrimaryDeepDesertPartition } from "./MapsPanel";
import type { PartitionCombatStateRow } from "../../api/maps";

// Regression coverage for the fix to deepDesertPartitionName: it must
// resolve PvP/PvE labeling from the server-resolved combat state (backed by
// the effective UserGame.ini configuration), never from `row.dimension`.
// Previously dimension 0 was hard-labeled "Deep Desert PvP" and dimension 1
// "Deep Desert PvE" regardless of actual partition configuration.

function combatRow(overrides: Partial<PartitionCombatStateRow> = {}): PartitionCombatStateRow {
  return {
    map: "DeepDesert_1",
    partitionId: "8",
    dimensionIndex: 0,
    databaseLabel: "DeepDesert_0",
    runtimeStatus: "RUNNING",
    serverDisplayName: null,
    configuredState: "PVE",
    materializedState: "PVE",
    source: "legacy-flags",
    securityZonesEnabled: true,
    restartRequired: false,
    configurationDrift: false,
    warnings: [],
    ...overrides
  };
}

describe("deepDesertPartitionName", () => {
  it("recognizes a numeric zero dimension as the primary partition", () => {
    expect(isPrimaryDeepDesertPartition({ dimension: 0 })).toBe(true);
    expect(isPrimaryDeepDesertPartition({ dimension: 1 })).toBe(false);
  });
  it("uses a real database label when present and not purely numeric", () => {
    const name = deepDesertPartitionName({ label: "Custom Sietch Name", dimension: 0 });
    expect(name).toBe("Custom Sietch Name");
  });

  it("prefers resolved combat state over a stale database label", () => {
    const name = deepDesertPartitionName(
      { label: "Deep Desert PvP", dimension: 0 },
      combatRow({ configuredState: "PVE" })
    );
    expect(name).toBe("Deep Desert 1 (PvE)");
  });

  it("falls back to a neutral instance name with no combat state supplied", () => {
    const name = deepDesertPartitionName({ label: "", dimension: 0 });
    expect(name).toBe("Deep Desert 1");
  });

  it("does NOT label dimension 0 as PvP when the resolved combat state is PVE", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ dimensionIndex: 0, configuredState: "PVE" })
    );
    expect(name).toContain("PvE");
    expect(name).not.toContain("PvP");
  });

  it("does NOT label dimension 1 as PvE when the resolved combat state is PVP", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 1 },
      combatRow({ dimensionIndex: 1, partitionId: "9", configuredState: "PVP" })
    );
    expect(name).toContain("PvP");
    expect(name).not.toContain("PvE");
  });

  it("surfaces a CONFLICT combat state instead of guessing PvP or PvE", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "CONFLICT" })
    );
    expect(name).toMatch(/conflicting/i);
    expect(name).not.toContain("(PvP)");
    expect(name).not.toContain("(PvE)");
  });

  it("does not append a PvP/PvE suffix when combat state is UNKNOWN", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "UNKNOWN" })
    );
    expect(name).toBe("Deep Desert 1");
  });

  it("a purely numeric database label is treated as non-descriptive and ignored", () => {
    const name = deepDesertPartitionName(
      { label: "0", dimension: 0 },
      combatRow({ configuredState: "PVP" })
    );
    expect(name).toContain("PvP");
  });

  // The primary/dimension-0 row (e.g. partition 8) previously never called this
  // function at all -- MapsPanel.tsx's top-level row only wired it in for the
  // dynamically-created dimension>0 rows, so the primary row rendered as bare
  // "DeepDesert_1" no matter what. This case documents the exact scenario the
  // wiring fix now covers; it was already correct at the function level before
  // that fix, since the bug was a missing call site, not a bug in this function.
  it("labels the primary (dimension 0) partition from its resolved combat state", () => {
    const name = deepDesertPartitionName(
      { label: "DeepDesert_0", dimension: 0 },
      combatRow({ partitionId: "8", dimensionIndex: 0, configuredState: "PVP" })
    );
    expect(name).toBe("Deep Desert 1 (PvP)");
  });

  // Regression coverage for surfacing the operator-configured Bgd.ServerDisplayName
  // (effective partition -> map -> global UserEngine.ini value) ahead of the
  // synthesized "Deep Desert N (PvP/PvE)" text. Previously this name was resolved
  // by neither the Bases page nor the Maps page.
  it("prefers a configured server display name over the synthesized PvP/PvE text", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "PVE", serverDisplayName: "My Arrakis" })
    );
    expect(name).toBe("My Arrakis");
  });

  it("falls back to the synthesized name when no display name is configured", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "PVE", serverDisplayName: null })
    );
    expect(name).toBe("Deep Desert 1 (PvE)");
  });

  it("ignores a blank/whitespace-only configured display name", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "PVP", serverDisplayName: "   " })
    );
    expect(name).toBe("Deep Desert 1 (PvP)");
  });
});
