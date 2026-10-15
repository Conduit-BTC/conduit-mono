import { describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
  giftWrap,
} from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  EVENT_KINDS,
  buildOrderStatusTimeline,
  getNdk,
  parseOrderMessageRumorEvent,
  unwrapGiftWrap,
  type CheckoutSparkPlan,
  type MerchantConversationSummary,
  type OrderSchema,
  type ParsedOrderMessage,
} from "@conduit/core"
import {
  canMerchantIssueOrderInvoice,
  getMerchantConversationState,
  getMerchantConversationStatusDisplay,
  hasMerchantRoutedCheckoutOrder,
} from "../apps/merchant/src/lib/order-phase"
import { publishCheckoutSparkSettledBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import { saveCheckoutSparkSettledPreparation } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import type { PreparedCheckoutSparkSettledFunding } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import type { BuyerMessageDeliveryResult } from "../apps/market/src/lib/order-publish"

const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const ORDER_ID = "router-order"
const PRODUCT = `30402:${MERCHANT}:digital-item`

const order: OrderSchema = {
  id: ORDER_ID,
  buyerPubkey: BUYER,
  buyerIdentityKind: "signed_in",
  merchantPubkey: MERCHANT,
  items: [
    {
      productId: PRODUCT,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 1000,
      currency: "SATS",
      shippingCostSats: 0,
    },
  ],
  subtotal: 1000,
  currency: "SATS",
  shippingCostSats: 0,
  shippingCostStatus: "not_required",
  createdAt: 1_800_000_000_000,
}

function rumor(overrides: Partial<NDKEvent> = {}) {
  return {
    id: "c".repeat(64),
    kind: EVENT_KINDS.ORDER,
    pubkey: BUYER,
    created_at: 1_800_000_000,
    content: JSON.stringify(order),
    tags: [
      ["p", MERCHANT],
      ["type", "order"],
      ["order", ORDER_ID],
      ["amount", "1000"],
      ["currency", "SATS"],
      ["item", PRODUCT, "1"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
    ],
    ...overrides,
  } as NDKEvent
}

function conversation(message: ReturnType<typeof parseOrderMessageRumorEvent>) {
  return {
    id: ORDER_ID,
    orderId: ORDER_ID,
    buyerPubkey: BUYER,
    merchantPubkey: MERCHANT,
    latestAt: message.createdAt,
    latestType: message.type,
    status: null,
    totalSummary: "1000 SATS",
    preview: "Order",
    messageCount: 1,
    messages: [message],
  } as MerchantConversationSummary
}

describe("private checkout Spark order marker", () => {
  it("recognizes a scoped guest order without granting payment or reply authority", () => {
    const payload = {
      ...order,
      buyerIdentityKind: "guest_ephemeral",
      guestContact: { email: "guest@example.com", phone: "+15555550100" },
    }
    const message = parseOrderMessageRumorEvent(
      rumor({ content: JSON.stringify(payload) })
    )
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected order")
    expect(message.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(message.payload.buyerIdentityKind).toBe("guest_ephemeral")
    const state = getMerchantConversationState(conversation(message))
    expect(state.checkoutSparkRouted).toBe(true)
    expect(state.paid).toBe(false)
    expect(
      canMerchantIssueOrderInvoice({
        buyerInboxKnown: false,
        queue: "unpaid_review",
        state: { ...state, status: "accepted", accepted: true },
      })
    ).toBe(false)
    for (const invalid of [
      { ...payload, guestContact: undefined },
      { ...payload, guestContact: { email: "guest@example.com" } },
      { ...payload, buyerIdentityKind: "signed_in" },
      { ...payload, buyerPubkey: MERCHANT },
    ]) {
      expect(() =>
        parseOrderMessageRumorEvent(rumor({ content: JSON.stringify(invalid) }))
      ).toThrow()
    }
  })

  it("survives an authenticated NIP-17 seal without exposing its tag on the wrap", async () => {
    const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
    const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
    const signedOrder = {
      ...order,
      buyerPubkey: buyer.pubkey,
      merchantPubkey: merchant.pubkey,
      items: [
        {
          ...order.items[0]!,
          productId: `30402:${merchant.pubkey}:digital-item`,
        },
      ],
    }
    const event = new NDKEvent(getNdk())
    event.kind = EVENT_KINDS.ORDER
    event.pubkey = buyer.pubkey
    event.created_at = order.createdAt / 1_000
    event.content = JSON.stringify(signedOrder)
    event.tags = [
      ["p", merchant.pubkey],
      ["type", "order"],
      ["order", ORDER_ID],
      ["amount", "1000"],
      ["currency", "SATS"],
      ["item", signedOrder.items[0]!.productId, "1"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
    ]
    event.id = event.getEventHash()
    const wrap = await wrapPrivateMessage(
      event,
      new NDKUser({ pubkey: merchant.pubkey }),
      buyer
    )
    expect(wrap.kind).toBe(EVENT_KINDS.GIFT_WRAP)
    expect(wrap.tags).not.toContainEqual([...CHECKOUT_SPARK_ROUTER_ORDER_TAG])
    const outcome = await unwrapGiftWrap(wrap, merchant)
    expect(outcome.status).toBe("ok")
    if (outcome.status !== "ok") throw new Error("Expected private order")
    const message = parseOrderMessageRumorEvent(outcome.rumor)
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected order")
    expect(message.checkoutPaymentRoute).toBe("spark_router_v1")

    const impostor = NDKPrivateKeySigner.generate()
    const forgedWrap = await giftWrap(
      event,
      new NDKUser({ pubkey: merchant.pubkey }),
      impostor
    )
    expect((await unwrapGiftWrap(forgedWrap, merchant)).status).not.toBe("ok")
  })

  it.each(["saved", "storage_failure", "account_changed", "publish_failed"])(
    "keeps order delivery separate from its local buyer binding: %s",
    async (mode) => {
      const storageMap = new Map<string, string>()
      const storage = {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageMap.set(key, value)
        },
        removeItem: (key: string) => {
          storageMap.delete(key)
        },
      }
      const plan = {
        checkoutId: "checkout-1",
        orderId: ORDER_ID,
        merchantPubkey: MERCHANT,
        walletId: "wallet-1",
        planDigest: "d".repeat(64),
        createdAt: order.createdAt,
        takeoverAt: order.createdAt + 60_000,
        funding: { expiresAt: order.createdAt + 60_000 },
        commerceQuote: {
          commerceTotalSats: order.subtotal,
          lines: [
            {
              productCoordinate: PRODUCT,
              merchantPubkey: MERCHANT,
              quantity: 1,
              unitMerchandiseSats: 1000,
              unitShippingSats: 0,
            },
          ],
        },
      } as CheckoutSparkPlan
      saveCheckoutSparkSettledPreparation(
        {
          schemaVersion: 3,
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          recoveryHandoffId: "handoff-1",
          fundingInvoiceExposedAt: order.createdAt,
          fundingSubmissionState: "not_started",
          savedAt: order.createdAt,
        },
        storage
      )
      let captured: NDKEvent | null = null
      let active = true
      let publishes = 0
      let binds = 0
      const pending = publishCheckoutSparkSettledBoundOrder(
        {
          checkoutId: plan.checkoutId,
          order,
          buyer: { kind: "signed_in", pubkey: BUYER },
          authenticatedPubkey: BUYER,
          ndk: getNdk(),
          shouldContinue: () => active,
          addressValidity: "not_required",
          shippingZoneEligibility: "not_required",
          storage,
        },
        {
          now: () => order.createdAt + 1_000,
          loadSettledFunding: async () =>
            ({
              plan,
              state: { credit: null },
            }) as PreparedCheckoutSparkSettledFunding,
          publishOrder: async (event) => {
            publishes += 1
            captured = event
            if (mode === "publish_failed") throw new Error("No relay accepted")
            if (mode === "account_changed") active = false
            return { localCacheError: null } as BuyerMessageDeliveryResult
          },
          bindBuyerOrder: async (boundPlan, buyer, assertCurrent) => {
            binds += 1
            assertCurrent()
            expect(boundPlan).toEqual(plan)
            expect(buyer).toBe(BUYER)
            expect(publishes).toBe(1)
            if (mode === "storage_failure")
              throw new Error("Storage unavailable")
            return {
              schemaVersion: 1,
              checkoutId: plan.checkoutId,
              planDigest: plan.planDigest,
              orderId: plan.orderId,
              merchantPubkey: MERCHANT,
              buyerPubkey: BUYER,
              walletId: plan.walletId,
              commerceTotalSats: order.subtotal,
            }
          },
        }
      )
      if (mode === "publish_failed") {
        await expect(pending).rejects.toThrow("No relay accepted")
        expect(binds).toBe(0)
        return
      }
      const result = await pending
      expect(result.orderId).toBe(ORDER_ID)
      expect(publishes).toBe(1)
      expect(binds).toBe(mode === "account_changed" ? 0 : 1)
      expect(result.delivery.localCacheError).toBe(
        mode === "saved"
          ? null
          : "The order was sent, but its local payment-history binding could not be saved."
      )
      expect(captured?.tags).toContainEqual([
        ...CHECKOUT_SPARK_ROUTER_ORDER_TAG,
      ])
      expect(JSON.parse(captured!.content)).toEqual(order)
      expect(captured!.content).not.toContain("planDigest")
      expect(captured!.content).not.toContain("funding")
      expect(captured!.content).not.toContain("walletId")
    }
  )

  it("projects an authenticated buyer order as awaiting settlement, never paid", () => {
    const message = parseOrderMessageRumorEvent(rumor())
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected order")
    expect(message.checkoutPaymentRoute).toBe("spark_router_v1")
    const thread = conversation(message)
    const state = getMerchantConversationState(thread)
    expect(state.checkoutSparkRouted).toBe(true)
    expect(state.paid).toBe(false)
    expect(state.paymentObserved).toBe(false)
    expect(getMerchantConversationStatusDisplay(thread).label).toBe(
      "Awaiting checkout verification"
    )
    const accepted = { ...state, status: "accepted", accepted: true }
    expect(
      canMerchantIssueOrderInvoice({
        buyerInboxKnown: true,
        queue: "unpaid_review",
        state: accepted,
      })
    ).toBe(false)
    expect(buildOrderStatusTimeline(accepted)[1]?.title).toBe(
      "Await checkout settlement"
    )
    expect(
      buildOrderStatusTimeline(accepted).some(
        (step) => step.status === "complete" && step.key === "payment"
      )
    ).toBe(false)
  })

  it("ignores buyer and merchant paid claims for routed checkout while preserving direct manual confirmation", () => {
    const message = parseOrderMessageRumorEvent(rumor())
    const status = {
      id: "e".repeat(64),
      orderId: ORDER_ID,
      type: "status_update",
      createdAt: message.createdAt + 1,
      senderPubkey: BUYER,
      recipientPubkey: MERCHANT,
      rawContent: "",
      payload: { status: "paid" },
    } as ParsedOrderMessage
    const forged = {
      ...conversation(message),
      messages: [message, status],
    }
    expect(getMerchantConversationState(forged).paid).toBe(false)
    expect(getMerchantConversationStatusDisplay(forged).label).toBe(
      "Awaiting checkout verification"
    )
    const confirmed = {
      ...forged,
      messages: [
        message,
        { ...status, senderPubkey: MERCHANT, recipientPubkey: BUYER },
      ],
    }
    expect(getMerchantConversationState(confirmed).paid).toBe(false)
    expect(getMerchantConversationStatusDisplay(confirmed).label).toBe(
      "Awaiting checkout verification"
    )
    const ordinary = parseOrderMessageRumorEvent(
      rumor({
        tags: rumor().tags.filter(
          (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
        ),
      })
    )
    const directConfirmed = {
      ...confirmed,
      messages: [ordinary, confirmed.messages[1]!],
    }
    expect(getMerchantConversationState(directConfirmed).paid).toBe(true)
    expect(getMerchantConversationStatusDisplay(directConfirmed).label).toBe(
      "Paid"
    )
  })

  it("preserves ordinary invoice flow for an unmarked historical order", () => {
    const tags = rumor().tags.filter(
      (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
    )
    const message = parseOrderMessageRumorEvent(rumor({ tags }))
    const state = getMerchantConversationState(conversation(message))
    expect(state.checkoutSparkRouted).toBe(false)
    expect(state.paid).toBe(false)
    expect(
      canMerchantIssueOrderInvoice({
        buyerInboxKnown: true,
        queue: "unpaid_review",
        state: { ...state, status: "accepted", accepted: true },
      })
    ).toBe(true)
  })

  it("blocks a competing invoice when an ordinary copy arrived first", () => {
    const ordinary = parseOrderMessageRumorEvent(
      rumor({
        id: "d".repeat(64),
        created_at: 1_800_000_001,
        tags: rumor().tags.filter(
          (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
        ),
      })
    )
    const routed = parseOrderMessageRumorEvent(
      rumor({ id: "e".repeat(64), created_at: 1_800_000_000 })
    )
    const scope = {
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
    }

    for (const messages of [
      [ordinary, routed],
      [routed, ordinary],
      [ordinary, routed, ordinary],
    ]) {
      const thread = { ...conversation(ordinary), messages }
      const state = getMerchantConversationState(thread)
      expect(state.checkoutSparkRouted).toBe(true)
      expect(state.paid).toBe(false)
      expect(hasMerchantRoutedCheckoutOrder([thread], scope)).toBe(true)
      expect(
        canMerchantIssueOrderInvoice({
          buyerInboxKnown: true,
          queue: "unpaid_review",
          state: { ...state, status: "accepted", accepted: true },
        })
      ).toBe(false)
    }
  })

  it("keeps the routed guard when a valid payload uses uppercase hex pubkeys", () => {
    const message = parseOrderMessageRumorEvent(
      rumor({
        content: JSON.stringify({
          ...order,
          buyerPubkey: BUYER.toUpperCase(),
          merchantPubkey: MERCHANT.toUpperCase(),
        }),
      })
    )
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected order")
    expect(message.checkoutPaymentRoute).toBe("spark_router_v1")
    const state = getMerchantConversationState(conversation(message))
    expect(state.checkoutSparkRouted).toBe(true)
    expect(
      canMerchantIssueOrderInvoice({
        buyerInboxKnown: true,
        queue: "unpaid_review",
        state: { ...state, status: "accepted", accepted: true },
      })
    ).toBe(false)
  })

  it("uses the conversation order identity when unrelated order messages are mixed in", () => {
    const unrelatedId = "another-order"
    const unrelated = parseOrderMessageRumorEvent(
      rumor({
        id: "f".repeat(64),
        content: JSON.stringify({ ...order, id: unrelatedId }),
        tags: rumor().tags.map((tag) =>
          tag[0] === "order" ? ["order", unrelatedId] : tag
        ),
      })
    )
    const ordinary = parseOrderMessageRumorEvent(
      rumor({
        id: "d".repeat(64),
        tags: rumor().tags.filter(
          (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
        ),
      })
    )
    const routed = parseOrderMessageRumorEvent(rumor({ id: "e".repeat(64) }))
    const scope = {
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
    }
    const mixed = { ...conversation(ordinary), messages: [unrelated, ordinary] }
    expect(getMerchantConversationState(mixed).checkoutSparkRouted).toBe(false)
    expect(hasMerchantRoutedCheckoutOrder([mixed], scope)).toBe(false)
    const reversedDirection = {
      ...routed,
      senderPubkey: MERCHANT,
      recipientPubkey: BUYER,
    }
    expect(
      getMerchantConversationState({
        ...mixed,
        messages: [ordinary, reversedDirection],
      }).checkoutSparkRouted
    ).toBe(false)

    const withExactRouted = {
      ...mixed,
      messages: [unrelated, ordinary, routed],
    }
    expect(
      getMerchantConversationState(withExactRouted).checkoutSparkRouted
    ).toBe(true)
    expect(hasMerchantRoutedCheckoutOrder([withExactRouted], scope)).toBe(true)
  })

  it("detects exact cached routed evidence before an invoice mutation", () => {
    const marked = conversation(parseOrderMessageRumorEvent(rumor()))
    const unmarked = conversation(
      parseOrderMessageRumorEvent(
        rumor({
          tags: rumor().tags.filter(
            (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
          ),
        })
      )
    )
    const scope = {
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
    }
    expect(hasMerchantRoutedCheckoutOrder([unmarked], scope)).toBe(false)
    expect(hasMerchantRoutedCheckoutOrder([marked], scope)).toBe(true)
    expect(
      hasMerchantRoutedCheckoutOrder([marked], {
        ...scope,
        orderId: "a-different-order",
      })
    ).toBe(false)
  })

  it("rechecks cached routing evidence in both merchant invoice mutations", async () => {
    const route = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    expect(
      route.match(/await assertNoObservedRoutedCheckoutInvoice\(/g)?.length
    ).toBe(2)
  })

  it("rejects forged, conflicting, or malformed routing claims", () => {
    const base = rumor()
    const forgedBuyer = rumor({
      content: JSON.stringify({ ...order, buyerPubkey: MERCHANT }),
    })
    const forgedRecipient = rumor({
      tags: base.tags.map((tag) => (tag[0] === "p" ? ["p", BUYER] : tag)),
    })
    const duplicate = rumor({
      tags: [...base.tags, [...CHECKOUT_SPARK_ROUTER_ORDER_TAG]],
    })
    const wrongAmount = rumor({
      tags: base.tags.map((tag) =>
        tag[0] === "amount" ? ["amount", "1"] : tag
      ),
    })
    const ordinaryShipping = rumor({
      content: JSON.stringify({ ...order, shippingCostStatus: "manual" }),
    })
    for (const candidate of [
      forgedBuyer,
      forgedRecipient,
      duplicate,
      wrongAmount,
      ordinaryShipping,
    ]) {
      expect(() => parseOrderMessageRumorEvent(candidate)).toThrow(
        "Invalid private checkout payment marker"
      )
    }
  })
})
