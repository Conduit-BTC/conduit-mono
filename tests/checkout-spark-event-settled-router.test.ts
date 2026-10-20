import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  allocateCheckoutSparkEventSettledSats,
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkEventBuyerPrice,
  calculateCheckoutSparkEventSettledGrossFundingSats,
} from "@conduit/core/protocol/checkout-spark-settled-allocation"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledEventPlan,
  isCheckoutSparkNativeTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  deriveCheckoutSparkNativeTreasuryBudget,
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
} from "@conduit/core/protocol/checkout-spark-treasury-finalization"
import {
  createCheckoutSparkMerchantSettlementRecord,
  projectCheckoutSparkMerchantSettlement,
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "@conduit/core/protocol/checkout-spark-merchant-settlement"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT,
  eventMarketFixtureInvoice,
  eventMarketFixtureParties,
} from "./support/checkout-spark-event-market-fixture"

const AT = EVENT_MARKET_FIXTURE_AT
const { organizerPubkey, supplierPubkey } = eventMarketFixtureParties
const hash = () => randomBytes(32).toString("hex")
const marketCoordinate = `30409:${organizerPubkey}:fair`
const invoice = eventMarketFixtureInvoice

function fixture(commerceTotalSats = 100_000) {
  return checkoutSparkEventMarketFixture({ commerceTotalSats }).input
}

function funded(input = fixture()) {
  const plan = freezeCheckoutSparkSettledEventPlan(input)
  const creditedSats =
    input.commerceQuote.commerceTotalSats +
    input.eventMarket.organizerFeeSats +
    input.recipients.at(-1)!.weightSats
  const state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: crypto.randomUUID(),
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: plan.funding.grossFundingSats,
      creditedSats,
      observedAt: AT + 1,
    }
  )
  const settlement: CheckoutSparkMerchantSettlementRecord = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: state.credit!.transferId,
      creditedSats,
      observedAt: AT + 1,
    },
  }
  return { plan, state, settlement }
}

/** A pure provider-fact fixture, not live receiving-wallet acceptance evidence. */
function payLeg(
  input: CheckoutSparkSettledReconciliation,
  settlement: CheckoutSparkMerchantSettlementRecord,
  position: number
) {
  const leg = input.legs[position]!
  const recipient = input.plan.recipients[position]!
  const allocationSats = leg.allocationSats!
  const invoiceAmountSats = allocationSats - 2
  const prepared = prepareCheckoutSparkSettledLeg(input, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(input.plan, leg.legId),
    ...invoice(invoiceAmountSats),
    invoiceAmountSats,
    maxFeeSats: 2,
    preparedAt: AT + 10 + position * 10,
  })
  const intent = prepared.legs[position]!.intent!
  const state = recordCheckoutSparkSettledLegStatus(prepared, {
    legId: recipient.legId,
    transferId: intent.transferId,
    paymentHash: intent.paymentHash,
    status: "paid",
    observedAt: intent.preparedAt + 1,
    finalDebitSats: invoiceAmountSats,
    finalFeeSats: 0,
  })
  return {
    state,
    settlement: {
      ...settlement,
      paidLegs: [
        ...settlement.paidLegs,
        {
          legId: recipient.legId,
          transferId: intent.transferId,
          allocationSats,
          finalDebitSats: invoiceAmountSats,
          finalFeeSats: 0,
          observedAt: intent.preparedAt + 1,
          recipientVerified: true as const,
        },
      ],
    },
  }
}

describe("Event Market settled payment plan v5", () => {
  it("adds organizer fees without charging Conduit's percentage on the fee", () => {
    expect(
      calculateCheckoutSparkEventAllocationWeights(100_000, 2_500)
    ).toEqual({
      commerceWeightSats: 100_000,
      conduitWeightSats: 2_100,
      organizerWeightSats: 2_500,
    })
    expect(
      calculateCheckoutSparkEventBuyerPrice({
        itemSubtotalSats: 90_000,
        shippingSubtotalSats: 10_000,
        organizerFeeSats: 2_500,
      })
    ).toEqual({
      itemSubtotalSats: 90_000,
      shippingSubtotalSats: 10_000,
      commerceTotalSats: 100_000,
      conduitFeeSats: 2_100,
      organizerFeeSats: 2_500,
      networkAllowanceSats: 154,
      coordinationFeeSats: 2_254,
      totalSats: 104_754,
      minimumApplies: false,
    })
  })

  it("freezes one organizer leg after commerce and restores the v5/state6 identity", () => {
    const input = fixture()
    const plan = freezeCheckoutSparkSettledEventPlan(input)
    expect(plan.schemaVersion).toBe(5)
    expect(isCheckoutSparkNativeTreasuryPlan(plan)).toBe(true)
    expect(plan.recipients.map((recipient) => recipient.kind)).toEqual([
      "merchant",
      "supplier",
      "organizer",
      "conduit",
    ])
    expect(plan.recipients.map((recipient) => recipient.weightSats)).toEqual([
      80_000, 20_000, 2_500, 2_100,
    ])
    expect(restoreCheckoutSparkSettledPlan(plan)).toEqual(plan)
    const state = createCheckoutSparkSettledReconciliation(plan)
    expect(state.schemaVersion).toBe(6)
    expect(restoreCheckoutSparkSettledReconciliation(state)).toEqual(state)
    expect(Object.isFrozen(plan.eventMarket)).toBe(true)
    expect(Object.isFrozen(plan.eventMarket!.grantAncestryEventIds)).toBe(true)
  })

  it("reserves the exact organizer budget before dividing the remaining commerce/Conduit credit", () => {
    const { plan, state } = funded()
    expect(state.legs.map((leg) => leg.allocationSats)).toEqual([
      80_000, 20_000, 2_500, 2_100,
    ])
    const full = allocateCheckoutSparkEventSettledSats({
      settledSats: plan.funding.grossFundingSats,
      fundingInvoiceGrossSats: plan.funding.grossFundingSats,
      weights: calculateCheckoutSparkEventAllocationWeights(100_000, 2_500),
    })
    expect(full.organizerAllocationSats).toBe(2_500)
    expect(
      full.commerceAllocationSats +
        full.conduitAllocationSats +
        full.organizerAllocationSats
    ).toBe(plan.funding.grossFundingSats)
    expect(full.commerceAllocationSats).toBeGreaterThanOrEqual(100_000)
    expect(full.conduitAllocationSats).toBeGreaterThanOrEqual(2_100)
  })

  it("supports fee-only commerce without inventing a zero-valued Merchant payout", () => {
    const { plan, state, settlement } = funded(fixture(0))
    expect(plan.recipients.map((recipient) => recipient.kind)).toEqual([
      "organizer",
      "conduit",
    ])
    expect(plan.funding.grossFundingSats).toBe(117)
    expect(state.legs.map((leg) => leg.allocationSats)).toEqual([5, 111])
    expect(settlement.schemaVersion).toBe(3)
    expect(settlement.merchantLegId).toBeNull()
    expect(settlement.requiredCommerceLegIds).toEqual([])
    expect(settlement.organizerLegId).toBe(plan.recipients[0]!.legId)
    expect(
      restoreCheckoutSparkMerchantSettlementRecord(settlement, plan)
    ).toEqual(settlement)
    expect(projectCheckoutSparkMerchantSettlement(settlement)).toMatchObject({
      creditVerified: true,
      commerceVerified: true,
      feePending: true,
    })
    expect(() =>
      deriveCheckoutSparkNativeTreasuryBudget(state, settlement)
    ).toThrow()
    const paid = payLeg(state, settlement, 0)
    expect(
      deriveCheckoutSparkNativeTreasuryBudget(paid.state, paid.settlement)
    ).toMatchObject({
      baseConduitAllocationSats: 111,
      unusedCommerceReserveSats: 2,
      authorizedDebitSats: 113,
    })
  })

  it("leaves an entirely free purchase to the non-funded flow", () => {
    expect(
      calculateCheckoutSparkEventBuyerPrice({
        itemSubtotalSats: 0,
        shippingSubtotalSats: 0,
        organizerFeeSats: 0,
      }).totalSats
    ).toBe(0)
    expect(() => calculateCheckoutSparkEventAllocationWeights(0, 0)).toThrow()
    expect(() =>
      calculateCheckoutSparkEventSettledGrossFundingSats(0, 0)
    ).toThrow()
  })

  it("does not haircut any frozen obligation when the exact credit is short", () => {
    const input = fixture()
    const plan = freezeCheckoutSparkSettledEventPlan(input)
    const state = createCheckoutSparkSettledReconciliation(plan)
    expect(() =>
      recordCheckoutSparkSettledCredit(state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: crypto.randomUUID(),
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: plan.funding.grossFundingSats,
        creditedSats: 104_599,
        observedAt: AT + 1,
      })
    ).toThrow()
    expect(() =>
      allocateCheckoutSparkEventSettledSats({
        settledSats: 104_599,
        fundingInvoiceGrossSats: plan.funding.grossFundingSats,
        weights: calculateCheckoutSparkEventAllocationWeights(100_000, 2_500),
      })
    ).toThrow()
  })

  it("rejects organizer fees masquerading as supplier/profile money or changed event evidence", () => {
    const input = fixture()
    const organizer = input.recipients[2]!
    for (const changed of [
      { ...organizer, kind: "supplier" as const },
      { ...organizer, recipientId: supplierPubkey },
      { ...organizer, weightSats: 2_501 },
      {
        ...organizer,
        destination: { ...organizer.destination, value: "other@example.test" },
      },
      {
        ...organizer,
        destination: {
          ...organizer.destination,
          source: {
            type: "signed_profile" as const,
            profileEventId: hash(),
            profileEventCreatedAt: AT / 1_000,
          },
        },
      },
      {
        ...organizer,
        destination: {
          ...organizer.destination,
          source: {
            type: "signed_event_market" as const,
            marketCoordinate,
            eventId: hash(),
            eventCreatedAt: AT / 1_000,
          },
        },
      },
    ]) {
      expect(() =>
        freezeCheckoutSparkSettledEventPlan({
          ...input,
          recipients: [
            input.recipients[0]!,
            input.recipients[1]!,
            changed,
            input.recipients[3]!,
          ],
        })
      ).toThrow()
    }
  })

  it("rejects reordered, duplicate, missing or zero-valued organizer obligations", () => {
    const input = fixture()
    const [merchant, supplier, organizer, conduit] = input.recipients
    for (const recipients of [
      [merchant!, organizer!, supplier!, conduit!],
      [merchant!, supplier!, conduit!],
      [merchant!, supplier!, organizer!, organizer!, conduit!],
      [merchant!, supplier!, { ...organizer!, weightSats: 0 }, conduit!],
    ]) {
      expect(() =>
        freezeCheckoutSparkSettledEventPlan({ ...input, recipients })
      ).toThrow()
    }
  })

  it("digest-binds the exact fee revision, pool and full cold-recovery source set", () => {
    const plan = freezeCheckoutSparkSettledEventPlan(fixture())
    for (const eventMarket of [
      { ...plan.eventMarket!, marketEventId: hash() },
      {
        ...plan.eventMarket!,
        grantAncestryEventIds: [
          ...plan.eventMarket!.grantAncestryEventIds,
          hash(),
        ],
      },
      { ...plan.eventMarket!, observedDeletionEventIds: [hash()] },
      { ...plan.eventMarket!, assignment: "Booth 2" },
      {
        ...plan.eventMarket!,
        mode: "organizer_handoff" as const,
        lines: plan.eventMarket!.lines.map((line) => ({
          ...line,
          stockPoolId: hash(),
        })),
      },
      { ...plan.eventMarket!, organizerFeeSats: 2_501 },
    ]) {
      expect(() =>
        restoreCheckoutSparkSettledPlan({ ...plan, eventMarket })
      ).toThrow()
    }
    expect(() =>
      restoreCheckoutSparkSettledPlan({ ...plan, schemaVersion: 4 })
    ).toThrow()
    const state = createCheckoutSparkSettledReconciliation(plan)
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({ ...state, schemaVersion: 5 })
    ).toThrow()
  })

  it("marks goods paid independently of the organizer but holds native collection until every payout is verified", () => {
    const { state, settlement } = funded()
    const merchantPaid = payLeg(state, settlement, 0)
    const commercePaid = payLeg(merchantPaid.state, merchantPaid.settlement, 1)
    expect(
      projectCheckoutSparkMerchantSettlement(commercePaid.settlement)
    ).toMatchObject({
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: true,
      feePending: true,
    })
    expect(commercePaid.settlement.requiredCommerceLegIds).toHaveLength(2)
    expect(commercePaid.settlement.requiredCommerceLegIds).not.toContain(
      commercePaid.settlement.organizerLegId
    )
    expect(() =>
      deriveCheckoutSparkNativeTreasuryBudget(
        commercePaid.state,
        commercePaid.settlement
      )
    ).toThrow()
    const allPaid = payLeg(commercePaid.state, commercePaid.settlement, 2)
    const unverifiedOrganizer = {
      ...allPaid.settlement,
      paidLegs: allPaid.settlement.paidLegs.map((leg) => {
        if (leg.legId !== allPaid.settlement.organizerLegId) return leg
        const { recipientVerified, ...unverified } = leg
        void recipientVerified
        return unverified
      }),
    }
    expect(() =>
      deriveCheckoutSparkNativeTreasuryBudget(
        allPaid.state,
        unverifiedOrganizer
      )
    ).toThrow()
    const budget = deriveCheckoutSparkNativeTreasuryBudget(
      allPaid.state,
      allPaid.settlement
    )
    expect(budget).toMatchObject({
      baseConduitAllocationSats: 2_100,
      unusedCommerceReserveSats: 6,
      authorizedDebitSats: 2_106,
    })
    const nativePrepared = prepareCheckoutSparkNativeTreasury(allPaid.state, {
      settlement: allPaid.settlement,
      preparedAt: AT + 100,
    })
    const completed = recordCheckoutSparkNativeTreasuryStatus(nativePrepared, {
      invoiceId: nativePrepared.plan.nativeTreasury!.invoiceId,
      providerTransferId: crypto.randomUUID(),
      status: "paid",
      observedAt: AT + 101,
      finalDebitSats: budget.authorizedDebitSats,
      finalFeeSats: 0,
    })
    expect(completed.treasuryFinalization?.status).toBe("paid")
    expect(completed.legs.every((leg) => leg.status === "paid")).toBe(true)
    expect(restoreCheckoutSparkSettledReconciliation(completed)).toEqual(
      completed
    )
  })
})
