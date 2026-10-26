import { describe, expect, it } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import {
  safePlaywrightFailure,
  smokeDurationBucket,
  serializeSmokeEvidence,
} from "../scripts/ci/playwright_smoke_reporter"
import {
  buildPlaywrightSmokeManifest,
  validatePlaywrightSmokeExecution,
  type PlaywrightJsonReport,
} from "../scripts/ci/validate_playwright_smoke_areas"

const evidence = {
  baseSha: "a".repeat(40),
  sourceHeadSha: "b".repeat(40),
  testedSha: "c".repeat(40),
}
const reporterPath = resolve("scripts/ci/playwright_smoke_reporter.ts")
const playwrightCli = require.resolve("@playwright/test/cli")
const playwrightImport = require.resolve("@playwright/test")
const smokeDiagnosticsImport = resolve("e2e/helpers/smoke-diagnostics.ts")

function createEventSmokeRunner(directory: string) {
  const output = join(directory, "results.json")
  const artifact = join(directory, "evidence.json")
  const progress = join(directory, "progress.log")
  const config = join(directory, "playwright.config.ts")
  writeFileSync(
    config,
    `export default { testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1, metadata: { smokeEvidence: ${JSON.stringify(evidence)} }, reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, progressFile: ${JSON.stringify(progress)}, evidence: ${JSON.stringify(evidence)} }]], projects: [{ name: "mobile-webkit" }] }`
  )
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [playwrightCli, "test", "-c", config, ...args],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      }
    )
  return { run, output, artifact, progress }
}

describe("composed smoke evidence", () => {
  it("keeps event prepaid confirmation observations private through the real reporter and verifier", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "conduit-event-prepaid-evidence-")
    )
    const sentinel = "private-" + crypto.randomUUID()
    const kind = "event-prepaid-confirmation"
    const observation = {
      observationAvailable: true,
      pointerDownOnTrigger: false,
      pointerUpOnTrigger: true,
      clickOnTrigger: false,
      expectedDialogMounted: true,
      expectedDialogRemoved: true,
      expectedDialogHidden: false,
      expectedDialogVisible: false,
      triggerCardinality: "single",
      triggerEnabled: true,
    }
    const privateFields = {
      privateValue: sentinel,
      inputValue: sentinel,
      rawError: sentinel,
      payload: { content: sentinel },
    }
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/event-market.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          `import { recordSmokeDiagnostic } from ${JSON.stringify(smokeDiagnosticsImport)}`,
          'test("controlled prepaid dialog evidence @market", ({}, info) => {',
          `  recordSmokeDiagnostic(info, ${JSON.stringify(kind)}, ${JSON.stringify({ ...observation, ...privateFields })});`,
          "  expect(false).toBe(true);",
          "});",
        ].join("\n")
      )
      const { run, output, artifact, progress } =
        createEventSmokeRunner(directory)
      const discovery = run(["--list", "--reporter=json"])
      expect(discovery.status).toBe(0)
      const manifest = buildPlaywrightSmokeManifest(
        JSON.parse(discovery.stdout),
        ["market"],
        evidence
      )
      expect(manifest.selectedTestCount).toBe(1)
      expect(run([]).status).toBe(1)
      const reportText = readFileSync(output, "utf8")
      const artifactText = readFileSync(artifact, "utf8")
      const progressText = readFileSync(progress, "utf8")
      expect(reportText + artifactText + progressText).not.toContain(sentinel)
      const report = JSON.parse(reportText) as PlaywrightJsonReport
      const retained = JSON.parse(artifactText)
      expect(retained.status).toBe("failed")
      expect(retained.timing.completedAttempts).toBe(1)
      const result = retained.tests[0].tests[0].results[0]
      expect(result.retry).toBe(0)
      expect(result.status).toBe("failed")
      expect(result.failure.category).toBe("assertion")
      expect(result.diagnostics).toEqual([{ kind, ...observation }])
      expect(progressText).toContain("diagnostic retry=0")
      expect(progressText).toContain(`"kind":"${kind}"`)

      const verifierFailure = (value: PlaywrightJsonReport) => {
        try {
          validatePlaywrightSmokeExecution(
            value,
            manifest,
            ["market"],
            evidence
          )
        } catch (error) {
          return String(error)
        }
        throw new Error("Controlled failure was not rejected by the verifier")
      }
      const failure = verifierFailure(report)
      expect(failure).toContain("did not pass cleanly")
      expect(failure).toContain(`"kind":"${kind}"`)
      expect(failure).not.toContain(sentinel)

      const injected = structuredClone(report)
      injected.suites![0]!.specs![0]!.tests![0]!.results![0]!.diagnostics = [
        { kind, ...observation, ...privateFields },
      ]
      const injectedFailure = verifierFailure(injected)
      expect(injectedFailure).toContain(`"kind":"${kind}"`)
      expect(injectedFailure).not.toContain(sentinel)
      for (const field of Object.keys(privateFields))
        expect(injectedFailure).not.toContain(field)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)

  it("keeps event stock control failures typed and private through the real reporter and verifier", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "conduit-event-stock-evidence-")
    )
    const sentinel = "private-" + crypto.randomUUID()
    const phases = ["setup_code_read", "stock_reconcile"] as const
    const observation = {
      observationAvailable: true,
      pageClosed: false,
      controlCardinality: "single",
      controlVisible: true,
      controlEnabled: false,
      controlHitTarget: false,
      detailsPresent: true,
      detailsOpen: true,
      refreshControlCardinality: "single",
      refreshControlEnabled: true,
    }
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/event-market.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          `import { recordEventStockControlFailure } from ${JSON.stringify(smokeDiagnosticsImport)}`,
          `for (const phase of ${JSON.stringify(phases)}) {`,
          "  test(`controlled event stock ${phase} @market`, async ({}, info) => {",
          `    const observation = ${JSON.stringify(observation)};`,
          "    const page = { isClosed: () => false, getByRole: () => ({ evaluateAll: async () => observation }) };",
          "    await recordEventStockControlFailure(page, info, phase);",
          '    const diagnostic = info.annotations.find((value) => value.type === "smoke:event-stock-control");',
          `    diagnostic.description = JSON.stringify({ ...JSON.parse(diagnostic.description), pickupCode: ${JSON.stringify(sentinel)}, inputValue: ${JSON.stringify(sentinel)}, errorMessage: ${JSON.stringify(sentinel)} });`,
          `    expect(${JSON.stringify(sentinel)}).toBe("different");`,
          "  });",
          "}",
        ].join("\n")
      )
      const { run, output, artifact, progress } =
        createEventSmokeRunner(directory)
      const discovery = run(["--list", "--reporter=json"])
      expect(discovery.status).toBe(0)
      const manifest = buildPlaywrightSmokeManifest(
        JSON.parse(discovery.stdout),
        ["market"],
        evidence
      )
      expect(manifest.selectedTestCount).toBe(2)
      expect(run([]).status).toBe(1)
      const reportText = readFileSync(output, "utf8")
      const artifactText = readFileSync(artifact, "utf8")
      const progressText = readFileSync(progress, "utf8")
      expect(reportText + artifactText + progressText).not.toContain(sentinel)
      const report = JSON.parse(reportText) as PlaywrightJsonReport
      const retained = JSON.parse(artifactText)
      expect(retained.status).toBe("failed")
      expect(retained.timing.completedAttempts).toBe(2)
      expect(retained.tests).toHaveLength(2)
      for (const [index, phase] of phases.entries()) {
        const result = retained.tests[index].tests[0].results[0]
        expect(result.retry).toBe(0)
        expect(result.status).toBe("failed")
        expect(result.failure.category).toBe("assertion")
        expect(result.failure.context).toBeUndefined()
        expect(result.diagnostics).toEqual([
          { kind: "event-stock-control", phase, ...observation },
        ])
      }
      expect(progressText).toContain("diagnostic retry=0")
      expect(progressText).toContain('"phase":"setup_code_read"')
      expect(progressText).toContain('"phase":"stock_reconcile"')
      let failure = ""
      try {
        validatePlaywrightSmokeExecution(report, manifest, ["market"], evidence)
      } catch (error) {
        failure = String(error)
      }
      expect(failure).toContain("did not pass cleanly")
      expect(failure).toContain('"kind":"event-stock-control"')
      expect(failure).not.toContain(sentinel)
      expect(failure).not.toContain("pickupCode")

      const injected = structuredClone(report)
      injected.suites![0]!.specs![0]!.tests![0]!.results![0]!.diagnostics = [
        {
          kind: "event-stock-control",
          phase: "setup_code_read",
          ...observation,
          pickupCode: sentinel,
          inputValue: sentinel,
          errorMessage: sentinel,
        },
      ]
      let injectedFailure = ""
      try {
        validatePlaywrightSmokeExecution(
          injected,
          manifest,
          ["market"],
          evidence
        )
      } catch (error) {
        injectedFailure = String(error)
      }
      expect(injectedFailure).toContain("did not pass cleanly")
      expect(injectedFailure).toContain('"kind":"event-stock-control"')
      expect(injectedFailure).not.toContain(sentinel)
      expect(injectedFailure).not.toContain("pickupCode")
      expect(injectedFailure).not.toContain("inputValue")
      expect(injectedFailure).not.toContain("errorMessage")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)

  it("retains only wallet import phase booleans after a controlled failure", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "conduit-wallet-menu-evidence-")
    )
    const privateValue = "private-" + crypto.randomUUID()
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/shared-ui-composition.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          'test("controlled wallet menu failure @market", () => {',
          `  test.info().annotations.push({ type: "smoke:wallet-import-menu", description: JSON.stringify({ phase: "trigger_clicked", observationAvailable: true, triggerVisible: true, triggerEnabled: true, importVisible: false, importEnabled: false, dialogVisible: false, loadingVisible: true, walletId: "${privateValue}" }) });`,
          "  expect(false).toBe(true);",
          "});",
        ].join("\n")
      )
      const output = join(directory, "results.json")
      const artifact = join(directory, "evidence.json")
      writeFileSync(
        join(directory, "playwright.config.ts"),
        `export default { testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1, metadata: { smokeEvidence: ${JSON.stringify(evidence)} }, reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, evidence: ${JSON.stringify(evidence)} }]], projects: [{ name: "mobile-webkit" }] }`
      )
      const run = spawnSync(
        process.execPath,
        [playwrightCli, "test", "-c", join(directory, "playwright.config.ts")],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        }
      )
      expect(run.status).toBe(1)
      const serialized = readFileSync(artifact, "utf8")
      expect(serialized).not.toContain(privateValue)
      const report = JSON.parse(serialized)
      expect(report.status).toBe("failed")
      expect(report.tests[0].tests[0].results[0].diagnostics).toEqual([
        {
          kind: "wallet-import-menu",
          phase: "trigger_clicked",
          observationAvailable: true,
          triggerVisible: true,
          triggerEnabled: true,
          importVisible: false,
          importEnabled: false,
          dialogVisible: false,
          loadingVisible: true,
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps bounded expected conditions through controlled first-attempt failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-context-"))
    const sentinel = "private-" + crypto.randomUUID()
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/merchant-order-inbox.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          `import { recordSmokeDiagnostic, recordSmokeFailureContext } from ${JSON.stringify(smokeDiagnosticsImport)}`,
          'for (const [expected, observed] of [["buyer_dialog_ready", "unmet"], ["buyer_send_clicked", "pending"], ["buyer_reply_relay_observed", "pending"], ["buyer_reply_saved", "unmet"]]) {',
          "  test(`controlled ${expected} @commerce`, async ({}, info) => {",
          "    test.setTimeout(500);",
          "    recordSmokeFailureContext(info, expected, observed);",
          `    recordSmokeDiagnostic(info, "order-reply", { phase: "buyer_reply", dialogVisible: false, privateValue: ${JSON.stringify(sentinel)} });`,
          '    if (expected === "buyer_reply_relay_observed") await new Promise(() => {});',
          `    expect(${JSON.stringify(sentinel)}).toBe("other");`,
          "  });",
          "}",
        ].join("\n")
      )
      const config = join(directory, "playwright.config.ts")
      const output = join(directory, "results.json")
      const artifact = join(directory, "evidence.json")
      const progress = join(directory, "progress.log")
      writeFileSync(
        config,
        `export default { testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1, metadata: { smokeEvidence: ${JSON.stringify(evidence)} }, reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, progressFile: ${JSON.stringify(progress)}, evidence: ${JSON.stringify(evidence)} }]], projects: [{ name: "chromium" }] }`
      )
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [playwrightCli, "test", "-c", config, ...args],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: 15000,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
          }
        )
      const discovery = run(["--list", "--reporter=json"])
      if (discovery.status !== 0)
        throw new Error(
          JSON.stringify(JSON.parse(discovery.stdout).errors).replaceAll(
            sentinel,
            "redacted"
          )
        )
      const manifest = buildPlaywrightSmokeManifest(
        JSON.parse(discovery.stdout),
        ["commerce"],
        evidence
      )
      expect(manifest.selectedTestCount).toBe(4)
      expect(run([]).status).toBe(1)
      const report = JSON.parse(
        readFileSync(output, "utf8")
      ) as PlaywrightJsonReport
      const retained = JSON.parse(readFileSync(artifact, "utf8"))
      const combined = JSON.stringify(retained) + readFileSync(progress, "utf8")
      expect(combined).not.toContain(sentinel)
      expect(retained.status).toBe("failed")
      expect(retained.timing.completedAttempts).toBe(4)
      expect(
        retained.tests.map(
          (spec: { tests: Array<{ results: Array<{ status: string }> }> }) =>
            spec.tests[0]!.results[0]!.status
        )
      ).toEqual(["failed", "failed", "timedOut", "failed"])
      expect(
        retained.tests.map(
          (spec: {
            tests: Array<{
              results: Array<{ retry: number; failure: unknown }>
            }>
          }) => spec.tests[0]!.results[0]!.retry
        )
      ).toEqual([0, 0, 0, 0])
      expect(
        retained.tests.map(
          (spec: {
            tests: Array<{ results: Array<{ failure: { context: unknown } }> }>
          }) => spec.tests[0]!.results[0]!.failure.context
        )
      ).toEqual([
        {
          boundary: "app-readiness",
          expected: "buyer_dialog_ready",
          observed: "unmet",
        },
        {
          boundary: "user-action",
          expected: "buyer_send_clicked",
          observed: "pending",
        },
        {
          boundary: "relay-provider",
          expected: "buyer_reply_relay_observed",
          observed: "pending",
        },
        {
          boundary: "assertion",
          expected: "buyer_reply_saved",
          observed: "unmet",
        },
      ])
      for (const spec of retained.tests) {
        expect(spec.tests[0].results[0].diagnostics).toEqual([
          { kind: "order-reply", phase: "buyer_reply", dialogVisible: false },
        ])
      }
      expect(() =>
        validatePlaywrightSmokeExecution(
          report,
          manifest,
          ["commerce"],
          evidence
        )
      ).toThrow("did not pass cleanly")
      const injected = structuredClone(report)
      injected.suites![0]!.specs![0]!.tests![0]!.results![0]!.diagnostics = [
        { kind: "order-reply", phase: "buyer_reply", privateValue: sentinel },
      ]
      injected.suites![0]!.specs![0]!.tests![0]!.results![0]!.failure = {
        category: "assertion",
        context: {
          boundary: "user-action",
          expected: "buyer_dialog_ready",
          observed: "unmet",
          privateValue: sentinel,
        },
      }
      let injectedMessage = ""
      try {
        validatePlaywrightSmokeExecution(
          injected,
          manifest,
          ["commerce"],
          evidence
        )
      } catch (error) {
        injectedMessage = String(error)
      }
      expect(injectedMessage).toContain('"dialogVisible":false')
      expect(injectedMessage).not.toContain(sentinel)
      expect(injectedMessage).not.toContain("privateValue")
      expect(injectedMessage).not.toContain('"expected":"buyer_dialog_ready"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)

  it("reports distinct parameterized failures through the real runner without exposing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-evidence-"))
    const sentinel = "private-" + crypto.randomUUID()
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/commerce.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          `for (const mode of ["pass", "assertion", "timeout", "throw", "poll", "caught", "collision", "collision-nested"]) test(\`probe \${mode} ${sentinel} @market\`, async () => {`,
          "  test.setTimeout(500);",
          '  test.info().annotations.push({ type: "smoke:commerce-journey", description: JSON.stringify({ phase: "checkout", elapsedSeconds: 12.345, phaseSeconds: 2.345, slowestSeconds: 5.678 }) });',
          '  if (mode === "poll") { let attempt = 0; await expect.poll(() => ++attempt, { intervals: [1] }).toBe(2); }',
          '  if (mode === "caught") { try { await test.step("caught-' +
            sentinel +
            '", async () => { expect(1).toBe(2); }); } catch {} }',
          '  await test.step("completed-' + sentinel + '", async () => {});',
          '  if (mode === "throw") throw new Error("' + sentinel + '");',
          '  if (mode === "assertion") expect("' +
            sentinel +
            '").toBe("different");',
          '  if (mode === "timeout") await test.step("waiting-' +
            sentinel +
            '", () => new Promise(() => {}));',
          '  if (mode === "poll" || mode === "caught") {',
          '    await test.step("ready-' + sentinel + '", async () => {});',
          '    try { expect("' + sentinel + '").toBe("terminal"); }',
          '    finally { await test.step("cleanup-' +
            sentinel +
            '", async () => {}); }',
          "  }",
          '  if (mode.startsWith("collision")) {',
          '    const fail = () => { const error = new Error("' +
            sentinel +
            '"); error.stack = "Error: ' +
            sentinel +
            '"; throw error; };',
          '    try { await test.step("recovered", fail); } catch {}',
          '    await test.step("collision-ready", async () => {});',
          '    try { await test.step("terminal", async () => {',
          '      if (mode === "collision-nested") await test.step("nested", fail, { location: { file: test.info().file, line: 21, column: 1 } });',
          "      else fail();",
          '    }); } finally { await test.step("collision-cleanup", async () => {}); }',
          "  }",
          "});",
        ].join("\n")
      )
      const config = join(directory, "playwright.config.ts")
      const output = join(directory, "results.json")
      const artifact = join(directory, "evidence.json")
      const progress = join(directory, "progress.log")
      const writeConfig = (startup = false) =>
        writeFileSync(
          config,
          `export default {
        testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1,
        metadata: { smokeEvidence: ${JSON.stringify(evidence)} },
        reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, progressFile: ${JSON.stringify(progress)}, evidence: ${JSON.stringify(evidence)} }]],
        projects: [{ name: "chromium" }],
        ${startup ? `webServer: { command: ${JSON.stringify("'" + process.execPath.replaceAll("'", "'\\''") + "' -e 'process.exit(1)'")}, wait: { stdout: /never-ready/ }, timeout: 1000 },` : ""}
      }`
        )
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [playwrightCli, "test", "-c", config, ...args],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: 15000,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
          }
        )
      writeConfig()
      const discovery = run(["--list", "--reporter=json"])
      expect(discovery.status).toBe(0)
      const manifest = buildPlaywrightSmokeManifest(
        JSON.parse(discovery.stdout),
        ["market"],
        evidence
      )
      expect(manifest.selectedTestCount).toBe(8)
      expect(run([]).status).toBe(1)
      const report = JSON.parse(
        readFileSync(output, "utf8")
      ) as PlaywrightJsonReport
      const serialized = readFileSync(artifact, "utf8")
      const summary = JSON.parse(serialized)
      const log = readFileSync(progress, "utf8")
      expect(serialized + log + readFileSync(output, "utf8")).not.toContain(
        sentinel
      )
      expect(summary.evidence).toEqual(evidence)
      expect(summary.status).toBe("failed")
      expect(typeof summary.timing.reporterSetupBucket).toBe("string")
      expect(typeof summary.timing.executionBucket).toBe("string")
      expect(serialized).not.toMatch(/"(?:[^"\n]*(?:Ms|Seconds)|duration)":/)
      expect(summary.timing.completedAttempts).toBe(8)
      expect(
        summary.tests.every((spec: { title?: string }) => !("title" in spec))
      ).toBe(true)
      const specs = report.suites![0]!.specs!
      const retainedResults = summary.tests.flatMap(
        (spec: {
          tests: Array<{
            results: Array<{ durationBucket: string; diagnostics: unknown[] }>
          }>
        }) => spec.tests.flatMap((test) => test.results)
      )
      expect(retainedResults).toHaveLength(8)
      expect(summary.schemaVersion).toBe(2)
      for (const result of retainedResults) {
        expect(result.durationBucket).toBeTypeOf("string")
        expect(result.diagnostics).toEqual([
          {
            kind: "commerce-journey",
            phase: "checkout",
            elapsedBucket: "5-15s",
            phaseBucket: "1-5s",
            slowestBucket: "5-15s",
          },
        ])
      }
      expect(specs[0]!.tests![0]!.results![0]!.duration).toBeTypeOf("number")
      expect(readFileSync(output, "utf8")).toContain('"elapsedSeconds":12.3')
      const ids = specs.map((spec) => spec.smokeId)
      expect(new Set(ids).size).toBe(8)
      expect([...ids].sort()).toEqual(
        manifest.tests.map((test) => test.id).sort()
      )
      const failures = specs
        .flatMap((spec) => spec.tests!.flatMap((test) => test.results!))
        .filter((result) => result.status !== "passed")
      expect(
        failures
          .map((result) => safePlaywrightFailure(result.failure)?.category)
          .sort()
      ).toEqual([
        "assertion",
        "assertion",
        "assertion",
        "timeout",
        "unknown",
        "unknown",
        "unknown",
      ])
      // The recovered poll and caught error must not obscure the terminal
      // assertion or let its cleanup replace the preceding successful boundary.
      const boundaries = specs
        .slice(4, 6)
        .flatMap((spec) => spec.tests!.flatMap((test) => test.results!))
      expect(boundaries).toHaveLength(2)
      for (const result of boundaries) {
        const failure = safePlaywrightFailure(result.failure)
        expect(failure?.failedStep?.location?.line).toBe(13)
        expect(failure?.lastCompletedStep?.location?.line).toBe(12)
        expect(failure?.category).toBe("assertion")
      }
      // Value-equal recovered errors must not win over the later terminal
      // occurrence, including when the terminal error propagates through a parent.
      const fixtureLines = readFileSync(
        join(directory, "e2e/commerce.playwright.ts"),
        "utf8"
      ).split("\n")
      const lineOf = (text: string) =>
        fixtureLines.findIndex((line) => line.includes(text)) + 1
      for (const [offset, terminal] of [
        'test.step("terminal"',
        'test.step("nested"',
      ].entries()) {
        const failure = safePlaywrightFailure(
          specs[6 + offset]!.tests![0]!.results![0]!.failure
        )
        expect(failure?.failedStep?.location?.line).toBe(lineOf(terminal))
        expect(failure?.lastCompletedStep?.location?.line).toBe(
          lineOf('test.step("collision-ready"')
        )
      }
      const unstepped = failures
        .map((result) => safePlaywrightFailure(result.failure))
        .find((failure) => failure?.category === "unknown")
      expect(unstepped?.failedStep).toBeUndefined()
      expect(unstepped?.lastCompletedStep?.category).toBe("test")
      expect(
        failures.every(
          (result) => safePlaywrightFailure(result.failure)?.lastCompletedStep
        )
      ).toBe(true)
      for (const id of ids) expect(log).toContain("case=" + id)
      expect(log).toContain("reproduce-source-group")
      expect(() =>
        validatePlaywrightSmokeExecution(report, manifest, ["market"], evidence)
      ).toThrow("did not pass cleanly")
      const missing = structuredClone(report)
      missing.suites![0]!.specs!.pop()
      expect(() =>
        validatePlaywrightSmokeExecution(
          missing,
          manifest,
          ["market"],
          evidence
        )
      ).toThrow("does not match")

      // Success must still earn the same strict evidence gate.
      expect(run(["--grep=probe pass"]).status).toBe(0)
      const passed = JSON.parse(
        readFileSync(output, "utf8")
      ) as PlaywrightJsonReport
      const passDiscovery = run([
        "--grep=probe pass",
        "--list",
        "--reporter=json",
      ])
      const passManifest = buildPlaywrightSmokeManifest(
        JSON.parse(passDiscovery.stdout),
        ["market"],
        evidence
      )
      expect(() =>
        validatePlaywrightSmokeExecution(
          passed,
          passManifest,
          ["market"],
          evidence
        )
      ).not.toThrow()
      expect(JSON.parse(readFileSync(artifact, "utf8")).status).toBe("passed")

      // Discovery-only runs may instantiate the reporter. Recreate stale evidence
      // to prove startup failure cannot leave an old passing artifact behind.
      writeFileSync(artifact, '{"status":"passed"}')
      writeConfig(true)
      expect(run([]).status).toBe(1)
      const startup = JSON.parse(readFileSync(artifact, "utf8"))
      expect(startup.status).toBe("failed")
      expect(startup.timing.executionBucket).toBe("under-1s")
      expect(startup.evidence).toEqual(evidence)
      expect(startup.errors).toContainEqual({
        phase: "startup",
        category: "web-server",
      })
      expect(() =>
        validatePlaywrightSmokeExecution(
          JSON.parse(readFileSync(output, "utf8")),
          manifest,
          ["market"],
          evidence
        )
      ).toThrow('"phase":"startup"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)

  it("scans artifact strings and revalidates untrusted failure boundaries", () => {
    for (const value of [
      "nsec1" + "q".repeat(60),
      "nostr+walletconnect://private",
      "https://example.com?token=private",
      "user@example.com",
      "lnbc" + "a".repeat(64),
    ]) {
      expect(() => serializeSmokeEvidence({ value })).toThrow("content-safety")
    }
    expect(() =>
      serializeSmokeEvidence({ evidence, smokeId: "d".repeat(64) })
    ).not.toThrow()
    const sentinel = crypto.randomUUID()
    expect(
      safePlaywrightFailure({
        category: "timeout",
        message: sentinel,
        failedStep: {
          category: "browser-operation",
          title: sentinel,
          location: {
            file: "e2e/probe.playwright.ts",
            line: sentinel,
            column: 3,
          },
        },
        lastCompletedStep: { category: sentinel },
      })
    ).toEqual({
      category: "timeout",
      failedStep: {
        category: "browser-operation",
        location: { file: "e2e/probe.playwright.ts", column: 3 },
      },
    })
  })

  it("retains long static conditions only in validated file-bound failure contexts", () => {
    const context = {
      boundary: "assertion",
      expected: "commerce_buyer_status_accepted_visible",
      observed: "unmet",
    }
    const artifact = (file: string, value: unknown) => ({
      tests: [
        { file, tests: [{ results: [{ failure: { context: value } }] }] },
      ],
    })
    const valid = artifact("e2e/commerce.playwright.ts", context)
    expect(JSON.parse(serializeSmokeEvidence(valid))).toEqual(valid)
    for (const invalid of [
      artifact("e2e/wallet-cross-app.playwright.ts", context),
      artifact("e2e/commerce.playwright.ts", {
        ...context,
        boundary: "user-action",
      }),
      artifact("e2e/commerce.playwright.ts", {
        ...context,
        expected: "unknown_condition_" + "a".repeat(40),
      }),
      artifact("e2e/commerce.playwright.ts", {
        ...context,
        detail: "nsec1" + "a".repeat(60),
      }),
      { ...valid, extra: context.expected },
      { context },
      { ...valid, nested: { context: { ...context } } },
    ]) {
      expect(() => serializeSmokeEvidence(invalid)).toThrow("content-safety")
    }
  })

  it("writes real-runner failure evidence for long approved condition names", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-long-context-"))
    const conditions = [
      ["commerce", "commerce_buyer_status_accepted_visible", "assertion"],
      [
        "wallet-cross-app",
        "wallet_refusal_foreground_import_completed",
        "user-action",
      ],
      [
        "mobile-safari-baseline",
        "mobile_wallet_setup_trigger_click_completed",
        "user-action",
      ],
    ]
    try {
      mkdirSync(join(directory, "e2e"))
      for (const [file, expected] of conditions) {
        writeFileSync(
          join(directory, `e2e/${file}.playwright.ts`),
          [
            `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
            `import { recordSmokeFailureContext } from ${JSON.stringify(smokeDiagnosticsImport)}`,
            'test("controlled failure @commerce", async ({}, info) => {',
            `  recordSmokeFailureContext(info, ${JSON.stringify(expected)}, "unmet");`,
            "  expect(false).toBe(true);",
            "});",
          ].join("\n")
        )
      }
      const output = join(directory, "results.json")
      const artifact = join(directory, "evidence.json")
      const config = join(directory, "playwright.config.ts")
      writeFileSync(
        config,
        `export default { testDir: "./e2e", testMatch: "*.playwright.ts", retries: 0, workers: 1, reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(output)}, evidenceFile: ${JSON.stringify(artifact)}, evidence: ${JSON.stringify(evidence)} }]], projects: [{ name: "chromium" }] }`
      )
      const run = spawnSync(
        process.execPath,
        [playwrightCli, "test", "-c", config],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        }
      )
      expect(run.status).toBe(1)
      const retained = JSON.parse(readFileSync(artifact, "utf8"))
      expect(retained.status).toBe("failed")
      expect(retained.errors).toEqual([])
      expect(retained.timing.completedAttempts).toBe(conditions.length)
      expect(retained.tests).toHaveLength(conditions.length)
      for (const [file, expected, boundary] of conditions) {
        const spec = retained.tests.find(
          (value: { file: string }) =>
            value.file === `e2e/${file}.playwright.ts`
        )
        expect(spec.tests[0].results[0]).toMatchObject({
          status: "failed",
          retry: 0,
          failure: { context: { boundary, expected, observed: "unmet" } },
        })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)

  it("uses fixed duration buckets and rejects exact retained timings", () => {
    expect(
      [
        0,
        999,
        1000,
        4999,
        5000,
        14999,
        15000,
        29999,
        30000,
        59999,
        60000,
        299999,
        300000,
        899999,
        900000,
        Number.MAX_SAFE_INTEGER,
        -1,
        NaN,
        Infinity,
      ].map(smokeDurationBucket)
    ).toEqual([
      "under-1s",
      "under-1s",
      "1-5s",
      "1-5s",
      "5-15s",
      "5-15s",
      "15-30s",
      "15-30s",
      "30-60s",
      "30-60s",
      "1-5m",
      "1-5m",
      "5-15m",
      "5-15m",
      "15m-plus",
      "15m-plus",
      "unknown",
      "unknown",
      "unknown",
    ])
    for (const key of [
      "reporterSetupMs",
      "executionMs",
      "duration",
      "elapsedSeconds",
      "phaseSeconds",
      "slowestSeconds",
    ]) {
      expect(() =>
        serializeSmokeEvidence({ nested: [{ [key]: 1234 }] })
      ).toThrow("duration")
    }
    for (const value of [1234, "1234ms", "private-value"]) {
      expect(() => serializeSmokeEvidence({ durationBucket: value })).toThrow(
        "duration"
      )
    }
  })
})
