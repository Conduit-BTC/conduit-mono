import { defineConfig, devices } from "@playwright/test"

const CI = !!process.env.CI
const marketPort = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
const merchantPort = process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
const e2eEnv = "VITE_DISABLE_DEVTOOLS=true"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.playwright.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `${e2eEnv} bun run --filter @conduit/market dev --mode mock --host 127.0.0.1 --port ${marketPort}`,
      url: `http://127.0.0.1:${marketPort}/products`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      command: `${e2eEnv} bun run --filter @conduit/merchant dev --mode mock --host 127.0.0.1 --port ${merchantPort}`,
      url: `http://127.0.0.1:${merchantPort}/`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
})
