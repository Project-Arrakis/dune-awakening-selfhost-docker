import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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

function stubConfigured(serverConfig: Record<string, string> = {}) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/settings") return Promise.resolve({
      serverConfig: { DISCORD_OAUTH_CLIENT_ID: "existing-client-id", DISCORD_OAUTH_REDIRECT_URI: "https://console.example.org/api/auth/discord/callback", ...serverConfig },
      config: { discordOAuthAppConfigured: true },
    } as never);
    if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
    return Promise.reject(new Error(`unexpected api call: ${path}`));
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

// Live-testing finding: "entered both values, clicked save and the secret
// input went away and nothing else [happened]". Root cause (confirmed against
// real server code, not guessed): writeOAuthConfig/saveOAuthClientSecret only
// write .env / the secret file -- config.discordOAuthAppConfigured is computed
// once from process.env at loadConfig() (server.js:81) and is never hot-reloaded,
// so a successful save is real but invisible until the console restarts. This
// exact "wrote config the running process hasn't loaded" problem already has a
// solved pattern in this same component for the later finalize step (the "done"
// step's restartNow() + poll-until-config-flips) -- the connect step's save
// never wired into it. publicConfig() already exposes discordOAuthAppConfigured
// (config.js:527), so /api/auth/state carries exactly the field needed to poll;
// this is a frontend-only fix.
describe("DiscordSetupWizard: a restart is required after saving (the process only reads .env at boot)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });
  afterEach(() => { vi.useRealTimers(); });

  function stubLocationReplace() {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, protocol: "https:", origin: "https://console.example.org", search: "", replace },
      writable: true,
    });
    return replace;
  }

  it("shows a 'restart required' prompt instead of silently doing nothing once the save succeeds", async () => {
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

    expect(await screen.findByText("Restart the console now")).toBeTruthy();
    // The stale, now-emptied form must not still be the only thing on screen --
    // that is exactly what read as "went away and nothing else".
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
  });

  it("clicking 'Restart the console now' restarts and polls for discordOAuthAppConfigured -- not discordOAuthConfigured, which also needs a home guild not set yet at this step -- before reloading", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      if (path === "/api/setup/discord-restart") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    const replace = stubLocationReplace();

    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));
    const restartButton = await screen.findByText("Restart the console now");

    // Fake timers only go on now -- findBy above relies on real-timer polling,
    // same precedent as features/players/PlayerSummary.test.tsx's 30s-refresh test.
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      pollCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ config: { discordOAuthAppConfigured: pollCount > 1, discordOAuthConfigured: false } }) });
    }));
    vi.useFakeTimers();

    fireEvent.click(restartButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(mockPost).toHaveBeenCalledWith("/api/setup/discord-restart", {});
    expect(replace).toHaveBeenCalledWith("/");
  });
});

// #643 (embed the guided wizard into Settings, post-login). Real Eight Hats
// Layer 1 findings this suite regression-pins directly (design doc
// docs/design/discord-settings-embed-l1-design-2026-08-30.md):
//   - Architect/UI/UX CRITICAL: the OAuth round-trip's return must be
//     distinguishable (via a sessionStorage marker) so App.tsx can route
//     back into Settings instead of the pre-login standalone takeover, and
//     skip that takeover's forced logout, for the embedded case only.
//   - QA HIGH: the `embedded` wrapper swap needs a structural test
//     (container.querySelector), since text-based queries can't detect it.
//   - GRC HIGH: role/MFA fields must pre-fill from already-saved config.
//   - Cloud Security HIGH: a "Change application credentials" affordance
//     must exist once configured, or there is no UI path left to rotate
//     the Client Secret.
//   - UI/UX HIGH: "done" step copy must not claim a sign-in page appears,
//     or offer "Back to sign in", once already logged in.
describe("DiscordSetupWizard: embedded mode (#643)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); window.sessionStorage.clear(); });
  afterEach(() => { window.sessionStorage.clear(); });

  it("embedded renders without the standalone login-screen wrapper", async () => {
    stubNotYetConfigured();
    const { container } = render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("I already have a Discord application");
    expect(container.querySelector("main.login-screen")).toBeNull();
    expect(container.querySelector(".discord-setup-embedded")).not.toBeNull();
  });

  it("non-embedded (default) keeps the standalone login-screen wrapper unchanged", async () => {
    stubNotYetConfigured();
    const { container } = render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("I already have a Discord application");
    expect(container.querySelector("main.login-screen")).not.toBeNull();
    expect(container.querySelector(".discord-setup-embedded")).toBeNull();
  });

  it("sets the discord-setup-return marker before navigating to Discord, only when embedded", async () => {
    stubConfigured();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("Continue with Discord"));
    expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBe("settings");
  });

  it("does not set the marker when not embedded -- the pre-login flow is unchanged", async () => {
    stubConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("Continue with Discord"));
    expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBeNull();
  });

  it("offers 'Change application credentials' once configured, from the authorize step, pre-filling the existing Client ID", async () => {
    stubConfigured();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("Continue with Discord");
    fireEvent.click(screen.getByText("Change application credentials"));
    expect(await screen.findByLabelText(/client id/i)).toHaveValue("existing-client-id");
  });

  it("pre-fills role mappings and the MFA toggle from already-saved config when reopened (GRC finding)", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({
        serverConfig: {
          DISCORD_OAUTH_CLIENT_ID: "existing-client-id",
          DISCORD_OAUTH_REDIRECT_URI: "https://console.example.org/api/auth/discord/callback",
          DISCORD_CONSOLE_ADMIN_ROLE_IDS: "111111111111111111",
          DISCORD_CONSOLE_MODERATOR_ROLE_IDS: "222222222222222222",
          DISCORD_CONSOLE_PLAYER_ROLE_IDS: "333333333333333333",
          DISCORD_OAUTH_REQUIRE_MFA_TIERS: "owner,admin",
        },
        config: { discordOAuthAppConfigured: true },
      } as never);
      if (path === "/api/setup/discord-identity") return Promise.resolve({
        user: { id: "u1", username: "operator", mfaEnabled: true },
        guilds: [{ id: "999999999999999999", name: "My Server", owner: true }],
      } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    await screen.findByLabelText(/admin role/i);
    // The map step renders as soon as `identity` resolves; the role/MFA
    // pre-fill is a separate effect that can settle a tick later -- wait for
    // the value, don't assume it's already there the instant the field exists.
    await waitFor(() => expect(screen.getByLabelText(/admin role/i)).toHaveValue("111111111111111111"));
    expect(screen.getByLabelText(/moderator role/i)).toHaveValue("222222222222222222");
    expect(screen.getByLabelText(/player role/i)).toHaveValue("333333333333333333");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("done step: embedded copy says 'Back to Settings', not 'Back to sign in', omits the sign-in-page claim, and warns the restart ends the session", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: { DISCORD_OAUTH_CLIENT_ID: "id", DISCORD_OAUTH_REDIRECT_URI: "uri" }, config: { discordOAuthAppConfigured: true } } as never);
      if (path === "/api/setup/discord-identity") return Promise.resolve({ user: { id: "u1", username: "operator", mfaEnabled: true }, guilds: [{ id: "999999999999999999", name: "My Server", owner: true }] } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/discord-finalize") return Promise.resolve({ ok: true, guild: { name: "My Server" }, owner: { username: "operator" } } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "111111111111111111" } });
    fireEvent.click(screen.getByText("Turn on Discord sign-in"));
    expect(await screen.findByText("Back to Settings")).toBeTruthy();
    expect(screen.queryByText(/sign-in page shows/i)).toBeNull();
    expect(screen.getByText(/end your current session/i)).toBeTruthy();
  });

  it("map step: mapping the same role ID to two access levels shows an inline conflict message and disables 'Turn on Discord sign-in' before any round-trip (parity with the removed manual form)", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: { DISCORD_OAUTH_CLIENT_ID: "id", DISCORD_OAUTH_REDIRECT_URI: "uri" }, config: { discordOAuthAppConfigured: true } } as never);
      if (path === "/api/setup/discord-identity") return Promise.resolve({ user: { id: "u1", username: "operator", mfaEnabled: true }, guilds: [{ id: "999999999999999999", name: "My Server", owner: true }] } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "111111111111111111" } });
    fireEvent.change(screen.getByLabelText(/moderator role/i), { target: { value: "111111111111111111" } });

    expect(await screen.findByText(/mapped to admin and moderator/i)).toBeTruthy();
    expect(screen.getByText("Turn on Discord sign-in")).toBeDisabled();
    expect(mockPost).not.toHaveBeenCalledWith("/api/setup/discord-finalize", expect.anything());
  });

  it("done step: non-embedded (pre-login) copy is unchanged -- 'Back to sign in' and the sign-in-page claim still appear", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: { DISCORD_OAUTH_CLIENT_ID: "id", DISCORD_OAUTH_REDIRECT_URI: "uri" }, config: { discordOAuthAppConfigured: true } } as never);
      if (path === "/api/setup/discord-identity") return Promise.resolve({ user: { id: "u1", username: "operator", mfaEnabled: true }, guilds: [{ id: "999999999999999999", name: "My Server", owner: true }] } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/discord-finalize") return Promise.resolve({ ok: true, guild: { name: "My Server" }, owner: { username: "operator" } } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "111111111111111111" } });
    fireEvent.click(screen.getByText("Turn on Discord sign-in"));
    expect(await screen.findByText("Back to sign in")).toBeTruthy();
    expect(screen.getByText(/sign-in page shows/i)).toBeTruthy();
    expect(screen.queryByText(/end your current session/i)).toBeNull();
  });
});
