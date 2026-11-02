import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser must never call docs.plus MCP directly (it 403s any request with an Origin header).
// It only talks to our backend under /api.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
