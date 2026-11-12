import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, getThemes, THEME_STORAGE_KEY, applyTheme, buildThemeTokens, contrast, ensureContrast, initTheme, loadSelectedTheme, parseHex, parseJsonc, saveSelectedTheme } from "./themeEngine";

const THEMES = getThemes();

describe("parseJsonc", () => {
  it("strips line comments but keeps // inside strings", () => {
    expect(parseJsonc('{ "a": "http://x", // note\n "b": 1 }')).toEqual({ a: "http://x", b: 1 });
  });
});

describe("palette catalogue", () => {
  it("offers the 16 dark Fedaykin palettes and 3 dark Tabr looks with unique ids", () => {
    expect(THEMES).toHaveLength(19);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(19);
    expect(THEMES.every((t) => t.appearance === "dark")).toBe(true);
    expect(THEMES.map((t) => t.id)).toEqual(expect.arrayContaining(["tabr-fremen", "tabr-awakening", "tabr-sietch"]));
  });

  it("emits a full, valid token set for every palette", () => {
    const keys = Object.keys(THEMES[0].tokens).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort(), theme.id).toEqual(keys);
      for (const [name, value] of Object.entries(theme.tokens)) {
        if (name !== "--bg-glow") expect(parseHex(value), `${theme.id} ${name}`).not.toBeNull();
      }
    }
  });

  it("keeps readable text at AA or better on the panel and canvas for every palette", () => {
    for (const theme of THEMES) {
      const bg = parseHex(theme.tokens["--bg"])!;
      const panel = parseHex(theme.tokens["--panel"])!;
      for (const token of ["--text", "--muted", "--text-faint", "--text-subtle", "--title", "--success-text", "--danger-text", "--state-motion"]) {
        const fg = parseHex(theme.tokens[token])!;
        expect(Math.min(contrast(fg, bg), contrast(fg, panel)), `${theme.id} ${token}`).toBeGreaterThanOrEqual(4.49);
      }
    }
  });
});

describe("ensureContrast", () => {
  it("leaves a passing colour alone and lifts a failing one", () => {
    const dark = parseHex("#101010")!;
    expect(ensureContrast([240, 240, 240], [dark], 7)).toEqual([240, 240, 240]);
    expect(contrast(ensureContrast([30, 30, 30], [dark], 4.5), dark)).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens toward black on a light surface", () => {
    const light = parseHex("#fafafa")!;
    expect(contrast(ensureContrast([200, 200, 200], [light], 4.5), light)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("buildThemeTokens", () => {
  it("derives a light-palette token set that still meets AA (kept for when light themes are offered)", () => {
    const tokens = buildThemeTokens({ color_01: "#fafafa", color_02: "#f4f4f4", color_09: "#1a1a1a", color_10: "#999999" });
    expect(contrast(parseHex(tokens["--muted"])!, parseHex(tokens["--bg"])!)).toBeGreaterThanOrEqual(4.49);
  });

  it("falls back instead of throwing on an empty palette", () => {
    expect(buildThemeTokens({})["--bg"]).toBe("#0d0f12");
  });
});

describe("apply and persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    applyTheme(DEFAULT_THEME_ID);
  });

  it("default sets no overrides", () => {
    initTheme();
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("saves, applies, restores and then resets cleanly", () => {
    const theme = THEMES.find((t) => t.id === "tabr-fremen")!;
    saveSelectedTheme("tabr-fremen");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("tabr-fremen");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(theme.tokens["--bg"]);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(loadSelectedTheme()).toBe("tabr-fremen");
    saveSelectedTheme(DEFAULT_THEME_ID);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("");
  });

  it("follows a theme chosen in another tab", () => {
    initTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, "tabr-sietch");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.dataset.theme).toBe("tabr-sietch");
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores a stored id that no longer exists", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "gone");
    expect(loadSelectedTheme()).toBe(DEFAULT_THEME_ID);
  });
});
