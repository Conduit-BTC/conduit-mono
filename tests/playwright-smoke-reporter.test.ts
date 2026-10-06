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

import {
  PrivacySafeSmokeReporter,
  safePlaywrightSmokeId,
} from "../scripts/ci/playwright_smoke_reporter"

import {
  decodeProductSubmitDiagnostic,
  productSubmitDiagnosticAttachment,
} from "../scripts/ci/product_submit_diagnostics"
import {
  buildPlaywrightSmokeManifest,
  validatePlaywrightSmokeExecution,
} from "../scripts/ci/validate_playwright_smoke_areas"

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
      const progressFile = join(directory, "progress.log")
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
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
        { allTests: () => [1, 2] } as unknown as Suite
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
      reporter.onTestBegin?.(safeTestCase, {
        retry: 0,
      } as TestResult)
      reporter.onTestEnd?.(safeTestCase, {
        attachments: [],
        duration: 11,
        retry: 0,
        status: "passed",
        stderr: [],
        stdout: [],
        steps: [],
      } as unknown as TestResult)
      reporter.onTestBegin?.(unsafeTestCase, {
        retry: 0,
      } as TestResult)
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
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized) as Record<string, unknown>
      expect(serialized.includes(privateSentinel)).toBe(false)
      expect(progress.includes(privateSentinel)).toBe(false)
      expect(progress).toContain("[smoke] selected=2")
      expect(progress).toContain("redacted smoke test")
      expect(progress).toContain("duration=17ms retry=0 status=passed")
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
              project: "unknown",
              smokeId: safePlaywrightSmokeId("safe-smoke-test"),
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
              project: "unknown",
              smokeId: safePlaywrightSmokeId("unsafe-smoke-test"),
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
        expect(statSync(progressFile).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("preserves only bounded shipping submit categories for the failed attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-readiness-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const sourceFile = join(
      directory,
      "e2e/merchant-shipping-tables.playwright.ts"
    )
    const sentinel = "private-readiness-value-must-not-be-serialized"
    const evidence = {
      baseSha: "a".repeat(40),
      sourceHeadSha: "b".repeat(40),
      testedSha: "c".repeat(40),
    }
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        sourceFile,
        'test("shipping smoke @merchant", async () => {})'
      )
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin(
        { metadata: { smokeEvidence: evidence } } as FullConfig,
        { allTests: () => [1] } as unknown as Suite
      )
      const testCase = {
        expectedStatus: "passed",
        id: "shipping-test",
        location: { file: sourceFile, line: 1, column: 1 },
        ok: () => true,
        outcome: () => "flaky",
        tags: ["@merchant"],
        title: "shipping smoke @merchant",
      } as TestCase
      const attachment = {
        name: productSubmitDiagnosticAttachment,
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({ blockers: ["form-invalid", "signer-unready"] })
        ),
        path: sentinel,
      }
      reporter.onTestEnd(testCase, {
        attachments: [
          attachment,
          { ...attachment, name: sentinel, body: Buffer.from(sentinel) },
        ],
        duration: 100,
        error: { location: testCase.location, message: sentinel },
        retry: 0,
        status: "failed",
      } as unknown as TestResult)
      reporter.onTestEnd(testCase, {
        attachments: [attachment],
        duration: 50,
        retry: 1,
        status: "passed",
      } as unknown as TestResult)
      reporter.onEnd({ status: "passed" } as FullResult)
      const serialized = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized)
      const attempts = report.suites[0].specs[0].tests[0].results
      expect(attempts[0].productSubmitBlockers).toEqual([
        "signer-unready",
        "form-invalid",
      ])
      expect(attempts[1].productSubmitBlockers).toBeUndefined()
      expect(progress).toContain("blockers=signer-unready,form-invalid")
      expect(serialized).not.toContain(sentinel)
      expect(progress).not.toContain(sentinel)
      const manifest = buildPlaywrightSmokeManifest(
        report,
        ["merchant"],
        evidence
      )
      expect(() =>
        validatePlaywrightSmokeExecution(
          report,
          manifest,
          ["merchant"],
          evidence
        )
      ).toThrow("Product submit blockers: signer-unready, form-invalid.")
      // A retry pass must still fail the aggregate acceptance policy.
      expect(() =>
        validatePlaywrightSmokeExecution(
          report,
          manifest,
          ["merchant"],
          evidence
        )
      ).toThrow("retry-dependent smoke tests as flaky")
      attempts[0].productSubmitBlockers = [sentinel]
      try {
        validatePlaywrightSmokeExecution(
          report,
          manifest,
          ["merchant"],
          evidence
        )
      } catch (error) {
        expect(String(error)).not.toContain(sentinel)
      }
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("drops malformed, oversized, file-backed, duplicated, and unrelated readiness attachments", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-readiness-"))
    const sentinel = "private-diagnostic-sentinel"
    const valid = {
      name: productSubmitDiagnosticAttachment,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ blockers: ["save-pending"] })),
    }
    try {
      const sourceFile = join(
        directory,
        "e2e/merchant-shipping-tables.playwright.ts"
      )
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        sourceFile,
        'test("shipping smoke @merchant", async () => {})'
      )
      for (const [index, attachments, file] of [
        [0, [{ ...valid, body: Buffer.from(sentinel) }], sourceFile],
        [
          1,
          [
            {
              ...valid,
              body: Buffer.from(JSON.stringify({ blockers: [sentinel] })),
            },
          ],
          sourceFile,
        ],
        [
          2,
          [
            {
              ...valid,
              body: Buffer.from(
                JSON.stringify({ blockers: ["save-pending"], secret: sentinel })
              ),
            },
          ],
          sourceFile,
        ],
        [3, [{ ...valid, body: Buffer.alloc(257, 65) }], sourceFile],
        [4, [{ ...valid, body: undefined, path: sourceFile }], sourceFile],
        [5, [valid, valid], sourceFile],
        [6, [valid], join(directory, "e2e/other.playwright.ts")],
        [7, [{ ...valid, contentType: "text/plain" }], sourceFile],
      ] as const) {
        const outputFile = join(directory, `results-${index}.json`)
        const reporter = new PrivacySafeSmokeReporter({ outputFile })
        const testCase = {
          expectedStatus: "passed",
          id: "shipping-test",
          location: { file, line: 1 },
          ok: () => false,
          outcome: () => "unexpected",
          tags: ["@merchant"],
          title: "shipping smoke @merchant",
        } as TestCase
        reporter.onTestEnd(testCase, {
          attachments,
          duration: 1,
          retry: 0,
          status: "failed",
        } as unknown as TestResult)
        reporter.onEnd({ status: "failed" } as FullResult)
        const serialized = readFileSync(outputFile, "utf8")
        expect(serialized).not.toContain("productSubmitBlockers")
        expect(serialized).not.toContain(sentinel)
      }
      expect(
        decodeProductSubmitDiagnostic(Buffer.from('{"blockers":[]}'))
      ).toEqual([])
      expect(
        decodeProductSubmitDiagnostic(
          Buffer.from('{"blockers":["unavailable"]}')
        )
      ).toEqual(["unavailable"])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("keeps project-specific specs aligned with smoke discovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(sourceDirectory, "mobile.playwright.ts")
    const title = "mobile checkout remains usable @market"

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        `test(${JSON.stringify(title)}, async () => {})\n`
      )
      const reporter = new PrivacySafeSmokeReporter({ outputFile })
      reporter.onBegin?.(
        { metadata: {} } as FullConfig,
        { allTests: () => [1, 2] } as unknown as Suite
      )

      for (const id of ["mobile-chromium-test", "mobile-webkit-test"]) {
        const testCase = {
          expectedStatus: "passed",
          id,
          parent: {
            project: () => ({ name: id.replace("-test", "") }),
          },
          location: { column: 1, file: sourceFile, line: 1 },
          ok: () => true,
          outcome: () => "expected",
          tags: ["@market"],
          title,
        } as TestCase
        reporter.onTestEnd?.(testCase, {
          attachments: [],
          duration: 10,
          retry: 0,
          status: "passed",
          stderr: [],
          stdout: [],
          steps: [],
        } as unknown as TestResult)
      }
      reporter.onEnd?.({ status: "passed" } as FullResult)

      const report = JSON.parse(readFileSync(outputFile, "utf8")) as {
        suites: Array<{
          specs: Array<{ tests: unknown[] }>
        }>
      }
      // The repository's `--list --reporter=json` discovery emits one manifest
      // row per selected mobile project, so execution must retain that shape.
      expect(report.suites[0]?.specs).toHaveLength(2)
      expect(
        report.suites[0]?.specs.every((spec) => spec.tests.length === 1)
      ).toBe(true)
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
          { allTests: () => [] } as unknown as Suite
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
