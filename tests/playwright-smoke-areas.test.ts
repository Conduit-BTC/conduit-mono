import { describe, expect, it } from "bun:test"

import {
  buildPlaywrightSmokeManifest,
  type PlaywrightJsonReport,
  validatePlaywrightSmokeAreas,
  validatePlaywrightSmokeExecution,
} from "../scripts/ci/validate_playwright_smoke_areas"

const playwrightConfig = await Bun.file("playwright.config.ts").text()
const smokeAreaValidator = await Bun.file(
  "scripts/ci/validate_playwright_smoke_areas.ts"
).text()
const ciWorkflow = await Bun.file(".github/workflows/ci.yml").text()
const prTitleWorkflow = await Bun.file(".github/workflows/pr-title.yml").text()
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
    expect(playwrightConfig).toContain("VITE_E2E_RELAY_URL=${relayUrl}")
    expect(playwrightConfig).toContain("RELAY_EPHEMERAL=true")
    expect(playwrightConfig).toContain("RELAY_FAULT_MODE=none")
    expect(playwrightConfig).toContain("PLAYWRIGHT_RELAY_PORT")
    expect(playwrightConfig).toContain("reuseExistingServer: false")
  })

  it("starts both apps for current dual-tagged cross-app smoke", () => {
    expect(playwrightConfig).toContain(
      "dual-tagged\n  // cross-app smoke runs in both existing shards"
    )
    expect(playwrightConfig).toContain("bun run --filter @conduit/market dev")
    expect(playwrightConfig).toContain("bun run --filter @conduit/merchant dev")
    expect(playwrightConfig).not.toContain(
      '...(smokeArea === "all" || smokeArea === "market"'
    )
    expect(playwrightConfig).not.toContain(
      '...(smokeArea === "all" || smokeArea === "merchant"'
    )
  })

  it("serializes current area shards while they share cross-app state", () => {
    expect(playwrightConfig).toContain(
      'workers: smokeArea === "all" ? (CI ? 2 : undefined) : 1'
    )
    expect(playwrightConfig).toContain(
      "Keep them single-worker until CND-193 isolates @commerce"
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
      '? [["json", { outputFile: smokeResultFile }]]'
    )
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
      evidence: null,
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

  it("reports bounded first-attempt diagnostics without raw failure content", () => {
    const retryDependent = {
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
    const manifest = buildPlaywrightSmokeManifest(
      retryDependent,
      ["market"],
      smokeEvidence
    )

    let errorMessage = ""
    try {
      validatePlaywrightSmokeExecution(
        retryDependent,
        manifest,
        ["market"],
        smokeEvidence
      )
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain(
      "First attempt: retry=0 status=failed duration=1234ms error=e2e/market.playwright.ts:42:7."
    )
    expect(errorMessage).not.toContain("/home/runner")
    expect(errorMessage).not.toContain("sensitive browser output")
  })
})
