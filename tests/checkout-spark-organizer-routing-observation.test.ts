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
  expect(observation.timeout().diagnostic).toMatchObject({
    lastLoadedNativeStatus: "not_observed",
    lastLoadedNativeTransferReference: "not_observed",
  })
  observation.payout("paid")
  observation.recipient("verified_unsettled")
  observation.nativeLoadedState("submitted", false)
  const first = observation.timeout()
  const diagnostic = {
    ...first.diagnostic,
    lastPayoutObservation: "unused-provider-detail" as "paid",
    lastLoadedNativeStatus: "unused-durable-detail" as "submitted",
    lastLoadedNativeTransferReference: "unused-reference-detail" as "absent",
    privatePayload: "unused-private-detail",
  }
  const filtered = new CheckoutSparkOrganizerRoutingTimeoutError(diagnostic)
  expect(Object.keys(filtered.diagnostic).sort()).toEqual([
    "completedWorkflowSteps",
    "elapsedMs",
    "lastLoadedNativeStatus",
    "lastLoadedNativeTransferReference",
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
  expect(filtered.diagnostic.lastLoadedNativeStatus).toBe("not_observed")
  expect(filtered.diagnostic.lastLoadedNativeTransferReference).toBe(
    "not_observed"
  )
  expect(JSON.stringify(filtered.diagnostic)).not.toContain("unused-")
  expect(Object.isFrozen(filtered.diagnostic)).toBe(true)
  observation.payout("lookup_unavailable")
  observation.recipient("verified_settled")
  observation.nativeLoadedState("paid", true)
  expect(first.diagnostic.lastPayoutObservation).toBe("paid")
  expect(first.diagnostic.lastRecipientObservation).toBe("verified_unsettled")
  expect(first.diagnostic.lastLoadedNativeStatus).toBe("submitted")
  expect(first.diagnostic.lastLoadedNativeTransferReference).toBe("absent")
  expect(observation.timeout().diagnostic).toMatchObject({
    lastLoadedNativeStatus: "paid",
    lastLoadedNativeTransferReference: "present",
  })
  observation.stage("goods")
  observation.stage("payout")
  expect(observation.timeout().diagnostic.lastRecipientObservation).toBe(
    "verified_settled"
  )
})
