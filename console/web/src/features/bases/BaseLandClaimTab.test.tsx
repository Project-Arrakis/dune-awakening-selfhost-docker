import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseLandClaim } from "../../api/bases";
import { BaseLandClaimTab } from "./BaseLandClaimTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    landClaim: vi.fn(),
    updateLandClaim: vi.fn()
  }
}));

const claim: BaseLandClaim = {
  supported: true,
  baseId: 31573,
  totemId: "459",
  map: "HaggaBasin",
  partitionId: 1,
  yaw: 90,
  verticalLevel: 1,
  maxVerticalLevel: 5,
  segments: [{ x: 1, y: 0, rowCount: 1 }],
  segmentCount: 1,
  duplicateCoordinates: 0
};

function renderEditor(overrides: Partial<Parameters<typeof BaseLandClaimTab>[0]> = {}) {
  const props = {
    baseId: "31573",
    baseName: "Kovalt Main",
    confirmAction: vi.fn().mockResolvedValue(true),
    onError: vi.fn(),
    ...overrides
  };
  render(<BaseLandClaimTab {...props} />);
  return props;
}

beforeEach(() => vi.clearAllMocks());

describe("BaseLandClaimTab", () => {
  it("shows the resolved totem, orientation, current grid, and restart requirement", async () => {
    vi.mocked(basesApi.landClaim).mockResolvedValue(claim);
    renderEditor();
    expect(await screen.findByText("459")).toBeInTheDocument();
    expect(screen.getByText("90°")).toBeInTheDocument();
    expect(screen.getByText(/Restart HaggaBasin after saving/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply Changes" })).toBeDisabled();
    expect(screen.getByLabelText("Sub-Fief origin")).toBeInTheDocument();
    expect(screen.getByLabelText("Existing segment 1, 0")).toBeInTheDocument();
  });

  it("adds only adjacent cells and saves them with a capped vertical level", async () => {
    vi.mocked(basesApi.landClaim).mockResolvedValue(claim);
    vi.mocked(basesApi.updateLandClaim).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: {
        ...claim,
        ok: true,
        added: 1,
        verticalChanged: true,
        verticalLevel: 5,
        segmentCount: 2,
        segments: [...claim.segments, { x: 2, y: 0, rowCount: 1 }]
      }
    });
    const props = renderEditor();
    const cell = await screen.findByLabelText("Add segment 2, 0");
    fireEvent.click(cell);
    expect(screen.getByLabelText("Remove selected segment 2, 0")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Vertical Level"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Changes" }));
    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      "Apply these land claim changes to Kovalt Main?",
      expect.objectContaining({ title: "Edit Land Claim" })
    ));
    await waitFor(() => expect(basesApi.updateLandClaim).toHaveBeenCalledWith("31573", [{ x: 2, y: 0 }], 5));
    expect(await screen.findByText(/A safety backup was created/)).toBeInTheDocument();
  });

  it("removing a selected bridge also removes selected cells that depend on it", async () => {
    vi.mocked(basesApi.landClaim).mockResolvedValue(claim);
    renderEditor();
    fireEvent.click(await screen.findByLabelText("Add segment 2, 0"));
    fireEvent.click(screen.getByLabelText("Add segment 3, 0"));
    expect(screen.getByLabelText("Remove selected segment 3, 0")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove selected segment 2, 0"));
    expect(screen.queryByLabelText("Remove selected segment 3, 0")).not.toBeInTheDocument();
  });
});
