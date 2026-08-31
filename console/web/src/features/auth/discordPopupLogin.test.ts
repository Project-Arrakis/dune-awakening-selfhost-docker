import { describe, it, expect, vi } from "vitest";
import { runDiscordPopupLogin, type DiscordAuthState } from "./discordPopupLogin";

function fakePopup(overrides: Partial<{ closed: boolean }> = {}) {
  const location = { replace: vi.fn() };
  const popup = { closed: overrides.closed ?? false, close: vi.fn(() => { popup.closed = true; }), location } as unknown as Window & { closed: boolean; close: () => void; location: { replace: (url: string) => void } };
  return popup;
}

function immediateSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

describe("runDiscordPopupLogin", () => {
  it("navigates the popup to the presentation=popup start URL", async () => {
    const popup = fakePopup();
    const fetchAuthState = vi.fn().mockResolvedValue({ authenticated: true, csrfToken: "csrf-1" } as DiscordAuthState);
    await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess: vi.fn(), isMounted: () => true
    });
    expect(popup.location.replace).toHaveBeenCalledWith("/api/auth/discord/start?presentation=popup");
  });

  it("falls back to the full-page redirect, on the same call, when the popup is blocked", async () => {
    const navigateFullPage = vi.fn();
    const result = await runDiscordPopupLogin({
      openPopup: () => null, fetchAuthState: vi.fn(), sleep: immediateSleep(), navigateFullPage,
      onSuccess: vi.fn(), isMounted: () => true
    });
    expect(navigateFullPage).toHaveBeenCalledWith("/api/auth/discord/start");
    expect(result).toEqual({ outcome: "fallback" });
  });

  it("polls until authenticated, then calls onSuccess and closes the popup", async () => {
    const popup = fakePopup();
    let calls = 0;
    const fetchAuthState = vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls < 3 ? { authenticated: false, csrfToken: null } : { authenticated: true, csrfToken: "csrf-2" };
    });
    const onSuccess = vi.fn();
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess, isMounted: () => true
    });
    expect(calls).toBe(3);
    expect(onSuccess).toHaveBeenCalledWith({ authenticated: true, csrfToken: "csrf-2" });
    expect(popup.close).toHaveBeenCalled();
    expect(result).toEqual({ outcome: "success" });
  });

  it("stops with 'cancelled' when the popup is closed before authentication completes -- never calls onSuccess", async () => {
    const popup = fakePopup();
    const fetchAuthState = vi.fn().mockImplementation(async () => {
      popup.closed = true; // simulate the operator closing it between polls
      return { authenticated: false, csrfToken: null };
    });
    const onSuccess = vi.fn();
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess, isMounted: () => true
    });
    expect(result).toEqual({ outcome: "cancelled" });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("keeps polling through a transient fetch failure, rather than giving up immediately", async () => {
    const popup = fakePopup();
    let calls = 0;
    const fetchAuthState = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network hiccup");
      return { authenticated: true, csrfToken: "csrf-3" };
    });
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess: vi.fn(), isMounted: () => true
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ outcome: "success" });
  });

  it("times out after maxAttempts, closing the popup", async () => {
    const popup = fakePopup();
    const fetchAuthState = vi.fn().mockResolvedValue({ authenticated: false, csrfToken: null });
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess: vi.fn(), isMounted: () => true, maxAttempts: 3
    });
    expect(fetchAuthState).toHaveBeenCalledTimes(3);
    expect(popup.close).toHaveBeenCalled();
    expect(result).toEqual({ outcome: "timeout" });
  });

  it("stops immediately once unmounted -- no further fetch or onSuccess call, even mid-poll -- and still closes the popup (code review finding: every other terminal outcome does)", async () => {
    const popup = fakePopup();
    let mounted = true;
    let calls = 0;
    const fetchAuthState = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) mounted = false; // simulate unmount happening between polls
      return { authenticated: true, csrfToken: "csrf-4" };
    });
    const onSuccess = vi.fn();
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess, isMounted: () => mounted
    });
    expect(calls, "must not keep polling after unmount").toBe(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "unmounted" });
    expect(popup.close, "an unmounted-mid-poll popup must not be left orphaned and open").toHaveBeenCalled();
  });

  it("checks isMounted immediately after sleep, before even consulting popup.closed -- an unmount there stops the loop before any fetch", async () => {
    const popup = fakePopup();
    const isMounted = vi.fn().mockReturnValue(false); // already unmounted by the time the first sleep resolves
    const fetchAuthState = vi.fn();
    const result = await runDiscordPopupLogin({
      openPopup: () => popup, fetchAuthState, sleep: immediateSleep(), navigateFullPage: vi.fn(),
      onSuccess: vi.fn(), isMounted, maxAttempts: 5
    });
    expect(fetchAuthState).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "unmounted" });
    expect(popup.close).toHaveBeenCalled();
  });
});
