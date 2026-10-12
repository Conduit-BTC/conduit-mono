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

describe("composed smoke evidence", () => {
  it("reports distinct parameterized failures through the real runner without exposing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "conduit-smoke-evidence-"))
    const sentinel = "private-" + crypto.randomUUID()
    try {
      mkdirSync(join(directory, "e2e"))
      writeFileSync(
        join(directory, "e2e/probe.playwright.ts"),
        [
          `import { test, expect } from ${JSON.stringify(playwrightImport)}`,
          `for (const mode of ["pass", "assertion", "timeout"]) test(\`probe \${mode} ${sentinel} @market\`, async () => {`,
          "  test.setTimeout(500);",
          '  await test.step("completed-' + sentinel + '", async () => {});',
          '  if (mode === "assertion") expect("' +
            sentinel +
            '").toBe("different");',
          '  if (mode === "timeout") await test.step("waiting-' +
            sentinel +
            '", () => new Promise(() => {}));',
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
      expect(manifest.selectedTestCount).toBe(3)
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
      expect(summary.timing.reporterSetupMs).toBeGreaterThanOrEqual(0)
      expect(summary.timing.executionMs).toBeGreaterThan(0)
      expect(summary.timing.completedAttempts).toBe(3)
      expect(
        summary.tests.every((spec: { title?: string }) => !("title" in spec))
      ).toBe(true)
      const specs = report.suites![0]!.specs!
      const ids = specs.map((spec) => spec.smokeId)
      expect(new Set(ids).size).toBe(3)
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
      ).toEqual(["assertion", "timeout"])
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
      ).toThrow()
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
})
