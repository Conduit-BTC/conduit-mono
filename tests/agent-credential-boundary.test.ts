import { describe, expect, it } from "bun:test"
import { readdir } from "node:fs/promises"

describe("public agent credential boundary", () => {
  it("keeps account-authenticated agent execution outside public workflows", async () => {
    const directory = ".github/workflows"
    const workflows = (await readdir(directory)).filter((name) =>
      /\.ya?ml$/.test(name)
    )

    expect(workflows.length).toBeGreaterThan(0)
    for (const name of workflows) {
      const workflow = await Bun.file(`${directory}/${name}`).text()
      if (name === "retire-legacy-codex.yml") {
        // Temporary terminal revocation has no agent or GitHub write capability.
        expect(workflow).toContain("permissions: {}")
        expect(workflow).toContain("  workflow_dispatch:")
        expect(workflow).toContain("github.ref == 'refs/heads/main'")
        expect(workflow).toContain("environment: legacy-codex-retirement")
        expect(workflow).toContain('AUTH_ORIGIN = "https://auth.openai.com"')
        expect(workflow).toContain(
          'code.lower() != "refresh_token_invalidated"'
        )
        expect(workflow).not.toMatch(
          /uses:|checkout|GH_TOKEN|GITHUB_TOKEN|PRIVATE_KEY|sudden-network|npx|docker|schedule:|pull_request:/
        )
        continue
      }
      expect(workflow).not.toMatch(
        /CODEX_AUTH_JSON|WORKFLOW_AGENT_GITHUB_APP_(?:PRIVATE_KEY|CLIENT_ID)|sudden-network\/agent/
      )
    }
  })
})
