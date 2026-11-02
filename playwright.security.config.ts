import { defineConfig } from "@playwright/test"

if (process.platform !== "linux") {
  throw new Error("Browser security checks require a Linux runner")
}

export default defineConfig({
  testDir: "./security-tests",
  testMatch: "**/*.playwright.ts",
  retries: 0,
  workers: 1,
  timeout: 45_000,
  reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "node scripts/dev/serve_security_build.mjs",
    url: "http://127.0.0.1:7100/about",
    reuseExistingServer: false,
  },
})
