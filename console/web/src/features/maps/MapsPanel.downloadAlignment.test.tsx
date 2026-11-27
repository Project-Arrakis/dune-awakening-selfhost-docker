import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import "../../styles.css";

describe("modifier configuration download alignment", () => {
  it("centers the help icon alongside both download buttons", () => {
    const { container } = render(
      <div className="settings-download-buttons">
        <InfoTooltip id="client-ini-download-help" label="About Client Configuration Downloads">Client configuration help.</InfoTooltip>
        <button className="settings-download-button">Engine.ini</button>
        <button className="settings-download-button">Game.ini</button>
      </div>
    );
    const row = container.querySelector(".settings-download-buttons")!;
    expect(getComputedStyle(row).display).toBe("flex");
    expect(getComputedStyle(row).alignItems).toBe("center");
    expect(screen.getByRole("button", { name: "About Client Configuration Downloads" }).closest(".memory-info-tooltip")?.parentElement).toBe(row);
    expect(screen.getByRole("button", { name: "Engine.ini" }).parentElement).toBe(row);
    expect(screen.getByRole("button", { name: "Game.ini" }).parentElement).toBe(row);
  });
});
