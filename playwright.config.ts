import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright config for Conduit visual smoke tests and NIP-07 signer QA.
 *
 * Assumes the caller starts the dev servers out of band
 * (`bun run dev:market` + `bun run dev:merchant`). We intentionally avoid
 * Playwright's `webServer` option because the monorepo ships two apps on
 * two ports and already has bun-driven dev scripts the team uses.
 *
 * CND-21: Multi-browser coverage for NIP-07 signer compatibility QA.
 * Real browser extension signers (Alby, nos2x, etc.) are tested manually;
 * automated tests use a deterministic NIP-07 shim injected at page load.
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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use the full chromium build instead of chrome-headless-shell.
        channel: "chromium",
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
      },
    },
    {
      name: "webkit",
      // WebKit requires system deps: libicu74, libjpeg-turbo8, gstreamer1.0-libav.
      // Install with: sudo npx playwright install-deps webkit
      // Tests are skipped automatically when the browser binary cannot launch.
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
})
