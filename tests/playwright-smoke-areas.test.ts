import { describe, expect, it } from "bun:test"

import {
  buildPlaywrightSmokeManifest,
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

  it("builds a deterministic content-free selected-spec manifest", () => {
    const manifest = buildPlaywrightSmokeManifest(
      reportWithSpecs([
        {
          file: "/home/runner/work/conduit/e2e/zeta.playwright.ts",
          line: 20,
          tags: ["merchant"],
          title: "seller fulfills an order",
        },
        {
          file: "alpha.playwright.ts",
          line: 10,
          tags: ["market"],
          title: "buyer checkout completes",
        },
      ]),
      ["merchant", "market"]
    )

    expect(manifest).toEqual({
      schemaVersion: 1,
      selectedTags: ["@market", "@merchant"],
      selectedTestCount: 2,
      tests: [
        {
          file: "e2e/alpha.playwright.ts",
          line: 10,
          name: "buyer checkout completes",
          tags: ["@market"],
        },
        {
          file: "e2e/zeta.playwright.ts",
          line: 20,
          name: "seller fulfills an order",
          tags: ["@merchant"],
        },
      ],
    })
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
