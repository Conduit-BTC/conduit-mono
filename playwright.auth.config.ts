import { defineConfig } from "@playwright/test"
if (process.platform !== "linux")
  throw new Error("Auth browser checks require Linux.")
const profile = process.env.CONDUIT_DEPLOYMENT_PROFILE || "preview"
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "auth-containment.pw.ts",
  workers: 1,
  retries: 0,
  timeout: 90000,
  use: {
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
  },
  webServer: ["market", "merchant"].map((app, i) => ({
    cwd: process.cwd(),
    command: `CONDUIT_DEPLOYMENT_PROFILE=${profile} node node_modules/vite/bin/vite.js apps/${app} --config apps/${app}/vite.config.ts --port ${7000 + i} --strictPort`,
    url: `http://localhost:${7000 + i}`,
    timeout: 120000,
    reuseExistingServer: false,
  })),
})
