import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { guildsApi } from "../../api/guilds";
import { playersApi } from "../../api/players";
import { GuildsPanel } from "./GuildsPanel";

vi.mock("../../api/guilds", () => ({
  guildsApi: {
    list: vi.fn(),
    members: vi.fn(),
    promote: vi.fn(),
    demote: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    disband: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    list: vi.fn()
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof GuildsPanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  render(<GuildsPanel {...props} />);
  return props;
}

const guildRow = { guild_id: "1", guild_name: "Spicy Girls", guild_faction: "", member_count: 3, guild_description: "" };

// Kynes = Leader, Vash = Officer, Chani = Member -- one row per rank tier.
const memberRows = [
  { player_id: "10", character_name: "Kynes", role_id: "100" },
  { player_id: "20", character_name: "Vash", role_id: "50" },
  { player_id: "30", character_name: "Chani", role_id: "1" }
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(guildsApi.list).mockResolvedValue({ rows: [guildRow], totalCount: 1, totalGuilds: 1, capabilities: { guilds: true } });
  vi.mocked(guildsApi.members).mockResolvedValue({ rows: memberRows, capabilities: { guildMembers: true } });
});

async function openGuildMembers() {
  await screen.findByText("Spicy Girls");
  fireEvent.click(screen.getByText("Spicy Girls"));
  await screen.findByText("Kynes");
}

describe("GuildsPanel member actions", () => {
  it("shows all three actions on every row, greying out whichever don't apply", async () => {
    renderPanel();
    await openGuildMembers();

    // Kynes (Leader): all three actions render but are disabled -- nothing to promote to, and
    // both Demote and Remove require someone else to be promoted first.
    expect(screen.getByRole("button", { name: "Cannot promote the leader further" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cannot demote the leader" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cannot remove the leader" })).toBeDisabled();

    // Vash (Officer): can promote to Leader, demote to Member, or be removed.
    expect(screen.getByRole("button", { name: "Promote Vash to Leader" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Demote Vash to Member" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Vash from guild" })).toBeEnabled();

    // Chani (Member): can promote to Officer or be removed, but Demote is disabled -- nothing lower.
    expect(screen.getByRole("button", { name: "Promote Chani to Officer" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cannot demote Chani further" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Chani from guild" })).toBeEnabled();
  });

  it("confirms, promotes an officer to leader, and refreshes the member list", async () => {
    vi.mocked(guildsApi.promote).mockResolvedValue({ supported: true, result: { ok: true } });
    const props = renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Promote Vash to Leader" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Promote Vash to Leader of Spicy Girls? Kynes will be demoted to Officer.",
      { title: "Promote to Leader", confirmLabel: "Promote" }
    ));
    await waitFor(() => expect(guildsApi.promote).toHaveBeenCalledWith("1", "20"));
    expect(vi.mocked(guildsApi.members).mock.calls.length).toBeGreaterThan(1);
  });

  it("confirms, promotes a member to officer, and refreshes the member list", async () => {
    vi.mocked(guildsApi.promote).mockResolvedValue({ supported: true, result: { ok: true } });
    const props = renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Promote Chani to Officer" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Promote Chani to Officer of Spicy Girls?",
      { title: "Promote to Officer", confirmLabel: "Promote" }
    ));
    await waitFor(() => expect(guildsApi.promote).toHaveBeenCalledWith("1", "30"));
    expect(vi.mocked(guildsApi.members).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not promote when the confirm dialog is declined", async () => {
    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Promote Vash to Leader" }));

    await waitFor(() => expect(guildsApi.promote).not.toHaveBeenCalled());
  });

  it("reports a no-op instead of a silent success when the target was already the leader", async () => {
    vi.mocked(guildsApi.promote).mockResolvedValue({ supported: true, result: { ok: true, alreadyLeader: true } });
    const props = renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Promote Vash to Leader" }));

    await waitFor(() => expect(guildsApi.promote).toHaveBeenCalledWith("1", "20"));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("Vash was already the guild leader -- no changes were made."));
  });

  it("shows a loading state on the member table while a post-promote refresh is in flight", async () => {
    vi.mocked(guildsApi.promote).mockResolvedValue({ supported: true, result: { ok: true } });
    renderPanel();
    await openGuildMembers();

    // Only the refetch triggered by the promote itself (not the initial open) needs to hang,
    // so it can be observed mid-flight.
    let resolveMembers: (value: { rows: typeof memberRows; capabilities: Record<string, unknown> }) => void = () => {};
    vi.mocked(guildsApi.members).mockReturnValue(new Promise((resolve) => { resolveMembers = resolve; }));

    fireEvent.click(screen.getByRole("button", { name: "Promote Vash to Leader" }));

    expect(await screen.findByText("(refreshing...)")).toBeInTheDocument();

    resolveMembers({ rows: memberRows, capabilities: { guildMembers: true } });
    await waitFor(() => expect(screen.queryByText("(refreshing...)")).not.toBeInTheDocument());
  });

  it("confirms, demotes an officer to member, and refreshes the member list", async () => {
    vi.mocked(guildsApi.demote).mockResolvedValue({ supported: true, result: { ok: true } });
    const props = renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Demote Vash to Member" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Demote Vash to Member of Spicy Girls?",
      { title: "Demote to Member", confirmLabel: "Demote" }
    ));
    await waitFor(() => expect(guildsApi.demote).toHaveBeenCalledWith("1", "20"));
    expect(vi.mocked(guildsApi.members).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not demote when the confirm dialog is declined", async () => {
    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Demote Vash to Member" }));

    await waitFor(() => expect(guildsApi.demote).not.toHaveBeenCalled());
  });

  it("confirms, removes a non-leader member, and refreshes the member list", async () => {
    vi.mocked(guildsApi.removeMember).mockResolvedValue({ supported: true, result: { ok: true } });
    const props = renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Remove Vash from guild" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Remove Vash from Spicy Girls?",
      { title: "Remove Member", confirmLabel: "Remove" }
    ));
    await waitFor(() => expect(guildsApi.removeMember).toHaveBeenCalledWith("1", "20"));
    expect(vi.mocked(guildsApi.members).mock.calls.length).toBeGreaterThan(1);
  });

  it("only searches players after Search is clicked, not on keystroke", async () => {
    vi.mocked(playersApi.list).mockResolvedValue({ rows: [{ actor_id: "40", character_name: "Duncan Idaho" }], totalCount: 1, totalPlayers: 1, capabilities: {} });
    renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Add Member" }));
    const modal = within(await screen.findByRole("dialog"));
    fireEvent.change(modal.getByPlaceholderText("Search character name"), { target: { value: "Dun" } });
    expect(playersApi.list).not.toHaveBeenCalled();

    fireEvent.click(modal.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(playersApi.list).toHaveBeenCalledWith({ q: "Dun", pageSize: 8, status: "all" }));
    expect(await modal.findByRole("button", { name: "Duncan Idaho" })).toBeInTheDocument();
  });

  it("adds the selected player to the guild and refreshes the member list", async () => {
    vi.mocked(playersApi.list).mockResolvedValue({ rows: [{ actor_id: "40", character_name: "Duncan Idaho" }], totalCount: 1, totalPlayers: 1, capabilities: {} });
    vi.mocked(guildsApi.addMember).mockResolvedValue({ supported: true, result: { ok: true } });
    renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Add Member" }));
    const modal = within(await screen.findByRole("dialog"));
    fireEvent.change(modal.getByPlaceholderText("Search character name"), { target: { value: "Dun" } });
    fireEvent.click(modal.getByRole("button", { name: "Search" }));
    fireEvent.click(await modal.findByRole("button", { name: "Duncan Idaho" }));

    fireEvent.click(modal.getByRole("button", { name: "Add to Guild" }));

    await waitFor(() => expect(guildsApi.addMember).toHaveBeenCalledWith("1", "40", 1));
    expect(vi.mocked(guildsApi.members).mock.calls.length).toBeGreaterThan(1);
  });
});

describe("GuildsPanel disband guild", () => {
  it("renders a Disband icon per top-level guild row", async () => {
    renderPanel();
    await screen.findByText("Spicy Girls");

    expect(screen.getByRole("button", { name: "Disband Spicy Girls" })).toBeInTheDocument();
  });

  it("confirms with the member count, disbands, and refreshes the guild list", async () => {
    vi.mocked(guildsApi.disband).mockResolvedValue({ supported: true, result: { ok: true } });
    const props = renderPanel();
    await screen.findByText("Spicy Girls");

    fireEvent.click(screen.getByRole("button", { name: "Disband Spicy Girls" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Disband Spicy Girls? This permanently deletes the guild and removes all its members.",
      { title: "Disband Guild", confirmLabel: "Disband", danger: true, details: [{ label: "Members", value: "3", tone: "danger" }] }
    ));
    await waitFor(() => expect(guildsApi.disband).toHaveBeenCalledWith("1", "DISBAND GUILD"));
    expect(vi.mocked(guildsApi.list).mock.calls.length).toBeGreaterThan(1);
  });

  it("closes the member panel when the disbanded guild was open", async () => {
    vi.mocked(guildsApi.disband).mockResolvedValue({ supported: true, result: { ok: true } });
    renderPanel();
    await openGuildMembers();

    fireEvent.click(screen.getByRole("button", { name: "Disband Spicy Girls" }));

    await waitFor(() => expect(guildsApi.disband).toHaveBeenCalledWith("1", "DISBAND GUILD"));
    expect(screen.queryByText("Members of Spicy Girls")).not.toBeInTheDocument();
  });

  it("does not disband when the confirm dialog is declined", async () => {
    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    await screen.findByText("Spicy Girls");

    fireEvent.click(screen.getByRole("button", { name: "Disband Spicy Girls" }));

    await waitFor(() => expect(guildsApi.disband).not.toHaveBeenCalled());
  });
});
