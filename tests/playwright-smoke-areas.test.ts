import { describe, expect, it } from "bun:test"

import {
  buildPlaywrightSmokeManifest,
  type PlaywrightJsonReport,
  validatePlaywrightSmokeAreas,
  validatePlaywrightSmokeExecution,
} from "../scripts/ci/validate_playwright_smoke_areas"
import { resolvePlaywrightWebServerTarget } from "../scripts/dev/run_playwright_web_server"

const normalizeLines = (value: string) => value.replaceAll("\r\n", "\n")
const playwrightConfig = normalizeLines(
  await Bun.file("playwright.config.ts").text()
)
const playwrightWebServer = normalizeLines(
  await Bun.file("scripts/dev/run_playwright_web_server.ts").text()
)
const smokeAreaValidator = normalizeLines(
  await Bun.file("scripts/ci/validate_playwright_smoke_areas.ts").text()
)
const ciWorkflow = normalizeLines(
  await Bun.file(".github/workflows/ci.yml").text()
)
const prTitleWorkflow = normalizeLines(
  await Bun.file(".github/workflows/pr-title.yml").text()
)
const previewLinksJob = ciWorkflow.slice(
  ciWorkflow.indexOf("\n  preview-links:\n")
)
const smokeEvidence = {
  baseSha: "b".repeat(40),
  sourceHeadSha: "a".repeat(40),
  testedSha: "c".repeat(40),
}

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
  it("disables app servers during all-area tag discovery", () => {
    expect(smokeAreaValidator).toContain('PLAYWRIGHT_SMOKE_DISCOVERY: "true"')
    expect(playwrightConfig).toContain(
      'process.env.PLAYWRIGHT_SMOKE_DISCOVERY === "true"'
    )
    expect(playwrightConfig).toContain(
      "webServer: smokeDiscovery ? undefined : webServer"
    )
  })

  it("runs smoke against an ephemeral loopback relay", () => {
    expect(playwrightWebServer).toContain("VITE_E2E_RELAY_URL: relayUrl")
    expect(playwrightWebServer).toContain('RELAY_EPHEMERAL: "true"')
    expect(playwrightWebServer).toContain('RELAY_FAULT_MODE: "none"')
    expect(playwrightWebServer).toContain(
      'target === "relay" ? "0" : undefined'
    )
    expect(playwrightConfig).toContain("(?<PLAYWRIGHT_RELAY_PORT>\\d+)")
    expect(playwrightConfig).toContain("wait: {")
    expect(playwrightConfig).toContain("reuseExistingServer: false")
    expect(playwrightConfig).toContain(
      "bun scripts/dev/run_playwright_web_server.ts relay"
    )
  })

  it("preserves an explicit relay port and otherwise requests OS assignment", () => {
    expect(resolvePlaywrightWebServerTarget("relay", {}).env).toMatchObject({
      RELAY_EPHEMERAL: "true",
      RELAY_FAULT_MODE: "none",
      RELAY_PORT: "0",
    })
    expect(
      resolvePlaywrightWebServerTarget("relay", {
        PLAYWRIGHT_RELAY_PORT: "7788",
      }).env.RELAY_PORT
    ).toBe("7788")
    expect(() => resolvePlaywrightWebServerTarget("market", {})).toThrow(
      "PLAYWRIGHT_RELAY_PORT must be captured before starting app servers"
    )
  })

  it("starts the wrapper on an OS-assigned port while 7777 is occupied", async () => {
    let occupiedServer: ReturnType<typeof Bun.serve> | undefined
    try {
      occupiedServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 7777,
        fetch: () => new Response("occupied"),
      })
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error
      }
    }

    const childEnvironment = { ...process.env }
    delete childEnvironment.PLAYWRIGHT_RELAY_PORT
    const child = Bun.spawn(
      ["bun", "scripts/dev/run_playwright_web_server.ts", "relay"],
      {
        cwd: process.cwd(),
        env: childEnvironment,
        stderr: "pipe",
        stdout: "pipe",
      }
    )
    const stdout = child.stdout.getReader()
    const timeout = setTimeout(() => child.kill(), 5_000)

    try {
      const decoder = new TextDecoder()
      let bufferedOutput = ""
      let capturedPort: number | undefined
      while (capturedPort === undefined) {
        const { done, value } = await stdout.read()
        if (done) break
        bufferedOutput += decoder.decode(value, { stream: true })
        const match = bufferedOutput.match(
          /Conduit Bun relay listening on ws:\/\/127\.0\.0\.1:(\d+)/
        )
        if (match?.[1]) capturedPort = Number(match[1])
      }

      if (capturedPort === undefined) {
        throw new Error(
          "Playwright relay wrapper did not report its bound port"
        )
      }
      expect(capturedPort).not.toBe(7777)
      expect((await fetch(`http://127.0.0.1:${capturedPort}/health`)).ok).toBe(
        true
      )
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      stdout.releaseLock()
      occupiedServer?.stop()
    }
  })

  it("propagates the captured relay URL to both app servers", () => {
    const capturedEnvironment = {
      PLAYWRIGHT_RELAY_PORT: "54321",
      PLAYWRIGHT_SMOKE_AREA: "commerce",
    }
    const market = resolvePlaywrightWebServerTarget(
      "market",
      capturedEnvironment
    )
    const merchant = resolvePlaywrightWebServerTarget(
      "merchant",
      capturedEnvironment
    )

    expect(market.env.VITE_E2E_RELAY_URL).toBe("ws://127.0.0.1:54321")
    expect(merchant.env.VITE_E2E_RELAY_URL).toBe("ws://127.0.0.1:54321")
    expect(market.env.VITE_ENABLE_E2E_TEST_HOOKS).toBe("true")
    expect(merchant.env.VITE_ENABLE_E2E_TEST_HOOKS).toBe("true")
    expect(market.env.VITE_LIGHTNING_NETWORK).toBe("testnet")
    expect(merchant.env.VITE_LIGHTNING_NETWORK).toBe("testnet")
  })

  it("starts both apps with the commerce lane's testnet wallet mode", () => {
    expect(playwrightWebServer).toContain(
      'const smokeArea = environment.PLAYWRIGHT_SMOKE_AREA ?? "all"'
    )
    expect(playwrightWebServer).toContain(
      'const commerceIncluded = smokeArea === "all" || smokeArea === "commerce"'
    )
    expect(playwrightWebServer).toContain(
      '...(commerceIncluded ? { VITE_LIGHTNING_NETWORK: "testnet" } : {})'
    )
    expect(playwrightWebServer).toContain('"@conduit/market"')
    expect(playwrightWebServer).toContain('"@conduit/merchant"')
    expect(playwrightConfig).toContain(
      "bun scripts/dev/run_playwright_web_server.ts market"
    )
    expect(playwrightConfig).toContain(
      "bun scripts/dev/run_playwright_web_server.ts merchant"
    )
    expect(playwrightConfig).toContain(
      'const commerceIncluded = smokeArea === "all" || smokeArea === "commerce"'
    )
    expect(playwrightConfig).toContain(
      "reuseExistingServer: !CI && !commerceIncluded"
    )
  })

  it("serializes selected areas while they share isolated cross-app state", () => {
    expect(playwrightConfig).toContain(
      'workers: smokeArea === "all" ? (CI ? 2 : undefined) : 1'
    )
    expect(playwrightConfig).toContain(
      "commerce lane can make exact replay and side-effect assertions"
    )
  })

  it("runs read-only CI jobs for bot-authored pull requests", () => {
    expect(ciWorkflow).not.toContain("github.actor != 'github-actions[bot]'")
    expect(prTitleWorkflow).not.toContain(
      "github.actor != 'github-actions[bot]'"
    )
    expect(ciWorkflow).toContain(
      "  e2e-smoke:\n    name: e2e-smoke\n    if: always()"
    )
    expect(ciWorkflow).toContain('shards=\'["market","merchant","commerce"]\'')
  })

  it("keeps candidate-controlled preview verification read-only", () => {
    expect(previewLinksJob).toContain(
      "github.event.pull_request.user.type != 'Bot'"
    )
    expect(previewLinksJob).toContain("'preview-links' ||")
    expect(previewLinksJob).toContain(
      "format('preview-links-ineligible-{0}', github.run_id)"
    )
    expect(previewLinksJob).not.toContain("\n    name: preview-links\n")
    expect(previewLinksJob).toContain("if: github.event_name == 'pull_request'")
    expect(previewLinksJob).not.toContain(
      "github.event.pull_request.user.login"
    )
    expect(previewLinksJob).toContain("issues: read")
    expect(previewLinksJob).toContain("pull-requests: read")
    expect(previewLinksJob).not.toContain("issues: write")
    expect(previewLinksJob).not.toContain("pull-requests: write")
    expect(previewLinksJob).toContain("Verify mainnet preview links")
    expect(previewLinksJob).toContain(
      "await core.summary.addRaw(previewSummary).write()"
    )
    expect(previewLinksJob).not.toContain("issues.createComment")
    expect(previewLinksJob).not.toContain("issues.updateComment")
    expect(previewLinksJob).not.toContain("issues.deleteComment")
  })

  it("reconciles discovery with first-attempt execution evidence", () => {
    expect(playwrightConfig).toContain("PLAYWRIGHT_SMOKE_RESULT_FILE")
    expect(playwrightConfig).toContain(
      '"./scripts/ci/playwright_smoke_reporter.ts"'
    )
    expect(playwrightConfig).toContain("{ outputFile: smokeResultFile }")
    expect(playwrightConfig).not.toContain(
      '["json", { outputFile: smokeResultFile }]'
    )
    expect(ciWorkflow).toContain("--manifest-output")
    expect(ciWorkflow).toContain("--expected-manifest")
    expect(ciWorkflow).toContain("--execution-report")
    expect(ciWorkflow).toContain("--source-head-sha")
    expect(ciWorkflow).toContain("--base-sha")
    expect(ciWorkflow).toContain("--tested-sha")
    expect(ciWorkflow).toContain('checkout_sha="$(git rev-parse HEAD)"')
    expect(ciWorkflow).toContain("if: always() && matrix.area != 'none'")
  })

  it("keeps required CI smoke evidence free of raw browser artifacts", () => {
    expect(playwrightConfig).toContain(
      "if (CI && !smokeDiscovery && !smokeResultFile)"
    )
    expect(playwrightConfig).toContain(
      '"CI Playwright smoke execution requires PLAYWRIGHT_SMOKE_RESULT_FILE"'
    )
    expect(playwrightConfig).toContain(
      "const ciReporters: ReporterDescription[] = smokeResultFile"
    )
    expect(playwrightConfig).toContain(
      '"./scripts/ci/playwright_smoke_reporter.ts"'
    )
    expect(playwrightConfig).toContain("{ outputFile: smokeResultFile }")
    expect(playwrightConfig).toContain(': [["null"]]')
    expect(playwrightConfig).not.toContain('["html", { open: "never" }]')
    expect(playwrightConfig).toContain('trace: CI ? "off" : "on-first-retry"')
    expect(playwrightConfig).toContain(
      'screenshot: CI ? "off" : "only-on-failure"'
    )
    expect(playwrightConfig).toContain('video: "off"')
    expect(ciWorkflow).toContain(
      "${{ runner.temp }}/playwright-smoke-${{ matrix.area }}-results.json"
    )
    expect(ciWorkflow).toContain("umask 077")
    expect(ciWorkflow).toContain("bunx playwright test >/dev/null 2>&1")
    expect(ciWorkflow).toContain("Remove raw Playwright output")
    expect(ciWorkflow).toContain('rm -f -- "$PLAYWRIGHT_SMOKE_RESULT_FILE"')
    expect(ciWorkflow).toContain(
      'rm -rf -- "$GITHUB_WORKSPACE/playwright-report" "$GITHUB_WORKSPACE/test-results"'
    )
    expect(ciWorkflow).not.toContain("Upload Playwright artifacts")
    expect(ciWorkflow).not.toContain("actions/upload-artifact")
    expect(smokeAreaValidator).not.toContain("result.stderr.trim()")
    expect(smokeAreaValidator).not.toContain("result.stdout.trim()")
    expect(smokeAreaValidator).toContain(
      'throw new Error("Playwright test discovery failed.")'
    )
    expect(smokeAreaValidator).toContain(
      'throw new Error("Playwright test discovery returned invalid JSON.")'
    )
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
        {
          file: "e2e/commerce.playwright.ts",
          tags: ["commerce"],
          title: "buyer and seller complete commerce",
        },
      ])
    )

    expect(counts).toEqual({ market: 1, merchant: 1, commerce: 1 })
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
        {
          file: "commerce.playwright.ts",
          line: 30,
          tags: ["commerce"],
          title: "buyer and seller complete commerce",
        },
      ]),
      ["merchant", "commerce", "market"]
    )

    expect(manifest).toEqual({
      schemaVersion: 1,
      evidence: null,
      selectedTags: ["@market", "@merchant", "@commerce"],
      selectedTestCount: 3,
      tests: [
        {
          file: "e2e/alpha.playwright.ts",
          line: 10,
          name: "redacted smoke test",
          tags: ["@market"],
        },
        {
          file: "e2e/commerce.playwright.ts",
          line: 30,
          name: "redacted smoke test",
          tags: ["@commerce"],
        },
        {
          file: "e2e/zeta.playwright.ts",
          line: 20,
          name: "redacted smoke test",
          tags: ["@merchant"],
        },
      ],
    })
  })

  it("canonicalizes dynamic titles identically during discovery and execution", () => {
    const discovered = reportWithSpecs([
      {
        file: "e2e/manual-checkout-invoice.playwright.ts",
        line: 48,
        tags: ["market"],
        title: "signed-in manual checkout fixture-specific title @market",
      },
    ])
    const expected = buildPlaywrightSmokeManifest(
      discovered,
      ["market"],
      smokeEvidence
    )
    const executed: PlaywrightJsonReport = {
      ...reportWithSpecs([
        {
          file: "e2e/manual-checkout-invoice.playwright.ts",
          line: 48,
          ok: true,
          tags: ["market"],
          tests: [
            {
              expectedStatus: "passed",
              results: [{ status: "passed" }],
              status: "expected",
            },
          ],
          title: "redacted smoke test",
        },
      ]),
      config: { metadata: { smokeEvidence } },
      errors: [],
      stats: { flaky: 0, skipped: 0, unexpected: 0 },
    }

    expect(expected.tests[0]?.name).toBe("redacted smoke test")
    expect(
      validatePlaywrightSmokeExecution(
        executed,
        expected,
        ["market"],
        smokeEvidence
      )
    ).toEqual(expected)
  })

  it("preserves static titles when discovery reports a source basename", async () => {
    const title =
      "E2E-COM-01..06 buyer and merchant settle once across reload @commerce"
    const source = normalizeLines(
      await Bun.file("e2e/commerce.playwright.ts").text()
    )
    const line =
      source
        .split("\n")
        .findIndex((candidate) => candidate.includes(`test("${title}"`)) + 1

    expect(line).toBeGreaterThan(0)
    expect(
      buildPlaywrightSmokeManifest(
        reportWithSpecs([
          {
            file: "commerce.playwright.ts",
            line,
            tags: ["commerce"],
            title,
          },
        ]),
        ["commerce"],
        smokeEvidence
      ).tests[0]?.name
    ).toBe(title)
  })

  it("rejects orphaned Playwright smoke tests", () => {
    expect(() =>
      validatePlaywrightSmokeAreas(
        reportWithSpecs([
          {
            file: "e2e/orphan.playwright.ts",
            line: 12,
            tags: ["regression"],
            title: "orphaned test @market",
          },
          { file: "e2e/market.playwright.ts", tags: ["market"] },
          { file: "e2e/merchant.playwright.ts", tags: ["merchant"] },
        ])
      )
    ).toThrow("e2e/orphan.playwright.ts:12 (orphaned test @market)")
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

    expect(() =>
      validatePlaywrightSmokeAreas(
        reportWithSpecs([
          { file: "e2e/market.playwright.ts", tags: ["market"] },
          { file: "e2e/merchant.playwright.ts", tags: ["merchant"] },
        ]),
        ["commerce"]
      )
    ).toThrow("The selected commerce smoke area contains zero tests.")
  })

  it("accepts only the discovered tests passing on their first attempt", () => {
    const report: PlaywrightJsonReport = {
      ...reportWithSpecs([
        {
          file: "e2e/market.playwright.ts",
          line: 8,
          ok: true,
          tags: ["market"],
          tests: [
            {
              expectedStatus: "passed",
              status: "expected",
              results: [{ status: "passed" }],
            },
          ],
          title: "buyer checkout completes",
        },
      ]),
      config: { metadata: { smokeEvidence } },
      errors: [],
      stats: { flaky: 0, skipped: 0, unexpected: 0 },
    }
    const expected = buildPlaywrightSmokeManifest(
      report,
      ["market"],
      smokeEvidence
    )

    expect(
      validatePlaywrightSmokeExecution(
        report,
        expected,
        ["market"],
        smokeEvidence
      )
    ).toEqual(expected)
  })

  it("reconciles project-specific discovery and execution rows", () => {
    const projectSpec = {
      file: "e2e/mobile.playwright.ts",
      line: 8,
      ok: true,
      tags: ["market"],
      tests: [
        {
          expectedStatus: "passed",
          status: "expected",
          results: [{ retry: 0, status: "passed" }],
        },
      ],
      title: "mobile checkout remains usable @market",
    }
    const report: PlaywrightJsonReport = {
      ...reportWithSpecs([projectSpec, projectSpec]),
      config: { metadata: { smokeEvidence } },
      errors: [],
      stats: { flaky: 0, skipped: 0, unexpected: 0 },
    }
    const expected = buildPlaywrightSmokeManifest(
      report,
      ["market"],
      smokeEvidence
    )

    expect(expected.selectedTestCount).toBe(2)
    expect(
      validatePlaywrightSmokeExecution(
        report,
        expected,
        ["market"],
        smokeEvidence
      )
    ).toEqual(expected)
  })

  it("rejects skipped, retry-dependent, and mismatched smoke execution", () => {
    const skipped = reportWithSpecs([
      {
        file: "e2e/market.playwright.ts",
        ok: true,
        tags: ["market"],
        tests: [
          {
            expectedStatus: "passed",
            status: "skipped",
            results: [{ status: "skipped" }],
          },
        ],
        title: "buyer checkout completes",
      },
    ])
    skipped.config = { metadata: { smokeEvidence } }
    const skippedManifest = buildPlaywrightSmokeManifest(
      skipped,
      ["market"],
      smokeEvidence
    )
    expect(() =>
      validatePlaywrightSmokeExecution(
        skipped,
        skippedManifest,
        ["market"],
        smokeEvidence
      )
    ).toThrow("did not pass cleanly on its first attempt")

    const flaky = {
      ...reportWithSpecs([
        {
          file: "/home/runner/work/conduit/e2e/market.playwright.ts",
          line: 8,
          ok: true,
          tags: ["market"],
          tests: [
            {
              expectedStatus: "passed",
              status: "flaky",
              results: [
                {
                  duration: 1_234,
                  error: {
                    location: {
                      column: 7,
                      file: "/home/runner/work/conduit/e2e/market.playwright.ts",
                      line: 42,
                    },
                    message: "sensitive browser output must not survive",
                  },
                  retry: 0,
                  status: "failed",
                },
                { duration: 250, retry: 1, status: "passed" },
              ],
            },
          ],
          title: "buyer checkout completes",
        },
      ]),
      config: { metadata: { smokeEvidence } },
      stats: { flaky: 1, skipped: 0, unexpected: 0 },
    } as unknown as PlaywrightJsonReport
    const flakyManifest = buildPlaywrightSmokeManifest(
      flaky,
      ["market"],
      smokeEvidence
    )
    let errorMessage = ""
    try {
      validatePlaywrightSmokeExecution(
        flaky,
        flakyManifest,
        ["market"],
        smokeEvidence
      )
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain("retry-dependent smoke tests as flaky")
    expect(errorMessage).toContain(
      "First attempt: retry=0 status=failed duration=1234ms error=e2e/market.playwright.ts:42:7."
    )
    expect(errorMessage).not.toContain("/home/runner")
    expect(errorMessage).not.toContain("sensitive browser output")

    const expectedDifferentTest = {
      ...skippedManifest,
      tests: skippedManifest.tests.map((test) => ({
        ...test,
        name: "different discovered test",
      })),
    }
    expect(() =>
      validatePlaywrightSmokeExecution(
        skipped,
        expectedDifferentTest,
        ["market"],
        smokeEvidence
      )
    ).toThrow("does not match the discovered manifest")

    const wrongEvidenceReport: PlaywrightJsonReport = {
      ...skipped,
      config: {
        metadata: {
          smokeEvidence: { ...smokeEvidence, testedSha: "d".repeat(40) },
        },
      },
    }
    expect(() =>
      validatePlaywrightSmokeExecution(
        wrongEvidenceReport,
        skippedManifest,
        ["market"],
        smokeEvidence
      )
    ).toThrow("does not bind the expected source, base, and tested SHAs")
  })
})
