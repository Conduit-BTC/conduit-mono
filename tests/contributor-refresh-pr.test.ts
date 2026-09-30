import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  assertContributorRefreshBotLogin,
  assertContributorRefreshPullRequest,
  CONTRIBUTOR_REFRESH_BRANCH,
  CONTRIBUTOR_SNAPSHOT_PATH,
} from "../scripts/ci/contributor_refresh_pr.mjs"

const repository = "Conduit-BTC/conduit-mono"
const botLogin = "contributor-refresh-test[bot]"
const pullRequest = {
  user: { type: "Bot", login: botLogin },
  head: {
    ref: CONTRIBUTOR_REFRESH_BRANCH,
    sha: "a".repeat(40),
    repo: { full_name: repository },
  },
  base: { ref: "main", repo: { full_name: repository } },
}
const files = [{ filename: CONTRIBUTOR_SNAPSHOT_PATH, status: "modified" }]

function verify(pr = pullRequest, changedFiles = files) {
  return () =>
    assertContributorRefreshPullRequest(pr, changedFiles, repository, botLogin)
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
    expect(assertContributorRefreshBotLogin(botLogin)).toBe(botLogin)
    expect(verify()).not.toThrow()
  })

  it("fails closed when the configured bot login is absent or malformed", () => {
    for (const login of [
      undefined,
      null,
      123,
      "",
      "contributor-refresh-test",
      "contributor-refresh-test[Bot]",
      "Contributor-refresh-test[bot]",
      "-contributor-refresh-test[bot]",
      "contributor-refresh-test-[bot]",
      "contributor refresh test[bot]",
      "contributor-refresh-test[bot]\n",
      " contributor-refresh-test[bot]",
    ]) {
      expect(() => assertContributorRefreshBotLogin(login)).toThrow()
      expect(() =>
        assertContributorRefreshPullRequest(
          pullRequest,
          files,
          repository,
          login
        )
      ).toThrow()
    }
  })

  it("rejects unrelated or spoofed authors and branches", () => {
    for (const user of [
      { type: "User", login: botLogin },
      { type: "Bot", login: "another-app[bot]" },
      { type: "Bot", login: "conduit-sudden-agent[bot]" },
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
      assertContributorRefreshPullRequest(null, files, repository, botLogin)
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

  it("uses a separate environment App and verifies identity before writing", () => {
    expect(workflow).toContain("environment: contributor-refresh")
    expect(workflow).toContain("vars.CONTRIBUTOR_REFRESH_APP_CLIENT_ID")
    expect(workflow).toContain("secrets.CONTRIBUTOR_REFRESH_APP_PRIVATE_KEY")
    expect(workflow).toContain("vars.CONTRIBUTOR_REFRESH_BOT_LOGIN")
    expect(workflow).not.toContain("WORKFLOW_AGENT_GITHUB_APP")
    expect(workflow).not.toContain("CODEX_AUTH_JSON")
    expect(workflow).not.toContain("permission-secrets:")
    expect(workflow).toContain("permission-contents: write")
    expect(workflow).toContain("permission-pull-requests: write")

    const loginValidation = workflow.indexOf(
      "const botLogin = assertContributorRefreshBotLogin("
    )
    const branchLookup = workflow.indexOf("github.rest.git.getRef(")
    expect(loginValidation).toBeGreaterThan(0)
    expect(branchLookup).toBeGreaterThan(loginValidation)
    const identityCheck = workflow.indexOf(
      "- name: Verify contributor App identity"
    )
    expect(identityCheck).toBeGreaterThan(
      workflow.indexOf("- name: Create repository write token")
    )
    expect(
      workflow.indexOf("- name: Create or update the snapshot-only PR")
    ).toBeGreaterThan(identityCheck)
    expect(workflow).toContain("steps.app_token.outputs.app-slug")
    expect(workflow).toContain(
      "botLogin !== `${process.env.CONTRIBUTOR_REFRESH_APP_SLUG}[bot]`"
    )
  })
})
