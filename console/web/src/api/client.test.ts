import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiDownload,
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_SESSION_EXPIRED_MESSAGE,
  loginRequest,
  setCsrfToken
} from "./client";

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API authentication handling", () => {
  it("announces an expired session instead of leaving feature pages in a fallback state", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Your browser login session expired." }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    await expect(api("/api/updates/check-stack")).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("refreshes a stale CSRF token without signing the user out", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "CSRF token mismatch." }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, csrfToken: "new-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api<{ ok: boolean }>("/api/settings", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect(expired).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("x-csrf-token")).toBe("new-token");
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("does not treat an unrelated forbidden response as an expired session", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Access denied by the configured IP allowlist." }),
      { status: 403 }
    )));

    await expect(api("/api/settings")).rejects.toThrow("Access denied by the configured IP allowlist.");
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  // Regression: isSessionAuthFailure used to treat EVERY 401 as a stale
  // session, regardless of message -- so a 401 that means something else
  // entirely (e.g. /api/auth/2fa/confirm's "wrong code" response) got
  // silently rewritten to the generic session-expired message, hiding the
  // real error from the user.
  it("does not treat a 401 with an unrelated message as a stale session", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "That code was not accepted. Check your device's clock and enter the current code." }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    await expect(api("/api/auth/2fa/confirm", { method: "POST", body: "{}" }))
      .rejects.toThrow("That code was not accepted. Check your device's clock and enter the current code.");
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("applies the same expired-session behavior to downloads", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Authentication required." }),
      { status: 401 }
    )));

    await expect(apiDownload("/api/backups/download")).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });
});

// loginRequest is a dedicated, non-throwing entry point for /api/auth/login:
// unlike every other route, EVERY status code the login route returns (200
// success, 401 wrong-password/totpRequired/recoveryFailed, 429 rate-limited,
// 503 second-factor-store-unavailable) carries a real, distinct body the
// caller must branch on -- there is no session yet at login time, so a
// generic "401 = session expired" interception (which api()/apiRequest()
// correctly apply to every OTHER authenticated route) would misrepresent
// every one of those login-specific outcomes as a stale-session error.
describe("loginRequest (dedicated login entry point, bypasses session-expiry interception)", () => {
  it("returns the parsed body and status for a successful login, without touching the session-expiry event", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ authenticated: true, csrfToken: "tok" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    const result = await loginRequest({ password: "correct" });
    expect(result).toEqual({ status: 200, body: { authenticated: true, csrfToken: "tok" } });
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("returns a 401 wrong-password body as data, not a thrown session-expired error", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Incorrect password. Please try again!" }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    const result = await loginRequest({ password: "wrong" });
    expect(result).toEqual({ status: 401, body: { error: "Incorrect password. Please try again!" } });
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("returns a 401 totpRequired body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code." }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    const result = await loginRequest({ password: "correct" });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ totpRequired: true, recoveryAvailable: true });
  });

  it("returns a 429 rate-limited body as data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Too many sign-in attempts. Please wait a few minutes, then try again." }),
      { status: 429, headers: { "content-type": "application/json" } }
    )));

    const result = await loginRequest({ password: "correct" });
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ error: expect.stringContaining("Too many sign-in attempts") });
  });
});

// Regression (Security-hat L2 finding, #407 phase 7): requireEnrollmentSession's
// two "you don't have a valid enrollment session" 403s use wording that didn't
// match the original session-expiry regex, so a TotpSetupScreen call failing
// this way was treated as an ordinary error instead of a stale-session one.
describe("isSessionAuthFailure recognizes the enrollment-session gate's own wording", () => {
  it("treats 'Sign in to begin two-factor setup.' (403) as a session failure", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Sign in to begin two-factor setup." }),
      { status: 403, headers: { "content-type": "application/json" } }
    )));

    await expect(api("/api/auth/2fa/setup", { method: "POST" })).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("treats 'Finish setting up two-factor authentication...' (403) as a session failure", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Finish setting up two-factor authentication before using the console." }),
      { status: 403, headers: { "content-type": "application/json" } }
    )));

    await expect(api("/api/characters")).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });
});
