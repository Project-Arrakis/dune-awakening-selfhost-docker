import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createDefaultSkinProfile, GLOBAL_WIDGET_CATALOG } from "./skins/skinDefaults";
import { clearSkinDomOverrides, saveAndApplySkin } from "./skins/skinEngine";

// Operator tiers are offered the Storage page when their role holds
// storage:read. It is the only way into the container item controls.
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Start on a page with no server data.
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

const APPLY_FILLS = "Apply Fills (Restart Survival)";

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
    return jsonResponse({ rows: [], totalCount: 0, stdout: "", capabilities: {} });
  }));
  return calls;
}

const storageCalls = (calls: string[]) => calls.filter((path) => /\/api\/storage(\/|\?|$)/.test(path));

async function menu() {
  return waitFor(() => {
    const el = document.getElementById("console-navigation");
    expect(el).toBeInTheDocument();
    return el as HTMLElement;
  });
}

// The menu before the session is known holds nothing that needs a permission, so
// wait for an entry this session is certainly offered.
async function loadedMenu(entry = "Server Control") {
  const nav = await menu();
  await waitFor(() => expect(within(nav).getByText(entry)).toBeInTheDocument());
  return nav;
}

// A custom skin, so the menu comes from the skin's own page list.
function storeCustomSkin() {
  const skin = createDefaultSkinProfile();
  saveAndApplySkin({
    ...skin,
    id: "custom-test",
    name: "Custom Test",
    customPages: [{ id: "custom:ops", title: "Ops Cockpit", subtitle: "", groupId: skin.navigation[0].id }]
  });
}

describe("the Storage menu entry for operator tiers", () => {
  it.each([
    ["owner", ["server:read", "server:control", "storage:read", "storage:mutate"]],
    ["moderator", ["server:read", "server:control", "storage:read"]]
  ])("is offered to %s holding storage:read and opens the container page", async (tier, actions) => {
    const calls = stubSession(tier, actions);
    render(<App />);
    const nav = await loadedMenu();

    fireEvent.click(within(nav).getByRole("button", { name: "Storage" }));

    expect(await screen.findByRole("button", { name: APPLY_FILLS })).toBeInTheDocument();
    await waitFor(() => expect(storageCalls(calls).length).toBeGreaterThan(0));
  });

  it("is listed in a custom menu for an operator holding storage:read", async () => {
    storeCustomSkin();
    stubSession("admin", ["server:read", "server:control", "storage:read"]);
    render(<App />);
    const nav = await loadedMenu();
    await waitFor(() => expect(within(nav).getByText("Ops Cockpit")).toBeInTheDocument());

    fireEvent.click(within(nav).getByRole("button", { name: "Storage" }));

    expect(await screen.findByRole("button", { name: APPLY_FILLS })).toBeInTheDocument();
  });

  it.each([["the built-in menu", false], ["a custom menu", true]])("is absent from %s without storage:read", async (_name, custom) => {
    if (custom) storeCustomSkin();
    // Every other grant an operator might hold next to it.
    const calls = stubSession("admin", ["server:read", "server:control", "bases:read", "vehicles:read", "storage:mutate"]);
    render(<App />);
    const nav = await loadedMenu();
    await waitFor(() => expect(within(nav).getByText("Vehicles")).toBeInTheDocument());

    expect(within(nav).queryByText("Storage")).not.toBeInTheDocument();
    expect(storageCalls(calls)).toEqual([]);
  });

  // So the menu is the only way in. A widget added for this page needs its own
  // access test.
  it("has no dashboard widget", () => {
    expect(GLOBAL_WIDGET_CATALOG.filter((widget) => widget.sourcePage === "Storage")).toEqual([]);
  });

  it.each(["player", "observer"])("leaves the %s tier on its own read-only storage page", async (tier) => {
    stubSession(tier, ["server:read", "storage:read"]);
    render(<App />);
    const nav = await loadedMenu("Storage");

    fireEvent.click(within(nav).getByRole("button", { name: "Storage" }));

    expect(await screen.findByRole("heading", { name: "Your Storage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLY_FILLS })).toBeNull();
  });

  it("stays hidden from a player without storage:read", async () => {
    stubSession("player", ["server:read", "bases:read"]);
    render(<App />);
    const nav = await loadedMenu("Bases");

    expect(within(nav).queryByText("Storage")).not.toBeInTheDocument();
  });
});
