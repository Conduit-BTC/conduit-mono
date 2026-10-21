import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createPlaywrightRouterConfig } from "../scripts/dev/playwright_router_config"
import {
  createRouterSmokeRecorder,
  parseRouterSmokeDiagnostic,
  routerSmokeDiagnosticFromAnnotations,
} from "../scripts/ci/router_smoke_diagnostic"

describe("runner-owned router phase evidence", () => {
  it("distinguishes ordinary preparation and reload checks without payment content", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    for (const phase of [
      "buyer order preparation rejected",
      "buyer prepared funding matches the frozen total",
      "cold Merchant restores exact saved funding deadlines",
      "cold Merchant remains before the original shopper cutoff",
      "cold Merchant reload preserves recorded accounting",
      "cold Merchant reload preserves the native send count",
      "cold Merchant retains one supplier notification",
      "private router keeps public zap history empty",
    ] as const) {
      recorder.phase(phase)
      expect(routerSmokeDiagnosticFromAnnotations(annotations)?.phase).toBe(
        phase
      )
    }
  })
  it("runs both isolated lanes independently and retains separate SHA-bound artifacts", () => {
    const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8")
    for (const [step, prerequisite] of [
      ["Validate isolated router smoke selection", "smoke_dependencies"],
      ["Run isolated router Playwright smoke tests", "router_selection"],
      ["Validate router receiver setup smoke selection", "smoke_dependencies"],
      ["Run router receiver setup Playwright smoke", "receiver_selection"],
    ]) {
      const start = workflow.indexOf(`- name: ${step}`)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(
        workflow.slice(start, workflow.indexOf("\n      - name:", start + 1))
      ).toContain(
        `if: \${{ !cancelled() && steps.${prerequisite}.outcome == 'success' }}`
      )
    }
    for (const lane of [
      ["router", "playwright-router-smoke"],
      ["router-receiver-setup", "playwright-router-receiver-setup"],
    ]) {
      expect(workflow).toContain(`name: smoke-evidence-${lane[0]}-`)
      expect(workflow).toContain(`${lane[1]}-evidence.json`)
    }
  })

  it("passes a separate sanitized evidence path into the isolated runner", () => {
    const config = createPlaywrightRouterConfig({
      PLAYWRIGHT_MARKET_PORT: "7014",
      PLAYWRIGHT_MERCHANT_PORT: "7015",
      PLAYWRIGHT_SMOKE_EVIDENCE_FILE: "/tmp/router-evidence.json",
    })
    expect(JSON.stringify(config.reporter)).toContain(
      '"evidenceFile":"/tmp/router-evidence.json"'
    )
    expect(config.retries).toBe(0)
  })

  it("records sender commitment without treating it as receiver claim", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("native treasury sender commits before receiver claim")

    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "native treasury sender commits before receiver claim",
      lifecycle: "body",
      body: "running",
    })
  })

  it("records replacement-device boundaries without journal or identity content", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    for (const phase of [
      "event replacement device registration",
      "event source device handover",
      "event retired device cannot continue",
      "event replacement journal restoration",
      "event replacement transfer discovery",
      "event replacement transfer activation",
      "event replacement writer projection",
    ] as const) {
      recorder.phase(phase)
      expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
        phase,
        lifecycle: "body",
        body: "running",
      })
    }
    expect(
      parseRouterSmokeDiagnostic({
        phase: "event replacement journal restoration",
        lifecycle: "body",
        body: "running",
        deviceId: "unexpected",
      })
    ).toBeUndefined()
  })

  it("retains the remaining offline completion checkpoints", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    for (const phase of [
      "sender commitment completes routing without native replay",
      "sender-committed exact provider transfer matches",
      "sender-committed persisted obligations match",
      "sender-committed payment receipt is fully verified",
      "unclaimed receiver keeps encrypted recovery active",
      "sender-committed refresh does not replay native payment",
    ] as const) {
      recorder.phase(phase)
      expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
        phase,
        lifecycle: "body",
        body: "running",
      })
    }
  })

  it("still rejects unapproved phases and extra provider fields", () => {
    const diagnostic = {
      phase: "native treasury sender commits before receiver claim",
      lifecycle: "body",
      body: "running",
    }
    expect(
      parseRouterSmokeDiagnostic({ ...diagnostic, phase: "unknown phase" })
    ).toBeUndefined()
    expect(
      parseRouterSmokeDiagnostic({ ...diagnostic, providerStatus: "paid" })
    ).toBeUndefined()
    expect(
      parseRouterSmokeDiagnostic({
        ...diagnostic,
        providerStatus: "paid",
        invoice: "private value",
      })
    ).toBeUndefined()
  })

  it("retains only fixed Event checkout and organizer handout stages", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    for (const phase of [
      "event setup",
      "event occurrence assignment",
      "event occurrence date selection",
      "event occurrence product selection",
      "event occurrence allocation submission",
      "event organizer device selection",
      "event reserved stock grant",
      "event buyer checkout",
      "event buyer catalog admission",
      "event buyer cart checkout",
      "event buyer price presentation",
      "event guest contact-free fields",
      "event mobile checkout layout",
      "event organizer fee disclosure",
      "event buyer plan preparation",
      "event buyer funding authorization",
      "event buyer automatic payment routing",
      "event organizer observes the buyer cutoff",
      "event organizer automatic payment routing",
      "event organizer stock authority rejected",
      "event organizer recovery authority rejected",
      "event organizer destination rejected",
      "event organizer routing stopped before sends",
      "event organizer routing stopped during commerce",
      "event organizer native submission pending",
      "event organizer native verification pending",
      "event exact pickup claim and handout",
      "event Merchant once-only stock reconciliation",
    ] as const) {
      recorder.phase(phase)
      const diagnostic = routerSmokeDiagnosticFromAnnotations(annotations)
      expect(diagnostic).toEqual({ phase, lifecycle: "body", body: "running" })
      expect(
        parseRouterSmokeDiagnostic({ ...diagnostic, orderId: "untrusted" })
      ).toBeUndefined()
    }
  })

  it("binds sender-commit checkpoints to fixed expected conditions and categories", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("sender-committed payment status visible")
    const checkpoint = routerSmokeDiagnosticFromAnnotations(annotations)
    expect(checkpoint).toEqual({
      phase: "sender-committed payment status visible",
      lifecycle: "body",
      body: "running",
      expected: "payment-recorded-visible",
      category: "app-readiness",
    })
    expect(
      parseRouterSmokeDiagnostic({ ...checkpoint, expected: "private value" })
    ).toBeUndefined()
    expect(
      parseRouterSmokeDiagnostic({ ...checkpoint, category: "other" })
    ).toBeUndefined()
    expect(
      parseRouterSmokeDiagnostic({ ...checkpoint, raw: "private value" })
    ).toBeUndefined()
    recorder.phase("sender commitment completes routing without native replay")
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "sender commitment completes routing without native replay",
      lifecycle: "body",
      body: "running",
    })
  })

  it("retains the latest body phase before a blocked await or finally", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("cold Merchant reload navigation completes")

    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "body",
      body: "running",
    })
    recorder.failed()
    recorder.teardown(false)
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "teardown",
      body: "failed",
    })
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "complete",
      body: "failed",
    })
  })

  it("identifies cleanup-only work only after positive body completion", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("cold Merchant retired reload does not replay payments")
    recorder.teardown(true)
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant retired reload does not replay payments",
      lifecycle: "teardown",
      body: "completed",
    })
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant retired reload does not replay payments",
      lifecycle: "complete",
      body: "completed",
    })
  })

  it("cannot overwrite a known body failure with cleanup success", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.failed()
    recorder.teardown(true)
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)?.body).toBe(
      "failed"
    )
  })

  it.each([
    [
      "sender-committed payment status visible",
      "payment-recorded-visible",
      "app-readiness",
    ],
    [
      "cold Merchant retains original encrypted recovery",
      "merchant-recovery-retained",
      "assertion",
    ],
    [
      "cold Merchant keeps the completed checkout wallet active",
      "checkout-wallet-retained",
      "assertion",
    ],
  ] as const)(
    "retains the allowlisted %s checkpoint in a real runner artifact",
    (phase, expected, category) => {
      const directory = mkdtempSync(join(tmpdir(), "conduit-router-evidence-"))
      const sentinel = `private-${crypto.randomUUID()}`
      try {
        mkdirSync(join(directory, "e2e"))
        const source = resolve("scripts/ci/router_smoke_diagnostic.ts")
        const playwrightImport = require.resolve("@playwright/test")
        const reporter = resolve("scripts/ci/playwright_smoke_reporter.ts")
        const playwrightCli = require.resolve("@playwright/test/cli")
        writeFileSync(
          join(directory, "e2e/commerce-router-recovery.playwright.ts"),
          [
            `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
            `import { createRouterSmokeRecorder } from ${JSON.stringify(source)}`,
            'test("native router controlled failure @commerce", async ({}, info) => {',
            "  const recorder = createRouterSmokeRecorder(info.annotations);",
            `  recorder.phase(${JSON.stringify(phase)});`,
            `  try { expect(${JSON.stringify(sentinel)}).toBe("different"); } finally { recorder.failed(); }`,
            "})",
          ].join("\n")
        )
        const output = join(directory, "results.json")
        const artifact = join(directory, "evidence.json")
        const progress = join(directory, "progress.log")
        const config = join(directory, "playwright.config.ts")
        writeFileSync(
          config,
          `export default { testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1, reporter: [[${JSON.stringify(reporter)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, progressFile: ${JSON.stringify(progress)} }]], projects: [{ name: "chromium" }] }`
        )
        const run = spawnSync(
          process.execPath,
          [playwrightCli, "test", "-c", config],
          {
            cwd: directory,
            encoding: "utf8",
          }
        )
        expect(run.status).not.toBe(0)
        const retained = readFileSync(artifact, "utf8")
        const progressText = readFileSync(progress, "utf8")
        expect(
          retained + progressText + readFileSync(output, "utf8")
        ).not.toContain(sentinel)
        const evidence = JSON.parse(retained)
        expect(evidence.status).toBe("failed")
        expect(evidence.timing.completedAttempts).toBe(1)
        const attempt = evidence.tests[0].tests[0].results[0]
        expect(attempt.retry).toBe(0)
        expect(attempt.router).toEqual({
          phase,
          lifecycle: "body",
          body: "failed",
          expected,
          category,
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
