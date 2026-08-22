import { parseGuestCheckoutOrderSmokeArtifact } from "../smoke/guest_checkout_order_evidence"

async function main(): Promise<void> {
  const path = process.argv[2]?.trim()
  const expectedCandidateCommitSha = process.argv[3]?.trim()
  const expectedWorkflowRunId = process.argv[4]?.trim()
  const expectedWorkflowRunAttempt = process.argv[5]?.trim()
  if (
    !path ||
    !expectedCandidateCommitSha ||
    !/^[0-9a-f]{40}$/.test(expectedCandidateCommitSha) ||
    !expectedWorkflowRunId ||
    !/^[1-9]\d*$/.test(expectedWorkflowRunId) ||
    !expectedWorkflowRunAttempt ||
    !/^[1-9]\d*$/.test(expectedWorkflowRunAttempt)
  ) {
    console.error("Guest checkout order smoke evidence is invalid.")
    process.exitCode = 1
    return
  }

  try {
    const serialized = await Bun.file(path).text()
    const artifact = parseGuestCheckoutOrderSmokeArtifact(serialized)
    if (
      artifact.candidateCommitSha !== expectedCandidateCommitSha ||
      artifact.workflowRunId !== expectedWorkflowRunId ||
      artifact.workflowRunAttempt !== expectedWorkflowRunAttempt
    ) {
      throw new Error("Guest checkout order smoke evidence is misbound.")
    }
    console.log("Guest checkout order smoke evidence is redacted and valid.")
  } catch {
    console.error("Guest checkout order smoke evidence is invalid.")
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
