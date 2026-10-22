import { defineConfig } from "@playwright/test"
import { fileURLToPath } from "node:url"

export default defineConfig({
  testDir: ".",
  testMatch: "*.playwright.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "../../../test-results/ui-workbench",
  use: {
    baseURL: "http://127.0.0.1:7003",
    browserName: "chromium",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "bun run dev:ui",
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    url: "http://127.0.0.1:7003",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
