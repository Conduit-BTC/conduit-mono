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
      expect(workflow).not.toMatch(
        /CODEX_AUTH_JSON|WORKFLOW_AGENT_GITHUB_APP_(?:PRIVATE_KEY|CLIENT_ID)|sudden-network\/agent/
      )
    }
  })
})
