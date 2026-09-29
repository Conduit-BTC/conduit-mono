import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  assertContributorRefreshPullRequest,
  CONTRIBUTOR_REFRESH_BRANCH,
  CONTRIBUTOR_SNAPSHOT_PATH,
} from "../scripts/ci/contributor_refresh_pr.mjs"

const repository = "Conduit-BTC/conduit-mono"
const pullRequest = {
  user: { type: "Bot", login: "conduit-sudden-agent[bot]" },
  head: {
    ref: CONTRIBUTOR_REFRESH_BRANCH,
    sha: "a".repeat(40),
    repo: { full_name: repository },
  },
  base: { ref: "main", repo: { full_name: repository } },
}
const files = [{ filename: CONTRIBUTOR_SNAPSHOT_PATH, status: "modified" }]

function verify(pr = pullRequest, changedFiles = files) {
  return () => assertContributorRefreshPullRequest(pr, changedFiles, repository)
}

const workflow = readFileSync(
  new URL(
    "../.github/workflows/refresh-repository-contributors.yml",
    import.meta.url
  ),
  "utf8"
)

describe("contributor refresh PR boundary", () => {
  it("accepts only the App-owned snapshot update", () => {
    expect(verify()).not.toThrow()
  })

  it("rejects unrelated or spoofed authors and branches", () => {
    for (const user of [
      { type: "User", login: "conduit-sudden-agent[bot]" },
      { type: "Bot", login: "another-app[bot]" },
    ]) {
      expect(verify({ ...pullRequest, user })).toThrow()
    }
    expect(
      verify({
        ...pullRequest,
        head: { ...pullRequest.head, ref: "chore/other" },
      })
    ).toThrow()
  })

  it("rejects fork heads and non-main bases", () => {
    expect(
      verify({
        ...pullRequest,
        head: {
          ...pullRequest.head,
          repo: { full_name: "attacker/conduit-mono" },
        },
      })
    ).toThrow()
    expect(
      verify({ ...pullRequest, base: { ...pullRequest.base, ref: "other" } })
    ).toThrow()
  })

  it("rejects executable changes, renames, deletions, and absent diffs", () => {
    expect(
      verify(pullRequest, [
        ...files,
        { filename: "package.json", status: "modified" },
      ])
    ).toThrow()
    expect(
      verify(pullRequest, [
        {
          filename: "scripts/vite/refresh_repository_contributors.ts",
          status: "modified",
        },
      ])
    ).toThrow()
    for (const status of ["renamed", "removed", "added"]) {
      expect(verify(pullRequest, [{ ...files[0], status }])).toThrow()
    }
    expect(verify(pullRequest, [])).toThrow()
    expect(() =>
      assertContributorRefreshPullRequest(null, files, repository)
    ).toThrow()
  })

  it("generates from immutable main before creating any write token", () => {
    expect(workflow).toContain(
      "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
    )
    expect(workflow).toContain("ref: ${{ github.sha }}")
    expect(workflow).toContain("persist-credentials: false")
    const generation = workflow.indexOf(
      "run: bun scripts/vite/refresh_repository_contributors.ts"
    )
    const guard = workflow.indexOf(
      "assertContributorRefreshPullRequest(pr, files"
    )
    const writeToken = workflow.indexOf("- name: Create repository write token")
    expect(generation).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(generation)
    expect(writeToken).toBeGreaterThan(guard)
    expect(workflow.slice(0, writeToken)).toContain(
      "GH_TOKEN: ${{ github.token }}"
    )
    expect(workflow.slice(0, writeToken)).not.toContain(
      "steps.app_token.outputs.token"
    )
    expect(workflow).not.toContain("git switch")
    expect(workflow).not.toContain("gh pr checkout")
    expect(workflow).toContain("branch.object.sha !== pr.head.sha")
  })

  it("updates one fixed branch and stages only the generated snapshot", () => {
    expect(workflow).toContain('cron: "17 8 * * 1"')
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("cancel-in-progress: false")
    expect(workflow).toContain(`branch: ${CONTRIBUTOR_REFRESH_BRANCH}`)
    expect(workflow).toContain(`add-paths: ${CONTRIBUTOR_SNAPSHOT_PATH}`)
    expect(workflow).not.toContain("branch-suffix:")
    expect(workflow).not.toContain("gh pr merge")
  })
})
