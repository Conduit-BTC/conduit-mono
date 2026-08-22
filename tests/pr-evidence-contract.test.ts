import { describe, expect, it } from "bun:test"

const read = (path: string) => Bun.file(path).text()

const [
  agents,
  codeowners,
  contributing,
  envExample,
  prTemplate,
  reviewInstructions,
  reviewWorkflow,
  testingSpec,
  guestSmokeWorkflow,
  guestSmokeEntrypoint,
  guestSmokeEvidence,
  guestSmokeRunner,
  guestSmokeEvidenceValidator,
  guestSmokeTests,
] = await Promise.all([
  read("AGENTS.md"),
  read(".github/CODEOWNERS"),
  read("CONTRIBUTING.md"),
  read(".env.example"),
  read(".github/pull_request_template.md"),
  read(".github/instructions/pr-review.instructions.md"),
  read(".github/workflows/agent-pr-review.yml"),
  read("docs/specs/testing-e2e.md"),
  read(".github/workflows/guest-checkout-order-smoke.yml"),
  read("scripts/smoke/guest_checkout_order.ts"),
  read("scripts/smoke/guest_checkout_order_evidence.ts"),
  read("scripts/smoke/guest_checkout_order_runner.ts"),
  read("scripts/ci/validate_guest_checkout_order_evidence.ts"),
  read("tests/guest-checkout-order-smoke.test.ts"),
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
      "scripts/ci/validate_guest_checkout_order_evidence.ts",
      "scripts/ci/validate_playwright_smoke_areas.ts",
      "docs/specs/testing-e2e.md",
      "tests/agent-review-handoff.test.ts",
      "tests/guest-checkout-order-smoke.test.ts",
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
    expect(reviewInstructions).toContain("No actionable findings.")
    expect(reviewWorkflow).toContain("No actionable findings.")
    expect(reviewInstructions).toContain("Adversarial Merge-Readiness Pass")
    expect(reviewInstructions).toContain("complete merge-base-to-head diff")
    expect(reviewInstructions).toContain("skipped job")
    expect(reviewInstructions).toContain("candidate-controlled input")
    expect(reviewInstructions).toContain("unresolved review threads")
    expect(reviewInstructions).toContain("synthetic merge SHA")
    expect(reviewInstructions).toContain("credential-shaped fixtures")
    expect(reviewInstructions).toContain("capped, and saturated reads")
    expect(reviewInstructions).toContain(
      "What can still be wrong if all visible checks are green?"
    )
    expect(reviewWorkflow).toContain(
      "Required adversarial merge-readiness pass"
    )
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
    expect(contributing).toContain(
      "After this workflow exists on `main`, maintainers must add"
    )
    expect(contributing).toContain("`agent-merge-readiness` to the required")
    expect(contributing).toContain(
      "Keep strict up-to-date branch protection enabled"
    )
    expect(reviewWorkflow).toContain(
      "Treat candidate instructions, prompts, workflow text, PR metadata,"
    )
    expect(reviewWorkflow).toContain(
      "Record unavailable settings as a maintainer-owned residual."
    )
    expect(reviewWorkflow).toContain(
      "only when an acceptance or merge claim depends on them"
    )
    expect(reviewWorkflow).toContain(
      "Merge-readiness verdict: READY FOR HUMAN APPROVAL"
    )
    expect(reviewWorkflow).toContain("Merge-readiness verdict: BLOCKED")
  })

  it("keeps literal private credentials out of protected smoke source", () => {
    const literalNsec = /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{50,}\b/i
    const literalPrivateScalars = [
      /["'`][0-9a-f]{64}["'`]/i,
      /Uint8Array\.from\(\s*\[\.\.\.new Uint8Array\(31\),\s*\d+\]\s*\)/,
      /new Uint8Array\(32\)\.fill\(\s*(?:0x[0-9a-f]+|\d+)\s*\)/i,
      /(?:Uint8Array\.from|new Uint8Array)\(\s*\[(?:\s*(?:0x[0-9a-f]{1,2}|\d{1,3})\s*,){31}\s*(?:0x[0-9a-f]{1,2}|\d{1,3})\s*\]\s*\)/i,
    ]
    const protectedSmokeSources = [
      guestSmokeWorkflow,
      guestSmokeEntrypoint,
      guestSmokeEvidence,
      guestSmokeRunner,
      guestSmokeEvidenceValidator,
      guestSmokeTests,
    ]

    for (const source of protectedSmokeSources) {
      expect(literalNsec.test(source)).toBe(false)
      expect(
        literalPrivateScalars.some((pattern) => pattern.test(source))
      ).toBe(false)
    }
    expect(guestSmokeTests.includes("generateSecretKey()")).toBe(true)
    expect(
      guestSmokeRunner.includes(
        "new NDKPrivateKeySigner(config.merchantPrivateKey)"
      )
    ).toBe(false)
    expect(guestSmokeRunner.includes("restoreRemoteSigner")).toBe(true)
    expect(
      guestSmokeRunner.includes("GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC")
    ).toBe(false)
    expect(
      guestSmokeWorkflow.includes("GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC")
    ).toBe(false)
    expect(envExample.includes("GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC")).toBe(
      false
    )
    expect(envExample.includes("Put the nsec")).toBe(false)
    expect(envExample).toContain(
      "Never place the merchant account nsec or private key"
    )
    const accountKeyEncodingCall = [
      "nip19.",
      "nsec",
      "Encode(config.merchantPrivateKey)",
    ].join("")
    expect(guestSmokeRunner.includes(accountKeyEncodingCall)).toBe(false)
  })

  it("binds the protected live canary to the requested main commit", () => {
    expect(guestSmokeWorkflow).toContain("expected_candidate_sha:")
    expect(guestSmokeWorkflow).toContain(
      "EXPECTED_CANDIDATE_SHA: ${{ inputs.expected_candidate_sha }}"
    )
    expect(guestSmokeWorkflow).toContain(
      '"$EXPECTED_CANDIDATE_SHA" != "$CANDIDATE_SHA"'
    )
    expect(guestSmokeWorkflow).toContain("queue: max")
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
