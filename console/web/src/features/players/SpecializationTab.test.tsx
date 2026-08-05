import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpecializationTab } from "../players/SpecializationTab";
import { playersApi } from "../../api/players";

vi.mock("../../api/players", () => ({
  playersApi: {
    specs: vi.fn(),
    addSpecializationXp: vi.fn(),
    grantMaxSpecialization: vi.fn(),
    resetSpecialization: vi.fn(),
    grantAllSpecializationKeystones: vi.fn(),
    resetAllSpecializationKeystones: vi.fn()
  }
}));

const mockConfirmAction = vi.fn();
const mockOnError = vi.fn();
const mockOnSkillBaselineChange = vi.fn();
const mockOnActionLog = vi.fn();

const defaultProps = {
  dbPlayerId: "player-123",
  actionPlayerId: "action-456",
  playerName: "TestPlayer",
  isOnline: false,
  onError: mockOnError,
  confirmAction: mockConfirmAction,
  onSkillBaselineChange: mockOnSkillBaselineChange,
  onActionLog: mockOnActionLog
};

const mockSpecsResponse = {
  rows: [
    { track_type: "Trooper", xp_amount: 5000, level: 3 },
    { track_type: "Mentat", xp_amount: 12000, level: 7 },
    { track_type: "Planetologist", xp_amount: 0, level: 0 }
  ],
  skillModules: [
    { module_id: "Skills.Key.Trooper1", level: 2 }
  ],
  capabilities: {}
};

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the busy-state tests install deferred
  // implementations that would otherwise leak into every later test in the file.
  vi.resetAllMocks();
  mockConfirmAction.mockResolvedValue(true);
});

describe("SpecializationTab", () => {
  describe("rendering", () => {
    it("shows loading state when no data", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/No specialization tracks were found/i)).toBeInTheDocument();
      });
    });

    it("renders specialization tracks from API", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
        expect(screen.getByText("Mentat")).toBeInTheDocument();
        expect(screen.getByText("Planetologist")).toBeInTheDocument();
      });
    });

    it("displays XP values formatted with locale", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("5,000")).toBeInTheDocument();
        expect(screen.getByText("12,000")).toBeInTheDocument();
      });
    });

    it("displays level badges", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({
        ...mockSpecsResponse,
        rows: [
          ...mockSpecsResponse.rows.slice(0, 2),
          { track_type: "Planetologist", xp_amount: 0, level: 12.146068 }
        ]
      });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("3")).toBeInTheDocument();
        expect(screen.getByText("7")).toBeInTheDocument();
        expect(screen.getByText("12")).toBeInTheDocument();
        expect(screen.queryByText("12.146068")).not.toBeInTheDocument();
      });
    });

    it("shows error message when API fails", async () => {
      vi.mocked(playersApi.specs).mockRejectedValue(new Error("Database connection failed"));
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/Database connection failed/i)).toBeInTheDocument();
      });
    });

    it("calls onSkillBaselineChange with parsed skill modules", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(mockOnSkillBaselineChange).toHaveBeenCalledWith({
          "Skills.Key.Trooper1": 2
        });
      });
    });
  });

  describe("keystone column", () => {
    it("shows Granted when every keystone for the track is owned", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({
        rows: [{ track_type: "Combat", xp_amount: 0, level: 0, keystone_count: 41, keystone_total: 41, has_keystone: true }],
        skillModules: [],
        capabilities: {}
      });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Granted")).toBeInTheDocument();
      });
    });

    it("shows a partial count when only some keystones are owned", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({
        rows: [{ track_type: "Combat", xp_amount: 0, level: 0, keystone_count: 12, keystone_total: 41, has_keystone: false }],
        skillModules: [],
        capabilities: {}
      });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("12/41")).toBeInTheDocument();
      });
      expect(screen.queryByText("Granted")).not.toBeInTheDocument();
    });

    it("shows the empty marker when no keystones are owned", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({
        rows: [{ track_type: "Combat", xp_amount: 0, level: 0, keystone_count: 0, keystone_total: 41, has_keystone: false }],
        skillModules: [],
        capabilities: {}
      });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Combat")).toBeInTheDocument();
      });
      expect(screen.queryByText("Granted")).not.toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });

  describe("keystone action feedback", () => {
    it("reports how many keystones were reset", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetAllSpecializationKeystones).mockResolvedValue({ supported: true, result: { deletedRows: 205 } });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Reset All Keystones" }));

      await waitFor(() => {
        expect(screen.getByText(/205 keystones reset/i)).toBeInTheDocument();
      });
    });

    it("says nothing was reset when the player had no keystones", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetAllSpecializationKeystones).mockResolvedValue({ supported: true, result: { deletedRows: 0 } });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Reset All Keystones" }));

      await waitFor(() => {
        expect(screen.getByText(/no keystones to reset/i)).toBeInTheDocument();
      });
      expect(mockOnActionLog).toHaveBeenCalledWith("Reset All Keystones", "TestPlayer", "0", "Succeeded");
    });

    it("reports how many keystones were granted", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true, result: { insertedRows: 205 } });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Grant All Keystones" }));

      await waitFor(() => {
        expect(screen.getByText(/205 keystones granted/i)).toBeInTheDocument();
      });
    });

    it("says nothing changed when every keystone was already granted", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true, result: { insertedRows: 0 } });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Grant All Keystones" }));

      await waitFor(() => {
        expect(screen.getByText(/already granted/i)).toBeInTheDocument();
      });
    });
  });

  describe("offline gating", () => {
    it("disables action buttons when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      expect(addButtons.length).toBeGreaterThan(0);
      addButtons.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });

    it("disables Grant All Keystones button when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      expect(keystoneButton).toBeDisabled();
    });

    it("disables Reset All Keystones button when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: "Reset All Keystones" })).toBeDisabled();
      expect(playersApi.resetAllSpecializationKeystones).not.toHaveBeenCalled();
    });

    it("enables action buttons when player is offline", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={false} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      const grantButtons = screen.getAllByText("Grant Max");
      const resetButtons = screen.getAllByText("Reset");

      [...addButtons, ...grantButtons, ...resetButtons].forEach((btn) => {
        expect(btn).not.toBeDisabled();
      });
    });

    it("shows offline notice in header", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/offline for all specialization changes/i)).toBeInTheDocument();
      });
    });
  });

  describe("Add XP", () => {
    it("calls addSpecializationXp with correct parameters", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.addSpecializationXp).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await act(async () => {
        fireEvent.click(addButtons[0]);
      });

      await waitFor(() => {
        expect(playersApi.addSpecializationXp).toHaveBeenCalledWith("player-123", {
          trackType: "Trooper",
          amount: 1000,
          confirmation: "ADD SPECIALIZATION XP"
        });
        expect(mockOnActionLog).toHaveBeenCalledWith("Add Specialization XP", "Trooper", "1000", "Succeeded");
        expect(playersApi.specs).toHaveBeenCalledTimes(2);
      });
    });

    it("shows error when XP amount is empty", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const xpInputs = screen.getAllByRole("spinbutton");
      await fireEvent.change(xpInputs[0], { target: { value: "" } });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await fireEvent.click(addButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/Enter an XP amount first/i)).toBeInTheDocument();
      });
    });

    it("keeps the XP amount independent for each track", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const xpInputs = screen.getAllByRole("spinbutton");
      await fireEvent.change(xpInputs[0], { target: { value: "5000" } });

      expect(xpInputs[0]).toHaveValue(5000);
      expect(xpInputs[1]).toHaveValue(1000);
      expect(xpInputs[2]).toHaveValue(1000);
    });

    it("submits each track with its own XP amount", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.addSpecializationXp).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      await fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "5000" } });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await act(async () => {
        fireEvent.click(addButtons[1]);
      });

      await waitFor(() => {
        expect(playersApi.addSpecializationXp).toHaveBeenCalledWith("player-123", {
          trackType: "Mentat",
          amount: 1000,
          confirmation: "ADD SPECIALIZATION XP"
        });
      });

      await act(async () => {
        fireEvent.click(addButtons[0]);
      });

      await waitFor(() => {
        expect(playersApi.addSpecializationXp).toHaveBeenCalledWith("player-123", {
          trackType: "Trooper",
          amount: 5000,
          confirmation: "ADD SPECIALIZATION XP"
        });
      });
    });

    it("resets XP amounts when the selected player changes", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      const { rerender } = render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      await fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "5000" } });
      expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(5000);

      rerender(<SpecializationTab {...defaultProps} dbPlayerId="player-999" />);

      await waitFor(() => {
        expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(1000);
      });
    });

    it("ignores a completed action and reload from the previously selected player", async () => {
      const nextPlayerResponse = {
        rows: [{ track_type: "Swordmaster", xp_amount: 9000, level: 5 }],
        skillModules: [],
        capabilities: {}
      };
      vi.mocked(playersApi.specs).mockImplementation(async (playerId) => (
        playerId === "player-999" ? nextPlayerResponse : mockSpecsResponse
      ));
      let resolveAdd: (value: { supported: boolean }) => void = () => {};
      vi.mocked(playersApi.addSpecializationXp).mockImplementation(
        () => new Promise<{ supported: boolean }>((resolve) => { resolveAdd = resolve; })
      );

      const { rerender } = render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add XP to Trooper" }));
      await waitFor(() => {
        expect(playersApi.addSpecializationXp).toHaveBeenCalledTimes(1);
      });

      rerender(<SpecializationTab {...defaultProps} dbPlayerId="player-999" playerName="NextPlayer" />);
      await waitFor(() => {
        expect(screen.getByText("Swordmaster")).toBeInTheDocument();
      });

      await act(async () => {
        resolveAdd({ supported: true });
      });

      expect(screen.getByText("Swordmaster")).toBeInTheDocument();
      expect(screen.queryByText("Trooper")).not.toBeInTheDocument();
      expect(screen.queryByText("XP updated. Relog required.")).not.toBeInTheDocument();
      expect(playersApi.specs).toHaveBeenCalledTimes(2);
      expect(playersApi.specs).toHaveBeenLastCalledWith("player-999");
    });

    it("does not dispatch a confirmed action after the selected player changes", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      let resolveConfirmation: (value: boolean) => void = () => {};
      mockConfirmAction.mockImplementation(
        () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; })
      );

      const { rerender } = render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Grant Max for Trooper" }));
      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalledTimes(1);
      });

      rerender(<SpecializationTab {...defaultProps} dbPlayerId="player-999" playerName="NextPlayer" />);
      await act(async () => {
        resolveConfirmation(true);
      });

      expect(playersApi.grantMaxSpecialization).not.toHaveBeenCalled();
    });

    it("does not submit Add XP while the player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      fireEvent.click(addButtons[0]);
      expect(addButtons[0]).toBeDisabled();
      expect(playersApi.addSpecializationXp).not.toHaveBeenCalled();
    });
  });

  describe("busy state", () => {
    type SpecActionResult = { supported: boolean; result?: Record<string, unknown>; reason?: string };

    it("locks only the row whose action is in flight", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      let resolveAdd: (value: SpecActionResult) => void = () => {};
      vi.mocked(playersApi.addSpecializationXp).mockImplementation(
        () => new Promise<SpecActionResult>((resolve) => { resolveAdd = resolve; })
      );
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await act(async () => {
        fireEvent.click(addButtons[0]);
      });

      expect(addButtons[0]).toBeDisabled();
      expect(screen.getByRole("button", { name: "Grant Max for Trooper" })).toBeDisabled();
      expect(addButtons[1]).not.toBeDisabled();
      expect(screen.getAllByRole("spinbutton")[1]).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Grant Max for Mentat" })).not.toBeDisabled();

      await act(async () => {
        resolveAdd({ supported: true });
      });
    });

    it("locks every row while a keystone action is in flight", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      let resolveGrant: (value: SpecActionResult) => void = () => {};
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockImplementation(
        () => new Promise<SpecActionResult>((resolve) => { resolveGrant = resolve; })
      );
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Grant All Keystones" }));
      });

      await waitFor(() => {
        screen.getAllByRole("button", { name: /Add XP to/i }).forEach((btn) => {
          expect(btn).toBeDisabled();
        });
      });

      await act(async () => {
        resolveGrant({ supported: true });
      });
    });
  });

  describe("Grant Max", () => {
    it("requests confirmation before granting", async () => {
      mockConfirmAction.mockResolvedValueOnce(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantMaxSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const grantButtons = screen.getAllByText("Grant Max");
      fireEvent.click(grantButtons[0]);

      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalledWith(
          expect.stringContaining("Grant max level for Trooper"),
          expect.objectContaining({ danger: true })
        );
      });
    });

    it("calls grantMaxSpecialization when confirmed", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantMaxSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const grantButtons = screen.getAllByText("Grant Max");
      fireEvent.click(grantButtons[0]);

      await waitFor(() => {
        expect(playersApi.grantMaxSpecialization).toHaveBeenCalledWith("player-123", {
          trackType: "Trooper",
          confirmation: "GRANT MAX SPECIALIZATION"
        });
      });
    });
  });

  describe("Reset", () => {
    it("requests confirmation before resetting", async () => {
      mockConfirmAction.mockResolvedValueOnce(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const resetButtons = screen.getAllByText("Reset");
      fireEvent.click(resetButtons[0]);

      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalledWith(
          expect.stringContaining("Reset Trooper specialization"),
          expect.objectContaining({ danger: true })
        );
      });
    });

    it("does not reset when confirmation is cancelled", async () => {
      mockConfirmAction.mockResolvedValue(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const resetButtons = screen.getAllByText("Reset");
      fireEvent.click(resetButtons[0]);

      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalled();
      });
      expect(playersApi.resetSpecialization).not.toHaveBeenCalled();
    });
  });

  describe("Grant All Keystones", () => {
    it("requests confirmation before granting", async () => {
      mockConfirmAction.mockResolvedValueOnce(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Grant All Keystones")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      fireEvent.click(keystoneButton!);

      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalledWith(
          expect.stringContaining("Grant all specialization keystones"),
          expect.objectContaining({ danger: true })
        );
      });
    });

    it("calls grantAllSpecializationKeystones when confirmed", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Grant All Keystones")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      fireEvent.click(keystoneButton!);

      await waitFor(() => {
        expect(playersApi.grantAllSpecializationKeystones).toHaveBeenCalledWith(
          "player-123",
          "GRANT ALL KEYSTONES"
        );
      });
    });
  });

  describe("Reset All Keystones", () => {
    it("requests confirmation before resetting", async () => {
      mockConfirmAction.mockResolvedValueOnce(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Reset All Keystones")).toBeInTheDocument();
      });

      const resetButton = screen.getByText("Reset All Keystones").closest("button");
      fireEvent.click(resetButton!);

      await waitFor(() => {
        expect(mockConfirmAction).toHaveBeenCalledWith(
          expect.stringContaining("Reset all specialization keystones"),
          expect.objectContaining({ danger: true })
        );
      });
    });
  });

  describe("Reload", () => {
    it("calls specs API when Reload is clicked", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      vi.mocked(playersApi.specs).mockResolvedValue({
        rows: [{ track_type: "Bene Gesserit", xp_amount: 20000, level: 10 }],
        skillModules: [],
        capabilities: {}
      });

      const reloadButton = screen.getByText("Reload").closest("button");
      fireEvent.click(reloadButton!);

      await waitFor(() => {
        expect(playersApi.specs).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Bene Gesserit")).toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    it("shows empty message when no dbPlayerId", async () => {
      render(<SpecializationTab {...defaultProps} dbPlayerId="" />);
      await waitFor(() => {
        expect(screen.getByText(/No specialization tracks were found/i)).toBeInTheDocument();
      });
    });
  });
});
