import { describe, expect, it } from "bun:test"

import {
  assertPlaywrightAreaCoverage,
  listedTestIds,
  planPlaywrightE2eRuns,
} from "../scripts/dev/run_playwright_e2e"
import { resolvePlaywrightWebServerTarget } from "../scripts/dev/run_playwright_web_server"

describe("local Playwright area runner", () => {
  it("splits unset and all-area entry points without dropping Commerce", () => {
    for (const requestedArea of [undefined, "all"]) {
      expect(planPlaywrightE2eRuns("full", requestedArea)).toEqual({
        areas: ["market", "merchant", "commerce"],
        args: [],
        discoveryArea: "all",
      })
      expect(planPlaywrightE2eRuns("mobile", requestedArea).areas).toEqual([
        "market",
        "merchant",
      ])
      expect(planPlaywrightE2eRuns("webkit", requestedArea).areas).toEqual([
        "market",
        "merchant",
      ])
    }
    expect(planPlaywrightE2eRuns("full", "market").areas).toEqual(["market"])
    expect(() => planPlaywrightE2eRuns("mobile", "commerce")).toThrow()
  })

  it("keeps both mobile browser projects in discovery", () => {
    const ids = listedTestIds({
      suites: [
        {
          specs: [
            {
              id: "one-test",
              tests: [
                { projectName: "mobile-chromium" },
                { projectName: "mobile-webkit" },
              ],
            },
          ],
        },
      ],
    })
    expect(ids).toEqual(
      new Set([
        JSON.stringify(["one-test", "mobile-chromium"]),
        JSON.stringify(["one-test", "mobile-webkit"]),
      ])
    )
    expect(planPlaywrightE2eRuns("mobile").args).toContain(
      "--project=mobile-chromium"
    )
    expect(planPlaywrightE2eRuns("webkit").args).not.toContain(
      "--project=mobile-chromium"
    )
  })

  it("routes the default Market and Commerce selections to compatible networks", () => {
    const areas = planPlaywrightE2eRuns("full").areas
    expect(areas).toContain("market")
    expect(areas).toContain("commerce")
    expect(
      resolvePlaywrightWebServerTarget("market", {
        PLAYWRIGHT_RELAY_PORT: "54321",
        PLAYWRIGHT_SMOKE_AREA: "market",
      }).env.VITE_LIGHTNING_NETWORK
    ).toBe("mainnet")
    expect(
      resolvePlaywrightWebServerTarget("market", {
        PLAYWRIGHT_RELAY_PORT: "54321",
        PLAYWRIGHT_SMOKE_AREA: "commerce",
      }).env.VITE_LIGHTNING_NETWORK
    ).toBe("testnet")
  })

  it("requires the area union to cover every selected test", () => {
    const full = new Set(["market", "shared", "merchant", "commerce"])
    expect(() =>
      assertPlaywrightAreaCoverage(full, [
        new Set(["market", "shared"]),
        new Set(["merchant", "shared"]),
        new Set(["commerce"]),
      ])
    ).not.toThrow()
    expect(() =>
      assertPlaywrightAreaCoverage(full, [
        new Set(["market", "shared"]),
        new Set(["merchant", "shared"]),
      ])
    ).toThrow("omit")
    expect(() =>
      assertPlaywrightAreaCoverage(full, [new Set(["market", "extra"])])
    ).toThrow("outside")
  })
})
