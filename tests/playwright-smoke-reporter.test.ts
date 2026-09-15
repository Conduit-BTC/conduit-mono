import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter"

import { PrivacySafeSmokeReporter } from "../scripts/ci/playwright_smoke_reporter"

describe("privacy-safe Playwright smoke reporter", () => {
  it("persists only the smoke verifier's content-free status fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const privateSentinel = "private-runner-value-must-not-be-serialized"
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(sourceDirectory, "commerce.playwright.ts")
    const safeTitle = "buyer and merchant settle once @commerce"
    const unsafeTitle = `buyer ${privateSentinel} @commerce`

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        [
          `test(${JSON.stringify(safeTitle)}, async () => {})`,
          `const dynamicTitle = ${JSON.stringify(privateSentinel)}`,
          "test(`buyer ${dynamicTitle} @commerce`, async () => {})",
        ].join("\n")
      )
      const reporter = new PrivacySafeSmokeReporter({ outputFile })
      reporter.onBegin?.(
        {
          metadata: {
            smokeEvidence: {
              baseSha: "a".repeat(40),
              privateSentinel,
              sourceHeadSha: "b".repeat(40),
              testedSha: "c".repeat(40),
            },
            unsafeMetadata: privateSentinel,
          },
        } as FullConfig,
        {} as Suite
      )

      const safeTestCase = {
        expectedStatus: "passed",
        id: "safe-smoke-test",
        location: {
          column: 1,
          file: sourceFile,
          line: 1,
        },
        ok: () => true,
        outcome: () => "expected",
        tags: ["@commerce"],
        title: safeTitle,
      } as TestCase
      const unsafeTestCase = {
        ...safeTestCase,
        id: "unsafe-smoke-test",
        location: { ...safeTestCase.location, line: 3 },
        tags: ["@commerce", `@${privateSentinel}`],
        title: unsafeTitle,
      } as TestCase
      reporter.onTestEnd?.(safeTestCase, {
        attachments: [],
        duration: 11,
        retry: 0,
        status: "passed",
        stderr: [],
        stdout: [],
        steps: [],
      } as unknown as TestResult)
      reporter.onTestEnd?.(unsafeTestCase, {
        attachments: [{ name: privateSentinel }],
        duration: 17,
        error: {
          location: unsafeTestCase.location,
          message: privateSentinel,
          stack: privateSentinel,
        },
        retry: 0,
        status: "passed",
        stderr: [privateSentinel],
        stdout: [privateSentinel],
        steps: [{ title: privateSentinel }],
      } as unknown as TestResult)
      reporter.onError?.({ message: privateSentinel } as TestError)
      reporter.onEnd?.({ status: "passed" } as FullResult)

      const serialized = readFileSync(outputFile, "utf8")
      const report = JSON.parse(serialized) as Record<string, unknown>
      expect(serialized.includes(privateSentinel)).toBe(false)
      expect(Object.keys(report).sort()).toEqual([
        "config",
        "errors",
        "stats",
        "suites",
      ])
      expect(report.config).toEqual({
        metadata: {
          smokeEvidence: {
            baseSha: "a".repeat(40),
            sourceHeadSha: "b".repeat(40),
            testedSha: "c".repeat(40),
          },
        },
      })
      expect(report.suites).toEqual([
        {
          specs: [
            {
              file: "e2e/commerce.playwright.ts",
              line: 1,
              ok: true,
              tags: ["@commerce"],
              tests: [
                {
                  expectedStatus: "passed",
                  results: [
                    {
                      duration: 11,
                      retry: 0,
                      status: "passed",
                    },
                  ],
                  status: "expected",
                },
              ],
              title: safeTitle,
            },
            {
              file: "e2e/commerce.playwright.ts",
              line: 3,
              ok: true,
              tags: ["@commerce"],
              tests: [
                {
                  expectedStatus: "passed",
                  results: [
                    {
                      duration: 17,
                      error: {
                        location: {
                          column: 1,
                          file: "e2e/commerce.playwright.ts",
                          line: 3,
                        },
                      },
                      retry: 0,
                      status: "passed",
                    },
                  ],
                  status: "expected",
                },
              ],
              title: "redacted smoke test",
            },
          ],
        },
      ])
      if (process.platform !== "win32") {
        expect(statSync(outputFile).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("drops malformed or partial smoke evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))

    try {
      const invalidEvidence = [
        {
          baseSha: "A".repeat(40),
          sourceHeadSha: "b".repeat(40),
          testedSha: "c".repeat(40),
        },
        {
          baseSha: "a".repeat(39),
          sourceHeadSha: "b".repeat(40),
          testedSha: "c".repeat(40),
        },
        {
          baseSha: "a".repeat(40),
          sourceHeadSha: "b".repeat(40),
        },
      ]

      for (const [index, smokeEvidence] of invalidEvidence.entries()) {
        const outputFile = join(directory, `results-${index}.json`)
        const reporter = new PrivacySafeSmokeReporter({ outputFile })
        reporter.onBegin?.(
          {
            metadata: {
              smokeEvidence,
            },
          } as FullConfig,
          {} as Suite
        )
        reporter.onEnd?.({ status: "passed" } as FullResult)

        expect(JSON.parse(readFileSync(outputFile, "utf8")).config).toEqual({
          metadata: {},
        })
      }
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
