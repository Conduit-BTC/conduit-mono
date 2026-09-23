import { describe, expect, it } from "bun:test"
import type { OrderLifecycle } from "@conduit/core"
import {
  doesCartMatchOrderAttempt,
  findCheckoutOrderRecovery,
  forgetCheckoutOrderAttempt,
  hasCheckoutPaymentProgress,
  listCheckoutOrderAttemptIds,
  rememberCheckoutOrderAttempt,
  requiresAcceptedOrderPaymentContinuation,
  requiresCheckoutOrderRecovery,
} from "../apps/market/src/lib/checkout-order-attempt"
import {
  createSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
  listSessionGuestOrderIds,
} from "../apps/market/src/lib/guest-order-identity"

function sharedStorageViews(): {
  first: Pick<Storage, "getItem" | "setItem" | "removeItem">
  second: Pick<Storage, "getItem" | "setItem" | "removeItem">
} {
  const values = new Map<string, string>()
  const view = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  })
  return { first: view(), second: view() }
}

describe("checkout order attempt locator", () => {
  it("is visible across tabs and never resurrects a removed locator", () => {
    const { first, second } = sharedStorageViews()
    rememberCheckoutOrderAttempt("order-a", 1_000, first)
    expect(listCheckoutOrderAttemptIds(second, 100)).toEqual(["order-a"])

    forgetCheckoutOrderAttempt("order-a", first)
    expect(listCheckoutOrderAttemptIds(second, 100)).toEqual([])

    rememberCheckoutOrderAttempt("order-b", 1_000, second)
    expect(listCheckoutOrderAttemptIds(first, 100)).toEqual(["order-b"])
  })

  it("prunes expired opaque locators", () => {
    const { first } = sharedStorageViews()
    rememberCheckoutOrderAttempt("expired", 99, first)
    rememberCheckoutOrderAttempt("active", 101, first)
    expect(listCheckoutOrderAttemptIds(first, 100)).toEqual(["active"])
  })

  it("keeps a same-page fallback when durable locator storage fails", () => {
    const { first } = sharedStorageViews()
    expect(listCheckoutOrderAttemptIds(first, 100)).toEqual([])
    const unavailable = {
      getItem: () => {
        throw new Error("storage denied")
      },
      setItem: () => {
        throw new Error("storage denied")
      },
      removeItem: () => {
        throw new Error("storage denied")
      },
    }
    rememberCheckoutOrderAttempt("in-memory", 1_000, unavailable)
    expect(listCheckoutOrderAttemptIds(unavailable, 100)).toEqual(["in-memory"])
  })

  it("only reopens attempts whose durable recovery fence is still active", () => {
    expect(
      requiresCheckoutOrderRecovery({
        checkoutRecoveryPending: false,
        hasAttemptLocator: false,
        hasGuestKey: true,
      })
    ).toBe(false)
    expect(
      requiresCheckoutOrderRecovery({
        checkoutRecoveryPending: true,
        hasAttemptLocator: true,
        hasGuestKey: false,
      })
    ).toBe(true)
  })

  it("retains pre-payment recovery until invoice or payment work advances", () => {
    expect(
      hasCheckoutPaymentProgress({
        paymentStatus: "not_started",
        invoiceStatus: "not_requested",
      })
    ).toBe(false)
    expect(
      hasCheckoutPaymentProgress({
        paymentStatus: "not_started",
        invoiceStatus: "requesting",
      })
    ).toBe(true)
    expect(
      hasCheckoutPaymentProgress({
        paymentStatus: "manual_required",
        invoiceStatus: "manual_required",
      })
    ).toBe(true)
  })

  it("matches only the exact cart represented by the staged order", () => {
    const stagedItems = [
      {
        productId: "30402:merchant:shirt",
        familyProductId: "30402:merchant:shirt-family",
        selectedSpecifications: [
          { key: "size", value: "medium" },
          { key: "color", value: "blue" },
        ],
        quantity: 2,
        shippingOptionId: "shipping-standard",
        shippingOptionDTag: "standard",
      },
    ]

    expect(
      doesCartMatchOrderAttempt(
        [
          {
            ...stagedItems[0],
            selectedSpecifications: [
              { key: "color", value: "blue" },
              { key: "size", value: "medium" },
            ],
          },
        ],
        stagedItems
      )
    ).toBe(true)
    expect(
      doesCartMatchOrderAttempt(
        [{ ...stagedItems[0], quantity: 1 }],
        stagedItems
      )
    ).toBe(false)
  })

  it("finds the accepted guest order after cart consumption and same-tab reload", async () => {
    const now = 1_700_000_000_000
    const orderId = "accepted-guest-order"
    const merchantPubkey = "a".repeat(64)
    const localStorage = sharedStorageViews()
    const sessionStorage = sharedStorageViews()
    const guest = createSessionGuestOrderSigningIdentity(
      orderId,
      merchantPubkey,
      { storage: sessionStorage.first, nowMs: now }
    )
    rememberCheckoutOrderAttempt(orderId, now + 60_000, localStorage.first)
    const persisted = {
      orderId,
      buyerPubkey: guest.pubkey,
      buyerIdentityKind: "guest_ephemeral",
      merchantPubkey,
      checkoutMode: "external_wallet",
      items: [{ productId: "30402:merchant:item", quantity: 1 }],
      orderDeliveryStatus: "sent",
      orderRelayDelivery: {
        expiresAt: now + 60_000,
        relayDelivery: [{ status: "acked" }],
      },
      checkoutRecoveryPending: true,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
      phase: "in_progress",
      updatedAt: now,
    } as OrderLifecycle
    let buyerIndexReads = 0
    const source = {
      listAttemptIds: (at: number) =>
        listCheckoutOrderAttemptIds(localStorage.second, at),
      listGuestIds: (at: number) =>
        listSessionGuestOrderIds(sessionStorage.second, at),
      getGuestPubkey: (id: string, at: number) =>
        getSessionGuestOrderSigningIdentity(id, sessionStorage.second, at)
          ?.pubkey ?? null,
      getOrder: async (id: string) => (id === orderId ? persisted : undefined),
      listBuyerOrders: async () => {
        buyerIndexReads += 1
        return []
      },
    }
    const found = await findCheckoutOrderRecovery(
      { accountPubkey: null, nowMs: now + 1 },
      source
    )

    expect(found).toEqual({ order: persisted, ownsOrder: true })
    expect(requiresAcceptedOrderPaymentContinuation(found!.order)).toBe(true)
    expect(buyerIndexReads).toBe(0)

    persisted.checkoutRecoveryPending = false
    persisted.invoiceStatus = "requesting"
    expect(
      await findCheckoutOrderRecovery(
        { accountPubkey: null, nowMs: now + 2 },
        source
      )
    ).toEqual({ order: persisted, ownsOrder: true })

    persisted.paymentStatus = "paid"
    persisted.proofDeliveryStatus = "sent"
    expect(
      await findCheckoutOrderRecovery(
        { accountPubkey: null, nowMs: now + 3 },
        source
      )
    ).toBeNull()
  })

  it("fences empty-cart recovery to the current buyer or live guest key", async () => {
    const now = 1_700_000_000_000
    const orderId = "other-buyer-order"
    const localStorage = sharedStorageViews()
    rememberCheckoutOrderAttempt(orderId, now + 60_000, localStorage.first)
    const persisted = {
      orderId,
      buyerPubkey: "a".repeat(64),
      merchantPubkey: "b".repeat(64),
      items: [{ productId: "30402:merchant:item", quantity: 1 }],
      orderRelayDelivery: { expiresAt: now + 60_000 },
      checkoutRecoveryPending: true,
      updatedAt: now,
    } as OrderLifecycle
    const source = {
      listAttemptIds: (at: number) =>
        listCheckoutOrderAttemptIds(localStorage.second, at),
      listGuestIds: () => [],
      getGuestPubkey: () => null,
      getOrder: async (id: string) => (id === orderId ? persisted : undefined),
      listBuyerOrders: async () => [],
    }

    expect(
      await findCheckoutOrderRecovery(
        { accountPubkey: null, nowMs: now + 1 },
        source
      )
    ).toBeNull()
    expect(
      await findCheckoutOrderRecovery(
        { accountPubkey: "c".repeat(64), nowMs: now + 1 },
        source
      )
    ).toBeNull()
    expect(
      await findCheckoutOrderRecovery(
        {
          accountPubkey: "c".repeat(64),
          nowMs: now + 1,
          purchase: {
            merchantPubkey: persisted.merchantPubkey,
            items: persisted.items,
          },
        },
        source
      )
    ).toEqual({ order: persisted, ownsOrder: false })
  })
})
