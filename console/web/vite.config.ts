import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Overridable for local/containerized dev (e.g. .claude/scripts/live-test.sh
    // points this at a docker-network API hostname). Defaults are unchanged from
    // the historical hardcoded values, so a plain `npm run dev` behaves exactly
    // as before.
    port: Number(process.env.VITE_DEV_PORT) || 5173,
    proxy: {
      "/api": process.env.VITE_API_TARGET || "http://127.0.0.1:8088"
    }
  }
});
