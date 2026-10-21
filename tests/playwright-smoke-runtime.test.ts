import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  expandSmokeMatrix,
  selectSmokeShards,
} from "../scripts/ci/select_smoke_shards"

const workflow = Bun.YAML.parse(
  await Bun.file(".github/workflows/ci.yml").text()
) as {
  jobs: Record<
    string,
    {
      needs?: string[]
      if?: string
      env?: Record<string, string>
      "timeout-minutes"?: string | number
      container?: { image: string; options: string }
      defaults?: { run: { shell: string } }
      steps: Array<{
        name?: string
        run?: string
        uses?: string
        if?: string
        with?: Record<string, unknown>
      }>
    }
  >
}
const smokeJob = workflow.jobs["e2e-smoke-shard"]!
const routerJob = workflow.jobs["e2e-router"]!
const eventRouterJob = workflow.jobs["e2e-event-router"]!
const aggregateJob = workflow.jobs["e2e-smoke"]!
const aggregateScript = aggregateJob.steps.find(
  (step) => step.name === "Verify selected smoke shards"
)!.run!
const playwrightPackage = (await Bun.file(
  "node_modules/@playwright/test/package.json"
).json()) as { version: string }

describe("Playwright CI runtime", () => {
  it("matches the installed Playwright version with a pinned image and skips it for no-op shards", () => {
    expect(smokeJob.container?.image).toMatch(
      new RegExp(
        `^\\$\\{\\{ matrix\\.job\\.area != 'none' && 'mcr\\.microsoft\\.com/playwright:v${playwrightPackage.version.replaceAll(".", "\\.")}-noble@sha256:[a-f0-9]{64}' \\|\\| '' \\}\\}$`
      )
    )
  })

  it("overlaps build with independent checks and keeps previews behind validated build", () => {
    expect(workflow.jobs["build-mainnet"]!.needs ?? []).toEqual([])
    expect(workflow.jobs["preview-links"]!.needs).toEqual(["build-mainnet"])
    for (const check of [
      "format",
      "lint",
      "typecheck",
      "test",
      "color-policy",
      "telemetry-policy",
      "e2e-smoke",
    ]) {
      expect(workflow.jobs[check]).toBeDefined()
    }
  })

  it("uses Bash and preinstalled browsers without a per-shard package download", () => {
    expect(smokeJob.defaults?.run.shell).toBe("bash")
    expect(smokeJob.container?.options).toContain("--init")
    expect(smokeJob.container?.options).toContain("--shm-size=1g")
    for (const step of smokeJob.steps) {
      expect(step.run ?? "").not.toMatch(/playwright install(?:-deps)?\b/)
    }
  })

  it.each([
    ["e2e-router", routerJob, ["router", "router-receiver-setup"]],
    ["e2e-event-router", eventRouterJob, ["event-router"]],
  ] as const)(
    "runs %s independently under the same required evidence policy",
    (jobId, job, lanes) => {
      expect(job.needs).toEqual(["smoke-changes"])
      expect(aggregateJob.needs).toContain(jobId)
      expect(job.container?.image).toMatch(
        new RegExp(
          `^mcr\\.microsoft\\.com/playwright:v${playwrightPackage.version.replaceAll(".", "\\.")}-noble@sha256:[a-f0-9]{64}$`
        )
      )
      expect(job.defaults?.run.shell).toBe("bash")
      expect(job["timeout-minutes"]).toBe(25)
      expect(job.if).toContain("needs.smoke-changes.result == 'success'")
      expect(job.if).toContain("'commerce'")
      expect(job.env?.PLAYWRIGHT_ROUTER_NATIVE_PROFILE).toBe(
        jobId === "e2e-event-router" ? "event" : undefined
      )
      expect(job.env?.PLAYWRIGHT_SMOKE_AREA).toBe("commerce")
      expect(
        job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
          ?.with?.["persist-credentials"]
      ).toBe(false)
      const uploads = job.steps.filter((step) =>
        step.uses?.startsWith("actions/upload-artifact@")
      )
      expect(uploads).toHaveLength(lanes.length)
      for (const [index, lane] of lanes.entries()) {
        const file =
          lane === "router-receiver-setup"
            ? "playwright-router-receiver-setup"
            : `playwright-${lane}-smoke`
        expect(uploads[index]?.uses).toBe(
          "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"
        )
        expect(uploads[index]?.if).toBe("always()")
        expect(uploads[index]?.with).toEqual({
          name: `smoke-evidence-${lane}-\${{ github.run_attempt }}`,
          path: `\${{ runner.temp }}/${file}-evidence.json`,
          "if-no-files-found": "error",
          "retention-days": 7,
        })
      }
      const scripts = job.steps.map((step) => step.run ?? "").join("\n")
      if (jobId === "e2e-event-router") {
        expect(scripts).toContain("bun scripts/ci/router_smoke_partition.ts")
        expect(scripts).toContain(
          "--expected-manifest playwright-event-router-smoke-manifest.json"
        )
      } else {
        expect(
          job.steps
            .filter((step) => step.name?.startsWith("Verify executed"))
            .every((step) => step.if === "always()")
        ).toBe(true)
        expect(
          job.steps.some(
            (step) =>
              step.name === "Remove raw router output" && step.if === "always()"
          )
        ).toBe(true)
        expect(JSON.stringify(job)).not.toContain("matrix.job")
        expect(JSON.stringify(smokeJob)).not.toContain(
          "PLAYWRIGHT_ROUTER_NATIVE_PROFILE"
        )
      }
      expect(scripts).toContain(
        '--execution-report "$PLAYWRIGHT_SMOKE_RESULT_FILE"'
      )
      expect(scripts).toContain(
        "--config playwright.router.config.ts >/dev/null 2>&1"
      )
      expect(scripts).not.toMatch(/playwright install(?:-deps)?\b/)
    }
  )

  it.each([
    ["documentation-only", ["docs/knowledge/testing.md"]],
    ["unit-test-only", ["tests/cart-model.test.ts"]],
  ] as const)(
    "accepts completed %s no-op shards at the aggregate gate",
    (_, paths) => {
      const shards = expandSmokeMatrix(selectSmokeShards(paths))
      expect(shards).toEqual([{ id: "none", area: "none", shard: "" }])
      const result = spawnSync("bash", ["-c", aggregateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          SELECT_RESULT: "success",
          SHARD_RESULT: "success",
          EVENT_REQUIRED: "false",
          EVENT_RESULT: "skipped",
          ROUTER_RESULT: "skipped",
          SHARDS: JSON.stringify(shards),
        },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("Smoke shard result: success")
    }
  )

  it.each(["failure", "cancelled", "skipped"])(
    "rejects %s selection or shard execution even for no-op changes",
    (status) => {
      for (const failedStage of ["SELECT_RESULT", "SHARD_RESULT"]) {
        const result = spawnSync("bash", ["-c", aggregateScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            SELECT_RESULT: "success",
            SHARD_RESULT: "success",
            EVENT_REQUIRED: "false",
            EVENT_RESULT: "skipped",
            ROUTER_RESULT: "skipped",
            SHARDS: JSON.stringify(expandSmokeMatrix([])),
            [failedStage]: status,
          },
        })
        expect(result.status).toBe(1)
      }
    }
  )

  it.each(["failure", "cancelled", "skipped", ""])(
    "rejects %s router execution when commerce is selected",
    (status) => {
      for (const failedJob of ["EVENT_RESULT", "ROUTER_RESULT"]) {
        const result = spawnSync("bash", ["-c", aggregateScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            SELECT_RESULT: "success",
            SHARD_RESULT: "success",
            EVENT_REQUIRED: "true",
            EVENT_RESULT: "success",
            ROUTER_RESULT: "success",
            SHARDS: JSON.stringify(expandSmokeMatrix(["commerce"])),
            [failedJob]: status,
          },
        })
        expect(result.status).toBe(1)
      }
    }
  )
  it.each(["success", "failure", "cancelled", ""])(
    "rejects unexpected %s router execution when commerce is not selected",
    (status) => {
      for (const unexpectedJob of ["EVENT_RESULT", "ROUTER_RESULT"]) {
        const result = spawnSync("bash", ["-c", aggregateScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            SELECT_RESULT: "success",
            SHARD_RESULT: "success",
            EVENT_REQUIRED: "false",
            EVENT_RESULT: "skipped",
            ROUTER_RESULT: "skipped",
            SHARDS: JSON.stringify(expandSmokeMatrix([])),
            [unexpectedJob]: status,
          },
        })
        expect(result.status).toBe(1)
      }
    }
  )
  it("accepts selected commerce coverage only after all required jobs succeed", () => {
    const result = spawnSync("bash", ["-c", aggregateScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        SELECT_RESULT: "success",
        SHARD_RESULT: "success",
        EVENT_REQUIRED: "true",
        EVENT_RESULT: "success",
        ROUTER_RESULT: "success",
        SHARDS: JSON.stringify(expandSmokeMatrix(["commerce"])),
      },
    })
    expect(result.status).toBe(0)
  })
})

it.each([
  ["main push", "push", "false", "0", false, 0],
  ["no-op or full coverage", "pull_request", "false", "0", false, 0],
  ["bounded source", "pull_request", "true", "0", true, 0],
  ["failed discovery", "pull_request", "true", "1", true, 1],
] as const)(
  "runs the selection workflow for %s",
  (_, event, needs, discoveryExit, installs, exit) => {
    const directory = mkdtempSync(join(tmpdir(), "smoke-selector-"))
    try {
      const log = join(directory, "calls")
      const output = join(directory, "output")
      writeFileSync(log, "")
      writeFileSync(output, "")
      writeFileSync(join(directory, "git"), "#!/bin/bash\nprintf base\n")
      writeFileSync(
        join(directory, "bun"),
        `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *--needs-inventory*) printf '%s' "$NEEDS_INVENTORY" ;;
  *test:e2e:areas*) exit "$DISCOVERY_EXIT" ;;
  *select_smoke_shards*) printf '%s' '[{"id":"none","area":"none","shard":""}]' ;;
esac
`
      )
      for (const name of ["git", "bun"]) chmodSync(join(directory, name), 0o755)
      const script = workflow.jobs["smoke-changes"]!.steps.find(
        (step) => step.name === "Select affected smoke shards"
      )!.run!
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          EVENT_NAME: event,
          RAW_BASE_SHA: "base",
          HEAD_SHA: "head",
          GITHUB_OUTPUT: output,
          CALL_LOG: log,
          NEEDS_INVENTORY: needs,
          DISCOVERY_EXIT: discoveryExit,
        },
      })
      expect(result.status).toBe(exit)
      const calls = readFileSync(log, "utf8")
      expect(calls.includes("install --frozen-lockfile")).toBe(installs)
      expect(calls.includes("run test:e2e:areas")).toBe(installs)
      expect(readFileSync(output, "utf8").includes("shards=")).toBe(exit === 0)
      if (event === "push") expect(calls).toContain("--all")
      if (installs && exit === 0)
        expect(calls).toContain("--inventory smoke-inventory.json")
      if (!installs)
        expect(calls).not.toContain("--inventory smoke-inventory.json")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
