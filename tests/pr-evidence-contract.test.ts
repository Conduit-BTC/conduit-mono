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

  it("uses one QA disposition vocabulary across authors and reviewers", () => {
    for (const disposition of dispositions) {
      expect(prTemplate).toContain(disposition)
      expect(contributing).toContain(disposition)
      expect(agents).toContain(disposition)
      expect(reviewInstructions).toContain(disposition)
      expect(reviewWorkflow).toContain(disposition)
      expect(testingSpec).toContain(disposition)
    }

    expect(reviewWorkflow).toContain("the reviewer-confirmed QA disposition")
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
    expect(reviewInstructions).toContain(
      "stubbed signers do not prove signatures, encryption, relay delivery"
    )
    expect(reviewWorkflow).toContain(
      "Do not accept stubbed signer evidence as proof of signatures"
    )
    expect(reviewInstructions).toContain("No actionable findings.")
    expect(reviewWorkflow).toContain("No actionable findings.")
  })
})
