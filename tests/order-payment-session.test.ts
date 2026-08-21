import { describe, expect, it } from "bun:test"

import {
  clearOrderPaymentClaim,
  readOrderPaymentClaim,
  rememberOrderPaymentClaim,
} from "../apps/market/src/lib/order-payment-session"

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
  }
}

describe("order payment session ownership", () => {
  it("retains independent content-free claim markers per order", () => {
    const session = storage()

    expect(rememberOrderPaymentClaim("order-a", "claim-a", session)).toBe(true)
    expect(rememberOrderPaymentClaim("order-b", "claim-b", session)).toBe(true)
    expect(readOrderPaymentClaim("order-a", session)).toBe("claim-a")
    expect(readOrderPaymentClaim("order-b", session)).toBe("claim-b")
  })

  it("only clears the claimant that still owns the marker", () => {
    const session = storage()
    rememberOrderPaymentClaim("order-a", "new-claim", session)

    expect(clearOrderPaymentClaim("order-a", "old-claim", session)).toBe(false)
    expect(readOrderPaymentClaim("order-a", session)).toBe("new-claim")
    expect(clearOrderPaymentClaim("order-a", "new-claim", session)).toBe(true)
    expect(readOrderPaymentClaim("order-a", session)).toBeNull()
  })

  it("fails closed when session storage is empty or unavailable", () => {
    const session = storage({
      "conduit:order-payment-claim:order-a": "",
    })
    expect(readOrderPaymentClaim("order-a", session)).toBeNull()

    const blocked = {
      getItem() {
        throw new Error("blocked")
      },
      setItem() {
        throw new Error("blocked")
      },
      removeItem() {
        throw new Error("blocked")
      },
    }
    expect(rememberOrderPaymentClaim("order-a", "claim-a", blocked)).toBe(false)
    expect(readOrderPaymentClaim("order-a", blocked)).toBeNull()
  })

  it("stores each order under an independent key", () => {
    const values = new Map<string, string>()
    const session = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }

    rememberOrderPaymentClaim("order-a", "claim-a", session)
    rememberOrderPaymentClaim("order-b", "claim-b", session)

    expect(values).toEqual(
      new Map([
        ["conduit:order-payment-claim:order-a", "claim-a"],
        ["conduit:order-payment-claim:order-b", "claim-b"],
      ])
    )
  })
})
