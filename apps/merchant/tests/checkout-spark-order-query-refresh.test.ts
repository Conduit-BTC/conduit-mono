import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { orderSchema, type MerchantConversationSummary } from "@conduit/core"
import {
  getCheckoutSparkOrderSettlement,
  type MerchantOrderSettlementBinding,
} from "../src/lib/checkout-spark-order-overlay"
import {
  checkoutSparkOrderSettlementQueryOptions,
  NO_CHECKOUT_SPARK_ORDER_BINDINGS,
} from "../src/lib/checkout-spark-order-query"
import { useCheckoutSparkOrderSettlements } from "../src/hooks/useCheckoutSparkOrderSettlements"

const principal = "a".repeat(64)
const buyer = "b".repeat(64)
const orderId = "paid-order"
const checkoutId = "paid-checkout"
const planDigest = "c".repeat(64)
const rumorId = "d".repeat(64)
const merchantLeg = "1".repeat(64)
const supplierLeg = "2".repeat(64)
const feeLeg = "3".repeat(64)
const createdAt = 1_800_000_000_000
const payload = orderSchema.parse({
  id: orderId,
  buyerPubkey: buyer,
  merchantPubkey: principal,
  items: [
    {
      productId: `30402:${principal}:digital-item`,
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
  createdAt,
})
const rawContent = JSON.stringify(payload)
const conversation: MerchantConversationSummary = {
  id: orderId,
  orderId,
  buyerPubkey: buyer,
  merchantPubkey: principal,
  latestAt: createdAt,
  latestType: "order",
  status: null,
  totalSummary: "1,000 SATS",
  preview: "Digital item",
  messageCount: 1,
  messages: [
    {
      id: rumorId,
      orderId,
      type: "order",
      createdAt,
      senderPubkey: buyer,
      recipientPubkey: principal,
      rawContent,
      payload,
      checkoutPaymentRoute: "spark_router_v1",
    },
  ],
}
const bindings: readonly MerchantOrderSettlementBinding[] = [
  {
    witness: {
      schemaVersion: 1,
      merchantPubkey: principal,
      buyerPubkey: buyer,
      orderId,
      rumorId,
      contentHash: createHash("sha256")
        .update(
          `conduit:checkout-spark-merchant-order-content:v1\0${rawContent}`
        )
        .digest("hex"),
      checkoutId,
      planDigest,
    },
    settlement: {
      schemaVersion: 1,
      merchantPubkey: principal,
      orderId,
      checkoutId,
      planDigest,
      merchantLegId: merchantLeg,
      requiredCommerceLegIds: [merchantLeg, supplierLeg],
      feeLegId: feeLeg,
      credit: { transferId: "credit", creditedSats: 1_113, observedAt: 1 },
      paidLegs: [merchantLeg, supplierLeg].map((legId) => ({
        legId,
        transferId: `transfer-${legId}`,
        allocationSats: 500,
        finalDebitSats: 500,
        finalFeeSats: 0,
        recipientVerified: true as const,
        observedAt: 1,
      })),
    },
  },
]
const input = {
  enabled: true,
  pubkey: principal,
  authGeneration: 1,
  isAuthGenerationCurrent: (generation: number) => generation === 1,
  orderIds: [orderId],
}

async function observeVerifiedOrder(
  orderIds: readonly string[] = input.orderIds
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const initial = checkoutSparkOrderSettlementQueryOptions(
    { ...input, orderIds },
    async () => bindings
  )
  await client.fetchQuery(initial)
  const observer = new QueryObserver(client, initial)
  const unsubscribe = observer.subscribe(() => undefined)
  return {
    observer,
    projection: (current = conversation) =>
      getCheckoutSparkOrderSettlement(
        current,
        observer.getCurrentResult().data ?? NO_CHECKOUT_SPARK_ORDER_BINDINGS
      ),
    close() {
      unsubscribe()
      observer.destroy()
      client.clear()
    },
  }
}

describe("Merchant settlement projection during order-list refresh", () => {
  it("keeps the same verified order visible while an unrelated order is added", async () => {
    const { observer, projection, close } = await observeVerifiedOrder()
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      expect(projection()?.commerceVerified).toBe(true)
      observer.setOptions(
        checkoutSparkOrderSettlementQueryOptions(
          { ...input, orderIds: [orderId, "new-order"] },
          async () => {
            await held
            return bindings
          }
        )
      )
      expect(observer.getCurrentResult().isFetching).toBe(true)
      expect(projection()?.commerceVerified).toBe(true)
      finish()
      await observer.refetch()
      expect(projection()?.commerceVerified).toBe(true)
    } finally {
      finish()
      close()
    }
  })

  it("replaces temporary facts when the new local read is empty, partial, or ambiguous", async () => {
    const partial: readonly MerchantOrderSettlementBinding[] = [
      {
        ...bindings[0]!,
        settlement: {
          ...bindings[0]!.settlement,
          paidLegs: bindings[0]!.settlement.paidLegs.slice(0, 1),
        },
      },
    ]
    for (const completed of [[], partial, [bindings[0]!, bindings[0]!]]) {
      const { observer, projection, close } = await observeVerifiedOrder()
      let finish!: () => void
      const held = new Promise<void>((resolve) => {
        finish = resolve
      })
      try {
        observer.setOptions(
          checkoutSparkOrderSettlementQueryOptions(
            { ...input, orderIds: [orderId, "new-order"] },
            async () => {
              await held
              return completed
            }
          )
        )
        expect(projection()?.commerceVerified).toBe(true)
        finish()
        await observer.refetch()
        expect(observer.getCurrentResult().data).toEqual(completed)
        expect(projection()?.commerceVerified === true).toBe(false)
      } finally {
        finish()
        close()
      }
    }
  })

  it("clears a new-list placeholder when its local read fails instead of claiming a fresh result", async () => {
    const { observer, projection, close } = await observeVerifiedOrder()
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      observer.setOptions(
        checkoutSparkOrderSettlementQueryOptions(
          { ...input, orderIds: [orderId, "new-order"] },
          async () => {
            await held
            throw new Error("Local read unavailable")
          }
        )
      )
      expect(projection()?.commerceVerified).toBe(true)
      finish()
      await observer.refetch()
      expect(observer.getCurrentResult().isError).toBe(true)
      expect(projection()).toBeNull()
    } finally {
      finish()
      close()
    }
  })

  it("does not carry another account or session into an unfinished read", async () => {
    const { observer, projection, close } = await observeVerifiedOrder()
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      for (const changed of [
        { ...input, pubkey: "e".repeat(64), authGeneration: 2 },
        { ...input, authGeneration: 3 },
      ]) {
        observer.setOptions(
          checkoutSparkOrderSettlementQueryOptions(
            {
              ...changed,
              isAuthGenerationCurrent: (generation) =>
                generation === changed.authGeneration,
            },
            async () => {
              await held
              return NO_CHECKOUT_SPARK_ORDER_BINDINGS
            }
          )
        )
        expect(observer.getCurrentResult().isPlaceholderData).toBe(false)
        expect(projection()).toBeNull()
      }
      finish()
      await observer.refetch()
      expect(projection()).toBeNull()
    } finally {
      finish()
      close()
    }
  })

  it("revalidates the current order witness while previous raw bindings are shown", async () => {
    const { observer, projection, close } = await observeVerifiedOrder()
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      observer.setOptions(
        checkoutSparkOrderSettlementQueryOptions(
          { ...input, orderIds: [orderId, "new-order"] },
          async () => {
            await held
            return bindings
          }
        )
      )
      expect(projection()?.commerceVerified).toBe(true)
      expect(projection({ ...conversation, messages: [] })).toBeNull()
      expect(projection({ ...conversation, orderId: "new-order" })).toBeNull()
      const newerOrder = {
        ...conversation,
        messages: conversation.messages!.map((message) => ({
          ...message,
          id: "f".repeat(64),
        })),
      }
      expect(projection(newerOrder)).toBeNull()
      finish()
      await observer.refetch()
      expect(projection(newerOrder)).toBeNull()
    } finally {
      finish()
      close()
    }
  })

  it("hides a revoked session immediately and masks disabled or signed-out hook results", () => {
    const client = new QueryClient()
    client.setQueryData(
      checkoutSparkOrderSettlementQueryOptions(input).queryKey,
      bindings
    )
    let current = true
    let enabled = true
    let pubkey: string | null = principal
    let rendered:
      ReturnType<typeof useCheckoutSparkOrderSettlements> | undefined
    function ReadSettlement() {
      rendered = useCheckoutSparkOrderSettlements({
        ...input,
        enabled,
        pubkey,
        isAuthGenerationCurrent: () => current,
        conversations: [conversation],
      })
      return null
    }
    const render = () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ReadSettlement)
        )
      )
    try {
      render()
      expect(rendered!.getOrderSettlement(conversation)?.commerceVerified).toBe(
        true
      )
      expect(rendered!.isRefreshing).toBe(false)
      expect(rendered!.unavailable).toBe(false)
      current = false
      expect(rendered!.getOrderSettlement(conversation)).toBeNull()
      render()
      expect(rendered!.bindings).toEqual([])
      current = true
      enabled = false
      render()
      expect(rendered!.getOrderSettlement(conversation)).toBeNull()
      expect(rendered!.bindings).toEqual([])
      enabled = true
      pubkey = null
      render()
      expect(rendered!.getOrderSettlement(conversation)).toBeNull()
      expect(rendered!.bindings).toEqual([])
      expect(rendered!.isRefreshing).toBe(false)
      expect(rendered!.unavailable).toBe(false)
    } finally {
      client.clear()
    }
  })

  it("preserves the verified view when other orders disappear or the list is reordered", async () => {
    for (const orderIds of [[orderId], ["older-order", orderId]]) {
      const { observer, projection, close } = await observeVerifiedOrder([
        orderId,
        "older-order",
      ])
      let finish!: () => void
      const held = new Promise<void>((resolve) => {
        finish = resolve
      })
      try {
        observer.setOptions(
          checkoutSparkOrderSettlementQueryOptions(
            { ...input, orderIds },
            async () => {
              await held
              return bindings
            }
          )
        )
        expect(projection()?.commerceVerified).toBe(true)
        finish()
        await observer.refetch()
        expect(projection()?.commerceVerified).toBe(true)
      } finally {
        finish()
        close()
      }
    }
  })
})
