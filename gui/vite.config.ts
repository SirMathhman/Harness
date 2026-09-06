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
      // In dev, Vite serves the app's own assets and index.html directly;
      // only the WebSocket (and the agent-server's HTTP surface, if any web
      // fetch is added later) is proxied. The catch-all "/" is deliberately
      // NOT proxied so Vite's HMR and source serving are not rerouted to the
      // agent-server (which would 500 on /src/*, /@vite/*, style.css, etc.).
      "/ws": {
        target: TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
