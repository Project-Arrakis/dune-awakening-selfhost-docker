import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// F4, #574: the "Sign in with Discord" button on the login screen opens a
// popup and polls /api/auth/state, instead of navigating the whole tab.
// discordPopupLogin.test.ts already covers the state-machine logic in full
// isolation (unmount safety, cancellation, timeout, transient-fetch
// tolerance) -- this file only verifies App.tsx wires it up: the real
// window.open call, the busy label, and the popup-blocked fallback.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubLoginScreen(authState: { authenticated: boolean; csrfToken: string | null } = { authenticated: false, csrfToken: null }) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) {
      return jsonResponse({ ...authState, config: { discordOAuthConfigured: true } });
    }
    return jsonResponse({});
  }));
}

describe("Discord popup login button", () => {
  it("opens a popup and navigates it to the popup-flagged start URL on a plain click", async () => {
    stubLoginScreen();
    const fakePopup = { closed: false, close: vi.fn(), location: { replace: vi.fn() } };
    const openSpy = vi.fn().mockReturnValue(fakePopup);
    vi.stubGlobal("open", openSpy);

    render(<App />);
    const button = await screen.findByText("Sign in with Discord");
    button.click();

    expect(openSpy).toHaveBeenCalledWith("about:blank", "console-discord-login", "popup,width=480,height=720");
    await waitFor(() => expect(fakePopup.location.replace).toHaveBeenCalledWith("/api/auth/discord/start?presentation=popup"));
    expect(await screen.findByText("Waiting for Discord...")).toBeInTheDocument();
  });

  it("recovers the button (not stuck on 'Waiting for Discord...') if window.open itself throws instead of returning null (code review finding)", async () => {
    stubLoginScreen();
    vi.stubGlobal("open", vi.fn().mockImplementation(() => { throw new Error("SecurityError: popup blocked by policy"); }));

    render(<App />);
    const button = await screen.findByText("Sign in with Discord");
    button.click();

    await waitFor(() => expect(screen.queryByText("Waiting for Discord...")).not.toBeInTheDocument());
    expect(await screen.findByText("Discord sign-in could not be started. Try again, or use the regular sign-in link.")).toBeInTheDocument();
  });

  it("falls back to the full-page redirect, without ever showing the busy label, when the popup is blocked", async () => {
    stubLoginScreen();
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    // jsdom cannot actually navigate; the assignment itself is what we verify.
    const originalHref = window.location.href;
    let assignedHref = "";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, set href(value: string) { assignedHref = value; }, get href() { return assignedHref || originalHref; } }
    });

    render(<App />);
    const button = await screen.findByText("Sign in with Discord");
    button.click();

    await waitFor(() => expect(assignedHref).toBe("/api/auth/discord/start"));
    expect(screen.queryByText("Waiting for Discord...")).not.toBeInTheDocument();
  });

  it("transitions to the authenticated console once polling reports success", async () => {
    // Land on Settings, not the default Home tab -- Home's panel makes many
    // real-server-status calls this test doesn't stub and doesn't care about
    // (same reasoning as App.accessControlVisibility.test.tsx).
    window.sessionStorage.setItem("dune-console:active-tab", "Settings");
    // sawClick guards against any /api/auth/state call that happens before
    // the button is clicked (the component's own mount-time fetch, and
    // potentially more than one of those) -- only polls made AFTER the
    // click participate in the pollCount-driven flip to authenticated.
    let sawClick = false;
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.includes("/api/auth/state")) {
        if (!sawClick) return jsonResponse({ authenticated: false, csrfToken: null, config: { discordOAuthConfigured: true } });
        pollCount += 1;
        return jsonResponse(pollCount < 2 ? { authenticated: false, csrfToken: null, config: { discordOAuthConfigured: true } } : { authenticated: true, csrfToken: "csrf-popup" });
      }
      if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "op", displayName: "Op", tier: "owner", guildId: "" }, allowedActions: ["server:read", "settings:read"], secondFactorEnrolled: true });
      if (path.includes("/api/setup/state")) return jsonResponse({ files: { env: true, token: true, battlegroup: true, complete: true }, config: {} });
      return jsonResponse({ stdout: "", stderr: "", exitCode: 0 });
    }));
    const fakePopup = { closed: false, close: vi.fn(), location: { replace: vi.fn() } };
    vi.stubGlobal("open", vi.fn().mockReturnValue(fakePopup));

    render(<App />);
    const button = await screen.findByText("Sign in with Discord");
    // Fake timers activated only now -- findByText above needs the REAL
    // setTimeout to poll while waiting for the initial render; only the
    // poll loop's own sleep() calls (triggered by the click below) need to
    // be fast-forwarded.
    vi.useFakeTimers();
    sawClick = true;
    button.click();
    expect(fakePopup.location.replace).toHaveBeenCalled();

    // First poll (not yet authenticated), then the second one succeeds.
    // advanceTimersByTimeAsync flushes the microtasks each fake-timer tick
    // triggers, so the state machine (and the React updates it causes) has
    // fully settled by the time each await returns -- no further waitFor
    // (which would itself need the now-faked setTimeout to tick) is needed.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fakePopup.close).toHaveBeenCalled();
    expect(screen.queryByText("Sign in with Discord")).not.toBeInTheDocument();
  });
});
