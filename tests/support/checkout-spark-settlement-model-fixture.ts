import {
  preparedSettledLegState,
  LEG_FIXTURE_CREATED_AT,
} from "./checkout-spark-settled-leg-fixture"
import {
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  freezeCheckoutSparkSettledEventPlan,
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
  recordCheckoutSparkSettledLegStatus,
} from "../../packages/core/src/protocol/checkout-spark-settled-router"
import { deriveCheckoutSparkNativeTreasuryInvoiceId } from "../../packages/core/src/protocol/checkout-spark-treasury-finalization"
import { createCheckoutSparkMerchantSettlementRecord } from "../../packages/core/src/protocol/checkout-spark-merchant-settlement"
import { computeEventMarketAssignmentDTag } from "../../packages/core/src/protocol/event-market-assignment"
import {
  calculateCheckoutSparkEventSettledGrossFundingSats,
  calculateCheckoutSparkEventAllocationWeights,
} from "../../packages/core/src/protocol/checkout-spark-settled-allocation"
import {
  makeSignedBolt11Fixture,
  bolt11PaymentSecretField,
} from "./signed-bolt11-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./bolt11-fixture"
import fundingFixture from "./checkout-spark-settlement-funding-invoice.json"

export function settlementInvoice(
  amount: number,
  hash: Uint8Array,
  at = LEG_FIXTURE_CREATED_AT
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: at / 1_000,
    fields: [
      bolt11PaymentHashField(hash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

export function settlementModelPlan(version: 3 | 4 | 5 = 4) {
  const original = preparedSettledLegState().plan
  // Retain a signed invoice (never its disposable key) for stable digest vectors.
  const base = freezeCheckoutSparkSettledPlan({
    ...original,
    funding: { ...original.funding, ...fundingFixture },
  })
  if (version === 3) return base
  const treasury = {
    schemaVersion: 1 as const,
    sparkAddress: "offline-native-address",
    receiverIdentityPublicKey: `02${"e".repeat(64)}`,
    senderIdentityPublicKey: base.funding.receiverIdentityPublicKey,
    invoiceRequest: "offline-native-invoice",
    feePolicy: "zero_required" as const,
    residualPolicy: "unused_commerce_reserves" as const,
  }
  const nativeTreasury = {
    ...treasury,
    invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId({
      ...base,
      ...treasury,
    }),
  }
  if (version === 4)
    return freezeCheckoutSparkSettledTreasuryPlan({ ...base, nativeTreasury })
  const organizerPubkey = "f".repeat(64)
  const marketCoordinate = `30409:${organizerPubkey}:market`
  const occurrenceCoordinate = `31922:${organizerPubkey}:occurrence`
  const line = base.commerceQuote.lines[0]!
  const marketEventId = "1".repeat(64)
  const organizerFeeSats = 1_000
  const weights = calculateCheckoutSparkEventAllocationWeights(
    0,
    organizerFeeSats
  )
  const grossFundingSats = calculateCheckoutSparkEventSettledGrossFundingSats(
    0,
    organizerFeeSats
  )
  return freezeCheckoutSparkSettledEventPlan({
    ...base,
    nativeTreasury,
    commerceQuote: {
      commerceTotalSats: 0,
      lines: [{ ...line, unitMerchandiseSats: 0 }],
    },
    funding: {
      ...base.funding,
      grossFundingSats,
      paymentRequest: fundingFixture.paymentRequest,
    },
    recipients: [
      {
        kind: "organizer",
        recipientId: organizerPubkey,
        weightSats: organizerFeeSats,
        destination: {
          type: "lightning_address",
          value: "organizer@example.test",
          source: {
            type: "signed_event_market",
            marketCoordinate,
            eventId: marketEventId,
            eventCreatedAt: base.createdAt / 1_000,
          },
        },
      },
      { ...base.recipients[1]!, weightSats: weights.conduitWeightSats },
    ],
    eventMarket: {
      schemaVersion: 1,
      organizerPubkey,
      marketCoordinate,
      marketEventId,
      occurrenceCoordinate,
      occurrenceEventId: "2".repeat(64),
      grantEventId: "3".repeat(64),
      grantAncestryEventIds: ["3".repeat(64)],
      observedDeletionEventIds: [],
      mode: "merchant_present",
      assignment: "table",
      lines: [
        {
          productCoordinate: line.productCoordinate,
          productEventId: line.productEventId,
          quantity: 1,
          assignmentEventId: "4".repeat(64),
          assignmentCoordinate: `30410:${base.merchantPubkey}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate: line.productCoordinate })}`,
        },
      ],
      organizerFee: {
        state: "active",
        marketCoordinate,
        organizerPubkey,
        eventId: marketEventId,
        createdAt: base.createdAt / 1_000,
        basisPoints: 0,
        minimumSats: organizerFeeSats,
        lightningAddress: "organizer@example.test",
      },
      organizerFeeSats,
    },
  })
}

export function paidSettlementModel(version: 4 | 5 = 4) {
  const plan = settlementModelPlan(version)
  const base = preparedSettledLegState()
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    base.credit!
  )
  const legId = plan.recipients[0]!.legId
  state = prepareCheckoutSparkSettledLeg(state, {
    ...base.legs[0]!.intent!,
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
  })
  const intent = state.legs[0]!.intent!
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId,
    transferId: intent.transferId,
    paymentHash: intent.paymentHash,
    status: "paid",
    observedAt: LEG_FIXTURE_CREATED_AT + 3,
    finalFeeSats: 4,
    finalDebitSats: 999,
  })
  const record = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: state.credit!.transferId,
      creditedSats: state.credit!.creditedSats,
      observedAt: state.credit!.observedAt,
    },
    paidLegs: [
      {
        legId,
        transferId: intent.transferId,
        allocationSats: 1_000,
        finalDebitSats: 999,
        finalFeeSats: 4,
        observedAt: LEG_FIXTURE_CREATED_AT + 3,
        recipientVerified: true as const,
      },
    ],
  }
  return { state, record }
}
