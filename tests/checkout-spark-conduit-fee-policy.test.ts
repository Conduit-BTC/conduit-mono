import { describe, expect, it } from "bun:test"
import {
  CHECKOUT_SPARK_CURRENT_CONDUIT_FEE_POLICY,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeePolicyForNewPlan,
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateCheckoutSparkEventSettledGrossFundingSats,
  calculateCheckoutSparkBuyerPrice,
  calculateCheckoutSparkEventBuyerPrice,
  allocateCheckoutSparkSettledSats,
  allocateCheckoutSparkEventSettledSats,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  freezeCheckoutSparkSettledEventPlan,
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"
import {
  checkoutSparkEventMarketFixture,
  eventMarketFixtureInvoice,
} from "./support/checkout-spark-event-market-fixture"

const policy = CHECKOUT_SPARK_CURRENT_CONDUIT_FEE_POLICY

function withCurrentFeePolicy(original: CheckoutSparkSettledPlan) {
  const commerce = original.commerceQuote.commerceTotalSats
  const grossFundingSats = original.eventMarket
    ? calculateCheckoutSparkEventSettledGrossFundingSats(
        commerce,
        original.eventMarket.organizerFeeSats,
        policy
      )
    : calculateCheckoutSparkSettledGrossFundingSats(commerce, policy)
  const input = {
    ...original,
    conduitFeePolicy: policy,
    funding: {
      ...original.funding,
      ...eventMarketFixtureInvoice(grossFundingSats),
      grossFundingSats,
    },
    recipients: original.recipients.map((recipient) => ({
      ...recipient,
      weightSats:
        recipient.kind === "conduit"
          ? calculateConduitCheckoutFeeSats(commerce, policy)
          : recipient.weightSats,
    })),
  }
  return original.eventMarket
    ? freezeCheckoutSparkSettledEventPlan({
        ...input,
        eventMarket: original.eventMarket,
        nativeTreasury: original.nativeTreasury!,
      })
    : original.nativeTreasury
      ? freezeCheckoutSparkSettledTreasuryPlan({
          ...input,
          nativeTreasury: original.nativeTreasury,
        })
      : freezeCheckoutSparkSettledPlan(input)
}

describe("versioned Conduit fee economics", () => {
  it.each([
    [0, 0],
    [1, 1],
    [10, 1],
    [47, 1],
    [48, 2],
    [1_000, 21],
    [5_285, 111],
    [5_286, 112],
    [100_000, 2_100],
    [100_001, 2_101],
  ])("uses ceiling 2.1%% without a minimum for %i sats", (commerce, fee) => {
    expect(calculateConduitCheckoutFeeSats(commerce, policy)).toBe(fee)
  })

  it("retains omitted historical policy and rejects unknown policies", () => {
    expect(calculateConduitCheckoutFeeSats(1_000)).toBe(111)
    expect(calculateCheckoutSparkSettledGrossFundingSats(1_000)).toBe(1_113)
    expect(() => calculateConduitCheckoutFeeSats(0)).toThrow()
    expect(() =>
      calculateConduitCheckoutFeeSats(1_000, "unknown" as typeof policy)
    ).toThrow("fee policy")
    expect(() =>
      calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: 0,
        shippingSubtotalSats: 0,
        conduitFeePolicy: "unknown" as typeof policy,
      })
    ).toThrow("fee policy")
    expect(() => calculateConduitCheckoutFeeSats(-1, policy)).toThrow()
  })

  it("names the legacy zero-commerce positive organizer-minimum admission exception", () => {
    expect(checkoutSparkConduitFeePolicyForNewPlan(1_000, 5)).toBe(policy)
    expect(checkoutSparkConduitFeePolicyForNewPlan(0, 0)).toBe(policy)
    expect(checkoutSparkConduitFeePolicyForNewPlan(0, 5)).toBeUndefined()
    const historical = checkoutSparkEventMarketFixture({
      commerceTotalSats: 0,
      organizerFee: {
        state: "active",
        basisPoints: 0,
        minimumSats: 5,
        lightningAddress: "organizer@example.test",
      },
    }).plan
    expect(historical.funding.grossFundingSats).toBe(117)
    expect(historical.recipients.map((recipient) => recipient.kind)).toEqual([
      "organizer",
      "conduit",
    ])
    expect(historical.recipients.at(-1)!.weightSats).toBe(111)
    expect(restoreCheckoutSparkSettledPlan(historical)).toEqual(historical)
    // The mathematical policy remains zero on zero commerce, never an invented fee.
    expect(calculateCheckoutSparkEventAllocationWeights(0, 5, policy)).toEqual({
      commerceWeightSats: 0,
      conduitWeightSats: 0,
      organizerWeightSats: 5,
    })
  })

  it("keeps provider allowance separate and rounds each checkout once", () => {
    expect(
      calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: 900,
        shippingSubtotalSats: 100,
        conduitFeePolicy: policy,
      })
    ).toMatchObject({
      conduitFeeSats: 21,
      networkAllowanceSats: 2,
      coordinationFeeSats: 23,
      totalSats: 1_023,
      minimumApplies: false,
    })
    const weights = calculateCheckoutSparkAllocationWeights(1_000, policy)
    expect(
      allocateCheckoutSparkSettledSats({
        settledSats: 1_021,
        fundingInvoiceGrossSats: 1_023,
        weights,
        conduitFeePolicy: policy,
      })
    ).toEqual({ commerceAllocationSats: 1_000, conduitAllocationSats: 21 })
    expect(
      allocateCheckoutSparkSettledSats({
        settledSats: 1_023,
        fundingInvoiceGrossSats: 1_023,
        weights,
        conduitFeePolicy: policy,
      })
    ).toEqual({ commerceAllocationSats: 1_002, conduitAllocationSats: 21 })
    expect(() =>
      allocateCheckoutSparkSettledSats({
        settledSats: 1_021,
        fundingInvoiceGrossSats: 1_023,
        weights,
      })
    ).toThrow("weights")
  })

  it("does not charge Conduit a percentage of the organizer fee", () => {
    const weights = calculateCheckoutSparkEventAllocationWeights(
      1_000,
      25,
      policy
    )
    expect(weights).toEqual({
      commerceWeightSats: 1_000,
      conduitWeightSats: 21,
      organizerWeightSats: 25,
    })
    expect(
      calculateCheckoutSparkEventBuyerPrice({
        itemSubtotalSats: 1_000,
        shippingSubtotalSats: 0,
        organizerFeeSats: 25,
        conduitFeePolicy: policy,
      })
    ).toMatchObject({
      totalSats: 1_048,
      conduitFeeSats: 21,
      organizerFeeSats: 25,
      minimumApplies: false,
    })
    expect(
      allocateCheckoutSparkEventSettledSats({
        settledSats: 1_046,
        fundingInvoiceGrossSats: 1_048,
        weights,
        conduitFeePolicy: policy,
      })
    ).toEqual({
      commerceAllocationSats: 1_000,
      conduitAllocationSats: 21,
      organizerAllocationSats: 25,
    })
    expect(
      calculateCheckoutSparkEventBuyerPrice({
        itemSubtotalSats: 0,
        shippingSubtotalSats: 0,
        organizerFeeSats: 0,
        conduitFeePolicy: policy,
      }).totalSats
    ).toBe(0)
  })

  it.each([3, 4, 5])(
    "round-trips new policy and old funded v%i economics without repricing",
    (schemaVersion) => {
      const native = nativeTreasuryFixture()
      const historical =
        schemaVersion === 3
          ? native.legacy
          : schemaVersion === 4
            ? native.plan
            : checkoutSparkEventMarketFixture({ commerceTotalSats: 1_000 }).plan
      const savedHistorical = JSON.parse(JSON.stringify(historical))
      const current = withCurrentFeePolicy(historical)
      expect(current.schemaVersion).toBe(schemaVersion)
      expect(current.conduitFeePolicy).toBe(policy)
      expect(current.planDigest).not.toBe(historical.planDigest)
      expect(current.recipients.at(-1)!.weightSats).toBe(21)
      expect(current.funding.grossFundingSats).toBe(
        historical.funding.grossFundingSats - 90
      )
      expect(restoreCheckoutSparkSettledPlan(savedHistorical)).toEqual(
        historical
      )
      expect(Object.hasOwn(savedHistorical, "conduitFeePolicy")).toBe(false)
      expect(savedHistorical.recipients.at(-1)!.weightSats).toBe(111)
      expect(
        restoreCheckoutSparkSettledPlan(JSON.parse(JSON.stringify(current)))
      ).toEqual(current)
      for (const plan of [historical, current]) {
        const creditedSats = plan.recipients.reduce(
          (sum, recipient) => sum + recipient.weightSats,
          0
        )
        const state = recordCheckoutSparkSettledCredit(
          createCheckoutSparkSettledReconciliation(plan),
          {
            requestId: plan.funding.requestId,
            paymentHash: plan.funding.paymentHash,
            receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
            transferId: "exact-attributed-funding",
            grossSats: plan.funding.grossFundingSats,
            creditedSats,
            observedAt: plan.createdAt + 1,
          }
        )
        expect(state.legs.at(-1)!.allocationSats).toBe(
          plan.recipients.at(-1)!.weightSats
        )
        expect(
          restoreCheckoutSparkSettledReconciliation(
            JSON.parse(JSON.stringify(state))
          )
        ).toEqual(state)
      }
      const stripped = { ...current }
      delete stripped.conduitFeePolicy
      expect(() => restoreCheckoutSparkSettledPlan(stripped)).toThrow()
      expect(() =>
        restoreCheckoutSparkSettledPlan({
          ...historical,
          conduitFeePolicy: policy,
        })
      ).toThrow()
    }
  )

  it("binds the policy even when the amounts happen to be identical", () => {
    const historical = checkoutSparkEventMarketFixture().plan
    const current = freezeCheckoutSparkSettledEventPlan({
      ...historical,
      eventMarket: historical.eventMarket!,
      nativeTreasury: historical.nativeTreasury!,
      conduitFeePolicy: policy,
    })
    expect(current.funding).toEqual(historical.funding)
    expect(current.recipients).toEqual(historical.recipients)
    expect(current.planDigest).not.toBe(historical.planDigest)
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...historical,
        conduitFeePolicy: policy,
      })
    ).toThrow("integrity")
    const stripped = { ...current }
    delete stripped.conduitFeePolicy
    expect(() => restoreCheckoutSparkSettledPlan(stripped)).toThrow("integrity")
  })
})
