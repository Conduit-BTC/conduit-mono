import { describe, expect, it } from "bun:test"

const read = (path: string) => Bun.file(path).text()

const [
  agents,
  codeowners,
  contributing,
  prTemplate,
  reviewInstructions,
  networkPosture,
  testingSpec,
] = await Promise.all([
  read("AGENTS.md"),
  read(".github/CODEOWNERS"),
  read("CONTRIBUTING.md"),
  read(".github/pull_request_template.md"),
  read(".github/instructions/pr-review.instructions.md"),
  read("docs/knowledge/decentralized-network-product-posture.md"),
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
      "tests/agent-credential-boundary.test.ts",
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
    expect(reviewInstructions).toContain(
      "No code changes needed. Ready for human review."
    )
    expect(reviewInstructions).toContain("Code changes required.")
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
    expect(contributing).not.toContain(
      "After this workflow exists on `main`, maintainers must add"
    )
    expect(contributing).not.toContain(
      "`agent-merge-readiness` to the required"
    )
    expect(contributing).toContain(
      "`agent-review-handoff` workflow context is retired"
    )
    expect(contributing.replace(/\s+/g, " ")).toContain(
      "Keep strict up-to-date branch protection enabled"
    )
    expect(reviewInstructions).not.toContain("Merge-readiness verdict:")
  })

  it("bounds Nostr review scope with the trusted product posture", () => {
    const normalizedPosture = networkPosture.replace(/\s+/g, " ")
    const normalizedInstructions = reviewInstructions.replace(/\s+/g, " ")

    for (const required of [
      "## Reference Identity Is Not Relay Reachability",
      "Relay and source hints are optional discovery aids",
      "They cannot prove public-relay availability or global convergence",
    ]) {
      expect(normalizedPosture).toContain(required)
    }

    for (const required of [
      "## Scope And Decentralized-State Review",
      "Later pull request body edits, prior automated findings, and remediation-added behavior are not independent requirement sources",
      "The scope ceiling limits new requirements; it does not exclude collateral regressions introduced or worsened by the candidate",
      "After one code-changing remediation round for the same root cause, require maintainer scope review before demanding another expansion",
      "A concrete regression introduced by remediation remains a finding",
      "classify the changed outcome as reference identity, discovery or reachability, family completeness, or action readiness",
      "Apply the relay failure matrix only to behavior the accepted scope actually changes",
      "global relay discovery, family completeness, or convergence is a residual risk, not a P2 defect",
      "concrete regressions in existing bounded lookup or degraded behavior, or in an accepted reachability requirement, remain findings",
      "Prefer removing or deferring optional hardening",
    ]) {
      expect(normalizedInstructions).toContain(required)
    }

    for (const forbidden of [
      "required by an explicit repository or pull request source",
      "Relay and distributed-state work covers partial",
    ]) {
      expect(normalizedInstructions).not.toContain(forbidden)
    }
  })

  it("documents current commerce shard selection and authoring boundary", () => {
    expect(testingSpec).toContain(
      "`@commerce` runs for affected critical commerce paths"
    )
    expect(testingSpec).toContain("shared Playwright and runtime changes run")
    expect(testingSpec).toContain(
      "The current selector includes `@commerce` for changes to:"
    )
    expect(testingSpec).toContain("[x] **AC-SELECT-2:**")
    expect(contributing).toContain(
      "Use `@commerce` only for the hermetic\ncross-app flow that requires both Market and Merchant"
    )
    expect(contributing).toContain(
      "Shared runtime changes and pushes to\n`main` run every critical shard"
    )
  })
})
