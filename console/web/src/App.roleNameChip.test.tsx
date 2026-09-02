import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// F3, #573: the signed-in chip shows the operator's actual Discord role name
// (when the console has one) instead of the bare access tier. The CSS class
// must stay tier-keyed regardless -- styling must never depend on an
// operator-chosen display string.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubSession(user: { tier: string; roleName?: string }) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured: true } });
    if (path.includes("/api/auth/me")) {
      return jsonResponse({
        user: { id: "u1", username: "op", displayName: "Op", tier: user.tier, guildId: "", roleName: user.roleName ?? "" },
        allowedActions: ["server:read"],
        secondFactorEnrolled: true
      });
    }
    if (path.includes("/api/setup/state")) return jsonResponse({ files: { env: true, token: true, battlegroup: true, complete: true }, config: {} });
    return jsonResponse({ stdout: "", stderr: "", exitCode: 0 });
  }));
}

describe("signed-in chip shows the Discord role name when one is available", () => {
  it("renders the role name as the chip text, but keeps the tier-keyed CSS class", async () => {
    stubSession({ tier: "admin", roleName: "Heavy Bats" });
    render(<App />);
    const chip = await waitFor(() => {
      const el = document.querySelector(".sidebar-user-tier");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    expect(chip.textContent).toBe("Heavy Bats");
    expect(chip.className).toBe("sidebar-user-tier tier-admin");
  });

  it("falls back to the plain tier string when no role name is configured", async () => {
    stubSession({ tier: "admin", roleName: "" });
    render(<App />);
    const chip = await waitFor(() => {
      const el = document.querySelector(".sidebar-user-tier");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    expect(chip.textContent).toBe("admin");
    expect(chip.className).toBe("sidebar-user-tier tier-admin");
  });

  it("falls back to the tier string when roleName is entirely absent from the response (older API shape)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured: true } });
      if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "op", displayName: "Op", tier: "player", guildId: "" }, allowedActions: [], secondFactorEnrolled: true });
      if (path.includes("/api/setup/state")) return jsonResponse({ files: { env: true, token: true, battlegroup: true, complete: true }, config: {} });
      return jsonResponse({ stdout: "", stderr: "", exitCode: 0 });
    }));
    render(<App />);
    const chip = await waitFor(() => {
      const el = document.querySelector(".sidebar-user-tier");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    expect(chip.textContent).toBe("player");
  });
});
