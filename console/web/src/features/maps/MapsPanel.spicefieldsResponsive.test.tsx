import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpicefieldsEditor } from "./MapsPanel";

describe("Spice Fields responsive editor", () => {
  it("labels every editable cell for the mobile card layout", () => {
    const row = {
      spicefield_type_id: 7,
      map_name: "Deep Desert",
      field_type: "Large",
      dimension_index: 2,
      max_globally_active: 6,
      max_globally_primed: 2,
      current_globally_active: 3,
      current_globally_primed: 1,
      is_spawning_active: true,
      global_spawn_weight: 1.5
    };

    const { container } = render(<SpicefieldsEditor
      rows={[row]}
      allRows={[row]}
      drafts={{ "7": { maxActive: "6", maxPrimed: "2", spawningActive: true, spawnWeight: "1.5" } }}
      filter=""
      savingId=""
      result={null}
      onFilterChange={vi.fn()}
      onRefresh={vi.fn()}
      onDraftChange={vi.fn()}
      onDiscard={vi.fn()}
      onSave={vi.fn()}
    />);

    expect(screen.getByRole("spinbutton", { name: "Deep Desert Max Active" }).closest("td")).toHaveAttribute("data-label", "Max Active");
    expect(screen.getByRole("spinbutton", { name: "Deep Desert Max Primed" }).closest("td")).toHaveAttribute("data-label", "Max Primed");
    expect(screen.getByRole("combobox", { name: "Deep Desert Spawning" }).closest("td")).toHaveAttribute("data-label", "Spawning");
    expect(screen.getByRole("spinbutton", { name: "Deep Desert Weight" }).closest("td")).toHaveAttribute("data-label", "Weight");
    expect(container.querySelectorAll("tbody td[data-label]")).toHaveLength(9);
  });
});
