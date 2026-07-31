import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";

describe("memory controls help", () => {
  it("exposes the tooltip to pointer, keyboard, and assistive technology users", () => {
    render(<InfoTooltip id="swap-help" label="About Memory Swap">Disk-backed emergency memory.</InfoTooltip>);
    const button = screen.getByRole("button", { name: "About Memory Swap" });
    const tooltip = screen.getByRole("tooltip");
    expect(button).toHaveAttribute("aria-describedby", "swap-help");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(tooltip).toHaveTextContent("Disk-backed emergency memory.");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps only one memory tooltip open", () => {
    render(<>
      <InfoTooltip id="balancer-help" label="About Memory Balancer">Balancer help.</InfoTooltip>
      <InfoTooltip id="swap-help" label="About Memory Swap">Swap help.</InfoTooltip>
    </>);
    const balancer = screen.getByRole("button", { name: "About Memory Balancer" });
    const swap = screen.getByRole("button", { name: "About Memory Swap" });
    fireEvent.click(balancer);
    expect(balancer).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseEnter(swap.closest(".memory-info-tooltip")!);
    expect(balancer).toHaveAttribute("aria-expanded", "false");
    expect(swap).toHaveAttribute("aria-expanded", "true");
  });
});
