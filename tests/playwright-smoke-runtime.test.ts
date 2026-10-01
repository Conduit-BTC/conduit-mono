import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"

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
