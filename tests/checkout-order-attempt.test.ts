import { describe, expect, it } from "bun:test"
import {
  doesCartMatchOrderAttempt,
  forgetCheckoutOrderAttempt,
  hasCheckoutPaymentProgress,
  listCheckoutOrderAttemptIds,
  rememberCheckoutOrderAttempt,
  requiresCheckoutOrderRecovery,
} from "../apps/market/src/lib/checkout-order-attempt"

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
})
