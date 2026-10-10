// dune-awakening-selfhost-docker#853/mentat-link#183: dedicated component
// tests for the hosted-bot role-picker widget (wizard step 2's single
// role-to-tier assignment table, design doc §4.6 option 2) -- separate
// file from DiscordBotSection.test.tsx's own broad wizard-flow coverage,
// focused specifically on the picker's own render states and save paths
// per the issue's own explicit test-coverage requirement (state/cookie
// mismatch is covered server-side by hostedBotRolesRoutes.integration.test.js;
// this file covers the frontend: fetch states, tier assignment, 409
// conflict rendering, and cacheStale/error fallback to the manual fields).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { api, post, ApiError } from "../../api/client";
import { DiscordBotSection } from "./DiscordBotSection";

// Preserves the real ApiError export (via importOriginal) while mocking
// api()/post() -- discordHostedBotApi.ts's saveRoles() does
// `err instanceof ApiError` in its catch block; a mock that dropped ApiError
// entirely would make that check throw (`instanceof` on `undefined`)
// instead of correctly recovering the 409 conflict body, the exact case
// this file's own conflict test exists to exercise.
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: vi.fn(), post: vi.fn() };
});

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

function seedOwnedGuilds(guilds: Array<{ id: string; name: string; owner: true }>) {
  window.sessionStorage.setItem("hostedBotOwnedGuilds", JSON.stringify(guilds));
}

const ROLES = [
  { id: "1", name: "Zeta", color: "#111111", position: 1 },
  { id: "2", name: "Alpha", color: "#222222", position: 2 }
];

// Reaches wizard step 2 in the hosted case -- pick "Hosted bot", register a
// guild, acknowledge the invite checkbox, click Continue. Mirrors the exact
// sequence DiscordBotSection.test.tsx's own
// "Continue on step 1 stays disabled..." test already proved works.
async function reachWizardStep2Hosted() {
  seedOwnedGuilds([{ id: "111111111111111111", name: "My Test Guild", owner: true }]);
  render(<DiscordBotSection />);
  await screen.findByText(/Which are you using/i);
  fireEvent.click(screen.getByRole("button", { name: /^Hosted bot$/i }));
  await screen.findByText(/Which server is this for/i);
  fireEvent.click(screen.getByText("My Test Guild"));
  fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
  await screen.findByText(/Connected to hosted bot for My Test Guild/i);
  fireEvent.click(screen.getByRole("checkbox", { name: /invited the bot/i }));
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
  await screen.findByText(/Configure roles/i);
}

describe("DiscordBotSection role-picker widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("renders one row per real Discord role, sorted by position descending", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null, roles: ROLES, cacheStale: false } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    await reachWizardStep2Hosted();

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1); // drop header row
    expect(rows).toHaveLength(2);
    // Alpha (position 2) sorts above Zeta (position 1).
    expect(within(rows[0]).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Zeta")).toBeInTheDocument();
  });

  it("assigning a role to a tier is mutually exclusive -- picking Admin for a role clears its Player selection", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null, roles: ROLES, cacheStale: false } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    await reachWizardStep2Hosted();
    await screen.findByRole("table");

    const playerRadio = screen.getByRole("radio", { name: "Alpha: Player" });
    const adminRadio = screen.getByRole("radio", { name: "Alpha: Admin" });
    fireEvent.click(playerRadio);
    expect(playerRadio).toBeChecked();
    fireEvent.click(adminRadio);
    expect(adminRadio).toBeChecked();
    expect(playerRadio).not.toBeChecked();
  });

  it("seeds the picker's assignments from already-persisted role IDs (re-entering step 2 doesn't reset a saved configuration)", async () => {
    mockApi.mockResolvedValue({
      enabled: false,
      roleIds: { player: ["2"], moderator: [], admin: [] },
      tokenConfigured: false,
      deploymentChoice: null,
      roles: ROLES,
      cacheStale: false
    } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    await reachWizardStep2Hosted();
    await screen.findByRole("table");

    expect(screen.getByRole("radio", { name: "Alpha: Player" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Zeta: None" })).toBeChecked();
  });

  it("saves the grouped tier arrays and shows no conflict message on a clean 200", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null, roles: ROLES, cacheStale: false } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc", applied: true } as never);
    await reachWizardStep2Hosted();
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("radio", { name: "Alpha: Player" }));
    fireEvent.click(screen.getByRole("radio", { name: "Zeta: Moderator" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^Save Roles$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/integrations/discord/hosted-bot/roles",
      { playerRoleIds: ["2"], moderatorRoleIds: ["1"], adminRoleIds: [] }
    ));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a 409 tier-conflict as an inline error, without advancing past the wizard", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null, roles: ROLES, cacheStale: false } as never);
    mockPost.mockImplementation((path: unknown) => {
      if (path === "/api/integrations/discord/hosted-bot/roles") {
        return Promise.reject(new ApiError("Conflict", 409, { conflict: { roleId: "1", currentTier: "player", requestedTier: "moderator" } }));
      }
      return Promise.resolve({ ok: true, token: "abc" } as never);
    });
    await reachWizardStep2Hosted();
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("radio", { name: "Zeta: Moderator" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Save Roles$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/player/i);
    expect(alert).toHaveTextContent(/moderator/i);
    // Sent back to step 2 (where the picker/conflict message are actually
    // visible) rather than left stranded on step 3 -- a rejected save must
    // not silently advance as if it had succeeded, and the operator needs
    // to actually see what to fix.
    expect(await screen.findByText(/Configure roles/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save Roles$/i })).toBeNull();
  });

  it("falls back to the manual comma-separated fields, with no table, when mentat reports cacheStale", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null, roles: [], cacheStale: true } as never);
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    await reachWizardStep2Hosted();

    await screen.findByText(/hasn't reconnected/i);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByLabelText(/Player role IDs/i)).toBeInTheDocument();
  });

  it("falls back to the manual fields when the roles fetch itself fails", async () => {
    mockApi.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.startsWith("/api/integrations/discord/hosted-bot/roles")) {
        return Promise.reject(new Error("Couldn't reach the hosted bot service."));
      }
      return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
    });
    mockPost.mockResolvedValue({ ok: true, token: "abc" } as never);
    await reachWizardStep2Hosted();

    await screen.findByText(/Couldn't reach the hosted bot service\. Use the manual fields below instead\./i);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByLabelText(/Player role IDs/i)).toBeInTheDocument();
  });
});
