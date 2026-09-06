// Playwright configuration for the GUI's browser tests.
//
// These live under e2e/ and use the *.spec.ts convention, which Bun's test
// runner would otherwise collect (verified: Bun 1.3 does match *.spec.ts). The
// repository's bunfig.toml confines `bun test` to test/, keeping the two
// runners separate; run these with `bun run test:browser`.

import { defineConfig, devices } from "@playwright/test";

const PORT = 5174;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  // The mounted-item budget is asserted against a fixed viewport, so the specs
  // must not race each other for the machine.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The 900px-tall fixture the render-item budget is stated against.
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The real app, served by the real dev server. The WebSocket transport is
    // the only thing the fixture replaces, so no agent-server is needed.
    command: `bunx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
