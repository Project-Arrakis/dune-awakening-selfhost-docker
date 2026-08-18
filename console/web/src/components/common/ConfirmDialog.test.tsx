import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, type ConfirmDialogOutcome, type ConfirmDialogRequest } from "./ConfirmDialog";

function baseRequest(overrides: Partial<ConfirmDialogRequest> = {}): ConfirmDialogRequest {
  return {
    title: "Confirm restart",
    message: "Are you sure?",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    danger: false,
    resolve: vi.fn(),
    ...overrides
  };
}

function renderDialog(overrides: Partial<ConfirmDialogRequest> = {}) {
  const onClose = vi.fn<(outcome: ConfirmDialogOutcome) => void>();
  const request = baseRequest(overrides);
  render(<ConfirmDialog request={request} onClose={onClose} />);
  return { request, onClose };
}

describe("ConfirmDialog", () => {
  it("renders only Cancel and Confirm when no tertiary/quaternary label is set", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart Immediately" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart later" })).toBeNull();
  });

  it("renders a 3rd tertiary button and resolves it distinctly from confirm/cancel", () => {
    const { onClose } = renderDialog({ tertiaryLabel: "Restart Immediately" });
    fireEvent.click(screen.getByRole("button", { name: "Restart Immediately" }));
    expect(onClose).toHaveBeenCalledWith("tertiary");
  });

  it("groups Cancel + quaternary apart from tertiary + confirm when a 4th choice is offered", () => {
    const { onClose } = renderDialog({ tertiaryLabel: "Restart Immediately", quaternaryLabel: "Restart later" });
    // All four render.
    for (const label of ["Cancel", "Restart later", "Restart Immediately", "Confirm"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // The grouped layout wrapper is present (divider between clusters).
    expect(document.querySelector(".confirm-modal-actions-grouped")).toBeTruthy();
    expect(document.querySelector(".confirm-modal-action-divider")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restart later" }));
    expect(onClose).toHaveBeenCalledWith("quaternary");
  });

  it("widens the modal for a 4-button dialog the same way it does for a 3-button one", () => {
    renderDialog({ tertiaryLabel: "Restart Immediately", quaternaryLabel: "Restart later" });
    expect(document.querySelector(".confirm-modal.confirm-modal-wide")).toBeTruthy();
  });
});
