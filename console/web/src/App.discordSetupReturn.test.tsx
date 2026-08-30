import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DISCORD_SETUP_RETURN_KEY } from "./features/auth/DiscordSetupWizard";

// #643 (embed the guided Discord setup wizard into Settings, post-login).
// Real Eight Hats Layer 1 CRITICAL finding, independently confirmed by both
// the Architect and UI/UX hats (docs/design/discord-settings-embed-l1-
// design-2026-08-30.md, finding #1): the OAuth round-trip's return
// (`?discordSetup=done`) is a full page navigation, and App.tsx's
// `discordSetupOpen` state used to derive purely from that URL param's
// presence -- meaning an already-authenticated operator returning from the
// Settings-embedded wizard's own "Continue with Discord" click was dropped
// into the pre-login standalone takeover, whose `onDone` unconditionally
// logs the session out. The fix: DiscordSetupWizard sets a sessionStorage
// marker before navigating (only when embedded); App.tsx consumes it here.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubAuthenticatedOwnerSession() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    calls.push(path);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured: false, discordOAuthAppConfigured: false } });
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "owner", displayName: "Owner", tier: "owner", guildId: "" }, allowedActions: ["server:read", "settings:read", "settings:write"], secondFactorEnrolled: true });
    if (path.includes("/api/setup/state")) return jsonResponse({ files: { env: true, token: true, battlegroup: true, complete: true }, config: {} });
    if (path.includes("/api/setup/discord-identity")) return Promise.resolve(new Response(JSON.stringify({ error: "not signed in with Discord yet" }), { status: 404, headers: { "content-type": "application/json" } }));
    if (path.includes("/api/settings")) return jsonResponse({ serverConfig: {}, config: { discordOAuthAppConfigured: false }, publicDirectory: {} });
    if (path.includes("/api/auth/logout")) return jsonResponse({ ok: true });
    return jsonResponse({ stdout: "", stderr: "", exitCode: 0 });
  }));
  return calls;
}

describe("App: returning from the Discord OAuth round-trip (#643)", () => {
  it("routes back into Settings, with no forced logout, when the discord-setup-return marker is present", async () => {
    window.sessionStorage.setItem(DISCORD_SETUP_RETURN_KEY, "settings");
    window.history.replaceState({}, "", "/?discordSetup=done");
    const calls = stubAuthenticatedOwnerSession();

    render(<App />);

    await waitFor(() => expect(document.getElementById("console-navigation")).toBeInTheDocument());
    // Lands in Settings -- not the standalone pre-login takeover.
    expect(document.querySelector("main.login-screen")).toBeNull();
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
    // The marker is one-shot.
    expect(window.sessionStorage.getItem(DISCORD_SETUP_RETURN_KEY)).toBeNull();
    // No forced logout for an operator who was already authenticated.
    expect(calls.some((p) => p.includes("/api/auth/logout"))).toBe(false);
  });

  it("keeps today's standalone pre-login takeover when the marker is absent (unchanged)", async () => {
    window.history.replaceState({}, "", "/?discordSetup=done");
    stubAuthenticatedOwnerSession();

    render(<App />);

    expect(await screen.findByText("Set up Discord sign-in")).toBeInTheDocument();
    expect(document.querySelector("main.login-screen")).not.toBeNull();
  });
});
