import { fileURLToPath } from "node:url"
import process from "node:process"
import { defineConfig } from "@playwright/test"

const cwd = fileURLToPath(new URL("../../../", import.meta.url))

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.playwright.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:7070",
    browserName: "chromium",
    // Optional existing Chrome for local environments without bundled Chromium.
    channel: process.env.STUDY_BROWSER_CHANNEL || undefined,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-night",
      use: { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" },
    },
    {
      name: "phone-day",
      use: { viewport: { width: 375, height: 812 }, colorScheme: "light" },
    },
  ],
  webServer: [
    {
      cwd,
      command: "bun run dev:study --host 127.0.0.1 --port 7070",
      url: "http://127.0.0.1:7070",
      reuseExistingServer: false,
    },
    {
      cwd,
      command:
        "bun run build:study && bun run --cwd apps/market vite preview --config design-study/vite.config.ts --host 127.0.0.1 --port 7071 --strictPort",
      url: "http://127.0.0.1:7071",
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
})
