import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ItemCatalogSelector, type CatalogItem } from "./ItemCatalog";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn(async () => ({
      rows: [
        { itemId: "ScrapMetal", id: "ScrapMetal", name: "Scrap Metal", category: "resource", source: "Resources" },
        { itemId: "PlantFiber", id: "PlantFiber", name: "Plant Fiber", category: "resource", source: "Resources" }
      ]
    }))
  }
}));

// This is the one place the shared click-to-deselect behavior actually
// lives (BaseInventoryTab's add panel just consumes it), so it's tested here
// directly rather than only indirectly through one of the three panels that
// embed this component.
function Harness() {
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  return <ItemCatalogSelector selected={selected} onSelect={setSelected} />;
}

describe("ItemCatalogSelector click-to-select", () => {
  it("selects on grid click, then clears on a second click of the same tile", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Scrap Metal/ }).length).toBeGreaterThan(0));

    const tile = screen.getByRole("button", { name: /Scrap Metal/ });
    fireEvent.click(tile);
    await waitFor(() => expect(tile.className).toMatch(/active/));
    expect(screen.getByText("Item Name")).toBeTruthy();

    fireEvent.click(tile);
    await waitFor(() => expect(tile.className).not.toMatch(/active/));
    expect(screen.queryByText("Item Name")).toBeNull();
  });

  it("selecting a different tile switches selection rather than toggling the first off", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Scrap Metal/ }).length).toBeGreaterThan(0));

    const scrap = screen.getByRole("button", { name: /Scrap Metal/ });
    const fiber = screen.getByRole("button", { name: /Plant Fiber/ });
    fireEvent.click(scrap);
    await waitFor(() => expect(scrap.className).toMatch(/active/));

    fireEvent.click(fiber);
    await waitFor(() => expect(fiber.className).toMatch(/active/));
    expect(scrap.className).not.toMatch(/active/);
  });

  it("selects on list-row click, then clears on a second click of the same row", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Scrap Metal/ }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());

    const row = screen.getByText("Scrap Metal").closest("tr")!;
    fireEvent.click(row);
    await waitFor(() => expect(row.className).toMatch(/active/));

    fireEvent.click(row);
    await waitFor(() => expect(row.className).not.toMatch(/active/));
  });
});
