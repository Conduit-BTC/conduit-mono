import { describe, expect, it } from "bun:test"

const workflow = Bun.YAML.parse(
  await Bun.file(".github/workflows/ci.yml").text()
) as {
  jobs: Record<
    string,
    {
      container?: { image: string; options: string }
      defaults?: { run: { shell: string } }
      steps: Array<{ run?: string }>
    }
  >
}
const smokeJob = workflow.jobs["e2e-smoke-shard"]!
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
})
