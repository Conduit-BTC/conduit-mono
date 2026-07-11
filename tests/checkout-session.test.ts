import { describe, expect, it } from "bun:test"
import { GUEST_ORDER_LOCAL_RETENTION_MS } from "@conduit/core"
import {
  DEFAULT_CHECKOUT_SHIPPING,
  clearCheckoutShippingSession,
  readCheckoutShippingSession,
  writeCheckoutShippingSession,
} from "../apps/market/src/lib/checkout-session"

function fakeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe("checkout shipping session", () => {
  it("restores contact details only inside the bounded session window", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    const shipping = {
      ...DEFAULT_CHECKOUT_SHIPPING,
      firstName: "Alice",
      email: "alice@example.com",
      phone: "+12025550123",
    }
    writeCheckoutShippingSession(shipping, storage, updatedAt)

    expect(
      readCheckoutShippingSession(
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS - 1
      )
    ).toEqual(shipping)
    expect(
      readCheckoutShippingSession(
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
      )
    ).toEqual(DEFAULT_CHECKOUT_SHIPPING)
    expect(storage.length).toBe(0)
  })

  it("drops legacy or malformed unbounded checkout storage", () => {
    const storage = fakeStorage()
    storage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({ email: "legacy@example.com" })
    )

    expect(readCheckoutShippingSession(storage)).toEqual(
      DEFAULT_CHECKOUT_SHIPPING
    )
    expect(storage.length).toBe(0)
  })

  it("drops checkout storage timestamped in the future", () => {
    const storage = fakeStorage()
    writeCheckoutShippingSession(
      DEFAULT_CHECKOUT_SHIPPING,
      storage,
      1_700_000_000_001
    )

    expect(readCheckoutShippingSession(storage, 1_700_000_000_000)).toEqual(
      DEFAULT_CHECKOUT_SHIPPING
    )
    expect(storage.length).toBe(0)
  })

  it("clears checkout contact data after successful delivery", () => {
    const storage = fakeStorage()
    writeCheckoutShippingSession(DEFAULT_CHECKOUT_SHIPPING, storage)

    clearCheckoutShippingSession(storage)

    expect(storage.length).toBe(0)
  })
})
