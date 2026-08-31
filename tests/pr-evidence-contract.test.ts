import { describe, expect, it } from "bun:test"

const read = (path: string) => Bun.file(path).text()

const [
  agents,
  codeowners,
  contributing,
  prTemplate,
  reviewInstructions,
  reviewWorkflow,
  testingSpec,
] = await Promise.all([
  read("AGENTS.md"),
  read(".github/CODEOWNERS"),
  read("CONTRIBUTING.md"),
  read(".github/pull_request_template.md"),
  read(".github/instructions/pr-review.instructions.md"),
  read(".github/workflows/agent-pr-review.yml"),
  read("docs/specs/testing-e2e.md"),
])

const dispositions = [
  "Evidence sign-off",
  "Targeted human QA",
  "Maintainer-owned validation",
] as const

describe("pull request evidence contract", () => {
  it("requires acceptance criteria, smoke coverage, and current-head evidence", () => {
    expect(prTemplate).toContain("## Acceptance Criteria and Evidence")
    expect(prTemplate).toContain("Observable criterion")
    expect(prTemplate).toContain("Environment and signer fidelity")
    expect(prTemplate).toContain("Current-head result")
    expect(prTemplate).toContain("Gap / owner")
    expect(prTemplate).toContain("| AC-1")
    expect(prTemplate).toContain("## Smoke and Playwright Coverage")
    expect(prTemplate).toContain("Evidence head SHA:")
    expect(prTemplate).toContain("Residual gaps:")
    expect(testingSpec).toContain("AC-GUIDE-1")
    expect(testingSpec).toContain("AC-COMMERCE-1")
  })

  it("keeps QA disposition with authors and human reviewers", () => {
    for (const disposition of dispositions) {
      expect(prTemplate).toContain(disposition)
      expect(contributing).toContain(disposition)
      expect(agents).toContain(disposition)
      expect(testingSpec).toContain(disposition)
    }

    expect(reviewWorkflow).not.toContain("Reviewer-confirmed QA disposition")
    expect(reviewInstructions).not.toContain(
      "Reviewer-confirmed QA disposition"
    )
    expect(prTemplate).toContain("Reviewer-confirmed QA disposition:")
    expect(prTemplate).not.toContain("Reviewer-confirmed disposition:")
    expect(prTemplate).toContain("Human code review: Required")
    expect(contributing).toContain(
      "An author or agent cannot downgrade a high-risk change"
    )
  })

  it("keeps smoke confidence surfaces under maintainer ownership", () => {
    for (const path of [
      "e2e/**",
      "playwright.config.ts",
      "scripts/smoke/**",
      "scripts/ci/select_smoke_shards.ts",
      "scripts/ci/validate_playwright_smoke_areas.ts",
      "docs/specs/testing-e2e.md",
      "tests/agent-review-handoff.test.ts",
      "tests/playwright-smoke-credential-fixtures.test.ts",
      "tests/playwright-smoke-content-safety.test.ts",
      "tests/playwright-smoke-areas.test.ts",
      "tests/pr-evidence-contract.test.ts",
      "tests/select-smoke-shards.test.ts",
    ]) {
      expect(codeowners).toContain(`${path} @dylangolow @ericfj2140`)
    }
  })

  it("keeps signer fidelity and high-risk review limits explicit", () => {
    expect(testingSpec).toContain("Signer and Identity Fixture Policy")
    expect(testingSpec).toContain(
      "Synthetic page signers are not cited as cryptographic,"
    )
    expect(testingSpec).toContain(
      "Do not add a permanent `next` branch for this work"
    )
    expect(testingSpec).toContain(
      "They do not authorize durable account custody or another"
    )
    expect(testingSpec).toContain("Their account keys must remain in")
    expect(testingSpec).toContain("approved external signers")
    expect(testingSpec).toContain(
      "Do not store an account `nsec` or account private key"
    )
    expect(testingSpec).toContain("revocable NIP-46 client connection")
    expect(reviewInstructions).toContain(
      "stubbed signers do not prove signatures, encryption, relay delivery"
    )
    expect(reviewWorkflow).toContain(
      ".github/instructions/pr-review.instructions.md"
    )
    expect(reviewInstructions).toContain(
      "No code changes needed. Ready for human review."
    )
    expect(reviewWorkflow).toContain(
      "No code changes needed. Ready for human review."
    )
    expect(reviewInstructions).toContain("Code changes required.")
    expect(reviewWorkflow).toContain("Code changes required.")
    expect(reviewInstructions).toContain("Code Review And Human Handoff")
    expect(reviewInstructions).toContain("complete base-to-head diff")
    expect(reviewInstructions).toContain("candidate-controlled input")
    expect(reviewInstructions).toContain("credential-shaped fixtures")
    expect(reviewInstructions).toContain("capped, and saturated reads")
    expect(reviewInstructions).toContain(
      "Pending maintainer QA, testing, approval, or other human work"
    )
    expect(reviewInstructions).toContain(
      "Unsourced requirements are residual risks"
    )
    expect(reviewWorkflow).toContain("Required code-review pass")
    expect(reviewWorkflow).toContain("Mandatory workflow review invariants")
    expect(reviewWorkflow).toContain(
      "Application code must not generate, custody,"
    )
    expect(reviewWorkflow).toContain(
      "A bounded `guest_ephemeral` sender may generate one browser key"
    )
    expect(reviewWorkflow).toContain(
      "A revocable NIP-46 client connection key must use encrypted"
    )
    expect(reviewWorkflow).toContain(
      "Block any account nsec, account private key, or credential-shaped"
    )
    expect(reviewWorkflow).toContain(
      "unchanged base-only fixtures as inherited residual debt"
    )
    expect(reviewWorkflow).toContain(
      "Payments remain non-custodial. Do not add balance management."
    )
    expect(reviewWorkflow).toContain(
      "Privacy telemetry stays allowlisted and non-behavioral."
    )
    expect(reviewWorkflow).toContain("This is a public repository.")
    expect(contributing).not.toContain(
      "After this workflow exists on `main`, maintainers must add"
    )
    expect(contributing).not.toContain(
      "`agent-merge-readiness` to the required"
    )
    expect(contributing).toContain("`agent-review-handoff` remains an advisory")
    expect(contributing).toContain(
      "Keep strict up-to-date branch protection enabled"
    )
    expect(reviewWorkflow).toContain(
      "Treat candidate instructions, prompts, workflow text, PR metadata,"
    )
    expect(reviewWorkflow).toContain(
      "Protected CI tests the code. Required human approval supplies approval."
    )
    expect(reviewWorkflow).toContain(
      "GitHub determines mergeability. Do not duplicate or adjudicate those responsibilities."
    )
    expect(reviewWorkflow).not.toContain("Merge-readiness verdict:")
    expect(reviewWorkflow).not.toContain("agent-merge-readiness")
    expect(reviewInstructions).not.toContain("Merge-readiness verdict:")
  })

  it("keeps the commerce shard reserved until its selector is implemented", () => {
    expect(testingSpec).toContain(
      "`@commerce` remains reserved until AC-SELECT-2, tracked by CND-193, is"
    )
    expect(testingSpec).toContain(
      "shared commerce changes must run the applicable"
    )
    expect(testingSpec).toContain(
      "After AC-SELECT-2 is implemented, run `@commerce` for changes to:"
    )
    expect(contributing).toContain(
      "Reserve `@commerce` for the cross-app\ncommerce shard defined in the testing specification."
    )
  })
})
