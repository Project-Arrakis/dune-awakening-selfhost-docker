import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpicefieldsEditor } from "./MapsPanel";

describe("Spice Fields Patch 1.5 settings", () => {
  it("renders active resource fields from the current schema with mobile labels", () => {
    const row = { field_id: "12345", map_name: "HaggaBasin", field_type: "Small" as const, dimension_index: 0, spawn_time: 10, value_remaining: 5000 };
    const { container } = render(<SpicefieldsEditor rows={[row]} allRows={[row]} loaded filter="" result={null} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByText("Small").closest("td")).toHaveAttribute("data-label", "Size");
    expect(screen.getByText("5,000").closest("td")).toHaveAttribute("data-label", "Spice Remaining");
    expect(container.querySelectorAll("tbody td[data-label]")).toHaveLength(5);
  });

  it("reports a valid empty state when no fields are currently active", () => {
    render(<SpicefieldsEditor rows={[]} allRows={[]} loaded filter="" result={null} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText("No Spice Fields are active right now.")).toBeInTheDocument();
  });
});
