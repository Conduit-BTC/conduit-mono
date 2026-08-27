import {
  defineConfig,
  devices,
  type ReporterDescription,
} from "@playwright/test"

import { smokeAreaTags } from "./e2e/helpers/smoke-areas"

const CI = !!process.env.CI
const smokeDiscovery = process.env.PLAYWRIGHT_SMOKE_DISCOVERY === "true"
const marketPort = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
const merchantPort = process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
const relayPort = process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"
const relayUrl = `ws://127.0.0.1:${relayPort}`
const e2eEnv = [
  `VITE_E2E_RELAY_URL=${relayUrl}`,
  "VITE_DISABLE_DEVTOOLS=true",
  "VITE_ENABLE_TELEMETRY=true",
  "VITE_ENABLE_TELEMETRY_TEST_HOOKS=true",
  "VITE_TELEMETRY_ALLOWED_HOSTS=127.0.0.1",
  "VITE_PLAUSIBLE_SRC=data:text/javascript,",
].join(" ")
const smokeArea = process.env.PLAYWRIGHT_SMOKE_AREA ?? "all"
const smokeResultFile = process.env.PLAYWRIGHT_SMOKE_RESULT_FILE
const smokeEvidenceValues = {
  baseSha: process.env.PLAYWRIGHT_SMOKE_BASE_SHA ?? "",
  sourceHeadSha: process.env.PLAYWRIGHT_SMOKE_SOURCE_HEAD_SHA ?? "",
  testedSha: process.env.PLAYWRIGHT_SMOKE_TESTED_SHA ?? "",
}
const smokeEvidenceValueCount =
  Object.values(smokeEvidenceValues).filter(Boolean).length
if (smokeEvidenceValueCount > 0 && smokeEvidenceValueCount < 3) {
  throw new Error(
    "Playwright smoke evidence requires source, base, and tested SHAs"
  )
}
const smokeEvidence =
  smokeEvidenceValueCount === 3 ? smokeEvidenceValues : undefined
if (CI && !smokeDiscovery && !smokeResultFile) {
  throw new Error(
    "CI Playwright smoke execution requires PLAYWRIGHT_SMOKE_RESULT_FILE"
  )
}
const ciReporters: ReporterDescription[] = smokeResultFile
  ? [["json", { outputFile: smokeResultFile }]]
  : [["null"]]

if (!new Set(["all", "market", "merchant"]).has(smokeArea)) {
  throw new Error(`Unknown Playwright smoke area: ${smokeArea}`)
}

const webServer = [
  {
    command: `RELAY_EPHEMERAL=true RELAY_FAULT_MODE=none RELAY_PORT=${relayPort} bun scripts/dev/relay_bun.ts`,
    url: `http://127.0.0.1:${relayPort}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  // Until the dedicated @commerce lane in CND-193 lands, dual-tagged
  // cross-app smoke runs in both existing shards and needs both apps.
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
]

export default defineConfig({
  metadata: smokeEvidence ? { smokeEvidence } : undefined,
  testDir: "./e2e",
  testMatch: "**/*.playwright.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // The current area shards share one relay and both app servers for dual-tagged
  // cross-app smoke. Keep them single-worker until CND-193 isolates @commerce.
  workers: smokeArea === "all" ? (CI ? 2 : undefined) : 1,
  reporter: CI ? ciReporters : "list",
  grep:
    smokeArea === "all"
      ? undefined
      : new RegExp(smokeAreaTags[smokeArea as keyof typeof smokeAreaTags]),
  use: {
    trace: CI ? "off" : "on-first-retry",
    screenshot: CI ? "off" : "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile-safari-baseline.playwright.ts",
    },
    {
      name: "mobile-chromium",
      testMatch: "**/mobile-safari-baseline.playwright.ts",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-webkit",
      testMatch: "**/mobile-safari-baseline.playwright.ts",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: smokeDiscovery ? undefined : webServer,
})
