import {
  defineConfig,
  devices,
  type PlaywrightTestConfig,
} from "@playwright/test"

import { resolvePlaywrightRouterPorts } from "./run_playwright_router_web_server"

export function createPlaywrightRouterConfig(
  environment: Record<string, string | undefined>
): PlaywrightTestConfig {
  if (
    environment.PLAYWRIGHT_SMOKE_AREA !== undefined &&
    environment.PLAYWRIGHT_SMOKE_AREA !== "all" &&
    environment.PLAYWRIGHT_SMOKE_AREA !== "commerce"
  ) {
    throw new Error("The isolated router smoke belongs to the commerce area.")
  }
  const smokeEvidence = {
    baseSha: environment.PLAYWRIGHT_SMOKE_BASE_SHA ?? "",
    sourceHeadSha: environment.PLAYWRIGHT_SMOKE_SOURCE_HEAD_SHA ?? "",
    testedSha: environment.PLAYWRIGHT_SMOKE_TESTED_SHA ?? "",
  }
  const evidenceValues = Object.values(smokeEvidence)
  const hasEvidence = evidenceValues.some(Boolean)
  if (
    (hasEvidence || environment.CI) &&
    !evidenceValues.every((value) => /^[0-9a-f]{40}$/.test(value))
  ) {
    throw new Error(
      "Router smoke evidence requires valid source, base, and tested SHAs."
    )
  }
  if (
    environment.CI &&
    environment.PLAYWRIGHT_SMOKE_DISCOVERY !== "true" &&
    !environment.PLAYWRIGHT_SMOKE_RESULT_FILE
  ) {
    throw new Error(
      "CI router smoke execution requires PLAYWRIGHT_SMOKE_RESULT_FILE."
    )
  }
  const { marketPort, merchantPort } = resolvePlaywrightRouterPorts(environment)
  const serverEnvironment = {
    PLAYWRIGHT_MARKET_PORT: marketPort,
    PLAYWRIGHT_MERCHANT_PORT: merchantPort,
    VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS:
      environment.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS ?? "",
  }
  return defineConfig({
    metadata: hasEvidence ? { smokeEvidence } : undefined,
    testDir: "./e2e",
    testMatch: "**/commerce-router-recovery.playwright.ts",
    grep: /@commerce/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!environment.CI,
    outputDir: "test-results/router-artifacts",
    preserveOutput: "never",
    globalTeardown: "./scripts/dev/playwright_router_teardown.ts",
    reporter: [
      [
        "./scripts/ci/playwright_smoke_reporter.ts",
        {
          outputFile:
            environment.PLAYWRIGHT_SMOKE_RESULT_FILE ??
            "test-results/router-smoke-results.json",
          progressFile: environment.PLAYWRIGHT_SMOKE_PROGRESS_FILE,
        },
      ],
    ],
    use: {
      trace: "off",
      screenshot: "off",
      video: "off",
      serviceWorkers: "block",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer:
      environment.PLAYWRIGHT_SMOKE_DISCOVERY === "true"
        ? undefined
        : [
            {
              command:
                "bun scripts/dev/run_playwright_router_web_server.ts relay",
              env: serverEnvironment,
              reuseExistingServer: false,
              timeout: 30_000,
              wait: {
                stdout:
                  /Conduit router relay ready on ws:\/\/127\.0\.0\.1:(?<PLAYWRIGHT_RELAY_PORT>\d+); clock=(?<PLAYWRIGHT_ROUTER_CLOCK_FILE>[^\r\n]+)/,
              },
            },
            {
              command:
                "bun scripts/dev/run_playwright_router_web_server.ts market",
              env: serverEnvironment,
              url: `http://127.0.0.1:${marketPort}/products`,
              reuseExistingServer: false,
              timeout: 120_000,
            },
            {
              command:
                "bun scripts/dev/run_playwright_router_web_server.ts merchant",
              env: serverEnvironment,
              url: `http://127.0.0.1:${merchantPort}/`,
              reuseExistingServer: false,
              timeout: 120_000,
            },
          ],
  })
}
