import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarNavIndicators } from "./App";

describe("sidebar navigation indicators", () => {
  it("shows the online-player count only when players are online", () => {
    const { rerender } = render(<SidebarNavIndicators item="Players" onlinePlayerCount={0} addonUpdatesAvailable={false} />);
    expect(screen.queryByLabelText("0 players online")).not.toBeInTheDocument();

    rerender(<SidebarNavIndicators item="Players" onlinePlayerCount={3} addonUpdatesAvailable={false} />);
    const indicator = screen.getByLabelText("3 players online");
    expect(indicator).toHaveTextContent("3");
    expect(indicator).toHaveClass("sidebar-nav-count-online");
  });

  it("shows the Addons icon only when an update is available", () => {
    const { rerender } = render(<SidebarNavIndicators item="Addons" onlinePlayerCount={0} addonUpdatesAvailable />);
    expect(screen.getByLabelText("Addon update available")).toBeInTheDocument();

    rerender(<SidebarNavIndicators item="Addons" onlinePlayerCount={0} addonUpdatesAvailable={false} />);
    expect(screen.queryByLabelText("Addon update available")).not.toBeInTheDocument();
  });
});
