import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The agent-server port the dev server proxies to (GUI spec §3.5).
const AGENT_PORT = 8787;
const TARGET = `http://localhost:${AGENT_PORT}`;

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      // WebSocket endpoint.
      "/ws": {
        target: TARGET,
        ws: true,
        changeOrigin: true,
      },
      // Everything else (static assets) falls through to the agent-server.
      "/": {
        target: TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
