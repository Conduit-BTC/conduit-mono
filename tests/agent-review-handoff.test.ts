import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const reviewWorkflow = await Bun.file(
  ".github/workflows/agent-pr-review.yml"
).text()
const simplifyWorkflow = await Bun.file(
  ".github/workflows/agent-simplify-review.yml"
).text()

const countOccurrences = (text: string, value: string) =>
  text.split(value).length - 1

const validationStepStart = simplifyWorkflow.indexOf(
  "      - name: Validate pull request and trigger"
)
const validationScriptStart = simplifyWorkflow.indexOf(
  "        run: |\n",
  validationStepStart
)
const validationScriptEnd = simplifyWorkflow.indexOf(
  "\n      - name:",
  validationScriptStart + 1
)
const validationScript = simplifyWorkflow
  .slice(validationScriptStart + "        run: |\n".length, validationScriptEnd)
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n")

type GateFixture = {
  eventName?: "pull_request_review" | "workflow_dispatch"
  headSha?: string
  triggerCommit?: string
  reviewCommit?: string
  reviewer?: string
  reviewBody?: string
  reviewComments?: string
  previousReviews?: string
}

const runGate = async ({
  eventName = "pull_request_review",
  headSha = "a".repeat(40),
  triggerCommit = headSha,
  reviewCommit = headSha,
  reviewer = "conduit-sudden-agent[bot]",
  reviewBody = `<!-- conduit:sudden-review clean head=${headSha} -->`,
  reviewComments = "[]",
  previousReviews = "[]",
}: GateFixture = {}) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "conduit-handoff-"))
  const ghPath = join(fixtureDirectory, "gh")
  const outputPath = join(fixtureDirectory, "github-output")
  const fakeGh = `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf '%s\\x1f%s\\x1f%s\\x1f%s\\x1f%s\\n' \\
    "$FAKE_BASE_REF" "$FAKE_HEAD_SHA" "false" "false" "OPEN"
elif [[ "$*" == *"/reviews/$TRIGGER_REVIEW_ID/comments?"* ]]; then
  printf '%s\\n' "$FAKE_REVIEW_COMMENTS"
elif [[ "$*" == *"/reviews/$TRIGGER_REVIEW_ID"* ]]; then
  jq -n \\
    --arg reviewer "$FAKE_REVIEWER" \\
    --arg commit "$FAKE_REVIEW_COMMIT" \\
    --arg body "$FAKE_REVIEW_BODY" \\
    '{user: {login: $reviewer}, commit_id: $commit, body: $body}'
elif [[ "$*" == *"/reviews?per_page=100"* ]]; then
  printf '%s\\n' "$FAKE_PREVIOUS_REVIEWS"
else
  printf 'Unexpected gh arguments: %s\\n' "$*" >&2
  exit 2
fi
`

  try {
    await writeFile(ghPath, fakeGh, { mode: 0o755 })
    const gateProcess = Bun.spawn(["bash", "-c", validationScript], {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        PATH: `${fixtureDirectory}:${Bun.env.PATH ?? ""}`,
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "Conduit-BTC/conduit-mono",
        GITHUB_EVENT_NAME: eventName,
        GITHUB_OUTPUT: outputPath,
        PR_NUMBER: "245",
        TRIGGER_REVIEW_ID: "123",
        TRIGGER_COMMIT_ID: triggerCommit,
        FAKE_BASE_REF: "main",
        FAKE_HEAD_SHA: headSha,
        FAKE_REVIEWER: reviewer,
        FAKE_REVIEW_COMMIT: reviewCommit,
        FAKE_REVIEW_BODY: reviewBody,
        FAKE_REVIEW_COMMENTS: reviewComments,
        FAKE_PREVIOUS_REVIEWS: previousReviews,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([
      gateProcess.exited,
      new Response(gateProcess.stderr).text(),
    ])
    const output = await Bun.file(outputPath)
      .exists()
      .then((exists) =>
        exists ? readFile(outputPath, "utf8") : Promise.resolve("")
      )

    return { exitCode, output, stderr }
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true })
  }
}

describe("agent review handoff", () => {
  it("does not treat uncommanded review comments as pull request events", () => {
    expect(reviewWorkflow).toContain("github.event_name == 'pull_request' &&")
    expect(reviewWorkflow).not.toContain("github.event.pull_request ||")
    expect(reviewWorkflow).toContain(
      "github.event.comment.body == '/agent review'"
    )
  })

  it("marks only zero-finding Sudden reviews for the final handoff", () => {
    expect(reviewWorkflow).toContain(
      "<!-- conduit:sudden-review clean head=${{ steps.pr.outputs.head_sha }} -->"
    )
    expect(reviewWorkflow).toContain(
      "A clean review must have zero inline comments"
    )
    expect(reviewWorkflow).toContain(
      '`commit_id: "${{ steps.pr.outputs.head_sha }}"`'
    )
    expect(reviewWorkflow).toContain("Never include the clean marker")
    expect(reviewWorkflow).toContain("resume: false")
  })

  it("runs automatic simplification only from a current clean bot review", () => {
    const triggerBlock = simplifyWorkflow.slice(
      0,
      simplifyWorkflow.indexOf("permissions:")
    )

    expect(triggerBlock).toContain("pull_request:\n    types: [synchronize]")
    expect(triggerBlock).toContain("pull_request_review:")
    expect(simplifyWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
    )
    expect(simplifyWorkflow).toContain(
      "github.event.review.user.login == 'conduit-sudden-agent[bot]'"
    )
    expect(simplifyWorkflow).toContain(
      'if [[ "$TRIGGER_COMMIT_ID" != "$head_sha" ]]'
    )
    expect(simplifyWorkflow).toContain(
      "/reviews/$TRIGGER_REVIEW_ID/comments?per_page=100"
    )
    expect(simplifyWorkflow).toContain(
      'if [[ "$review_comment_count" != "0" ]]'
    )
    expect(simplifyWorkflow).toContain(
      'if [[ "$review_body" != *"$clean_marker"* ]]'
    )
    expect(simplifyWorkflow).toContain(
      '`commit_id: "${{ steps.pr.outputs.head_sha }}"`'
    )
  })

  it("invokes the pinned Ponytail skill once automatically per pull request", () => {
    expect(simplifyWorkflow).toContain("Use the $ponytail-review skill")
    expect(simplifyWorkflow).toContain(
      "DietrichGebert/ponytail/0a4dd63ad4541f4f655c4108a295916f3c1d8fda/skills/ponytail-review/SKILL.md"
    )
    expect(simplifyWorkflow).toContain(
      "40df33b58fc6ef889b93585733feb9566b76e9586efa7f376785c1e995197ac0"
    )
    expect(simplifyWorkflow).toContain(
      "<!-- conduit:ponytail-final head=${{ steps.pr.outputs.head_sha }} -->"
    )
    expect(simplifyWorkflow).toContain(
      "jq -s --arg marker '<!-- conduit:ponytail-final'"
    )
    expect(simplifyWorkflow).toContain(
      "A final Ponytail review already exists; skipping the automatic rerun."
    )
    expect(simplifyWorkflow).toContain("should_run=false")
    expect(simplifyWorkflow).toContain(
      'echo "should_run=$should_run" >> "$GITHUB_OUTPUT"'
    )
    expect(
      countOccurrences(
        simplifyWorkflow,
        "if: steps.pr.outputs.should_run == 'true'"
      )
    ).toBe(5)
    expect(simplifyWorkflow).toContain(
      "github.event.comment.body == '/agent simplify'"
    )

    const automaticOnlyBlock = simplifyWorkflow.slice(
      simplifyWorkflow.indexOf(
        'if [[ "$GITHUB_EVENT_NAME" == "pull_request_review" ]]'
      ),
      simplifyWorkflow.indexOf('echo "number=$PR_NUMBER" >> "$GITHUB_OUTPUT"')
    )
    expect(automaticOnlyBlock).toContain("previous_ponytail_reviews")
    expect(automaticOnlyBlock).toContain("should_run=false")
  })

  it("evaluates clean, stale, dirty, duplicate, and manual gate fixtures", async () => {
    const headSha = "b".repeat(40)
    const clean = await runGate({ headSha })
    expect(clean.exitCode).toBe(0)
    expect(clean.output).toContain("should_run=true")

    const stale = await runGate({
      headSha,
      triggerCommit: "c".repeat(40),
    })
    expect(stale.exitCode).not.toBe(0)
    expect(stale.stderr).toContain("clean review is stale")

    const dirty = await runGate({ headSha, reviewComments: "[{}]" })
    expect(dirty.exitCode).not.toBe(0)
    expect(dirty.stderr).toContain("contains inline findings")

    const duplicate = await runGate({
      headSha,
      previousReviews: JSON.stringify([
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-final head=${headSha} -->`,
        },
      ]),
    })
    expect(duplicate.exitCode).toBe(0)
    expect(duplicate.output).toContain("should_run=false")

    const oldHeadMarker = await runGate({
      headSha,
      previousReviews: JSON.stringify([
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-final head=${"d".repeat(40)} -->`,
        },
      ]),
    })
    expect(oldHeadMarker.exitCode).toBe(0)
    expect(oldHeadMarker.output).toContain("should_run=false")

    const wrongReviewer = await runGate({
      headSha,
      reviewer: "untrusted-reviewer",
    })
    expect(wrongReviewer.exitCode).not.toBe(0)
    expect(wrongReviewer.stderr).toContain("Sudden Agent reviewer")

    const mismatchedFetchedCommit = await runGate({
      headSha,
      reviewCommit: "e".repeat(40),
    })
    expect(mismatchedFetchedCommit.exitCode).not.toBe(0)
    expect(mismatchedFetchedCommit.stderr).toContain(
      "source review does not match"
    )

    const mismatchedMarker = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${"f".repeat(40)} -->`,
    })
    expect(mismatchedMarker.exitCode).not.toBe(0)
    expect(mismatchedMarker.stderr).toContain("exact clean-review marker")

    const manual = await runGate({
      eventName: "workflow_dispatch",
      headSha,
      previousReviews: JSON.stringify([
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-final head=${headSha} -->`,
        },
      ]),
    })
    expect(manual.exitCode).toBe(0)
    expect(manual.output).toContain("should_run=true")
  })
})
