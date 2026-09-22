import { describe, expect, it } from "bun:test"
import {
  buildMerchantPresentSaleAuthorization,
  getMerchantPresentSaleCommerceFingerprintRef,
  type OrderSchema,
  type ParsedOrderMessage,
} from "@conduit/core"
import {
  consumeMerchantPresentAuthorizationUseAtomically,
  consumeReadyMerchantPresentAuthorization,
  deriveMerchantPresentAuthorizationState,
  getMerchantPresentOrderReview,
  parseMerchantPresentDirectAuthorizationText,
  persistMerchantPresentOrderReview,
  resolveMerchantPresentOrderContext,
  type MerchantPresentAuthorizationLockManager,
} from "../apps/market/src/lib/merchant-present-order-authorization"

const merchantPubkey = "a".repeat(64)
const buyerPubkey = "b".repeat(64)
const organizerPubkey = "c".repeat(64)
const productCoordinate = `30402:${merchantPubkey}:coffee`
const collectionCoordinate = `30405:${organizerPubkey}:market-day`
const reviewedCommerceFingerprint = JSON.stringify({
  items: [productCoordinate],
  totalSats: 21,
  paymentDestination: "merchant@example.test",
})

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  dump(): string {
    return JSON.stringify(Array.from(this.values.entries()))
  }
}

const immediateLocks: MerchantPresentAuthorizationLockManager = {
  request: async (_name, _options, callback) => callback(),
}

function boothOrder(): OrderSchema {
  return {
    id: "booth-order-1",
    merchantPubkey,
    buyerPubkey,
    items: [
      {
        productId: productCoordinate,
        title: "Coffee",
        format: "physical",
        fulfillment: {
          type: "pickup",
          organizerPubkey,
          product: {
            coordinate: productCoordinate,
            eventId: "1".repeat(64),
            createdAt: 100,
            merchantPubkey,
          },
          calendar: {
            coordinate: `31923:${organizerPubkey}:market-day`,
            eventId: "2".repeat(64),
            createdAt: 101,
          },
          collection: {
            coordinate: collectionCoordinate,
            eventId: "3".repeat(64),
            createdAt: 102,
          },
          option: {
            coordinate: `30406:${merchantPubkey}:market-day-booth`,
            eventId: "4".repeat(64),
            createdAt: 103,
            title: "Merchant booth",
            location: "North hall",
          },
          handoffMode: "merchant_handoff",
          handlerPubkey: merchantPubkey,
          costSats: 0,
          sourceCost: {
            amount: 0,
            currency: "SAT",
            normalizedCurrency: "SAT",
          },
        },
        quantity: 1,
        priceAtPurchase: 21,
        currency: "SATS",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SAT",
          normalizedCurrency: "SAT",
        },
        shippingOptionId: `30406:${merchantPubkey}:market-day-booth`,
        shippingOptionDTag: "market-day-booth",
      },
    ],
    subtotal: 21,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    purchaseContext: {
      type: "merchant_present",
      merchantPubkey,
      collection: {
        coordinate: collectionCoordinate,
        eventId: "3".repeat(64),
        createdAt: 102,
      },
      reviewedCommerceFingerprintRef:
        getMerchantPresentSaleCommerceFingerprintRef(
          reviewedCommerceFingerprint
        ),
    },
    createdAt: 1_000_000,
  }
}

function orderMessage(payload: OrderSchema = boothOrder()): ParsedOrderMessage {
  return {
    id: "order-message",
    orderId: payload.id,
    type: "order",
    createdAt: payload.createdAt,
    senderPubkey: payload.buyerPubkey,
    recipientPubkey: payload.merchantPubkey,
    rawContent: JSON.stringify(payload),
    payload,
  }
}

function authorizationMessage(expiresAt = 1_240): ParsedOrderMessage {
  const payload = buildMerchantPresentSaleAuthorization({
    order: boothOrder(),
    nonce: "5".repeat(64),
    issuedAt: 1_000,
    expiresAt,
  })
  return {
    id: "authorization-message",
    orderId: payload.orderId,
    type: "merchant_present_sale_authorization",
    createdAt: payload.issuedAt * 1_000,
    senderPubkey: payload.merchantPubkey,
    recipientPubkey: payload.buyerPubkey,
    rawContent: JSON.stringify(payload),
    payload,
  }
}

describe("buyer merchant-present order authorization", () => {
  it("keeps an ordinary remote merchant-pickup order outside the booth gate", async () => {
    const remote = boothOrder()
    delete remote.purchaseContext
    const storage = new MemoryStorage()

    const context = await resolveMerchantPresentOrderContext({
      orderId: remote.id,
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage(remote)],
      storage,
      readCachedMessages: async () => [],
    })

    expect(context).toEqual({ status: "remote" })
    expect(
      deriveMerchantPresentAuthorizationState({ context, now: 1_050 })
    ).toEqual({ status: "remote" })
  })

  it("fails closed without the exact session-reviewed commerce terms", async () => {
    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage()],
      storage: new MemoryStorage(),
      readCachedMessages: async () => [],
    })

    expect(context.status).toBe("unavailable")
    if (context.status !== "unavailable") return
    expect(context.reason).toContain("exact price, payment destination")
  })

  it("uses the session-bound booth order when guest cache recovery is unavailable", async () => {
    const storage = new MemoryStorage()
    persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint },
      storage
    )

    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      storage,
      readCachedMessages: async () => {
        throw new Error("indexed db unavailable")
      },
    })

    expect(context.status).toBe("merchant_present")
  })

  it("uses the signed-in conversation when the local cache is unavailable", async () => {
    const storage = new MemoryStorage()
    persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint },
      storage
    )

    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage()],
      storage,
      readCachedMessages: async () => {
        throw new Error("indexed db unavailable")
      },
    })

    expect(context.status).toBe("merchant_present")
  })

  it("uses the exact cached guest order and imported capability", async () => {
    const storage = new MemoryStorage()
    persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint },
      storage
    )

    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [],
      storage,
      readCachedMessages: async () => [orderMessage()],
    })
    const state = deriveMerchantPresentAuthorizationState({
      context,
      importedAuthorization: authorizationMessage().payload,
      now: 1_050,
    })

    expect(context.status).toBe("merchant_present")
    expect(state.status).toBe("ready")
  })

  it("moves from waiting to ready using the exact signed-in conversation", async () => {
    const storage = new MemoryStorage()
    const review = persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint, storedAt: 10 },
      storage
    )
    expect(getMerchantPresentOrderReview("booth-order-1", storage)).toEqual(
      review
    )
    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage()],
      storage,
      readCachedMessages: async () => [],
    })

    expect(
      deriveMerchantPresentAuthorizationState({ context, now: 1_050 }).status
    ).toBe("waiting")
    expect(
      deriveMerchantPresentAuthorizationState({
        context,
        messages: [orderMessage(), authorizationMessage()],
        now: 1_050,
      }).status
    ).toBe("ready")
  })

  it("shows an expired merchant confirmation as an actionable invalid state", async () => {
    const storage = new MemoryStorage()
    persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint },
      storage
    )
    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage()],
      storage,
      readCachedMessages: async () => [],
    })
    const state = deriveMerchantPresentAuthorizationState({
      context,
      messages: [authorizationMessage(1_010)],
      now: 1_050,
    })

    expect(state.status).toBe("invalid")
    if (state.status !== "invalid") return
    expect(state.reason).toContain("expired")
  })

  it("atomically consumes one content-safe use reference only once", async () => {
    const storage = new MemoryStorage()
    const use = { useRef: "9".repeat(64), expiresAt: 2_000 }

    expect(
      await consumeMerchantPresentAuthorizationUseAtomically(use, {
        storage,
        locks: immediateLocks,
        now: 1_000,
      })
    ).toBe(true)
    expect(
      await consumeMerchantPresentAuthorizationUseAtomically(use, {
        storage,
        locks: immediateLocks,
        now: 1_001,
      })
    ).toBe(false)
    expect(storage.dump()).not.toContain(reviewedCommerceFingerprint)
  })

  it("revalidates then consumes the exact ready authorization", async () => {
    const reviewStorage = new MemoryStorage()
    const useStorage = new MemoryStorage()
    persistMerchantPresentOrderReview(
      { order: boothOrder(), reviewedCommerceFingerprint },
      reviewStorage
    )
    const context = await resolveMerchantPresentOrderContext({
      orderId: "booth-order-1",
      buyerPubkey,
      merchantPubkey,
      messages: [orderMessage()],
      storage: reviewStorage,
      readCachedMessages: async () => [],
    })
    const state = deriveMerchantPresentAuthorizationState({
      context,
      messages: [authorizationMessage()],
      now: 1_050,
    })
    if (state.status !== "ready") throw new Error("expected ready state")

    await expect(
      consumeReadyMerchantPresentAuthorization(state, {
        storage: useStorage,
        locks: immediateLocks,
        now: 1_050,
      })
    ).resolves.toEqual(state.authorization)
    await expect(
      consumeReadyMerchantPresentAuthorization(state, {
        storage: useStorage,
        locks: immediateLocks,
        now: 1_051,
      })
    ).rejects.toThrow("already used")
  })

  it("rejects malformed pasted guest confirmations before import", () => {
    expect(() =>
      parseMerchantPresentDirectAuthorizationText("not-json")
    ).toThrow("complete signed booth confirmation")
    expect(() => parseMerchantPresentDirectAuthorizationText("{}")).toThrow(
      "not a valid signed event"
    )
  })
})
