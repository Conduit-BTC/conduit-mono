import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright config for Conduit visual smoke tests.
 *
 * Assumes the caller starts the dev servers out of band
 * (`bun run dev:market` + `bun run dev:merchant`). We intentionally avoid
 * Playwright's `webServer` option because the monorepo ships two apps on
 * two ports and already has bun-driven dev scripts the team uses.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use the full chromium build already cached by Playwright instead
        // of the chrome-headless-shell binary (which isn't installed here).
        channel: "chromium",
      },
    },
  ],
})
