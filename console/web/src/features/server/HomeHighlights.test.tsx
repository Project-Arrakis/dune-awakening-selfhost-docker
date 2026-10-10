import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { HomeHighlights } from "./HomeHighlights";

test("shows the Regis image and ordered enable/spawn instructions without changing settings", () => {
  render(<HomeHighlights />);
  const panel = screen.getByRole("complementary", { name: "Highlights" });
  expect(within(panel).getByRole("heading", { name: /^Regis Tanks/ })).toBeVisible();
  expect(within(panel).getByRole("img")).toHaveAttribute("src", "/images/features/regis-tank.jpg");
  expect(within(panel).getByText("Experimental")).toBeVisible();
  const steps = within(panel).getAllByRole("listitem");
  expect(steps).toHaveLength(2);
  expect(steps[0]).toHaveTextContent("Settings → Experimental Features");
  expect(steps[0]).toHaveTextContent("wait for Hagga to finish restarting");
  expect(steps[1]).toHaveTextContent("player must be online in Hagga");
  expect(steps[1]).toHaveTextContent("Players → Player → Admin → Spawn Vehicle");
  expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
  expect(panel.firstElementChild).toHaveClass("home-highlight-art");
  expect(panel.lastElementChild).toHaveClass("home-highlight-content");
  expect(panel.lastElementChild?.firstElementChild).toHaveClass("home-highlights-heading");
});
