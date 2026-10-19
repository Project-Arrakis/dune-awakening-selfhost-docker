import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CombatStatusBadge, MapDisplayName } from "./MapsPanel";

describe("Map combat status badge", () => {
  it("renders PvE with the green status class", () => {
    render(<CombatStatusBadge state="PVE" />);
    expect(screen.getByText("PvE Config")).toHaveClass("combat-status-pve");
  });

  it("renders PvP with the red status class", () => {
    render(<CombatStatusBadge state="PVP" />);
    expect(screen.getByText("PvP Config")).toHaveClass("combat-status-pvp");
    expect(screen.getByLabelText("PvP combat configuration")).toHaveAttribute("title", expect.stringContaining("does not verify combat rules in game"));
  });

  it("labels overlapping selectors as a configuration warning rather than a verified game error", () => {
    render(<CombatStatusBadge state="CONFLICT" />);
    expect(screen.getByText("Conflict Config")).toHaveAttribute("title", expect.stringContaining("not a verified game error"));
  });

  it("uses a neutral Unknown badge instead of guessing", () => {
    render(<CombatStatusBadge state="UNKNOWN" />);
    expect(screen.getByText("Unknown Config")).toHaveClass("combat-status-unknown");
  });

  it("explains when a restart is needed to materialize the saved setting", () => {
    render(<CombatStatusBadge state="PVE" restartRequired />);
    expect(screen.getByLabelText("PvE combat configuration")).toHaveAttribute("title", expect.stringMatching(/restart required/i));
  });

  it("renders the resolved PvP state for a Deep Desert instance", () => {
    render(<MapDisplayName mapId="DeepDesert_1" instanceName="Deep Desert 1 (PvP)" combatState="PVP" />);
    expect(screen.getByText("PvP Config")).toHaveClass("combat-status-pvp");
  });

  it("renders the resolved PvE state for a secondary Deep Desert instance", () => {
    render(<MapDisplayName mapId="DeepDesert_1" instanceName="Deep Desert 2 (PvE)" combatState="PVE" />);
    expect(screen.getByText("PvE Config")).toHaveClass("combat-status-pve");
  });
});
