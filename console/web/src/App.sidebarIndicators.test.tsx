import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarNavIndicators, isNavItemVisible, navGroups } from "./App";

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

// ---- isNavItemVisible() / "Access Control" nav-gate regression (Layer 3
// re-audit, UI hat -- HIGH, L3-H1a) ----
//
// The "Access Control" nav item was previously gated on
// Action.SERVER_CONTROL ("server:*"), a copy-paste artifact from the
// "Server Control" row directly above it in navGroups -- every real IAM
// route this tab manages requires settings:read/settings:write (see
// console/api/src/actions.js's ROUTE_CAPABILITIES/
// EXTRA_ROUTE_CAPABILITIES), never server:*. This produced a total
// navigation dead-end for a deliberately-configured settings:write-only
// tier (this feature's own documented intended use case): the backend
// would accept every one of that tier's IAM mutation calls, but the tab
// to reach them never rendered at all.
describe("isNavItemVisible()", () => {
  it("hides every item when there is no authenticated user", () => {
    expect(isNavItemVisible({ requiredAction: "settings:write" }, null, ["settings:write"])).toBe(false);
  });

  it("shows an item with no requiredAction to any authenticated user", () => {
    expect(isNavItemVisible({}, { id: "x" }, [])).toBe(true);
  });

  it("shows an item when the exact requiredAction is in allowedActions", () => {
    expect(isNavItemVisible({ requiredAction: "settings:write" }, { id: "x" }, ["settings:write"])).toBe(true);
  });

  it("hides an item when the exact requiredAction is NOT in allowedActions", () => {
    expect(isNavItemVisible({ requiredAction: "settings:write" }, { id: "x" }, ["server:read"])).toBe(false);
  });

  it("resolves a wildcard requiredAction (e.g. server:*) against a matching prefixed allowed action", () => {
    expect(isNavItemVisible({ requiredAction: "server:*" }, { id: "x" }, ["server:read", "server:restart"])).toBe(true);
  });

  it("hides a wildcard requiredAction when no allowed action shares its prefix", () => {
    expect(isNavItemVisible({ requiredAction: "server:*" }, { id: "x" }, ["settings:write"])).toBe(false);
  });

  it("REGRESSION (L3-H1a): a settings:write-only tier (this feature's own documented intended use case) sees the Access Control nav item -- it does NOT require server:* or any server:* permission", () => {
    const settingsWriteOnly = ["settings:write"];
    expect(isNavItemVisible({ requiredAction: "server:*" }, { id: "x" }, settingsWriteOnly)).toBe(false); // sanity: this tier does NOT hold server:*
    expect(isNavItemVisible({ requiredAction: "settings:write" }, { id: "x" }, settingsWriteOnly)).toBe(true); // the ACTUAL gate this nav item must use
  });
});

describe("navGroups configuration", () => {
  it("REGRESSION (L3-H1a): the real, live 'Access Control' nav entry requires settings:write, not server:* -- confirms the fix is wired into the actual config, not just proven correct in isolation", () => {
    const accessControlItem = navGroups.flatMap((group) => group.items).find((item) => item.tab === "Access Control");
    expect(accessControlItem).toBeDefined();
    expect(accessControlItem?.requiredAction).toBe("settings:write");
  });

  it("every navGroups item's requiredAction (when present) is a real action known to the server-side action catalog's own namespace convention (namespace:verb or namespace:*)", () => {
    const allItems = navGroups.flatMap((group) => group.items);
    for (const item of allItems) {
      if (item.requiredAction) {
        expect(item.requiredAction).toMatch(/^[a-z-]+:[a-z*-]+$/);
      }
    }
  });
});
