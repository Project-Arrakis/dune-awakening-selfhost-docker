import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CombatStatusBadge, MapDisplayName } from "./MapsPanel";

describe("Map combat status badge", () => {
  it("renders PvE with the green status class", () => {
    render(<CombatStatusBadge state="PVE" />);
    expect(screen.getByText("PvE")).toHaveClass("combat-status-pve");
  });

  it("renders PvP with the red status class", () => {
    render(<CombatStatusBadge state="PVP" />);
    expect(screen.getByText("PvP")).toHaveClass("combat-status-pvp");
    expect(screen.getByRole("button", { name: "About PvP combat settings" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("does not verify combat rules in game");
    expect(screen.getByText("PvP")).not.toHaveAttribute("title");
  });

  it("labels overlapping selectors as a configuration warning rather than a verified game error", () => {
    render(<CombatStatusBadge state="CONFLICT" />);
    expect(screen.getByText("Conflict")).toHaveClass("combat-status-conflict");
    expect(screen.getByRole("tooltip")).toHaveTextContent("not a verified game error");
  });

  it("uses a neutral Unknown badge instead of guessing", () => {
    render(<CombatStatusBadge state="UNKNOWN" />);
    expect(screen.getByText("Unknown")).toHaveClass("combat-status-unknown");
  });

  it("explains when a restart is needed to materialize the saved setting", () => {
    render(<CombatStatusBadge state="PVE" restartRequired />);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/restart required/i);
  });

  it("renders the resolved PvP state for a Deep Desert instance", () => {
    render(<MapDisplayName mapId="DeepDesert_1" instanceName="Deep Desert 1 (PvP)" combatState="PVP" />);
    expect(screen.getByText("PvP")).toHaveClass("combat-status-pvp");
  });

  it("renders the resolved PvE state for a secondary Deep Desert instance", () => {
    render(<MapDisplayName mapId="DeepDesert_1" instanceName="Deep Desert 2 (PvE)" combatState="PVE" />);
    expect(screen.getByText("PvE")).toHaveClass("combat-status-pve");
  });

  it("opens help from the info button and closes it with Escape", () => {
    const { container } = render(<CombatStatusBadge state="PVE" />);
    const help = screen.getByRole("button", { name: "About PvE combat settings" });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.getElementById(help.getAttribute("aria-describedby")!)).toBe(screen.getByRole("tooltip"));
    expect(help).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Saved UserGame selection: PvE");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
  });

  it("gives each map its own help and closes the previous explanation", () => {
    render(<><CombatStatusBadge state="PVE" /><CombatStatusBadge state="PVE" /></>);
    const [first, second] = screen.getAllByRole("button", { name: "About PvE combat settings" });
    expect(first.getAttribute("aria-describedby")).not.toBe(second.getAttribute("aria-describedby"));
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
  });
});
