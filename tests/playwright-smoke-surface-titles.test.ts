import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "bun:test"
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter"

import {
  PrivacySafeSmokeReporter,
  safePlaywrightSmokeTitle,
} from "../scripts/ci/playwright_smoke_reporter"
import { buildPlaywrightSmokeManifest } from "../scripts/ci/validate_playwright_smoke_areas"

const file = "e2e/shared-ui-surface-audit.playwright.ts"
const sourceFile = resolve(file)
const routes = {
  market: [
    "/",
    "/products",
    "/merchants",
    "/sellers",
    "/zapouts",
    "/events",
    "/cart",
    "/checkout",
    "/orders",
    "/messages",
    "/profile",
    "/preferences",
    "/wallet",
    "/network",
    "/about",
    "/terms-of-service",
    "/privacy-policy",
  ],
  merchant: [
    "/",
    "/products",
    "/events",
    "/events/new",
    "/orders",
    "/messages",
    "/profile",
    "/wallet",
    "/shipping",
    "/network",
    "/about",
    "/terms-of-service",
    "/privacy-policy",
  ],
}
const sanitize = (title: string, titleFile = file) =>
  safePlaywrightSmokeTitle({ file: titleFile, line: 1, sourceFile, title })

describe("surface audit title privacy boundary", () => {
  it("preserves every fixed area, theme and route combination", () => {
    for (const [area, paths] of Object.entries(routes)) {
      for (const theme of ["day-market", "night-market"]) {
        for (const route of paths) {
          const title = `${area} surface audit in ${theme}: ${route} @${area}`
          expect(sanitize(title)).toBe(title)
        }
      }
    }
  })

  it("redacts unknown or cross-area routes, unsafe values and other files", () => {
    const titles = [
      "market surface audit in day-market: /account @market",
      "market surface audit in day-market: /events/new @market",
      "merchant surface audit in day-market: /cart @merchant",
      "market surface audit in custom-theme: / @market",
      "market surface audit in day-market: / @merchant",
      "commerce surface audit in day-market: / @commerce",
      "market surface audit in day-market: /wallet?token=private @market",
      "market surface audit in day-market: /wallet#private @market",
      "market surface audit in day-market: /wallet/private @market",
      "market surface audit in day-market: //wallet @market",
      "market surface audit in day-market: /wallet/ @market",
      "market surface audit in day-market: /wallet @market @commerce",
      "market surface audit in day-market: /wallet @market private",
      "market surface audit in day-market: /wallet\n@market",
      "market surface audit in day-market: /wallet\u0000 @market",
      `market surface audit in day-market: /${"a".repeat(64)} @market`,
      `market surface audit in day-market: /npub1${"q".repeat(58)} @market`,
      "market surface audit in day-market: /nostr+walletconnect://private @market",
    ]
    for (const title of titles) {
      expect(sanitize(title)).toBe("redacted smoke test")
    }
    expect(
      sanitize(
        "market surface audit in day-market: / @market",
        "e2e/other.playwright.ts"
      )
    ).toBe("redacted smoke test")
  })

  it("reports readable progress and manifest names while keeping evidence title-free", () => {
    const directory = mkdtempSync(join(tmpdir(), "surface-title-privacy-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const evidenceFile = join(directory, "evidence.json")
    const safeTitle = "market surface audit in night-market: /wallet @market"
    const unsafeTitle =
      "market surface audit in night-market: /wallet?token=private @market"
    const titles = [safeTitle, unsafeTitle]
    try {
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
        evidenceFile,
      })
      reporter.onBegin(
        {
          metadata: {
            smokeEvidence: {
              baseSha: "a".repeat(40),
              sourceHeadSha: "b".repeat(40),
              testedSha: "c".repeat(40),
            },
          },
        } as FullConfig,
        { allTests: () => titles } as unknown as Suite
      )
      for (const [index, title] of titles.entries()) {
        const testCase = {
          id: `surface-title-${index}`,
          title,
          tags: ["@market"],
          expectedStatus: "passed",
          location: { file: sourceFile, line: 1, column: 1 },
          parent: { project: () => ({ name: "chromium" }) },
          ok: () => true,
          outcome: () => "expected",
        } as unknown as TestCase
        const result = {
          attachments: [],
          duration: 1,
          retry: 0,
          status: "passed",
          stderr: [],
          stdout: [],
          steps: [],
        } as unknown as TestResult
        reporter.onTestBegin(testCase, result)
        reporter.onTestEnd(testCase, result)
      }
      reporter.onEnd({ status: "passed" } as FullResult)
      const progress = readFileSync(progressFile, "utf8")
      expect(progress).toContain(safeTitle)
      expect(progress).toContain("redacted smoke test")
      expect(progress).not.toContain("token=private")
      const report = JSON.parse(readFileSync(outputFile, "utf8"))
      const manifest = buildPlaywrightSmokeManifest(report)
      expect(manifest.tests.map((test) => test.name).sort()).toEqual(
        [safeTitle, "redacted smoke test"].sort()
      )
      expect(new Set(manifest.tests.map((test) => test.id)).size).toBe(2)
      const evidenceText = readFileSync(evidenceFile, "utf8")
      const evidence = JSON.parse(evidenceText)
      expect(evidence.tests).toHaveLength(2)
      expect(evidence.tests.every((test: object) => !("title" in test))).toBe(
        true
      )
      expect(evidenceText).not.toContain(safeTitle)
      expect(evidenceText).not.toContain("token=private")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
