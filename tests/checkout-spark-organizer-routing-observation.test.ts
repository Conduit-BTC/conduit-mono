import { expect, it } from "bun:test"
import {
  CheckoutSparkOrganizerRoutingTimeoutError,
  createCheckoutSparkOrganizerRoutingObservation,
} from "../apps/merchant/src/lib/checkout-spark-organizer-routing-observation"

it("keeps timeout snapshots immutable, exact-keyed and limited to fixed verdicts", () => {
  const observation = createCheckoutSparkOrganizerRoutingObservation(
    () => 50,
    0
  )
  observation.payout("paid")
  observation.recipient("verified_unsettled")
  const first = observation.timeout()
  const diagnostic = {
    ...first.diagnostic,
    lastPayoutObservation: "unused-provider-detail" as "paid",
    privatePayload: "unused-private-detail",
  }
  const filtered = new CheckoutSparkOrganizerRoutingTimeoutError(diagnostic)
  expect(Object.keys(filtered.diagnostic).sort()).toEqual([
    "completedWorkflowSteps",
    "elapsedMs",
    "lastNativeObservation",
    "lastNativePreflight",
    "lastNativeSend",
    "lastPayoutObservation",
    "lastProgressAck",
    "lastRecipientObservation",
    "lastWorkflowOutcome",
    "lastWorkflowWaitReason",
    "scheduledBackoffMs",
    "stage",
    "writerCheckMs",
    "writerChecks",
  ])
  expect(filtered.diagnostic.lastPayoutObservation).toBe("not_observed")
  expect(JSON.stringify(filtered.diagnostic)).not.toContain("unused-")
  expect(Object.isFrozen(filtered.diagnostic)).toBe(true)
  observation.payout("lookup_unavailable")
  observation.recipient("verified_settled")
  expect(first.diagnostic.lastPayoutObservation).toBe("paid")
  expect(first.diagnostic.lastRecipientObservation).toBe("verified_unsettled")
  observation.stage("goods")
  observation.stage("payout")
  expect(observation.timeout().diagnostic.lastRecipientObservation).toBe(
    "verified_settled"
  )
})
