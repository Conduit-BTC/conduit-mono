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
import { chromium, expect as browserExpect } from "@playwright/test"

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter"

import {
  classifyProductSubmitValidation,
  classifySmokeBrowserError,
  observeMessagesDialogTrigger,
  parseSmokeFailureContext,
  safeRetainedSmokeDiagnostics,
  safeRetainedSmokeFailureContext,
  safeSmokeDiagnostics,
  smokeFailureContextFromAnnotations,
} from "../e2e/helpers/smoke-diagnostics"

import {
  PrivacySafeSmokeReporter,
  safePlaywrightSmokeId,
  safePlaywrightRunnerError,
} from "../scripts/ci/playwright_smoke_reporter"

describe("privacy-safe Playwright smoke reporter", () => {
  // The regular unit job does not install browser binaries. Run this bounded
  // DOM control in a Playwright-capable environment with CONDUIT_DOM_CONTROL=1.
  const browserIt = process.env.CONDUIT_DOM_CONTROL === "1" ? it : it.skip
  browserIt(
    "retains a delivered gesture when its dialog immediately unmounts",
    async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          '<button aria-label="Open messages"><svg aria-hidden="true"></svg></button>'
        )
        await page.evaluate(() => {
          document.querySelector("button")!.onclick = () => {
            const dialog = document.createElement("div")
            dialog.setAttribute("role", "dialog")
            dialog.textContent = "Private message must not leave the page"
            document.body.append(dialog)
            setTimeout(() => dialog.remove(), 0)
          }
        })
        const probe = await observeMessagesDialogTrigger(page)
        try {
          await page.getByRole("button", { name: "Open messages" }).click()
          await browserExpect
            .poll(() => probe.evaluate((value) => value.read().dialogRemoved))
            .toBe(true)
          const observation = await probe.evaluate((value) => value.read())
          expect(observation).toMatchObject({
            triggerCount: 1,
            pointerDownOnTrigger: true,
            pointerUpOnTrigger: true,
            clickOnTrigger: true,
            dialogMounted: true,
            dialogRemoved: true,
            dialogCount: 0,
            visibleDialogCount: 0,
          })
          expect(JSON.stringify(observation)).not.toContain("Private message")
        } finally {
          await probe.evaluate((value) => value.dispose())
          await probe.dispose()
        }
      } finally {
        await browser.close()
      }
    }
  )

  it("classifies browser failures without retaining error text or URLs", () => {
    const privateText = "private-" + crypto.randomUUID()
    for (const [message, expected] of [
      [
        `Navigation to ${privateText} interrupted by another navigation`,
        "navigation_interrupted",
      ],
      [`net::ERR_CONNECTION_REFUSED at ${privateText}`, "connection_refused"],
      [`net::ERR_CONNECTION_RESET ${privateText}`, "connection_reset"],
      [`net::ERR_NAME_NOT_RESOLVED ${privateText}`, "name_resolution"],
      [`Target page closed ${privateText}`, "target_closed"],
      [privateText, "unknown"],
    ]) {
      const category = classifySmokeBrowserError(new Error(message))
      expect(category).toBe(expected)
      expect(category).not.toContain(privateText)
    }
    const timeout = new Error(privateText)
    timeout.name = "TimeoutError"
    expect(classifySmokeBrowserError(timeout)).toBe("timeout")
    expect(classifySmokeBrowserError({ message: privateText })).toBe("unknown")
  })
  browserIt(
    "uses the nested form status when an image announcement persists",
    async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(`
          <div role="dialog">
            <form>
              <fieldset>
                <input id="product-shipping-weight" aria-invalid="true" />
                <p aria-live="polite">Opened primary image URL entry.</p>
              </fieldset>
              <div aria-live="polite">Add the shipping weight in grams to use your shipping table.</div>
            </form>
          </div>
        `)
        const dialog = page.locator('[role="dialog"]')
        expect(await dialog.evaluate(classifyProductSubmitValidation)).toBe(
          "measurements"
        )
        await dialog
          .locator('form > div[aria-live="polite"]')
          .evaluate((node) => node.remove())
        expect(await dialog.evaluate(classifyProductSubmitValidation)).toBe(
          "unknown"
        )
      } finally {
        await browser.close()
      }
    }
  )

  it("retains the historical other validation category", () => {
    expect(
      safeSmokeDiagnostics("e2e/merchant-shipping-tables.playwright.ts", [
        {
          type: "smoke:product-submit",
          description: JSON.stringify({ validation: "other" }),
        },
      ])
    ).toEqual([{ kind: "product-submit", validation: "other" }])
  })

  it("rejects malformed, cross-file, and conflicting failure context", () => {
    const file = "e2e/merchant-order-inbox.playwright.ts"
    const privateValue = "private-" + crypto.randomUUID()
    const safe = {
      boundary: "app-readiness",
      expected: "buyer_dialog_ready",
      observed: "unmet",
    }
    expect(
      parseSmokeFailureContext(file, {
        expected: "buyer_dialog_ready",
        observed: "unmet",
      })
    ).toEqual(safe)
    expect(safeRetainedSmokeFailureContext(file, safe)).toEqual(safe)
    expect(
      safeRetainedSmokeFailureContext(file, {
        ...safe,
        boundary: "relay-provider",
      })
    ).toBeUndefined()
    expect(
      parseSmokeFailureContext("e2e/wallet-sign-in.playwright.ts", {
        expected: "buyer_dialog_ready",
        observed: "unmet",
      })
    ).toBeUndefined()
    for (const value of [
      { expected: privateValue, observed: "pending" },
      { expected: "__proto__", observed: "pending" },
      { expected: "constructor", observed: "pending" },
      { expected: "buyer_dialog_ready", observed: privateValue },
      {
        expected: "buyer_dialog_ready",
        observed: "pending",
        detail: privateValue,
      },
    ]) {
      expect(parseSmokeFailureContext(file, value)).toBeUndefined()
    }
    expect(
      smokeFailureContextFromAnnotations(file, [
        {
          type: "smoke:failure-context",
          description: JSON.stringify({
            expected: "buyer_dialog_ready",
            observed: "unmet",
          }),
        },
        {
          type: "smoke:failure-context",
          description: JSON.stringify({
            expected: "buyer_dialog_ready",
            observed: "unmet",
          }),
        },
      ])
    ).toBeUndefined()
    expect(
      safeRetainedSmokeDiagnostics(file, [
        {
          kind: "order-reply",
          phase: "buyer_reply",
          dialogVisible: false,
          privateValue,
        },
      ])
    ).toEqual([
      { kind: "order-reply", phase: "buyer_reply", dialogVisible: false },
    ])
    expect(
      safeRetainedSmokeDiagnostics("e2e/commerce.playwright.ts", [
        { kind: "commerce-journey", phase: "checkout", elapsedSeconds: 12.3 },
      ])
    ).toEqual([{ kind: "commerce-journey", phase: "checkout" }])
    expect(
      safePlaywrightRunnerError({ phase: "startup", category: "web-server" })
    ).toEqual({ phase: "startup", category: "web-server" })
    expect(
      safePlaywrightRunnerError({
        phase: "startup",
        category: "web-server",
        message: privateValue,
      })
    ).toBeUndefined()
  })

  it("retains a closed router phase and body timeout boundary without raw errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(
      sourceDirectory,
      "commerce-router-recovery.playwright.ts"
    )
    const title = "native router recovery remains isolated @commerce"
    const router = {
      phase: "cold Merchant reload navigation completes",
      lifecycle: "body",
      body: "running",
    }
    const privateSentinel = "private-router-error-must-not-be-serialized"

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        `test(${JSON.stringify(title)}, async () => {})`
      )
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin?.(
        { metadata: {} } as FullConfig,
        { allTests: () => [1] } as unknown as Suite
      )
      const testCase = {
        expectedStatus: "passed",
        id: "router-body-timeout",
        location: { column: 1, file: sourceFile, line: 1 },
        ok: () => false,
        outcome: () => "unexpected",
        tags: ["@commerce"],
        title,
      } as TestCase
      reporter.onTestEnd?.(testCase, {
        annotations: [
          { type: "router-phase", description: JSON.stringify(router) },
        ],
        duration: 240_001,
        error: { message: privateSentinel, stack: privateSentinel },
        retry: 0,
        status: "timedOut",
      } as TestResult)
      reporter.onEnd?.({ status: "timedout" } as FullResult)

      const serialized = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized)
      expect(report.suites[0].specs[0].tests[0].results[0].router).toEqual(
        router
      )
      expect(progress).toContain(
        'router_phase="cold Merchant reload navigation completes" router_lifecycle=body router_body=running'
      )
      expect(serialized).not.toContain(privateSentinel)
      expect(progress).not.toContain(privateSentinel)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("drops unknown, partial, duplicate, inconsistent, non-string and non-router tuples", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(
      sourceDirectory,
      "commerce-router-recovery.playwright.ts"
    )
    const ordinarySourceFile = join(sourceDirectory, "commerce.playwright.ts")
    const title = "native router diagnostics reject unapproved data @commerce"
    const privateSentinel = "private-router-annotation-must-not-be-serialized"
    const safe = {
      phase: "cold Merchant reload navigation completes",
      lifecycle: "body",
      body: "running",
    }
    const annotation = (value: unknown) => ({
      type: "router-phase",
      description: JSON.stringify(value),
    })
    const invalidAnnotations = [
      [annotation({ ...safe, phase: privateSentinel })],
      [annotation({ ...safe, lifecycle: privateSentinel })],
      [annotation({ ...safe, body: privateSentinel })],
      [annotation({ phase: safe.phase, lifecycle: safe.lifecycle })],
      [annotation({ ...safe, extra: privateSentinel })],
      [annotation(safe), annotation(safe)],
      [annotation(safe), annotation({ ...safe, lifecycle: "teardown" })],
      [annotation({ ...safe, lifecycle: "teardown" })],
      [annotation({ ...safe, body: "completed" })],
      [annotation({ ...safe, lifecycle: ["body"], body: ["running"] })],
      [{ type: "router-phase", description: privateSentinel }],
      [annotation(safe)],
    ]

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        `test(${JSON.stringify(title)}, async () => {})`
      )
      writeFileSync(
        ordinarySourceFile,
        `test(${JSON.stringify(title)}, async () => {})`
      )
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin?.(
        { metadata: {} } as FullConfig,
        { allTests: () => invalidAnnotations } as unknown as Suite
      )
      for (const [index, annotations] of invalidAnnotations.entries()) {
        reporter.onTestEnd?.(
          {
            expectedStatus: "passed",
            id: `router-invalid-tuple-${index}`,
            location: {
              column: 1,
              file:
                index === invalidAnnotations.length - 1
                  ? ordinarySourceFile
                  : sourceFile,
              line: 1,
            },
            ok: () => false,
            outcome: () => "unexpected",
            tags: ["@commerce"],
            title,
          } as TestCase,
          {
            annotations,
            duration: 3,
            retry: 0,
            status: "timedOut",
          } as TestResult
        )
      }
      reporter.onEnd?.({ status: "timedout" } as FullResult)
      const serialized = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized)
      expect(
        report.suites[0].specs.every(
          (spec: { tests: Array<{ results: Array<{ router?: unknown }> }> }) =>
            spec.tests[0]?.results[0]?.router === undefined
        )
      ).toBe(true)
      expect(serialized).not.toContain(privateSentinel)
      expect(progress).not.toContain(privateSentinel)
      expect(progress).not.toContain("router_phase=")
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

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

  it("emits the closed hermetic network diagnostic fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(
      sourceDirectory,
      "commerce-router-recovery.playwright.ts"
    )
    const title = "native router recovery remains isolated @commerce"

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        `test(${JSON.stringify(title)}, async () => {})\n`
      )
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin?.(
        { metadata: {} } as FullConfig,
        { allTests: () => [1] } as unknown as Suite
      )
      const testCase = {
        expectedStatus: "passed",
        id: "router-network-failure",
        location: { column: 1, file: sourceFile, line: 1 },
        ok: () => false,
        outcome: () => "unexpected",
        tags: ["@commerce"],
        title,
      } as TestCase
      reporter.onTestEnd?.(testCase, {
        annotations: [
          { type: "hermetic-network-operation", description: "deliver" },
          {
            type: "hermetic-network-source",
            description: "current_document",
          },
          {
            type: "hermetic-network-category",
            description: "connection_refused",
          },
        ],
        duration: 19,
        retry: 0,
        status: "failed",
      } as TestResult)
      reporter.onEnd?.({ status: "failed" } as FullResult)

      const serialized = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized) as {
        suites: Array<{
          specs: Array<{
            tests: Array<{
              results: Array<{ diagnostic?: unknown }>
            }>
          }>
        }>
      }
      expect(
        report.suites[0]?.specs[0]?.tests[0]?.results[0]?.diagnostic
      ).toEqual({
        operation: "deliver",
        source: "current_document",
        category: "connection_refused",
      })
      expect(progress).toContain(
        "diagnostic_operation=deliver diagnostic_source=current_document diagnostic_category=connection_refused"
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("drops arbitrary diagnostic annotations and raw failure details", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-reporter-"))
    const outputFile = join(directory, "results.json")
    const progressFile = join(directory, "progress.log")
    const sourceDirectory = join(directory, "e2e")
    const sourceFile = join(sourceDirectory, "commerce.playwright.ts")
    const privateSentinel = "private-diagnostic-must-not-be-serialized"
    const titles = [
      "router diagnostic rejects an unknown name @commerce",
      "router diagnostic rejects an unknown value @commerce",
    ]

    try {
      mkdirSync(sourceDirectory)
      writeFileSync(
        sourceFile,
        titles
          .map((title) => `test(${JSON.stringify(title)}, async () => {})`)
          .join("\n")
      )
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin?.(
        { metadata: {} } as FullConfig,
        { allTests: () => [1, 2] } as unknown as Suite
      )
      for (const [index, title] of titles.entries()) {
        const testCase = {
          expectedStatus: "passed",
          id: `unsafe-router-diagnostic-${index}`,
          location: { column: 1, file: sourceFile, line: index + 1 },
          ok: () => false,
          outcome: () => "unexpected",
          tags: ["@commerce"],
          title,
        } as TestCase
        reporter.onTestEnd?.(testCase, {
          annotations:
            index === 0
              ? [{ type: privateSentinel, description: privateSentinel }]
              : [
                  {
                    type: "hermetic-network-operation",
                    description: privateSentinel,
                  },
                  {
                    type: "hermetic-network-source",
                    description: "current_document",
                  },
                  {
                    type: "hermetic-network-category",
                    description: privateSentinel,
                  },
                ],
          duration: 23,
          error: { message: privateSentinel, stack: privateSentinel },
          retry: 0,
          status: "failed",
        } as TestResult)
      }
      reporter.onEnd?.({ status: "failed" } as FullResult)

      const serialized = readFileSync(outputFile, "utf8")
      const progress = readFileSync(progressFile, "utf8")
      const report = JSON.parse(serialized) as {
        suites: Array<{
          specs: Array<{
            tests: Array<{
              results: Array<{ diagnostic?: unknown }>
            }>
          }>
        }>
      }
      expect(serialized).not.toContain(privateSentinel)
      expect(progress).not.toContain(privateSentinel)
      expect(
        report.suites[0]?.specs.every(
          (spec) => spec.tests[0]?.results[0]?.diagnostic === undefined
        )
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

describe("browser process diagnostics", () => {
  it("emits fixed categories while discarding arbitrary stderr and process details", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-browser-signals-"))
    try {
      const outputFile = join(directory, "report.json")
      const progressFile = join(directory, "progress.log")
      const reporter = new PrivacySafeSmokeReporter({
        outputFile,
        progressFile,
      })
      reporter.onBegin(
        { metadata: {} } as FullConfig,
        { allTests: () => [] } as unknown as Suite
      )
      const privateValue = crypto.randomUUID()
      reporter.onStdErr(`unrelated Network process crashed ${privateValue}`)
      reporter.onStdErr(`pw:browser <launched> pid=1234 ${privateValue}`)
      reporter.onStdErr(
        Buffer.from(
          `pw:browser [pid=1234][err] Network process crashed ${privateValue}`
        )
      )
      reporter.onStdErr(
        `pw:browser <process did exit: signal=SIGSEGV> ${privateValue}`
      )
      reporter.onStdErr(
        `pw:browser [err] malloc(): corrupted double-linked list ${privateValue}`
      )
      reporter.onStdErr(
        `pw:browser <process did exit: signal=SIGABRT> ${privateValue}`
      )
      reporter.onStdErr(`pw:browser arbitrary output ${privateValue}`)
      reporter.onEnd({ status: "failed" } as FullResult)
      const progress = readFileSync(progressFile, "utf8")
      const report = readFileSync(outputFile, "utf8")
      expect(progress).toContain(
        'browser-signals {"launched":1,"networkProcessCrashed":1,"segmentationFault":1,"aborted":1,"heapCorruption":1}'
      )
      expect(progress + report).not.toContain(privateValue)
      expect(progress + report).not.toContain("pid=1234")
      expect(progress + report).not.toContain("arbitrary output")
      expect(progress + report).not.toContain("malloc()")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("bounded smoke failure diagnostics", () => {
  it("retains only bounded foreground wallet state counts and availability", () => {
    const privateValue = crypto.randomUUID()
    const annotation = {
      type: "smoke:wallet-foreground-open",
      description: JSON.stringify({
        runtimeLockedCount: 1,
        runtimeConnectingCount: 0,
        runtimeReadyCount: 0,
        runtimeErrorCount: 1,
        runtimeMissingCount: 0,
        sparkAvailability: "ready",
        walletId: privateValue,
        error: privateValue,
        balance: privateValue,
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/wallet-cross-app.playwright.ts", [annotation])
    ).toEqual([
      {
        kind: "wallet-foreground-open",
        runtimeLockedCount: 1,
        runtimeConnectingCount: 0,
        runtimeReadyCount: 0,
        runtimeErrorCount: 1,
        runtimeMissingCount: 0,
        sparkAvailability: "ready",
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    expect(
      safeSmokeDiagnostics("e2e/wallet-cross-app.playwright.ts", [
        {
          type: annotation.type,
          description: JSON.stringify({
            sparkAvailability: privateValue,
            runtimeErrorCount: privateValue,
            runtimeMissingCount: 32769,
          }),
        },
      ])
    ).toEqual([])
  })

  it("limits migration diagnostics to fixed phases and route failure categories", () => {
    const privateValue = crypto.randomUUID()
    const annotation = {
      type: "smoke:wallet-migration",
      description: JSON.stringify({
        scenario: "sdk-open",
        phase: "retry",
        elapsedSeconds: 12,
        passwordPresent: true,
        showEnabled: false,
        routeFetchCategory: "aborted",
        routeFetchPageClosed: false,
        routeFetchNavigationRequest: false,
        routeFetchNavigations: 2,
        routeFetchStarts: 3,
        routeFetchCompletes: 2,
        errorMessage: privateValue,
        mnemonic: privateValue,
        password: privateValue,
        walletId: privateValue,
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/wallet-sign-in.playwright.ts", [annotation])
    ).toEqual([
      {
        kind: "wallet-migration",
        scenario: "sdk-open",
        phase: "retry",
        elapsedSeconds: 12,
        passwordPresent: true,
        showEnabled: false,
        routeFetchCategory: "aborted",
        routeFetchPageClosed: false,
        routeFetchNavigationRequest: false,
        routeFetchNavigations: 2,
        routeFetchStarts: 3,
        routeFetchCompletes: 2,
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    expect(
      safeSmokeDiagnostics("e2e/wallet-sign-in.playwright.ts", [
        {
          ...annotation,
          description: JSON.stringify({
            scenario: privateValue,
            phase: privateValue,
          }),
        },
      ])
    ).toEqual([])
  })
  it("retains only fixed Commerce phase, side-effect and menu-state observations", () => {
    const annotations = [
      {
        type: "smoke:commerce-journey",
        description: JSON.stringify({
          buyerObservationAvailable: true,
          buyerLifecyclePaid: true,
          buyerProofSent: true,
          buyerPaidMessages: 0,
          buyerMessageDialogVisible: true,
          phase: "merchant_order",
          elapsedSeconds: 180,
          phaseSeconds: 100,
          slowestPhase: "publish_product",
          slowestSeconds: 20,
          cleanupStarted: true,
          cleanupComplete: false,
          makeInvoice: 0,
          payInvoice: 0,
          lookupInvoice: 0,
          foreignMakeInvoice: 0,
          foreignReceiveCapable: true,
          foreignAlreadyReceiving: false,
          foreignRegistryRefreshObserved: true,
          foreignMenuVisibleBeforeClick: true,
          foreignMenuEnabledBeforeClick: true,
          foreignMenuHitTargetBeforeClick: false,
          foreignWalletId: "private-value",
          orderId: "private-value",
          invoice: "private-value",
          balance: 99,
        }),
      },
    ]
    const [safe] = safeSmokeDiagnostics(
      "e2e/commerce.playwright.ts",
      annotations
    )
    expect(safe).toEqual({
      kind: "commerce-journey",
      buyerObservationAvailable: true,
      buyerLifecyclePaid: true,
      buyerProofSent: true,
      buyerPaidMessages: 0,
      buyerMessageDialogVisible: true,
      phase: "merchant_order",
      elapsedSeconds: 180,
      phaseSeconds: 100,
      slowestPhase: "publish_product",
      slowestSeconds: 20,
      cleanupStarted: true,
      cleanupComplete: false,
      makeInvoice: 0,
      payInvoice: 0,
      lookupInvoice: 0,
      foreignMakeInvoice: 0,
      foreignReceiveCapable: true,
      foreignAlreadyReceiving: false,
      foreignRegistryRefreshObserved: true,
      foreignMenuVisibleBeforeClick: true,
      foreignMenuEnabledBeforeClick: true,
      foreignMenuHitTargetBeforeClick: false,
    })
    expect(
      safeSmokeDiagnostics("e2e/wallet-lifecycle.playwright.ts", annotations)
    ).toEqual([])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [
        {
          type: "smoke:commerce-journey",
          description: JSON.stringify({
            phase: "private-value",
            slowestPhase: "private-value",
            elapsedSeconds: 32769,
          }),
        },
      ])
    ).toEqual([])
  })
  it("exports only allowlisted scalar observations from the matching fixture", () => {
    const annotation = {
      type: "smoke:footer-layout",
      description: JSON.stringify({
        phase: "initial",
        layout: "clipped",
        triggerY: 612.345,
        footerHidden: true,
        widgetMarginBottom: 114.345,
        widgetTransformY: -8.765,
        footerTransformY: 12.345,
        widgetHiddenShift: 114,
        widgetBottomOffset: 114,
        atomicTriggerY: 588.456,
        atomicTriggerBottom: 644.456,
        atomicFooterLinkTop: 644,
        atomicFooterHeight: 80,
        atomicLayout: "intersecting",
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
        widgetMarginBottom: 114.3,
        widgetTransformY: -8.8,
        footerTransformY: 12.3,
        widgetHiddenShift: 114,
        widgetBottomOffset: 114,
        atomicTriggerY: 588.5,
        atomicTriggerBottom: 644.5,
        atomicFooterLinkTop: 644,
        atomicFooterHeight: 80,
        atomicLayout: "intersecting",
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

  it("drops unbounded or nonnumeric footer styles and never exports raw CSS", () => {
    for (const field of [
      "widgetMarginBottom",
      "widgetTransformY",
      "footerTransformY",
      "widgetHiddenShift",
      "widgetBottomOffset",
      "atomicTriggerY",
      "atomicTriggerBottom",
      "atomicFooterLinkTop",
      "atomicFooterHeight",
    ]) {
      for (const value of [
        "private-value",
        "matrix(1, 0, 0, 1, 0, 114)",
        "114px",
        null,
        true,
        {},
        [114],
        32768.1,
        -32768.1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          safeSmokeDiagnostics("e2e/mobile-safari-baseline.playwright.ts", [
            {
              type: "smoke:footer-layout",
              description: JSON.stringify({
                phase: "initial",
                [field]: value,
                rawStyle: "private-value",
                transform: "private-value",
              }),
            },
          ])
        ).toEqual([{ kind: "footer-layout", phase: "initial" }])
      }
    }
  })

  it("keeps atomic footer layout categories closed and geometry bounded", () => {
    for (const atomicLayout of ["missing", "intersecting", "disjoint"]) {
      expect(
        safeSmokeDiagnostics("e2e/mobile-safari-baseline.playwright.ts", [
          {
            type: "smoke:footer-layout",
            description: JSON.stringify({
              phase: "initial",
              atomicLayout,
              atomicTriggerY: -32768,
              atomicTriggerBottom: 32768,
              atomicFooterLinkTop: 0,
              atomicFooterHeight: 80,
              rawDom: "private-value",
              rawStyle: "private-value",
              message: "private-value",
            }),
          },
        ])
      ).toEqual([
        {
          kind: "footer-layout",
          phase: "initial",
          atomicLayout,
          atomicTriggerY: -32768,
          atomicTriggerBottom: 32768,
          atomicFooterLinkTop: 0,
          atomicFooterHeight: 80,
        },
      ])
    }
    for (const atomicLayout of ["private-value", "", null, 1, true, [], {}]) {
      expect(
        safeSmokeDiagnostics("e2e/mobile-safari-baseline.playwright.ts", [
          {
            type: "smoke:footer-layout",
            description: JSON.stringify({
              phase: "initial",
              atomicLayout,
              rawDom: "private-value",
            }),
          },
        ])
      ).toEqual([{ kind: "footer-layout", phase: "initial" }])
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
        failedDocuments: 1,
        pageCrashed: true,
        networkProcessCrashed: true,
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
        pageCrashed: true,
        networkProcessCrashed: true,
        failedDocuments: 1,
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

  it("bounds populated-audit phases and crash observations to that fixture", () => {
    const annotation = {
      type: "smoke:populated-audit",
      description: JSON.stringify({
        phase: "wallet_ready",
        elapsedSeconds: 25.18,
        pageCrashed: true,
        url: "private-value",
        invoice: "private-value",
      }),
    }
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-populated-audit.playwright.ts", [
        annotation,
      ])
    ).toEqual([
      {
        kind: "populated-audit",
        phase: "wallet_ready",
        elapsedSeconds: 25.2,
        pageCrashed: true,
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-surface-audit.playwright.ts", [
        annotation,
      ])
    ).toEqual([])
    expect(
      safeSmokeDiagnostics("e2e/shared-ui-populated-audit.playwright.ts", [
        {
          ...annotation,
          description: JSON.stringify({
            phase: "private-value",
            elapsedSeconds: 40000,
            pageCrashed: "private-value",
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
          ...(kind === "product-dialog-open"
            ? { triggerStartY: 321.123, triggerDownY: 100, triggerUpY: 12 }
            : {}),
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
          ...(kind === "product-dialog-open"
            ? { triggerStartY: 321.1, triggerDownY: 100, triggerUpY: 12 }
            : {}),
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

  it("retains only coarse image-dialog delivery state for its fixture", () => {
    const file = "e2e/merchant-product-image-preview.playwright.ts"
    const kind = "merchant-image-dialog-open"
    const observation = {
      pointerDownObserved: true,
      pointerDownOnTrigger: true,
      pointerUpObserved: true,
      pointerUpOnTrigger: false,
      clickObserved: true,
      clickOnTrigger: false,
      dialogMounted: false,
      dialogRemoved: false,
      dialogPresent: false,
      triggerConnected: true,
      triggerEnabledAtDown: true,
      triggerEnabledAtClick: true,
      triggerEnabledAfter: true,
      triggerMovementDuringGesture: "moved",
      triggerCountBefore: "one",
      triggerCountAfter: "multiple",
      fontsAtDown: "loaded",
      fontsAtClick: "unknown",
      resumeDraftPresentBefore: true,
      draftKeyStateBefore: "one",
      resumeDraftPresent: true,
      draftKeyState: "one",
    }
    const annotation = {
      type: `smoke:${kind}`,
      description: JSON.stringify({
        ...observation,
        triggerX: 102.453,
        triggerY: 384,
        pubkey: "private-sentinel",
        invoice: "private-sentinel",
      }),
    }
    expect(safeSmokeDiagnostics(file, [annotation])).toEqual([
      { kind, ...observation },
    ])
    expect(
      safeRetainedSmokeDiagnostics(file, [
        { kind, ...observation, rawDom: "private-sentinel" },
      ])
    ).toEqual([{ kind, ...observation }])
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    expect(
      safeSmokeDiagnostics(file, [
        {
          ...annotation,
          description: JSON.stringify({
            triggerMovementDuringGesture: "private-sentinel",
            triggerCountAfter: "private-sentinel",
          }),
        },
      ])
    ).toEqual([])
  })

  it("keeps stalled-journey phases file-bound and strips unapproved values", () => {
    for (const fixture of [
      {
        file: "e2e/merchant-order-inbox.playwright.ts",
        kind: "order-reply",
        phase: "merchant_navigate",
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
    expect(
      safeSmokeDiagnostics("e2e/merchant-order-inbox.playwright.ts", [
        {
          type: "smoke:order-reply",
          description: JSON.stringify({
            phase: "buyer_dialog",
            dialogVisible: true,
            inputPresent: false,
            inputVisible: false,
            inputEnabled: false,
            sendPresent: false,
            focusWithinDialog: true,
            message: "private-value",
          }),
        },
      ])
    ).toEqual([
      {
        kind: "order-reply",
        phase: "buyer_dialog",
        dialogVisible: true,
        inputPresent: false,
        inputVisible: false,
        inputEnabled: false,
        sendPresent: false,
        focusWithinDialog: true,
      },
    ])
    expect(
      safeSmokeDiagnostics("e2e/merchant-product-image-preview.playwright.ts", [
        {
          type: "smoke:fallback-recovery",
          description: JSON.stringify({
            phase: "publish_ready",
            fulfillmentFocusedAtSelection: false,
            tagInputFocused: true,
            committedTagCount: 2,
            publishEnabled: false,
            rawError: "private-value",
          }),
        },
      ])
    ).toEqual([
      {
        kind: "fallback-recovery",
        phase: "publish_ready",
        fulfillmentFocusedAtSelection: false,
        tagInputFocused: true,
        committedTagCount: 2,
        publishEnabled: false,
      },
    ])
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
              validation: "measurements",
              invalidControls: 1,
              invalidTitle: false,
              invalidPrice: false,
              invalidStock: false,
              invalidShippingWeight: true,
              invalidTags: false,
              invalidImages: false,
              invalidOther: false,
              action: "publish",
              invalidControlId: "private-value",
              signedStatusText: "private-value",
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
            validation: "measurements",
            invalidControls: 1,
            invalidTitle: false,
            invalidPrice: false,
            invalidStock: false,
            invalidShippingWeight: true,
            invalidTags: false,
            invalidImages: false,
            invalidOther: false,
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

describe("wallet balance route diagnostics", () => {
  it("retains only bounded wallet route observations for its owning balance file", () => {
    const privateValue = "private-" + crypto.randomUUID()
    const values = {
      routeFetchCategory: "closed",
      routeFetchPageClosed: true,
      routeFetchNavigationRequest: false,
      routeFetchNavigations: 2,
      routeFetchStarts: 1,
      routeFetchCompletes: 0,
      routeFetchStartNavigations: 2,
      routeFetchStartNavigationRequests: 2,
      routeFetchFailureNavigationRequests: 2,
      routeFetchNewNavigationRequested: false,
      walletBalance: privateValue,
      walletId: privateValue,
      errorMessage: privateValue,
    }
    const annotation = {
      type: "smoke:wallet-balances",
      description: JSON.stringify(values),
    }
    const expected = { kind: "wallet-balances", ...values }
    delete (expected as Record<string, unknown>).walletBalance
    delete (expected as Record<string, unknown>).walletId
    delete (expected as Record<string, unknown>).errorMessage
    const retained = safeSmokeDiagnostics("e2e/wallet-balances.playwright.ts", [
      annotation,
    ])
    expect(retained).toEqual([expected])
    expect(JSON.stringify(retained)).not.toContain(privateValue)
    expect(
      safeRetainedSmokeDiagnostics(
        "e2e/wallet-balances.playwright.ts",
        retained
      )
    ).toEqual([expected])
    for (const file of [
      "e2e/wallet-cross-app.playwright.ts",
      "e2e/wallet-sign-in.playwright.ts",
      "e2e/commerce.playwright.ts",
    ]) {
      expect(safeSmokeDiagnostics(file, [annotation])).toEqual([])
      expect(safeRetainedSmokeDiagnostics(file, retained)).toEqual([])
    }
    for (const [field, value] of [
      ["routeFetchCategory", privateValue],
      ["routeFetchPageClosed", privateValue],
      ["routeFetchStarts", privateValue],
      ["routeFetchStarts", 32_769],
      ["routeFetchStarts", Number.POSITIVE_INFINITY],
    ] as const) {
      const altered = safeSmokeDiagnostics(
        "e2e/wallet-balances.playwright.ts",
        [
          {
            type: annotation.type,
            description: JSON.stringify({ ...values, [field]: value }),
          },
        ]
      )
      expect(altered[0]).not.toHaveProperty(field)
      expect(JSON.stringify(altered)).not.toContain(privateValue)
    }
  })
})

describe("commerce inbox reconnect diagnostics", () => {
  it("retains only bounded observations from the owning inbox case", () => {
    const privateValue = "private-" + crypto.randomUUID()
    const values = {
      observationAvailable: true,
      controlCount: 1,
      controlVisible: true,
      dialogCount: 0,
      composerVisible: true,
      bodyMatchCount: 2,
      visibleBodyMatchCount: 1,
      loadingHistoryVisible: false,
      emptyHistoryVisible: false,
      unavailableHistoryVisible: false,
      buyerDirectCountReachedThreeBeforeReconnect: true,
      sessionCurrent: true,
      providerReady: true,
      localObservationAvailable: true,
      localCoverage: "partial",
      localDirectCount: 5,
      localReplyRetained: true,
      localPending: false,
      localStorageFailed: false,
    }
    const annotation = {
      type: "smoke:commerce-inbox-reconnect",
      description: JSON.stringify({ ...values, message: privateValue }),
    }
    const retained = safeSmokeDiagnostics("e2e/commerce-inbox.playwright.ts", [
      annotation,
    ])
    expect(retained).toEqual([{ kind: "commerce-inbox-reconnect", ...values }])
    expect(JSON.stringify(retained)).not.toContain(privateValue)
    expect(
      safeRetainedSmokeDiagnostics("e2e/commerce-inbox.playwright.ts", retained)
    ).toEqual(retained)
    expect(
      safeSmokeDiagnostics("e2e/commerce.playwright.ts", [annotation])
    ).toEqual([])
    expect(
      safeRetainedSmokeDiagnostics("e2e/commerce.playwright.ts", retained)
    ).toEqual([])
    for (const [field, value] of [
      ["controlCount", privateValue],
      ["controlCount", 32_769],
      ["providerReady", privateValue],
      ["localCoverage", privateValue],
    ] as const) {
      const altered = safeSmokeDiagnostics("e2e/commerce-inbox.playwright.ts", [
        {
          type: annotation.type,
          description: JSON.stringify({ ...values, [field]: value }),
        },
      ])
      expect(altered[0]).not.toHaveProperty(field)
      expect(JSON.stringify(altered)).not.toContain(privateValue)
    }
  })
})

describe("wallet recovery and bounded control diagnostics", () => {
  const fixtures = [
    {
      kind: "commerce-buyer-status",
      file: "e2e/commerce.playwright.ts",
      expected: "commerce_buyer_status_accepted_visible",
      boundary: "assertion",
      values: {
        phase: "failure",
        observationAvailable: true,
        dialogMounted: true,
        dialogRemoved: false,
        pointerDownOnTrigger: true,
        pointerUpOnTrigger: true,
        clickOnTrigger: true,
        triggerMovementDuringGesture: "stable",
        dialogCount: 1,
        acceptedCount: 1,
        visibleAcceptedCount: 0,
        sessionCurrent: true,
        providerReady: true,
        localObservationAvailable: true,
        localPending: false,
        localStorageFailed: false,
        localOrderCount: 2,
        localAcceptedCount: 1,
        localCoverage: "complete",
      },
    },
    {
      kind: "wallet-background-refusal",
      file: "e2e/wallet-cross-app.playwright.ts",
      expected: "wallet_refusal_import_ready",
      boundary: "app-readiness",
      values: {
        phase: "foreground_import",
        syncObserved: true,
        syncOutcome: "resolved",
        foregroundImportSettled: false,
        observationAvailable: true,
        lockObservationAvailable: true,
        heldReadInsideAccountSetupLock: false,
        readinessObservationAvailable: true,
        nativeSessionOpen: true,
        targetRuntimeReady: true,
        targetRuntimeConnecting: false,
        targetRuntimeLocked: false,
        targetRuntimeUnavailable: false,
        targetRuntimeError: false,
        walletCount: 2,
        otherReadyWalletCount: 1,
        otherNativeOpenWalletCount: 1,
        readyTextCount: 2,
        readyStateCount: 0,
        openButtonCount: 0,
      },
    },
    {
      kind: "commerce-journey",
      file: "e2e/commerce.playwright.ts",
      expected: "commerce_store_navigation_completed",
      boundary: "app-readiness",
      values: {
        phase: "store_ready",
        navigationObservationAvailable: true,
        navigationResponseObserved: true,
        navigationResponseStatus: 200,
        navigationRequestFailed: true,
        navigationCommitted: false,
        navigationPageClosed: false,
        navigationFailure: "navigation_interrupted",
        buyerReadAfterReload: true,
      },
    },
    {
      kind: "order-reply",
      file: "e2e/merchant-order-inbox.playwright.ts",
      expected: "merchant_messages_dialog_ready",
      boundary: "app-readiness",
      values: {
        phase: "merchant_reply",
        observationAvailable: true,
        triggerCount: 1,
        triggerVisible: true,
        triggerEnabled: true,
        triggerHitTarget: true,
        pointerDownOnTrigger: true,
        pointerUpOnTrigger: true,
        clickOnTrigger: true,
        dialogCount: 0,
        visibleDialogCount: 0,
        dialogMounted: true,
        dialogRemoved: true,
      },
    },
    {
      kind: "mobile-wallet-menu",
      file: "e2e/mobile-safari-baseline.playwright.ts",
      expected: "mobile_wallet_setup_item_ready",
      boundary: "app-readiness",
      values: {
        attempt: "after_reload",
        phase: "menu_removed",
        observationAvailable: true,
        triggerPresent: true,
        triggerEnabled: true,
        walletLoading: false,
        menuMounted: true,
        menuPresent: false,
        menuOpen: false,
        menuRemoved: true,
        itemPresent: false,
        itemVisible: false,
        itemEnabled: false,
        dialogPresent: false,
        pointerDownOnTrigger: true,
        triggerMovementDuringGesture: "stable",
      },
    },
  ] as const
  for (const fixture of fixtures) {
    it(`retains only closed, file-bound ${fixture.kind} observations`, () => {
      const privateValue = "private-" + crypto.randomUUID()
      const annotation = {
        type: `smoke:${fixture.kind}`,
        description: JSON.stringify({
          ...fixture.values,
          walletId: privateValue,
          recoveryPhrase: privateValue,
          lockName: privateValue,
          connectionString: privateValue,
          walletBalance: privateValue,
          errorMessage: privateValue,
          orderId: privateValue,
          pubkey: privateValue,
          plaintext: privateValue,
          ciphertext: privateValue,
          pointerDownY: 120,
        }),
      }
      const retained = safeSmokeDiagnostics(fixture.file, [annotation])
      expect(retained).toEqual([{ kind: fixture.kind, ...fixture.values }])
      expect(safeRetainedSmokeDiagnostics(fixture.file, retained)).toEqual(
        retained
      )
      expect(JSON.stringify(retained)).not.toContain(privateValue)
      expect(retained[0]).not.toHaveProperty("pointerDownY")
      const other = fixtures.find((item) => item.file !== fixture.file)!
      expect(safeSmokeDiagnostics(other.file, [annotation])).toEqual([])
      expect(safeRetainedSmokeDiagnostics(other.file, retained)).toEqual([])
      expect(
        parseSmokeFailureContext(other.file, {
          expected: fixture.expected,
          observed: "pending",
        })
      ).toBeUndefined()
      expect(
        parseSmokeFailureContext(fixture.file, {
          expected: fixture.expected,
          observed: "pending",
        })
      ).toEqual({
        boundary: fixture.boundary,
        expected: fixture.expected,
        observed: "pending",
      })
      for (const field of Object.keys(fixture.values)) {
        const altered = safeSmokeDiagnostics(fixture.file, [
          {
            type: annotation.type,
            description: JSON.stringify({
              ...fixture.values,
              [field]: privateValue,
            }),
          },
        ])
        expect(altered[0]).not.toHaveProperty(field)
        expect(JSON.stringify(altered)).not.toContain(privateValue)
      }
    })
  }
})
