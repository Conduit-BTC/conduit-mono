import { describe, expect, it } from "bun:test"

import { validateRouterSmokePartition } from "../scripts/ci/router_smoke_partition"
import type { PlaywrightJsonReport } from "../scripts/ci/validate_playwright_smoke_areas"

function report(ids: string[]): PlaywrightJsonReport {
  return {
    suites: [
      {
        specs: ids.map((id) => ({
          file: "commerce-router-recovery.playwright.ts",
          id,
          line: id === "ordinary" ? 10 : 20,
          title: "native router @commerce",
          tags: ["commerce"],
          tests: [{ projectName: "chromium" }],
        })),
      },
    ],
  }
}

describe("required native router partition", () => {
  it("requires the complete native set exactly once across ordinary and event jobs", () => {
    const ordinary = report(["ordinary"])
    const event = report(["event"])
    const all = report(["ordinary", "event"])
    expect(
      validateRouterSmokePartition({ all, ordinary, event }).all
        .selectedTestCount
    ).toBe(2)
    for (const parts of [
      { all, ordinary, event: ordinary },
      { all, ordinary: all, event },
      { all, ordinary, event: report([]) },
      { all, ordinary, event: report(["unexpected"]) },
    ])
      expect(() => validateRouterSmokePartition(parts)).toThrow()
  })
  it("rejects discovery errors and mismatched candidate metadata before execution", () => {
    const evidence = {
      baseSha: "b".repeat(40),
      sourceHeadSha: "a".repeat(40),
      testedSha: "c".repeat(40),
    }
    const withEvidence = (ids: string[]) => ({
      ...report(ids),
      config: { metadata: { smokeEvidence: evidence } },
    })
    const reports = {
      all: withEvidence(["ordinary", "event"]),
      ordinary: withEvidence(["ordinary"]),
      event: withEvidence(["event"]),
    }
    expect(() => validateRouterSmokePartition(reports, evidence)).not.toThrow()
    expect(() =>
      validateRouterSmokePartition(
        {
          ...reports,
          event: report(["event"]),
        },
        evidence
      )
    ).toThrow("expected SHAs")
    expect(() =>
      validateRouterSmokePartition(
        {
          ...reports,
          event: {
            ...reports.event,
            config: {
              metadata: {
                smokeEvidence: { ...evidence, testedSha: "d".repeat(40) },
              },
            },
          },
        },
        evidence
      )
    ).toThrow("expected SHAs")
    expect(() =>
      validateRouterSmokePartition(
        {
          ...reports,
          event: { ...reports.event, errors: [{}] },
        },
        evidence
      )
    ).toThrow("discovery reported errors")
  })
})
