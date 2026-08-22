import { describe, expect, it } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const reviewWorkflow = await Bun.file(
  ".github/workflows/agent-pr-review.yml"
).text()
const simplifyWorkflow = await Bun.file(
  ".github/workflows/agent-simplify-review.yml"
).text()
const reviewConcurrency = reviewWorkflow.slice(
  reviewWorkflow.indexOf("concurrency:"),
  reviewWorkflow.indexOf("\njobs:")
)
const workflowDirectory = ".github/workflows"
const workflows = await Promise.all(
  (await readdir(workflowDirectory))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map(async (name) => {
      const path = `${workflowDirectory}/${name}`
      return [path, await Bun.file(path).text()] as const
    })
)
const requiredTokenWorkflowPaths = [
  ".github/workflows/agent-auth-refresh.yml",
  ".github/workflows/agent-ops-codex-first-shot.yml",
  ".github/workflows/agent-pr-harden.yml",
  ".github/workflows/agent-pr-review.yml",
  ".github/workflows/agent-simplify-review.yml",
] as const

const countOccurrences = (text: string, value: string) =>
  text.split(value).length - 1

const getOutputValue = (output: string, name: string) =>
  output
    .trim()
    .split("\n")
    .filter((line) => line.startsWith(`${name}=`))
    .at(-1)
    ?.slice(name.length + 1)

const getNamedJob = (workflow: string, name: string) => {
  const start = workflow.indexOf(`  ${name}:\n`)
  const remainder = workflow.slice(start + 1)
  const nextOffset = remainder.search(/\n {2}[A-Za-z0-9_-]+:\n/)
  const next = nextOffset === -1 ? undefined : start + 1 + nextOffset
  return workflow.slice(start, next)
}

const getNamedStep = (workflow: string, name: string) => {
  const start = workflow.indexOf(`      - name: ${name}`)
  const next = workflow.indexOf("\n      - name:", start + 1)
  return workflow.slice(start, next === -1 ? undefined : next)
}

const getRunScript = (workflow: string, name: string) => {
  const stepStart = workflow.indexOf(`      - name: ${name}`)
  const marker = "        run: |\n"
  const scriptStart = workflow.indexOf(marker, stepStart) + marker.length
  const lines = workflow.slice(scriptStart).split("\n")
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("          ")
  )
  return lines
    .slice(0, end === -1 ? undefined : end)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
}

const validationScript = getRunScript(
  simplifyWorkflow,
  "Validate pull request and trigger"
)
const revalidationScript = getRunScript(
  simplifyWorkflow,
  "Revalidate queued handoff"
)
const stageSkillScript = getRunScript(
  simplifyWorkflow,
  "Stage pinned Ponytail review skill"
)
const reserveAttemptScript = getRunScript(
  simplifyWorkflow,
  "Reserve automatic Ponytail attempt"
)

type GateFixture = {
  eventName?: "pull_request_review" | "workflow_dispatch"
  headSha?: string
  triggerCommit?: string
  expectedHead?: string
  reviewCommit?: string
  reviewer?: string
  reviewBody?: string
  reviewComments?: string
  previousReviews?: string
}

const runGate = async (
  {
    eventName = "pull_request_review",
    headSha = "a".repeat(40),
    triggerCommit = headSha,
    expectedHead = headSha,
    reviewCommit = headSha,
    reviewer = "conduit-sudden-agent[bot]",
    reviewBody = `<!-- conduit:sudden-review clean head=${headSha} -->\nNo actionable findings.\nReviewer-confirmed QA disposition: Maintainer-owned validation`,
    reviewComments = "[]",
    previousReviews = "[]",
  }: GateFixture = {},
  script = validationScript
) => {
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
    const gateProcess = Bun.spawn(["bash", "-c", script], {
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
        EXPECTED_HEAD_SHA: expectedHead,
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
    const [exitCode, stdout, stderr] = await Promise.all([
      gateProcess.exited,
      new Response(gateProcess.stdout).text(),
      new Response(gateProcess.stderr).text(),
    ])
    const outputFile = Bun.file(outputPath)
    const output = (await outputFile.exists()) ? await outputFile.text() : ""

    return { exitCode, output, stderr, stdout }
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true })
  }
}

describe("agent review handoff", () => {
  it("shares PR review concurrency only with trusted commands", () => {
    expect(reviewWorkflow).toContain("github.event_name == 'pull_request' &&")
    expect(reviewWorkflow).not.toContain("github.event.pull_request ||")
    expect(reviewConcurrency).toContain(
      "github.event.comment.body != '/agent review'"
    )
    expect(reviewConcurrency).toContain(
      '!contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'),'
    )
    expect(reviewConcurrency).toContain(
      "github.event.comment.author_association"
    )
    expect(reviewConcurrency).toContain(
      "format('non-review-comment-{0}', github.run_id)"
    )
    expect(reviewConcurrency).toContain("github.event.pull_request.number ||")
    expect(reviewConcurrency).toContain("github.event.issue.number ||")
    expect(reviewConcurrency).toContain("inputs.pr_number ||")
    expect(reviewWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' && github.event.action == 'synchronize' }}"
    )
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
      "Reviewer-confirmed QA disposition: <disposition>"
    )
    expect(reviewWorkflow).toContain(
      '`commit_id: "${{ steps.pr.outputs.head_sha }}"`'
    )
    expect(reviewWorkflow).toContain("Never include the clean marker")
    expect(reviewWorkflow).toContain(
      "Automatic Ponytail review is intentionally once per pull request."
    )
    expect(countOccurrences(reviewWorkflow, "resume: false")).toBe(3)
    expect(
      countOccurrences(
        reviewWorkflow,
        "prompt: ${{ steps.review_prompt.outputs.value }}"
      )
    ).toBe(3)
  })

  it("preserves the review validation toolchain and auth fallbacks", () => {
    const codexReview = getNamedStep(
      reviewWorkflow,
      "Run Sudden Agent review with CODEX_AUTH_JSON"
    )
    const authFileReview = getNamedStep(
      reviewWorkflow,
      "Run Sudden Agent review with auth file"
    )
    const apiKeyReview = getNamedStep(
      reviewWorkflow,
      "Run Sudden Agent review with API key"
    )

    expect(reviewWorkflow).toContain(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
    )
    expect(reviewWorkflow).toContain(
      "bun install --frozen-lockfile --ignore-scripts"
    )
    expect(codexReview).toContain(
      "agent_auth_file: ${{ secrets.CODEX_AUTH_JSON }}"
    )
    expect(codexReview).toContain(
      "continue-on-error: ${{ steps.auth.outputs.has_auth_file == 'true' || steps.auth.outputs.has_api_key == 'true' }}"
    )
    expect(authFileReview).toContain(
      "agent_auth_file: ${{ secrets.SUDDEN_AGENT_AUTH_FILE }}"
    )
    expect(authFileReview).toContain(
      "steps.auth.outputs.has_auth_file == 'true'"
    )
    expect(authFileReview).toContain(
      "steps.auth.outputs.has_codex_auth_json != 'true' ||"
    )
    expect(authFileReview).toContain(
      "steps.review_codex_auth_json.outcome == 'failure'"
    )
    expect(authFileReview).toContain(
      "continue-on-error: ${{ steps.auth.outputs.has_api_key == 'true' }}"
    )
    expect(apiKeyReview).toContain(
      "agent_api_key: ${{ secrets.SUDDEN_AGENT_API_KEY }}"
    )
    expect(apiKeyReview).toContain("steps.auth.outputs.has_api_key == 'true'")
    expect(apiKeyReview).toContain(
      "steps.auth.outputs.has_codex_auth_json != 'true' ||"
    )
    expect(apiKeyReview).toContain(
      "steps.review_codex_auth_json.outcome == 'failure'"
    )
    expect(apiKeyReview).toContain(
      "steps.auth.outputs.has_auth_file != 'true' ||"
    )
    expect(apiKeyReview).toContain(
      "steps.review_auth_file.outcome == 'failure'"
    )

    for (const reviewStep of [codexReview, authFileReview, apiKeyReview]) {
      expect(reviewStep).toContain(
        "prompt: ${{ steps.review_prompt.outputs.value }}"
      )
    }
  })

  it("uses one current GitHub App client ID contract", () => {
    const tokenAction = "actions/create-github-app-token@"
    const pinnedTokenAction =
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
    const clientIdInput =
      "client-id: ${{ vars.WORKFLOW_AGENT_GITHUB_APP_CLIENT_ID }}"

    for (const [path, workflow] of workflows) {
      expect(workflow, path).not.toContain("WORKFLOW_AGENT_GITHUB_APP_ID")
      expect(workflow, path).not.toContain("app-id:")

      const tokenActionCount = countOccurrences(workflow, tokenAction)
      expect(countOccurrences(workflow, pinnedTokenAction), path).toBe(
        tokenActionCount
      )
      expect(countOccurrences(workflow, clientIdInput), path).toBe(
        tokenActionCount
      )
    }

    for (const requiredPath of requiredTokenWorkflowPaths) {
      const workflow = workflows.find(([path]) => path === requiredPath)?.[1]
      expect(workflow, requiredPath).toBeDefined()
      expect(countOccurrences(workflow ?? "", tokenAction), requiredPath).toBe(
        1
      )
    }
  })

  it("runs automatic simplification only from a current clean bot review", () => {
    const workflowHeader = simplifyWorkflow.slice(
      0,
      simplifyWorkflow.indexOf("jobs:")
    )
    const preflightJob = getNamedJob(simplifyWorkflow, "preflight")
    const simplifyJob = getNamedJob(simplifyWorkflow, "simplify")

    expect(workflowHeader).not.toContain("pull_request:")
    expect(workflowHeader).toContain("pull_request_review:")
    expect(workflowHeader).not.toContain("concurrency:")
    expect(simplifyWorkflow).not.toContain("cancel-stale:")
    expect(simplifyWorkflow).not.toContain("cancel-in-progress:")
    expect(preflightJob).not.toContain("concurrency:")
    expect(preflightJob).toContain("number: ${{ steps.pr.outputs.number }}")
    expect(preflightJob).toContain("head_sha: ${{ steps.pr.outputs.head_sha }}")
    expect(preflightJob).toContain(
      "should_run: ${{ steps.pr.outputs.should_run }}"
    )
    expect(simplifyJob).toContain("needs: preflight")
    expect(simplifyJob).toContain(
      "needs.preflight.outputs.should_run == 'true'"
    )
    expect(simplifyJob).toContain(
      "group: agent-ponytail-final-${{ needs.preflight.outputs.number }}"
    )
    expect(simplifyJob).toContain("queue: max")
    expect(simplifyJob).not.toContain("cancel-in-progress: true")
    expect(simplifyJob).toContain("Revalidate queued handoff")
    expect(simplifyJob).toContain(
      "Immediately before submission, fetch the pull request again."
    )
    expect(simplifyJob).toContain(
      "its head is not `${{ steps.pr.outputs.head_sha }}`, stop without"
    )
    expect(simplifyJob).toContain("submitting a review.")
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
    expect(
      countOccurrences(simplifyWorkflow, 'grep -Fqx "$clean_summary"')
    ).toBe(2)
    expect(
      countOccurrences(simplifyWorkflow, 'grep -Ecx "$qa_disposition_pattern"')
    ).toBe(2)
    expect(simplifyWorkflow).toContain(
      '`commit_id: "${{ steps.pr.outputs.head_sha }}"`'
    )
  })

  it("invokes the pinned Ponytail skill once automatically per pull request", () => {
    const reserveAttemptStep = getNamedStep(
      simplifyWorkflow,
      "Reserve automatic Ponytail attempt"
    )

    expect(simplifyWorkflow).toContain(
      "[$ponytail-review](${{ steps.ponytail_skill.outputs.skill_path }})"
    )
    expect(simplifyWorkflow).not.toContain("Use the $ponytail-review skill")
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
      "jq -s --arg marker '<!-- conduit:ponytail-'"
    )
    expect(simplifyWorkflow).toContain(
      "An automatic Ponytail attempt already exists; skipping the automatic rerun."
    )
    expect(reserveAttemptStep).toContain(
      "if: steps.pr.outputs.should_run == 'true' && github.event_name == 'pull_request_review'"
    )
    expect(reserveAttemptStep).toContain(
      'marker="<!-- conduit:ponytail-attempted head=$HEAD_SHA -->"'
    )
    expect(reserveAttemptStep).toContain(
      "GH_TOKEN: ${{ steps.app_token.outputs.token }}"
    )
    expect(reserveAttemptStep).toContain(
      "PR_NUMBER: ${{ steps.pr.outputs.number }}"
    )
    expect(reserveAttemptStep).toContain(
      "HEAD_SHA: ${{ steps.pr.outputs.head_sha }}"
    )
    expect(reserveAttemptStep).toContain("gh api --method POST")
    expect(reserveAttemptStep).toContain("-f event=COMMENT")
    expect(reserveAttemptStep).toContain('-f commit_id="$HEAD_SHA"')
    expect(reserveAttemptStep).toContain(
      "Automatic final Ponytail review started."
    )
    expect(
      simplifyWorkflow.indexOf("- name: Revalidate queued handoff")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Create GitHub App review token")
    )
    expect(
      simplifyWorkflow.indexOf("- name: Create GitHub App review token")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Reserve automatic Ponytail attempt")
    )
    expect(
      simplifyWorkflow.indexOf("- name: Reserve automatic Ponytail attempt")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Require automation credentials")
    )
    expect(
      simplifyWorkflow.indexOf("- name: Require automation credentials")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Checkout immutable pull request head")
    )
    expect(
      simplifyWorkflow.indexOf("- name: Checkout immutable pull request head")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Stage pinned Ponytail review skill")
    )
    expect(
      simplifyWorkflow.indexOf("- name: Stage pinned Ponytail review skill")
    ).toBeLessThan(
      simplifyWorkflow.indexOf("- name: Run final Ponytail review")
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
    ).toBe(6)
    expect(simplifyWorkflow).toContain(
      "github.event.comment.body == '/agent simplify'"
    )
  })

  it("writes the durable attempt marker before the automatic review", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "conduit-attempt-"))
    const ghPath = join(fixtureDirectory, "gh")
    const resultPath = join(fixtureDirectory, "result")
    const headSha = "9".repeat(40)
    const fakeGh = `#!/usr/bin/env bash
set -euo pipefail

expected_body=$'body=<!-- conduit:ponytail-attempted head='"$FAKE_HEAD_SHA"$' -->\\n\\nAutomatic final Ponytail review started.'
[[ "$1" == "api" ]]
shift
method=""
path=""
event_field=""
commit_field=""
body_field=""
silent=false
while (( $# > 0 )); do
  case "$1" in
    --method)
      shift
      method="$1"
      ;;
    -f)
      shift
      case "$1" in
        event=*) event_field="$1" ;;
        commit_id=*) commit_field="$1" ;;
        body=*) body_field="$1" ;;
        *) exit 2 ;;
      esac
      ;;
    --silent) silent=true ;;
    repos/*) path="$1" ;;
    *) exit 2 ;;
  esac
  shift
done
[[ "$method" == "POST" ]]
[[ "$path" == "repos/Conduit-BTC/conduit-mono/pulls/245/reviews" ]]
[[ "$event_field" == "event=COMMENT" ]]
[[ "$commit_field" == "commit_id=$FAKE_HEAD_SHA" ]]
[[ "$body_field" == "$expected_body" ]]
[[ "$silent" == "true" ]]
printf 'reserved\\n' > "$FAKE_RESULT_PATH"
`

    try {
      await writeFile(ghPath, fakeGh, { mode: 0o755 })
      const reserveProcess = Bun.spawn(["bash", "-c", reserveAttemptScript], {
        cwd: process.cwd(),
        env: {
          ...Bun.env,
          PATH: `${fixtureDirectory}:${Bun.env.PATH ?? ""}`,
          GH_TOKEN: "fixture-token",
          GITHUB_REPOSITORY: "Conduit-BTC/conduit-mono",
          PR_NUMBER: "245",
          HEAD_SHA: headSha,
          FAKE_HEAD_SHA: headSha,
          FAKE_RESULT_PATH: resultPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([
        reserveProcess.exited,
        new Response(reserveProcess.stderr).text(),
      ])

      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(await readFile(resultPath, "utf8")).toBe("reserved\n")
    } finally {
      await rm(fixtureDirectory, { force: true, recursive: true })
    }
  })

  it("stages the skill outside PR-controlled symlinks", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "conduit-skill-"))
    const checkout = join(fixtureDirectory, "checkout")
    const fakeBin = join(fixtureDirectory, "bin")
    const runnerHome = join(fixtureDirectory, "home")
    const runnerTemp = join(fixtureDirectory, "runner-temp")
    const maliciousSkillDirectory = join(
      checkout,
      ".agents",
      "skills",
      "ponytail-review"
    )
    const agentsPath = join(checkout, "AGENTS.md")
    const duplicateSkillPath = join(
      checkout,
      ".agents",
      "skills",
      "duplicate-ponytail",
      "SKILL.md"
    )
    const outputPath = join(fixtureDirectory, "github-output")
    const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
output=""
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    shift
    output="$1"
  fi
  shift
done
[[ -n "$output" ]]
printf 'verified Ponytail skill\n' > "$output"
`
    const fakeSha256sum = `#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r _line; do :; done
`

    try {
      await mkdir(maliciousSkillDirectory, { recursive: true })
      await mkdir(fakeBin, { recursive: true })
      await mkdir(runnerHome, { recursive: true })
      await mkdir(runnerTemp, { recursive: true })
      await writeFile(agentsPath, "trusted repository instructions\n")
      await symlink(
        "../../../AGENTS.md",
        join(maliciousSkillDirectory, "SKILL.md")
      )
      await mkdir(join(checkout, ".agents", "skills", "duplicate-ponytail"), {
        recursive: true,
      })
      await writeFile(
        duplicateSkillPath,
        "---\nname: ponytail-review\ndescription: untrusted duplicate\n---\n"
      )
      await writeFile(join(fakeBin, "curl"), fakeCurl, { mode: 0o755 })
      await writeFile(join(fakeBin, "sha256sum"), fakeSha256sum, {
        mode: 0o755,
      })

      const stageProcess = Bun.spawn(["bash", "-c", stageSkillScript], {
        cwd: checkout,
        env: {
          ...Bun.env,
          HOME: runnerHome,
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputPath,
          PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
          PONYTAIL_SKILL_URL: "https://example.invalid/SKILL.md",
          PONYTAIL_SKILL_SHA256: "fixture-hash",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([
        stageProcess.exited,
        new Response(stageProcess.stderr).text(),
      ])

      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(await readFile(agentsPath, "utf8")).toBe(
        "trusted repository instructions\n"
      )
      expect(
        await readFile(
          join(runnerHome, ".agents", "skills", "ponytail-review", "SKILL.md"),
          "utf8"
        )
      ).toBe("verified Ponytail skill\n")
      expect(await readFile(outputPath, "utf8")).toBe(
        `skill_path=${join(
          runnerHome,
          ".agents",
          "skills",
          "ponytail-review",
          "SKILL.md"
        )}\n`
      )
      expect(await readFile(duplicateSkillPath, "utf8")).toContain(
        "name: ponytail-review"
      )
    } finally {
      await rm(fixtureDirectory, { force: true, recursive: true })
    }
  })

  it("evaluates clean, stale, dirty, duplicate, and manual gate fixtures", async () => {
    const headSha = "b".repeat(40)
    const clean = await runGate({ headSha })
    expect(clean.exitCode).toBe(0)
    expect(getOutputValue(clean.output, "should_run")).toBe("true")

    const stale = await runGate({
      headSha,
      triggerCommit: "c".repeat(40),
    })
    expect(stale.exitCode).toBe(0)
    expect(getOutputValue(stale.output, "should_run")).toBe("false")
    expect(stale.stdout).toContain("clean review is stale")

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
    expect(getOutputValue(duplicate.output, "should_run")).toBe("false")

    const attempted = await runGate({
      headSha,
      previousReviews: JSON.stringify([
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-attempted head=${headSha} -->`,
        },
      ]),
    })
    expect(attempted.exitCode).toBe(0)
    expect(getOutputValue(attempted.output, "should_run")).toBe("false")
    expect(attempted.stdout).toContain("attempt already exists")

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
    expect(getOutputValue(oldHeadMarker.output, "should_run")).toBe("false")

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
    expect(mismatchedFetchedCommit.exitCode).toBe(0)
    expect(getOutputValue(mismatchedFetchedCommit.output, "should_run")).toBe(
      "false"
    )
    expect(mismatchedFetchedCommit.stdout).toContain("source review is stale")

    const mismatchedMarker = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${"f".repeat(40)} -->\nNo actionable findings.\nReviewer-confirmed QA disposition: Maintainer-owned validation`,
    })
    expect(mismatchedMarker.exitCode).not.toBe(0)
    expect(mismatchedMarker.stderr).toContain("exact clean-review marker")

    const missingSummary = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nReviewer-confirmed QA disposition: Maintainer-owned validation`,
    })
    expect(missingSummary.exitCode).not.toBe(0)
    expect(missingSummary.stderr).toContain("exact clean-review summary")

    const missingDisposition = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nNo actionable findings.`,
    })
    expect(missingDisposition.exitCode).not.toBe(0)
    expect(missingDisposition.stderr).toContain(
      "exactly one allowed QA disposition"
    )

    const invalidDisposition = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nNo actionable findings.\nReviewer-confirmed QA disposition: Automated QA`,
    })
    expect(invalidDisposition.exitCode).not.toBe(0)
    expect(invalidDisposition.stderr).toContain(
      "exactly one allowed QA disposition"
    )

    const duplicateDisposition = await runGate({
      headSha,
      reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nNo actionable findings.\nReviewer-confirmed QA disposition: Evidence sign-off\nReviewer-confirmed QA disposition: Targeted human QA`,
    })
    expect(duplicateDisposition.exitCode).not.toBe(0)
    expect(duplicateDisposition.stderr).toContain(
      "exactly one allowed QA disposition"
    )

    const manual = await runGate({
      eventName: "workflow_dispatch",
      headSha,
      previousReviews: JSON.stringify([
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-final head=${headSha} -->`,
        },
        {
          user: { login: "conduit-sudden-agent[bot]" },
          body: `<!-- conduit:ponytail-attempted head=${headSha} -->`,
        },
      ]),
    })
    expect(manual.exitCode).toBe(0)
    expect(getOutputValue(manual.output, "should_run")).toBe("true")
  })

  it("revalidates queued handoffs inside the Ponytail execution lock", async () => {
    const headSha = "1".repeat(40)
    const clean = await runGate({ headSha }, revalidationScript)
    expect(clean.exitCode).toBe(0)
    expect(getOutputValue(clean.output, "should_run")).toBe("true")

    const changedHead = await runGate(
      { headSha, expectedHead: "2".repeat(40) },
      revalidationScript
    )
    expect(changedHead.exitCode).toBe(0)
    expect(getOutputValue(changedHead.output, "should_run")).toBe("false")
    expect(changedHead.stdout).toContain("head changed while queued")

    const duplicate = await runGate(
      {
        headSha,
        previousReviews: JSON.stringify([
          {
            user: { login: "conduit-sudden-agent[bot]" },
            body: `<!-- conduit:ponytail-final head=${headSha} -->`,
          },
        ]),
      },
      revalidationScript
    )
    expect(duplicate.exitCode).toBe(0)
    expect(getOutputValue(duplicate.output, "should_run")).toBe("false")
    expect(duplicate.stdout).toContain("now exists")

    const attempted = await runGate(
      {
        headSha,
        previousReviews: JSON.stringify([
          {
            user: { login: "conduit-sudden-agent[bot]" },
            body: `<!-- conduit:ponytail-attempted head=${headSha} -->`,
          },
        ]),
      },
      revalidationScript
    )
    expect(attempted.exitCode).toBe(0)
    expect(getOutputValue(attempted.output, "should_run")).toBe("false")
    expect(attempted.stdout).toContain("attempt now exists")

    const dirty = await runGate(
      { headSha, reviewComments: "[{}]" },
      revalidationScript
    )
    expect(dirty.exitCode).not.toBe(0)
    expect(dirty.stderr).toContain("contains inline findings")

    const missingSummary = await runGate(
      {
        headSha,
        reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nReviewer-confirmed QA disposition: Maintainer-owned validation`,
      },
      revalidationScript
    )
    expect(missingSummary.exitCode).not.toBe(0)
    expect(missingSummary.stderr).toContain("exact clean-review summary")

    const missingDisposition = await runGate(
      {
        headSha,
        reviewBody: `<!-- conduit:sudden-review clean head=${headSha} -->\nNo actionable findings.`,
      },
      revalidationScript
    )
    expect(missingDisposition.exitCode).not.toBe(0)
    expect(missingDisposition.stderr).toContain(
      "exactly one allowed QA disposition"
    )

    const manual = await runGate(
      {
        eventName: "workflow_dispatch",
        headSha,
        previousReviews: JSON.stringify([
          {
            user: { login: "conduit-sudden-agent[bot]" },
            body: `<!-- conduit:ponytail-final head=${headSha} -->`,
          },
          {
            user: { login: "conduit-sudden-agent[bot]" },
            body: `<!-- conduit:ponytail-attempted head=${headSha} -->`,
          },
        ]),
      },
      revalidationScript
    )
    expect(manual.exitCode).toBe(0)
    expect(getOutputValue(manual.output, "should_run")).toBe("true")
  })
})
