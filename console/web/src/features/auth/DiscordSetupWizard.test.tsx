import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { DiscordSetupWizard } from "./DiscordSetupWizard";

// #641 (guided Discord app-creation flow + hard HTTPS gate). Real Eight Hats
// Layer 1 findings this test suite regression-pins directly (design doc
// docs/design/discord-setup-wizard-guided-flow-l1-design-2026-08-30.md, §4.3):
//   - Architect HIGH: the connect-step save must send ONLY the 2 keys it
//     manages (DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_REDIRECT_URI) -- never
//     as blank strings for any other write-oauth-config field, which would
//     recreate the exact discordSetupFinalize owner-bootstrap-allowlist bug
//     this codebase already fixed once.
//   - QA HIGH: the window.open/visibilitychange mechanism has zero test
//     precedent in this codebase -- resolved in the design by using the
//     existing, trivially-testable <a rel="noreferrer"> pattern instead of a
//     raw window.open() call, which this suite asserts directly (the href).
//   - QA MEDIUM: the HTTPS gate line had zero test coverage even in its
//     original warning-only form.
vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

function stubNotYetConfigured() {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/settings") return Promise.resolve({ serverConfig: {}, config: { discordOAuthAppConfigured: false } } as never);
    if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
}

function stubHttps(value: boolean) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, protocol: value ? "https:" : "http:", origin: value ? "https://console.example.org" : "http://console.example.org", search: "" },
    writable: true,
  });
}

describe("DiscordSetupWizard: hard HTTPS gate", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });
  afterEach(() => { stubHttps(true); });

  it("blocks the connect step entirely and shows free HTTPS options when not loaded over HTTPS", async () => {
    stubHttps(false);
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText(/requires https/i)).toBeTruthy();
    expect(screen.getByText(/Cloudflare Tunnel/i)).toBeTruthy();
    expect(screen.getAllByText(/Tailscale/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ngrok/i).length).toBeGreaterThan(0);
    // The connect-step branch buttons must not appear while blocked.
    expect(screen.queryByText("I already have a Discord application")).toBeNull();
  });

  it("does not block, and shows the normal connect step, when loaded over HTTPS", async () => {
    stubHttps(true);
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText("I already have a Discord application")).toBeTruthy();
    expect(screen.queryByText(/requires https/i)).toBeNull();
  });
});

describe("DiscordSetupWizard: guided app-creation branch", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("shows the branch question before either path is chosen", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText("I already have a Discord application")).toBeTruthy();
    expect(screen.getByText("I need to create one")).toBeTruthy();
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
  });

  // Live-testing finding: "I need to create one" used the same tiny,
  // muted-text-link class as "Cancel" -- a real, weighted either/or choice
  // (arguably the MORE common path for a first-time operator) looked like a
  // throwaway escape hatch next to the bold primary button. It needs its own
  // real, visually-distinct secondary-button styling, not .login-password-
  // toggle (reserved for genuine tertiary/escape actions like Cancel).
  it("'I need to create one' is a real secondary button, not styled the same as Cancel", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    const needAppButton = await screen.findByText("I need to create one");
    const cancelButton = screen.getByText("Cancel");
    expect(needAppButton.className).not.toBe(cancelButton.className);
    expect(needAppButton.className).toContain("login-secondary-button");
  });

  it("'I already have one' reveals the form directly, with the dedicated-app warning co-located", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    expect(await screen.findByLabelText(/client id/i)).toBeTruthy();
    expect(screen.getByLabelText(/client secret/i)).toBeTruthy();
    expect(screen.getByText(/dedicated/i)).toBeTruthy();
  });

  it("'I need to create one' opens Discord's portal via a safe <a rel=noreferrer> link, shows a numbered checklist, and the same form", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I need to create one"));

    const link = await screen.findByRole("link", { name: /developer portal/i });
    expect(link.getAttribute("href")).toBe("https://discord.com/developers/applications");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");

    expect(screen.getByText("OAuth2")).toBeTruthy();
    expect(await screen.findByLabelText(/client id/i)).toBeTruthy();
    expect(screen.getByText(/dedicated/i)).toBeTruthy();
  });

  it("shows a welcome-back nudge once the window regains focus after choosing 'need to create one'", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I need to create one"));
    expect(screen.queryByText(/welcome back/i)).toBeNull();

    fireEvent(window, new Event("focus"));
    expect(await screen.findByText(/welcome back/i)).toBeTruthy();
  });
});

describe("DiscordSetupWizard: saving the connect-step form", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("sends ONLY DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_REDIRECT_URI to write-oauth-config -- no other key present at all", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));

    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/write-oauth-config", expect.anything()));
    const [, body] = mockPost.mock.calls.find(([p]) => p === "/api/setup/write-oauth-config")!;
    expect(Object.keys(body as object).sort()).toEqual(["DISCORD_OAUTH_CLIENT_ID", "DISCORD_OAUTH_REDIRECT_URI"].sort());
    expect((body as Record<string, string>).DISCORD_OAUTH_CLIENT_ID).toBe("123456789012345678");
  });

  it("also saves the secret via save-oauth-secret when one was entered", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      if (path === "/api/setup/save-oauth-secret") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));

    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "shh-its-a-secret" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/save-oauth-secret", { secret: "shh-its-a-secret", overwrite: false }));
  });

  it("does not call save-oauth-secret at all when no secret was entered", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/write-oauth-config", expect.anything()));
    expect(mockPost).not.toHaveBeenCalledWith("/api/setup/save-oauth-secret", expect.anything());
  });
});
