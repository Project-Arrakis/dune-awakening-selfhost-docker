import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import { MemoryUsageBar } from "./MapsPanel";

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

describe("map memory usage", () => {
  const gib = 1024 ** 3;
  const row = {
    container: "dune-server-survival-1",
    map: "Survival_1",
    usedBytes: 10.5 * gib,
    limitBytes: 13 * gib,
    percent: 80.8,
    raw: "10.5GiB / 13GiB",
    swapUsedBytes: 2 * gib,
    swapLimitBytes: 2 * gib,
    swapSupported: true
  };

  it("renders measured swap as a separate green segment and combined total", () => {
    const { container } = render(<MemoryUsageBar row={row} fallback="Unavailable" swapEnabled />);
    expect(screen.getByRole("progressbar", { name: "Combined RAM and swap usage" })).toHaveAttribute("aria-valuenow", "83.3");
    expect(screen.getByText("10.5 GB / 13.0 GB RAM")).toBeInTheDocument();
    expect(screen.getByText("+ 2.0 GB Swap")).toBeInTheDocument();
    expect(screen.getByText("(2.0 GB Used)")).toBeInTheDocument();
    expect(container.querySelector(".memory-usage-swap-zone")).toHaveStyle({ width: "13.333333333333334%" });
    expect(container.querySelector(".memory-usage-swap")).toHaveStyle({ width: "100%" });
  });

  it("shows enabled but unused swap as added GB capacity instead of zero bytes", () => {
    render(<MemoryUsageBar row={{ ...row, swapUsedBytes: 0 }} fallback="Unavailable" swapEnabled />);
    expect(screen.getByText("+ 2.0 GB Swap")).toBeInTheDocument();
    expect(screen.getByText("(0.0 GB Used)")).toBeInTheDocument();
  });

  it("retains the RAM-only meter when Memory Swap is disabled", () => {
    render(<MemoryUsageBar row={row} fallback="Unavailable" swapEnabled={false} />);
    expect(screen.getByRole("progressbar", { name: "RAM usage" })).toHaveAttribute("aria-valuenow", "80.8");
    expect(screen.queryByText(/Swap/)).not.toBeInTheDocument();
    expect(screen.getByText("10.5 GB / 13.0 GB")).toBeInTheDocument();
  });
});
