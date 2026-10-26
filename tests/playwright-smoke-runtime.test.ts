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

  it("runs the Event native partition independently under the same required evidence policy", () => {
    expect(eventRouterJob.needs).toEqual(["smoke-changes"])
    expect(aggregateJob.needs).toContain("e2e-event-router")
    expect(eventRouterJob.container?.image).toMatch(
      new RegExp(
        `^mcr\\.microsoft\\.com/playwright:v${playwrightPackage.version.replaceAll(".", "\\.")}-noble@sha256:[a-f0-9]{64}$`
      )
    )
    expect(eventRouterJob.defaults?.run.shell).toBe("bash")
    expect(eventRouterJob["timeout-minutes"]).toBe(25)
    expect(eventRouterJob.if).toContain(
      "needs.smoke-changes.result == 'success'"
    )
    expect(eventRouterJob.if).toContain("'commerce'")
    expect(eventRouterJob.env?.PLAYWRIGHT_ROUTER_NATIVE_PROFILE).toBe("event")
    expect(eventRouterJob.env?.PLAYWRIGHT_SMOKE_AREA).toBe("commerce")
    expect(
      eventRouterJob.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@")
      )?.with?.["persist-credentials"]
    ).toBe(false)
    const uploads = eventRouterJob.steps.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@")
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.uses).toBe(
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"
    )
    expect(uploads[0]?.if).toBe("always()")
    expect(uploads[0]?.with).toEqual({
      name: "smoke-evidence-event-router-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/playwright-event-router-smoke-evidence.json",
      "if-no-files-found": "error",
      "retention-days": 7,
    })
    const scripts = eventRouterJob.steps
      .map((step) => step.run ?? "")
      .join("\n")
    expect(scripts).toContain("bun scripts/ci/router_smoke_partition.ts")
    expect(scripts).toContain(
      "--expected-manifest playwright-event-router-smoke-manifest.json"
    )
    expect(scripts).toContain(
      '--execution-report "$PLAYWRIGHT_SMOKE_RESULT_FILE"'
    )
    expect(scripts).toContain(
      "--config playwright.router.config.ts >/dev/null 2>&1"
    )
    expect(scripts).not.toMatch(/playwright install(?:-deps)?\b/)
  })

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
            SHARDS: JSON.stringify(expandSmokeMatrix([])),
            [failedStage]: status,
          },
        })
        expect(result.status).toBe(1)
      }
    }
  )

  it.each(["failure", "cancelled", "skipped", ""])(
    "rejects %s Event router execution when commerce is selected",
    (status) => {
      const result = spawnSync("bash", ["-c", aggregateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          SELECT_RESULT: "success",
          SHARD_RESULT: "success",
          EVENT_REQUIRED: "true",
          EVENT_RESULT: status,
          SHARDS: JSON.stringify(expandSmokeMatrix(["commerce"])),
        },
      })
      expect(result.status).toBe(1)
    }
  )
  it("accepts selected Event coverage only after both required jobs succeed", () => {
    const result = spawnSync("bash", ["-c", aggregateScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        SELECT_RESULT: "success",
        SHARD_RESULT: "success",
        EVENT_REQUIRED: "true",
        EVENT_RESULT: "success",
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
