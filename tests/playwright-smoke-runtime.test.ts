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
      container?: { image: string; options: string }
      defaults?: { run: { shell: string } }
      steps: Array<{ name?: string; run?: string }>
    }
  >
}
const smokeJob = workflow.jobs["e2e-smoke-shard"]!
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
            SHARDS: JSON.stringify(expandSmokeMatrix([])),
            [failedStage]: status,
          },
        })
        expect(result.status).toBe(1)
      }
    }
  )
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
