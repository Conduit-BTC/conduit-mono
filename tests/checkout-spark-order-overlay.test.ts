import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  orderSchema,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantSettlementRecord,
  type MerchantConversationSummary,
  type ParsedOrderMessage,
} from "@conduit/core"
import {
  getCheckoutSparkOrderSettlement,
  getCheckoutSparkOrderSettlementRecord,
  projectCheckoutSparkOrderSettlements,
  type MerchantOrderSettlementBinding,
} from "../apps/merchant/src/lib/checkout-spark-order-overlay"

const buyer = "a".repeat(64)
const merchant = "b".repeat(64)
const merchantLeg = "1".repeat(64)
const supplierLeg = "2".repeat(64)
const feeLeg = "3".repeat(64)
const orderId = "routed-order"
const checkoutId = "routed-checkout"
const planDigest = "4".repeat(64)
const rumorId = "5".repeat(64)
const orderPayload = orderSchema.parse({
  id: orderId,
  buyerPubkey: buyer,
  merchantPubkey: merchant,
  items: [
    {
      productId: `30402:${merchant}:digital-item`,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 1_000,
      currency: "SATS",
      shippingCostSats: 0,
    },
  ],
  subtotal: 1_000,
  currency: "SATS",
  shippingCostSats: 0,
  shippingCostStatus: "not_required",
  createdAt: 1_800_000_000_000,
})
const rawContent = JSON.stringify(orderPayload)
const orderMessage: ParsedOrderMessage = {
  id: rumorId,
  orderId,
  type: "order",
  createdAt: 1_800_000_000_000,
  senderPubkey: buyer,
  recipientPubkey: merchant,
  rawContent,
  payload: orderPayload,
  checkoutPaymentRoute: "spark_router_v1",
}
const witness: CheckoutSparkMerchantOrderWitness = {
  schemaVersion: 1,
  merchantPubkey: merchant,
  buyerPubkey: buyer,
  orderId,
  rumorId,
  contentHash: createHash("sha256")
    .update(`conduit:checkout-spark-merchant-order-content:v1\0${rawContent}`)
    .digest("hex"),
  checkoutId,
  planDigest,
}
const conversation: MerchantConversationSummary = {
  id: orderId,
  orderId,
  buyerPubkey: buyer,
  merchantPubkey: merchant,
  latestAt: 1_800_000_000_000,
  latestType: "order",
  status: null,
  totalSummary: "1,000 SATS",
  preview: "Digital item",
  messageCount: 1,
  messages: [orderMessage],
}

function paidLeg(legId: string) {
  return {
    legId,
    transferId: `transfer-${legId}`,
    allocationSats: 500,
    finalDebitSats: 500,
    finalFeeSats: 0,
    recipientVerified: true as const,
    observedAt: 1,
  }
}

function settlement(
  paid: readonly string[] = []
): CheckoutSparkMerchantSettlementRecord {
  return {
    schemaVersion: 1,
    merchantPubkey: merchant,
    orderId,
    checkoutId,
    planDigest,
    merchantLegId: merchantLeg,
    requiredCommerceLegIds: [merchantLeg, supplierLeg],
    feeLegId: feeLeg,
    credit: {
      transferId: "credit-transfer",
      creditedSats: 1_113,
      observedAt: 1,
    },
    paidLegs: paid.map(paidLeg),
  }
}

function binding(paid: readonly string[] = []): MerchantOrderSettlementBinding {
  return { witness, settlement: settlement(paid) }
}

describe("exact merchant order settlement overlay", () => {
  it("shows exact witnessed receiver observations without confirming commerce or manufacturing Spark facts", () => {
    const observed = {
      witness,
      settlement: { ...settlement(), credit: null },
      receiverSettlement: {
        creditVerified: false,
        merchantVerified: false,
        commerceVerified: false,
        feePending: false,
        recipientUnverified: false,
        receiverSettlementObserved: true,
        receiverCommerceObserved: true,
      },
    }
    expect(
      getCheckoutSparkOrderSettlement(conversation, [observed])
    ).toMatchObject({
      creditVerified: false,
      merchantVerified: false,
      commerceVerified: false,
      feePending: false,
      receiverSettlementObserved: true,
      receiverCommerceObserved: true,
    })
    expect(
      getCheckoutSparkOrderSettlementRecord(conversation, [observed])
    ).toEqual(observed.settlement)
    expect(observed.settlement.paidLegs).toEqual([])
    expect(
      getCheckoutSparkOrderSettlement(
        { ...conversation, buyerPubkey: "c".repeat(64) },
        [observed]
      )
    ).toBeNull()
  })

  it("keeps provider-paid imported records visible without marking commerce verified", () => {
    const verified = binding([merchantLeg, supplierLeg])
    const imported = {
      witness: verified.witness,
      settlement: {
        ...verified.settlement,
        paidLegs: verified.settlement.paidLegs.map((leg) => {
          const providerOnly = { ...leg }
          delete providerOnly.recipientVerified
          return providerOnly
        }),
      },
    }
    expect(getCheckoutSparkOrderSettlement(conversation, [imported])).toEqual({
      creditVerified: true,
      merchantVerified: false,
      commerceVerified: false,
      feePending: true,
      recipientUnverified: true,
    })
  })

  it("binds provider settlement to the exact order and keeps optional fee separate", () => {
    expect(
      getCheckoutSparkOrderSettlementRecord(conversation, [
        binding([merchantLeg, supplierLeg]),
      ])?.paidLegs.map((leg) => leg.legId)
    ).toEqual([merchantLeg, supplierLeg])
    expect(
      getCheckoutSparkOrderSettlement(conversation, [
        binding([merchantLeg, supplierLeg]),
      ])
    ).toEqual({
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: true,
      feePending: true,
      recipientUnverified: false,
    })
    expect(
      getCheckoutSparkOrderSettlement(conversation, [binding([merchantLeg])])
    ).toMatchObject({
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: false,
    })
    expect(
      getCheckoutSparkOrderSettlement(conversation, [
        binding([merchantLeg, supplierLeg, feeLeg]),
      ])?.feePending
    ).toBe(false)
  })

  it("rejects an altered order, a mixed-buyer bucket, and conflicting witnesses", () => {
    const altered = {
      ...orderMessage,
      rawContent: rawContent.replace("digital-item", "altered-item"),
    } as ParsedOrderMessage
    expect(
      getCheckoutSparkOrderSettlement(
        { ...conversation, messages: [altered] },
        [binding([merchantLeg, supplierLeg])]
      )
    ).toBeNull()
    expect(
      getCheckoutSparkOrderSettlement(
        {
          ...conversation,
          messages: [
            orderMessage,
            { ...orderMessage, senderPubkey: "c".repeat(64) },
          ],
        },
        [binding([merchantLeg, supplierLeg])]
      )
    ).toBeNull()
    expect(
      getCheckoutSparkOrderSettlement(conversation, [
        binding([merchantLeg, supplierLeg]),
        {
          witness: { ...witness, checkoutId: "other-checkout" },
          settlement: { ...settlement(), checkoutId: "other-checkout" },
        },
      ])
    ).toBeNull()
    expect(
      getCheckoutSparkOrderSettlementRecord(conversation, [
        binding([merchantLeg, supplierLeg]),
        binding([merchantLeg, supplierLeg]),
      ])
    ).toBeNull()
  })

  it("never attaches routed status to a direct order or invalid record", () => {
    expect(
      getCheckoutSparkOrderSettlement(
        {
          ...conversation,
          messages: [{ ...orderMessage, checkoutPaymentRoute: undefined }],
        },
        [binding([merchantLeg, supplierLeg])]
      )
    ).toBeNull()
    expect(
      getCheckoutSparkOrderSettlement(conversation, [
        {
          witness,
          settlement: {
            ...settlement([merchantLeg, supplierLeg]),
            planDigest: "bad",
          },
        },
      ])
    ).toBeNull()
  })

  it("keeps projections local to the matching conversation", () => {
    const projected = projectCheckoutSparkOrderSettlements(
      [conversation, { ...conversation, id: "other", orderId: "other" }],
      [binding([merchantLeg, supplierLeg])]
    )
    expect(projected.get(orderId)?.commerceVerified).toBe(true)
    expect(projected.has("other")).toBe(false)
  })
})
