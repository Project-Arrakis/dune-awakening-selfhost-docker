import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Terrain assets ship pre-gzipped and are inflated in the browser, so Vite
  // must hash and copy them rather than parse them; ?url imports fail without it.
  assetsInclude: ["**/*.gz"],
  build: {
    // The gzipped layout sidecars are ~1.6 KB, under Vite's 4 KB inline limit,
    // so they would otherwise be inlined into the main bundle and re-downloaded
    // by every user whenever any one layout is rebuilt. Note: under `build`,
    // unlike `assetsInclude` above.
    assetsInlineLimit: (file: string) => (file.endsWith(".gz") ? false : undefined)
  },
  server: {
    // Overridable for local/containerized dev (e.g. .claude/scripts/live-test.sh
    // points this at a docker-network API hostname). Defaults are unchanged from
    // the historical hardcoded values, so a plain `npm run dev` behaves exactly
    // as before.
    //
    // VITE_DEV_PORT wins over PORT so live-test.sh's explicit choice is never
    // overridden by a PORT that happens to be set in the environment; PORT is
    // then honoured so two worktrees can each run a dev server without both
    // trying to bind 5173.
    port: Number(process.env.VITE_DEV_PORT || process.env.PORT) || 5173,
    proxy: {
      "/api": process.env.VITE_API_TARGET || "http://127.0.0.1:8088"
    }
  }
});
