import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4318",
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bun node_modules/vite/bin/vite.js --config tests/browser/vite.config.ts",
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
  },
  outputDir: "test-results/browser",
})
