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

import { safeSmokeDiagnostics } from "../e2e/helpers/smoke-diagnostics"

import {
  PrivacySafeSmokeReporter,
  safePlaywrightSmokeId,
} from "../scripts/ci/playwright_smoke_reporter"

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

describe("bounded smoke failure diagnostics", () => {
  it("exports only allowlisted scalar observations from the matching fixture", () => {
    const annotation = {
      type: "smoke:footer-layout",
      description: JSON.stringify({
        phase: "initial",
        layout: "clipped",
        triggerY: 612.345,
        footerHidden: true,
        footerX: "private-value",
        footerY: 1000000,
        viewportWidth: null,
        message: "private-value",
        content: "private-value",
        pubkey: "private-value",
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/mobile-safari-baseline.playwright.ts", [
        annotation,
      ])
    ).toEqual([
      {
        kind: "footer-layout",
        phase: "initial",
        layout: "clipped",
        triggerY: 612.3,
        footerHidden: true,
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    for (const description of [
      "{",
      "[]",
      "null",
      "x".repeat(2049),
      '{"phase":"private-value"}',
    ]) {
      expect(
        safeSmokeDiagnostics("e2e/mobile-safari-baseline.playwright.ts", [
          { ...annotation, description },
        ])
      ).toEqual([])
    }
  })

  it("bounds compact-price pointer and upload diagnostics to their owning files", () => {
    for (const [kind, file, values, expected] of [
      [
        "price-interaction",
        "e2e/shared-ui-visual-contract.playwright.ts",
        { click: false, quantity: 1 },
        { kind: "price-interaction", click: false, quantity: 1 },
      ],
      [
        "footer-follow",
        "e2e/mobile-safari-baseline.playwright.ts",
        { phase: "hidden", footerTop: 700, footerHidden: false },
        {
          kind: "footer-follow",
          phase: "hidden",
          footerTop: 700,
          footerHidden: false,
        },
      ],
      [
        "fallback-upload",
        "e2e/merchant-product-image-preview.playwright.ts",
        { phase: "publish", inboxPrompt: true },
        { kind: "fallback-upload", phase: "publish", inboxPrompt: true },
      ],
    ] as const) {
      const annotation = {
        type: `smoke:${kind}`,
        description: JSON.stringify({
          ...values,
          url: "private-value",
          pubkey: "private-value",
          content: "private-value",
        }),
      }
      expect(safeSmokeDiagnostics(file, [annotation])).toEqual([expected])
      expect(
        safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
      ).toEqual([])
    }
  })

  it("allows only fixed surface phases and scalar pending-resource observations", () => {
    const annotation = {
      type: "smoke:surface-audit",
      description: JSON.stringify({
        phase: "navigate",
        routeIndex: 4,
        pendingImages: 2,
        navigationError: "aborted",
        url: "private-value",
        pubkey: "private-value",
        message: "private-value",
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-surface-audit.playwright.ts", [
        annotation,
      ])
    ).toEqual([
      {
        kind: "surface-audit",
        phase: "navigate",
        routeIndex: 4,
        pendingImages: 2,
        navigationError: "aborted",
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-surface-audit.playwright.ts", [
        {
          ...annotation,
          description: JSON.stringify({
            phase: "private-value",
            url: "private-value",
          }),
        },
      ])
    ).toEqual([])
  })

  it("allows only fixed cart phases without cart contents or identity", () => {
    const annotation = {
      type: "smoke:cart-stale-action",
      description: JSON.stringify({
        phase: "stale_decrease",
        tabIndex: 1,
        items: "private-value",
        pubkey: "private-value",
        url: "private-value",
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/market-cart-concurrency.playwright.ts", [
        annotation,
      ])
    ).toEqual([
      { kind: "cart-stale-action", phase: "stale_decrease", tabIndex: 1 },
    ])
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-surface-audit.playwright.ts", [
        annotation,
      ])
    ).toEqual([])
  })

  it("keeps content-free dialog observations bound to each owning fixture", () => {
    for (const [kind, file, otherOwner] of [
      [
        "product-dialog-open",
        "e2e/commerce.playwright.ts",
        "e2e/merchant-variation-shipping.playwright.ts",
      ],
      [
        "variation-dialog-open",
        "e2e/merchant-variation-shipping.playwright.ts",
        "e2e/commerce.playwright.ts",
      ],
    ] as const) {
      const annotation = {
        type: `smoke:${kind}`,
        description: JSON.stringify({
          pointerDownOnTrigger: true,
          pointerUpOnTrigger: false,
          clickOnTrigger: false,
          dialogMounted: false,
          dialogRemoved: false,
          dialogPresent: false,
          triggerEnabled: true,
          fontsAtClick: "loading",
          triggerX: 212.345,
          triggerWidth: Infinity,
          triggerHeight: "private-value",
          pubkey: "private-value",
          connectionString: "private-value",
          message: "private-value",
        }),
      }
      expect(safeSmokeDiagnostics(file, [annotation])).toEqual([
        {
          kind,
          pointerDownOnTrigger: true,
          pointerUpOnTrigger: false,
          clickOnTrigger: false,
          dialogMounted: false,
          dialogRemoved: false,
          dialogPresent: false,
          triggerEnabled: true,
          fontsAtClick: "loading",
          triggerX: 212.3,
        },
      ])
      expect(
        safeSmokeDiagnostics("e2e/merchant-shipping-tables.playwright.ts", [
          annotation,
        ])
      ).toEqual([])
      expect(
        safeSmokeDiagnostics(file, [
          {
            ...annotation,
            description:
              '{"fontsAtClick":"private-value","clickOnTrigger":"private-value"}',
          },
        ])
      ).toEqual([])
      expect(safeSmokeDiagnostics(otherOwner, [annotation])).toEqual([])
    }
  })

  it("keeps stalled-journey phases file-bound and strips unapproved values", () => {
    for (const fixture of [
      {
        file: "e2e/merchant-order-inbox.playwright.ts",
        kind: "order-reply",
        phase: "buyer_checkout",
      },
      {
        file: "e2e/merchant-product-image-preview.playwright.ts",
        kind: "fallback-recovery",
        phase: "restore_draft",
      },
    ]) {
      const annotation = {
        type: `smoke:${fixture.kind}`,
        description: JSON.stringify({
          phase: fixture.phase,
          pubkey: "private-value",
          content: "private-value",
          rawError: "private-value",
        }),
      }
      expect(safeSmokeDiagnostics(fixture.file, [annotation])).toEqual([
        { kind: fixture.kind, phase: fixture.phase },
      ])
      expect(
        safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
      ).toEqual([])
      expect(
        safeSmokeDiagnostics(fixture.file, [
          { ...annotation, description: '{"phase":"private-value"}' },
        ])
      ).toEqual([])
    }
  })

  it("keeps first-attempt readiness evidence in the report and failure progress without private annotations", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-diagnostic-"))
    try {
      const outputFile = join(directory, "results.json")
      const progressFile = join(directory, "progress.log")
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      const testCase = {
        id: "diagnostic-case",
        title: "redacted",
        expectedStatus: "passed",
        location: {
          file: "e2e/merchant-shipping-tables.playwright.ts",
          line: 390,
          column: 1,
        },
        ok: () => false,
        outcome: () => "flaky",
        tags: ["@merchant"],
      } as TestCase
      reporter.onBegin(
        { metadata: {} } as FullConfig,
        { allTests: () => [testCase] } as unknown as Suite
      )
      reporter.onTestEnd(testCase, {
        duration: 12,
        retry: 0,
        status: "failed",
        annotations: [
          {
            type: "smoke:product-submit",
            description: JSON.stringify({
              phase: "first_product",
              present: true,
              enabled: false,
              signerAvailable: true,
              validation: "images",
              action: "publish",
              rawError: "private-value",
            }),
          },
          { type: "private", description: "private-value" },
        ],
      } as unknown as TestResult)
      reporter.onTestEnd(testCase, {
        duration: 10,
        retry: 1,
        status: "passed",
        annotations: [],
      } as unknown as TestResult)
      reporter.onEnd({ status: "passed" } as FullResult)
      const report = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const parsed = JSON.parse(report)
      expect(parsed.suites[0].specs[0].tests[0].results[0].diagnostics).toEqual(
        [
          {
            kind: "product-submit",
            phase: "first_product",
            present: true,
            enabled: false,
            signerAvailable: true,
            validation: "images",
            action: "publish",
          },
        ]
      )
      expect(progress).toContain("diagnostic retry=0")
      expect(progress).toContain('"signerAvailable":true')
      expect(report + progress).not.toContain("private-value")
      expect(JSON.parse(report).stats.flaky).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
