import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";

// Keep complete text available even when a panel opts into ellipsis.
describe("DataTable cell titles", () => {
  it("gives a plain-text cell a title carrying its full, un-truncated value", () => {
    const longName = "dune-system-20260830-120000-4711-9931.tar.gz.enc";
    render(<DataTable rows={[{ name: longName }]} columns={["name"]} />);
    const cell = screen.getByText(longName);
    expect(cell.getAttribute("title")).toBe(longName);
  });

  it("does not carry a title on an empty cell", () => {
    render(<DataTable rows={[{ name: "" }]} columns={["name"]} />);
    const cell = document.querySelector("td[data-column='name']");
    expect(cell?.getAttribute("title")).toBeNull();
  });

  it("does not add a text title over a custom-rendered cell", () => {
    // renderCell can return arbitrary JSX (badges, links, buttons); a text
    // title guessed from that would be meaningless or wrong, so it is
    // deliberately left to whatever the custom renderer supplies itself.
    render(<DataTable
      rows={[{ name: "row-1" }]}
      columns={["name"]}
      renderCell={() => <button>Action</button>}
    />);
    const cell = document.querySelector("td[data-column='name']");
    expect(cell?.getAttribute("title")).toBeNull();
    expect(screen.getByText("Action")).toBeTruthy();
  });
});

describe("DataTable overflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("switches scroll containment only when the populated table outgrows its panel", () => {
    let measure: () => void = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { measure = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const { rerender, unmount } = render(<DataTable rows={[]} />);
    expect(observe).not.toHaveBeenCalled();
    rerender(<DataTable rows={[{ name: "Desert Retreat" }]} />);
    const wrap = screen.getByRole("region");
    const table = screen.getByRole("table");
    let panelWidth = 1000;
    let tableWidth = 1000;
    Object.defineProperty(wrap, "clientWidth", { get: () => panelWidth });
    Object.defineProperty(table, "scrollWidth", { get: () => tableWidth });
    expect(observe.mock.calls.map(([element]) => element)).toEqual([wrap, table]);
    act(() => measure());
    expect(wrap).not.toHaveClass("has-horizontal-overflow");
    panelWidth = 600;
    act(() => measure());
    expect(wrap).toHaveClass("has-horizontal-overflow");
    tableWidth = 600;
    act(() => measure());
    expect(wrap).not.toHaveClass("has-horizontal-overflow");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("DataTable responsive labels", () => {
  it("exposes the displayed column and action labels on body cells", () => {
    render(<DataTable
      rows={[{ base_name: "Sietch Tabr" }]}
      columns={["base_name"]}
      columnLabels={{ base_name: "Base Name" }}
      action={() => <button>Open</button>}
    />);

    expect(document.querySelector("td[data-column='base_name']")).toHaveAttribute("data-label", "Base Name");
    expect(screen.getByRole("button", { name: "Open" }).closest("td")).toHaveAttribute("data-label", "Actions");
  });
});
