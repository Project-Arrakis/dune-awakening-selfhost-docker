import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { AUTH_SESSION_EXPIRED_EVENT, setCsrfToken } from "./api/client";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stateFetch() {
  return jsonResponse({ authenticated: false, csrfToken: null, config: {} });
}

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function submitPassword(password: string) {
  const pwInput = await screen.findByPlaceholderText("Admin Password");
  fireEvent.change(pwInput, { target: { value: password } });
  fireEvent.submit(pwInput.closest("form")!);
}

describe("App login flow (Tier 3 password + TOTP)", () => {
  it("shows the real server error for a wrong password, not the generic session-expired message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        return jsonResponse({ error: "Incorrect password. Please try again!" }, 401);
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("wrong");

    await waitFor(() => {
      expect(screen.getByText("Incorrect password. Please try again!")).toBeInTheDocument();
    });
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  it("prompts for a TOTP code when the server requires one, and signs in once it's provided", async () => {
    let loginCalls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        loginCalls += 1;
        const body = JSON.parse(String(opts.body || "{}"));
        if (loginCalls === 1) {
          expect(body.totpCode).toBeFalsy();
          return jsonResponse({ totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code, or use a recovery code if you have lost your device." }, 401);
        }
        expect(body.totpCode).toBe("123456");
        return jsonResponse({ authenticated: true, csrfToken: "tok" });
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");

    const totpInput = await screen.findByPlaceholderText(/authenticator code/i);
    fireEvent.change(totpInput, { target: { value: "123456" } });
    fireEvent.submit(totpInput.closest("form")!);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Admin Password")).not.toBeInTheDocument();
    });
  });

  it("offers a recovery-code affordance on the TOTP step and submits it instead of a TOTP code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        const body = JSON.parse(String(opts.body || "{}"));
        if (body.recoveryCode) {
          expect(body.recoveryCode).toBe("aaaa-bbbb-cccc-dddd-ee");
          return jsonResponse({ resetupRequired: true, csrfToken: "resetup-tok" });
        }
        return jsonResponse({ totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code." }, 401);
      }
      if (p.includes("/api/auth/2fa/setup")) return jsonResponse({ secret: "AAAAAAAAAAAAAAAA", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AA==" });
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");

    const recoveryToggle = await screen.findByText(/lost access to your authenticator/i);
    fireEvent.click(recoveryToggle);

    const recoveryInput = await screen.findByPlaceholderText(/recovery code/i);
    fireEvent.change(recoveryInput, { target: { value: "aaaa-bbbb-cccc-dddd-ee" } });
    fireEvent.submit(recoveryInput.closest("form")!);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Admin Password")).not.toBeInTheDocument();
    });
  });

  it("clears stale input when toggling between the TOTP-code and recovery-code fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        return jsonResponse({ totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code." }, 401);
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");

    const totpInput = await screen.findByPlaceholderText(/authenticator code/i);
    fireEvent.change(totpInput, { target: { value: "123456" } });

    fireEvent.click(screen.getByText(/lost access to your authenticator/i));
    const recoveryInput = await screen.findByPlaceholderText(/recovery code/i);
    expect((recoveryInput as HTMLInputElement).value).toBe("");
    expect(screen.queryByPlaceholderText(/authenticator code/i)).not.toBeInTheDocument();

    fireEvent.change(recoveryInput, { target: { value: "aaaa-bbbb-cccc-dddd-ee" } });
    fireEvent.click(screen.getByText(/use your authenticator instead/i));
    const totpInputAgain = await screen.findByPlaceholderText(/authenticator code/i);
    expect((totpInputAgain as HTMLInputElement).value).toBe("");
    expect(screen.queryByPlaceholderText(/recovery code/i)).not.toBeInTheDocument();
  });

  it("shows the TOTP setup screen (QR code) when the server requires enrollment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        return jsonResponse({ enrollmentRequired: true, csrfToken: "enroll-tok" });
      }
      if (p.includes("/api/auth/2fa/setup")) {
        return jsonResponse({ secret: "AAAAAAAAAAAAAAAA", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AA==" });
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");

    await waitFor(() => {
      const img = screen.getByAltText(/authenticator qr code/i) as HTMLImageElement;
      expect(img.src).toContain("data:image/png;base64");
    });
    expect(screen.getByText("AAAAAAAAAAAAAAAA")).toBeInTheDocument();
  });

  // Regression (Architect/Security-hat L2 finding, #407 phase 7): if the
  // enrollment session itself is invalid/expired by the time the setup
  // screen calls /api/auth/2fa/setup, the error message doesn't match the
  // client's session-expiry regex, so nothing resets setupMode -- the
  // operator was stuck on the setup screen with no way back to the plain
  // login form except a hard page reload. A visible "back to sign in"
  // escape hatch fixes this regardless of which error occurred.
  it("offers a way back to the plain login screen from the TOTP setup screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        return jsonResponse({ enrollmentRequired: true, csrfToken: "enroll-tok" });
      }
      if (p.includes("/api/auth/2fa/setup")) {
        return jsonResponse({ secret: "AAAAAAAAAAAAAAAA", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AA==" });
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");
    await screen.findByAltText(/authenticator qr code/i);

    fireEvent.click(screen.getByText(/back to sign in/i));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Admin Password")).toBeInTheDocument();
    });
  });

  // Regression (Architect-hat L2 finding, #407 phase 7): totpRequired and its
  // sibling state used to be set on the way IN to the TOTP step but never
  // reset on the way OUT via a session-expiry event, so a later session
  // expiry left the login screen permanently rendering the code/recovery
  // field with no password input to even attempt a fresh login.
  it("resets TOTP login state on a session-expiry event, so the password field reappears", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string, opts?: RequestInit) => {
      const p = String(path);
      if (p.includes("/api/auth/state")) return stateFetch();
      if (p.includes("/api/auth/login") && opts?.method === "POST") {
        return jsonResponse({ totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code." }, 401);
      }
      return jsonResponse({});
    }));

    render(<App />);
    await submitPassword("correct-password");
    await screen.findByPlaceholderText(/authenticator code/i);

    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Admin Password")).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/authenticator code/i)).not.toBeInTheDocument();
  });
});
