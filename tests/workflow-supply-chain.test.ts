import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

function isPinned(reference: string): boolean {
  if (reference.startsWith("./")) return !reference.split("/").includes("..")
  if (reference.startsWith("docker://"))
    return /@sha256:[a-f0-9]{64}$/.test(reference)
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/.test(reference)
}

describe("workflow supply chain", () => {
  it("rejects mutable or computed executable references", () => {
    for (const ref of [
      "actions/checkout@main",
      "actions/checkout@v7",
      "a/b@123abc",
      "docker://image:latest",
      "${{ inputs.action }}",
      "./../outside",
    ])
      expect(isPinned(ref)).toBe(false)
    expect(isPinned(`actions/checkout@${"a".repeat(40)}`)).toBe(true)
    expect(isPinned(`docker://example/image@sha256:${"a".repeat(64)}`)).toBe(
      true
    )
  })
  it("pins every direct action and reusable workflow", () => {
    for (const name of readdirSync(".github/workflows").filter((name) =>
      /\.ya?ml$/.test(name)
    )) {
      const source = readFileSync(`.github/workflows/${name}`, "utf8")
      const workflow = Bun.YAML.parse(source) as {
        permissions?: Record<string, string>
        jobs: Record<
          string,
          {
            uses?: string
            steps?: Array<{ uses?: string; with?: Record<string, unknown> }>
          }
        >
      }
      for (const job of Object.values(workflow.jobs)) {
        for (const step of [job, ...(job.steps ?? [])]) {
          if (!step.uses) continue
          expect(isPinned(step.uses), `${name}: ${step.uses}`).toBe(true)
          if (step.uses.startsWith("actions/checkout@"))
            expect(
              (step as { with?: Record<string, unknown> }).with?.[
                "persist-credentials"
              ],
              name
            ).toBe(false)
        }
      }
      expect(workflow.permissions?.contents, name).not.toBe("write")
    }
  })
  it("retains updates and removes obsolete audit exemptions", () => {
    const updates = readFileSync(".github/dependabot.yml", "utf8")
    expect(updates).toContain('package-ecosystem: "github-actions"')
    const audit = Bun.YAML.parse(
      readFileSync(".github/workflows/dependency-security.yml", "utf8")
    ) as {
      permissions: Record<string, string>
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>
          steps?: Array<{ run?: string }>
        }
      >
    }
    expect(audit.permissions["security-events"]).toBeUndefined()
    const runs =
      audit.jobs["bun-audit"].steps?.map((step) => step.run ?? "").join("\n") ??
      ""
    expect(runs).toContain("bun audit --audit-level=high")
    expect(runs).not.toContain("--ignore")
    expect(audit.jobs["osv-pr-scan"].permissions?.["security-events"]).toBe(
      "write"
    )
  })
  it("bounds dependency lifecycle execution to reviewed binary installers", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"))
    expect(manifest.trustedDependencies).toEqual(["esbuild", "workerd"])
    expect(readFileSync("bunfig.toml", "utf8")).toContain(
      "minimumReleaseAge = 259200"
    )
  })
})
