import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Off by default (no test currently imports a stylesheet). Needed so
    // BaseInventoryTab.test.tsx can import the real styles.css and assert
    // computed-style facts about it -- jsdom has no CSS engine to reflect
    // without this, so those assertions would otherwise silently check
    // nothing. Scoped in effect to whichever test files actually import CSS;
    // does not change behavior for the rest of the suite.
    css: true,
    setupFiles: ["src/test/setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**"]
    }
  }
});
