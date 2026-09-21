import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const captureChoamPosition = vi.fn();
const online = vi.fn();

vi.mock("../../api/maps", () => ({ mapsApi: { captureChoamPosition: (...args: unknown[]) => captureChoamPosition(...args) } }));
vi.mock("../../api/players", () => ({ playersApi: { online: () => online() } }));

import { ChoamPositionEditor, ChoamTerminalsEditor } from "./MapsPanel";

const TRANSFORM = { x: 192623.2, y: 2451.06, z: 13551.53, qx: 0, qy: 0, qz: 0.5788, qw: -0.8155 };
const CENTER = { key: "the-anvil", name: "The Anvil", transform: TRANSFORM, defaultTransform: TRANSFORM, custom: false };
const LIMITS = { radiusUu: 5000, verticalUu: 2000 };

function renderEditor(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(<ChoamPositionEditor center={CENTER} limits={LIMITS} saving={false} onSave={onSave} onReset={vi.fn()} onClose={vi.fn()} {...overrides} />);
  return { onSave };
}

beforeEach(() => {
  captureChoamPosition.mockReset();
  online.mockReset();
  online.mockResolvedValue({ rows: [{ actor_id: 6, character_name: "DarkShark" }, { actor_id: 222, character_name: "Other" }] });
});

describe("CHOAM position editor", () => {
  it("keeps the Set Position and Close toggle at the same stable width", async () => {
    render(<ChoamTerminalsEditor
      overview={{ supported: true, tradeCenters: [CENTER], sietches: [], placements: [], positionLimits: LIMITS }}
      savingKey=""
      result={null}
      onInstall={vi.fn()}
      onRemove={vi.fn()}
      onSavePosition={vi.fn()}
      onResetPosition={vi.fn()}
    />);
    const setPosition = screen.getByRole("button", { name: "Set Position" });
    expect(setPosition).toHaveClass("choam-position-toggle");
    fireEvent.click(setPosition);
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("choam-position-toggle");
  });

  it("seeds from the post's current position so no character is needed", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("X")).toHaveValue(192623.2));
    expect(screen.getByLabelText("Z")).toHaveValue(13551.53);
    expect(captureChoamPosition).not.toHaveBeenCalled();
  });

  it("shows online character names in the enabled character picker", async () => {
    renderEditor();
    const select = await screen.findByLabelText("Character");
    await waitFor(() => expect(select).toBeEnabled());
    expect(screen.getByRole("option", { name: "DarkShark" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Other" })).toBeTruthy();
  });

  it("leaves the character picker empty and disabled when nobody is online", async () => {
    online.mockResolvedValue({ rows: [] });
    renderEditor();
    const select = await screen.findByLabelText("Character");
    await screen.findByText("No characters are online right now.");
    expect(select).toBeDisabled();
    expect(select.textContent).toBe("");
    expect(screen.queryByText("Select an online character")).toBeNull();
  });

  it("uses title capitalization for the position action buttons", async () => {
    renderEditor({ center: { ...CENTER, custom: true } });
    expect(await screen.findByRole("button", { name: "Save Position" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset to Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Character Position" })).toBeTruthy();
  });

  // Number("") is 0, so a cleared field used to pass validation and silently
  // save that axis as zero -- the same footgun the server guards against.
  //
  // Facing is the field that isolates this: a cleared X or Y also drags the
  // position to the world origin, which the bound check rejects anyway, so
  // such a test passes even with the guard removed. Heading zero is in bounds.
  it("blocks saving when the heading is cleared rather than saving it as zero", async () => {
    renderEditor();
    const heading = await screen.findByLabelText(/facing in degrees/i);
    fireEvent.change(heading, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /save position/i })).toBeDisabled();
  });

  it("blocks saving when the heading is not a number", async () => {
    renderEditor();
    const heading = await screen.findByLabelText(/facing in degrees/i);
    fireEvent.change(heading, { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: /save position/i })).toBeDisabled();
  });

  it("saves the edited values, converting the heading back to a stored yaw", async () => {
    const { onSave } = renderEditor();
    await screen.findByLabelText("X");
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "192700" } });
    fireEvent.change(screen.getByLabelText(/facing in degrees/i), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /save position/i }));
    expect(onSave).toHaveBeenCalledWith(CENTER, expect.objectContaining({ x: 192700, yaw: 0 }), expect.anything());
  });

  // A capture belongs to one character; letting the picker move mid-poll let a
  // resolving capture overwrite the form with the previous character's position.
  it("locks the character picker while a capture is running", async () => {
    captureChoamPosition.mockReturnValue(new Promise(() => {}));
    renderEditor();
    const select = await screen.findByLabelText("Character");
    fireEvent.change(select, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /use character position/i }));
    await waitFor(() => expect(select).toBeDisabled());
  });

  it("ignores a capture response that arrives after waiting is stopped", async () => {
    let resolveCapture: (value: unknown) => void = () => {};
    captureChoamPosition.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    renderEditor();
    const select = await screen.findByLabelText("Character");
    fireEvent.change(select, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /use character position/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop waiting/i }));

    await act(async () => {
      resolveCapture({
        supported: true,
        ready: true,
        source: { serial: "2", x: 192900, y: 2451.06, z: 13551.53, yaw: 0 },
        placement: { x: 192900, y: 2451.06, z: 13551.53, yaw: 0, distanceUu: 277, verticalUu: 0 }
      });
      await Promise.resolve();
    });

    expect(screen.getByLabelText("X")).toHaveValue(TRANSFORM.x);
  });

  it("states that an installed terminal only moves after a restart", async () => {
    renderEditor();
    await screen.findByLabelText("X");
    expect(screen.getByText(/only moves in-game after a map restart/i)).toBeTruthy();
  });

  it("refuses a position outside the trade post bound", async () => {
    renderEditor();
    const x = await screen.findByLabelText("X");
    fireEvent.change(x, { target: { value: String(TRANSFORM.x + LIMITS.radiusUu + 1) } });
    expect(screen.getByRole("button", { name: /save position/i })).toBeDisabled();
    expect(screen.getByText(/outside the allowed range/i)).toBeTruthy();
  });
});
