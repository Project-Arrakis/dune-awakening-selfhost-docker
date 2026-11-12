import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePanel } from "./ThemePanel";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, applyTheme } from "./themeEngine";

describe("ThemePanel", () => {
  beforeEach(() => { window.localStorage.clear(); applyTheme(DEFAULT_THEME_ID); });
  afterEach(cleanup);

  it("lists Default plus every palette and marks the current one", () => {
    render(<ThemePanel />);
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    expect(screen.getByRole("radio", { name: /Default/ })).toHaveAttribute("aria-checked", "true");
  });

  it("applies and stores a theme when chosen, and Escape closes", () => {
    const onClose = vi.fn();
    render(<ThemePanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: /Tabr Fremen/ }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("tabr-fremen");
    expect(document.documentElement.dataset.theme).toBe("tabr-fremen");
    expect(screen.getByRole("radio", { name: /Tabr Fremen/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys and keeps one tab stop", () => {
    render(<ThemePanel />);
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getAllByRole("radio")[1], { key: "ArrowLeft" });
    expect(screen.getAllByRole("radio")[0]).toHaveAttribute("aria-checked", "true");
  });
});
