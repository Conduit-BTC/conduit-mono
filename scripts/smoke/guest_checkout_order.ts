import "fake-indexeddb/auto"

import { isAbsolute } from "node:path"

import {
  buildGuestCheckoutOrderSmokeArtifact,
  NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
  serializeGuestCheckoutOrderSmokeArtifact,
  type GuestCheckoutOrderSmokeArtifactStage,
  type GuestCheckoutOrderSmokeRelayEvidence,
} from "./guest_checkout_order_evidence"

type Environment = Record<string, string | undefined>

export type GuestCheckoutOrderSmokeEvidenceContext = {
  candidateCommitSha: string
  workflowRunId: string
  workflowRunAttempt: string
  evidencePath: string
}

type GuestCheckoutOrderSmokeEntrypointOutcome =
  | { status: "passed"; stage: "complete" }
  | {
      status: "failed"
      stage: GuestCheckoutOrderSmokeArtifactStage
    }
  | {
      status: "inconclusive"
      stage: Exclude<GuestCheckoutOrderSmokeArtifactStage, "cleanup">
    }

function requiredEvidenceValue(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error("Smoke evidence configuration is unavailable.")
  return value
}

export function parseGuestCheckoutOrderSmokeEvidenceContext(
  env: Environment = process.env
): GuestCheckoutOrderSmokeEvidenceContext {
  const context = {
    candidateCommitSha: requiredEvidenceValue(
      env,
      "GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA"
    ),
    workflowRunId: requiredEvidenceValue(
      env,
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID"
    ),
    workflowRunAttempt: requiredEvidenceValue(
      env,
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT"
    ),
    evidencePath: requiredEvidenceValue(
      env,
      "GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH"
    ),
  }
  if (!isAbsolute(context.evidencePath)) {
    throw new Error("Smoke evidence configuration is unavailable.")
  }
  buildGuestCheckoutOrderSmokeArtifact({
    candidateCommitSha: context.candidateCommitSha,
    workflowRunId: context.workflowRunId,
    workflowRunAttempt: context.workflowRunAttempt,
    outcome: { status: "failed", stage: "configuration" },
    relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
    durationMs: 0,
  })
  return context
}

export function applyGuestCheckoutOrderSmokeCleanupOutcome(
  outcome: GuestCheckoutOrderSmokeEntrypointOutcome,
  cleanupFailed: boolean
): GuestCheckoutOrderSmokeEntrypointOutcome {
  return cleanupFailed && outcome.status === "passed"
    ? { status: "failed", stage: "cleanup" }
    : outcome
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  let evidenceContext: GuestCheckoutOrderSmokeEvidenceContext
  try {
    evidenceContext = parseGuestCheckoutOrderSmokeEvidenceContext()
  } catch {
    console.error(
      "Guest checkout order smoke failed at evidence_configuration."
    )
    process.exitCode = 1
    return
  }

  let outcome: GuestCheckoutOrderSmokeEntrypointOutcome = {
    status: "failed",
    stage: "configuration",
  }
  let relayEvidence: GuestCheckoutOrderSmokeRelayEvidence = {
    ...NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
  }
  let getFailureEvidence:
    | ((error: unknown) => {
        status: "failed" | "inconclusive"
        stage: Exclude<GuestCheckoutOrderSmokeArtifactStage, "cleanup">
      })
    | undefined
  let disconnectNdk: (() => void) | undefined
  let closeDatabase: (() => void) | undefined

  try {
    const runner = await import("./guest_checkout_order_runner")
    const core = await import("@conduit/core")
    getFailureEvidence = runner.getGuestCheckoutOrderSmokeFailureEvidence
    disconnectNdk = core.disconnectNdk
    closeDatabase = () => core.db.close()

    const config = runner.parseGuestCheckoutOrderSmokeConfig()
    await runner.runGuestCheckoutOrderSmoke(config, {
      onRelayEvidence: (evidence) => {
        relayEvidence = evidence
      },
    })
    outcome = { status: "passed", stage: "complete" }
  } catch (error) {
    const evidence = getFailureEvidence?.(error)
    if (evidence) outcome = evidence
    process.exitCode = 1
  }

  let cleanupFailed = false
  try {
    disconnectNdk?.()
  } catch {
    cleanupFailed = true
    process.exitCode = 1
  }
  try {
    closeDatabase?.()
  } catch {
    cleanupFailed = true
    process.exitCode = 1
  }
  outcome = applyGuestCheckoutOrderSmokeCleanupOutcome(outcome, cleanupFailed)

  let evidenceWriteFailed = false
  try {
    const artifact = buildGuestCheckoutOrderSmokeArtifact({
      candidateCommitSha: evidenceContext.candidateCommitSha,
      workflowRunId: evidenceContext.workflowRunId,
      workflowRunAttempt: evidenceContext.workflowRunAttempt,
      outcome,
      relayEvidence,
      durationMs: Date.now() - startedAt,
    })
    await Bun.write(
      evidenceContext.evidencePath,
      serializeGuestCheckoutOrderSmokeArtifact(artifact)
    )
  } catch {
    evidenceWriteFailed = true
    process.exitCode = 1
  }

  if (outcome.status !== "passed") {
    console.error(
      `Guest checkout order smoke ${outcome.status} at ${outcome.stage}.`
    )
  } else if (!evidenceWriteFailed && !cleanupFailed) {
    console.log(
      "Guest checkout order smoke passed. The merchant recovered one encrypted guest order. No invoice was requested and no payment was attempted."
    )
  }
  if (evidenceWriteFailed) {
    console.error("Guest checkout order smoke failed at evidence_write.")
  }
  if (cleanupFailed) {
    if (outcome.stage !== "cleanup") {
      console.error("Guest checkout order smoke failed at cleanup.")
    }
  }
}

if (import.meta.main) await main()
