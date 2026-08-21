import { describe, expect, it } from "bun:test"

import {
  type PlaywrightJsonReport,
  validatePlaywrightSmokeAreas,
} from "../scripts/ci/validate_playwright_smoke_areas"

function reportWithSpecs(
  specs: NonNullable<
    NonNullable<PlaywrightJsonReport["suites"]>[number]["specs"]
  >
): PlaywrightJsonReport {
  return {
    suites: [
      {
        specs,
      },
    ],
  }
}

describe("Playwright smoke area validation", () => {
  it("counts explicitly tagged tests in each area", () => {
    const counts = validatePlaywrightSmokeAreas(
      reportWithSpecs([
        { file: "e2e/market.playwright.ts", title: "market flow @market" },
        {
          file: "e2e/merchant.playwright.ts",
          tags: ["merchant"],
          title: "merchant flow",
        },
      ])
    )

    expect(counts).toEqual({ market: 1, merchant: 1 })
  })

  it("counts structured tags when titles contain no area token", () => {
    const counts = validatePlaywrightSmokeAreas(
      reportWithSpecs([
        {
          file: "e2e/market.playwright.ts",
          tags: ["market"],
          title: "buyer checkout completes",
        },
        {
          file: "e2e/merchant.playwright.ts",
          tags: ["merchant"],
          title: "seller fulfills an order",
        },
      ])
    )

    expect(counts).toEqual({ market: 1, merchant: 1 })
  })

  it("rejects orphaned Playwright smoke tests", () => {
    expect(() =>
      validatePlaywrightSmokeAreas(
        reportWithSpecs([
          {
            file: "e2e/orphan.playwright.ts",
            line: 12,
            tags: ["regression"],
            title: "orphaned test",
          },
          { file: "e2e/market.playwright.ts", tags: ["market"] },
          { file: "e2e/merchant.playwright.ts", tags: ["merchant"] },
        ])
      )
    ).toThrow("e2e/orphan.playwright.ts:12 (orphaned test)")
  })

  it("rejects a selected area with zero tests", () => {
    expect(() =>
      validatePlaywrightSmokeAreas(
        reportWithSpecs([
          { file: "e2e/market.playwright.ts", tags: ["market"] },
        ]),
        ["merchant"]
      )
    ).toThrow("The selected merchant smoke area contains zero tests.")
  })
})
