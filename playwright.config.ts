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
const requestedRelayPort = process.env.PLAYWRIGHT_RELAY_PORT
const configuredRelayPort =
  requestedRelayPort && requestedRelayPort !== "0"
    ? requestedRelayPort
    : undefined
const smokeArea = process.env.PLAYWRIGHT_SMOKE_AREA ?? "all"
const commerceIncluded = smokeArea === "all" || smokeArea === "commerce"
const smokeResultFile = process.env.PLAYWRIGHT_SMOKE_RESULT_FILE
const smokeProgressFile = process.env.PLAYWRIGHT_SMOKE_PROGRESS_FILE
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
  ? [
      [
        "./scripts/ci/playwright_smoke_reporter.ts",
        { outputFile: smokeResultFile, progressFile: smokeProgressFile },
      ],
    ]
  : [["null"]]
const mobileTestFiles = [
  "**/mobile-safari-baseline.playwright.ts",
  "**/event-sign-preview-mobile.playwright.ts",
]
const productImageUploadCoverageFiles = [
  "**/merchant-product-image-preview.playwright.ts",
]

if (!new Set(["all", "market", "merchant", "commerce"]).has(smokeArea)) {
  throw new Error(`Unknown Playwright smoke area: ${smokeArea}`)
}

const relayWebServer = configuredRelayPort
  ? {
      command: "bun scripts/dev/run_playwright_web_server.ts relay",
      reuseExistingServer: false,
      timeout: 30_000,
      url: `http://127.0.0.1:${configuredRelayPort}/health`,
    }
  : {
      command: "bun scripts/dev/run_playwright_web_server.ts relay",
      timeout: 30_000,
      wait: {
        stdout:
          /Conduit Bun relay listening on ws:\/\/127\.0\.0\.1:(?<PLAYWRIGHT_RELAY_PORT>\d+)/,
      },
    }

const webServer = [
  relayWebServer,
  {
    command: "bun scripts/dev/run_playwright_web_server.ts market",
    url: `http://127.0.0.1:${marketPort}/products`,
    reuseExistingServer: !CI && !commerceIncluded,
    timeout: 120_000,
  },
  {
    command: "bun scripts/dev/run_playwright_web_server.ts merchant",
    url: `http://127.0.0.1:${merchantPort}/`,
    reuseExistingServer: !CI && !commerceIncluded,
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
  // Area shards share one isolated relay. Keep each selected area single-worker
  // so the commerce lane can make exact replay and side-effect assertions.
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
      testIgnore: mobileTestFiles,
    },
    {
      name: "mobile-chromium",
      testMatch: [...mobileTestFiles, ...productImageUploadCoverageFiles],
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-webkit",
      testMatch: [...mobileTestFiles, ...productImageUploadCoverageFiles],
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: smokeDiscovery ? undefined : webServer,
})
