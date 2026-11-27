import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createDefaultSkinProfile } from "./skins/skinDefaults";
import { clearSkinDomOverrides, saveAndApplySkin, updatePageWidgetLayout } from "./skins/skinEngine";

// A custom skin changes how the console looks. It must not change who is
// offered which page: not in the menu, and not through a dashboard widget.
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Start on a page with no server data, so these tests only exercise access.
  window.sessionStorage.setItem("dune-console:active-tab", "Language");
  clearSkinDomOverrides();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearSkinDomOverrides();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubSession(tier: string, allowedActions: string[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    calls.push(path);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured: true } });
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "u", displayName: "U", tier, guildId: "" }, allowedActions, secondFactorEnrolled: true });
    if (path.includes("/api/setup/state")) return jsonResponse({ files: { complete: true } });
    if (path.includes("/api/server/status")) return jsonResponse({ ok: true, stdout: "", data: { summary: { overall: "READY", title: "Test Server" }, gameServers: [] } });
    if (path.includes("/api/players/online")) return jsonResponse({ rows: [] });
    // Embedded pages read command output from `stdout`.
    return jsonResponse({ rows: [], totalCount: 0, stdout: "" });
  }));
  return calls;
}

// A skin with a renamed menu entry and one custom dashboard holding a Backups widget.
function storeCustomSkin() {
  const skin = createDefaultSkinProfile();
  saveAndApplySkin({
    ...skin,
    id: "custom-test",
    name: "Custom Test",
    navigation: skin.navigation.map((group, index) => index === 0
      ? { ...group, items: group.items.map((item) => item.tab === "Home" ? { ...item, customLabel: "Cockpit" } : item) }
      : group),
    customPages: [{ id: "custom:ops", title: "Ops Cockpit", subtitle: "", groupId: skin.navigation[0].id }]
  });
  updatePageWidgetLayout("custom:ops", (layout) => ({
    ...layout,
    widgets: [{ id: "backups.main", title: "Backup Archives & Restore", span: 12, hidden: false, sourcePage: "Backups" }]
  }));
}

async function menu() {
  return waitFor(() => {
    const el = document.getElementById("console-navigation");
    expect(el).toBeInTheDocument();
    return el as HTMLElement;
  });
}

describe("custom skins and page access", () => {
  it("gives a player the built-in menu, without custom dashboards or the Skin Studio", async () => {
    storeCustomSkin();
    stubSession("player", ["server:read", "players:read", "guilds:read", "bases:read", "vehicles:read", "storage:read"]);
    render(<App />);
    const nav = await menu();

    await waitFor(() => expect(within(nav).getByText("Storage")).toBeInTheDocument());
    expect(within(nav).getByText("Home")).toBeInTheDocument();
    for (const hidden of ["Cockpit", "Ops Cockpit", "Access Control", "Backups", "Settings"]) {
      expect(within(nav).queryByText(hidden)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Skin & Layout Studio" })).not.toBeInTheDocument();
  });

  it("keeps the fork's pages and the access rule in an operator's custom menu", async () => {
    storeCustomSkin();
    stubSession("admin", ["server:read", "server:control", "bases:read", "storage:read"]);
    render(<App />);
    const nav = await menu();

    await waitFor(() => expect(within(nav).getByText("Access Control")).toBeInTheDocument());
    for (const shown of ["Cockpit", "Ops Cockpit", "Server Control", "Bases"]) expect(within(nav).getByText(shown)).toBeInTheDocument();
    // Listed by the skin, but not allowed (or, for Storage, never in an operator's menu).
    for (const hidden of ["Backups", "Settings", "Database", "Storage"]) expect(within(nav).queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skin & Layout Studio" })).toBeInTheDocument();
  });

  it("leaves a dashboard widget empty when its page is not allowed", async () => {
    storeCustomSkin();
    const calls = stubSession("admin", ["server:read"]);
    render(<App />);
    const nav = await menu();

    (await waitFor(() => within(nav).getByText("Ops Cockpit"))).closest("button")!.click();

    await waitFor(() => expect(document.querySelector(".skin-custom-dashboard-page")).toBeInTheDocument());
    await vi.dynamicImportSettled();
    expect(document.querySelector(".skin-embedded-source")).toBeNull();
    expect(calls.some((c) => c.includes("/api/backups"))).toBe(false);
  });

  it("renders the same widget for a session that may open its page", async () => {
    storeCustomSkin();
    stubSession("admin", ["server:read", "backups:read"]);
    render(<App />);
    const nav = await menu();

    (await waitFor(() => within(nav).getByText("Ops Cockpit"))).closest("button")!.click();

    await waitFor(() => expect(document.querySelector(".skin-embedded-source")).toBeInTheDocument());
  });
});
