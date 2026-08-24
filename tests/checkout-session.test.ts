import { describe, expect, it } from "bun:test"
import { GUEST_ORDER_LOCAL_RETENTION_MS } from "@conduit/core"
import {
  DEFAULT_CHECKOUT_SHIPPING,
  claimGuestCheckoutShippingSession,
  clearCheckoutShippingSession,
  getCheckoutShippingDraftOwnershipAction,
  initializeCheckoutShippingSession,
  inspectCheckoutShippingDraftOwnership,
  pruneExpiredCheckoutShippingSession,
  readCheckoutShippingInitialization,
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
      readCheckoutShippingInitialization(
        null,
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS - 1,
        null
      ).value
    ).toEqual(shipping)
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS,
        null
      ).value
    ).toEqual(DEFAULT_CHECKOUT_SHIPPING)
    expect(storage.length).toBe(0)
  })

  it("drops legacy or malformed unbounded checkout storage", () => {
    const storage = fakeStorage()
    storage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({ email: "legacy@example.com" })
    )

    expect(
      readCheckoutShippingInitialization(null, storage, undefined, null).value
    ).toEqual(DEFAULT_CHECKOUT_SHIPPING)
    expect(storage.length).toBe(0)
  })

  it("drops checkout storage timestamped in the future", () => {
    const storage = fakeStorage()
    writeCheckoutShippingSession(
      DEFAULT_CHECKOUT_SHIPPING,
      storage,
      1_700_000_000_001
    )

    expect(
      readCheckoutShippingInitialization(null, storage, 1_700_000_000_000, null)
        .value
    ).toEqual(DEFAULT_CHECKOUT_SHIPPING)
    expect(storage.length).toBe(0)
  })

  it("clears checkout contact data after successful delivery", () => {
    const storage = fakeStorage()
    writeCheckoutShippingSession(DEFAULT_CHECKOUT_SHIPPING, storage)

    clearCheckoutShippingSession(storage)

    expect(storage.length).toBe(0)
  })

  it("proactively expires abandoned checkout contact data", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      {
        ...DEFAULT_CHECKOUT_SHIPPING,
        street: "123 Private Street",
        email: "alice@example.com",
        phone: "+12025550123",
      },
      storage,
      updatedAt
    )

    expect(
      pruneExpiredCheckoutShippingSession(
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
      )
    ).toBe(true)
    expect(storage.length).toBe(0)
  })

  it("preserves an active identity-scoped draft during global pruning", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      { ...DEFAULT_CHECKOUT_SHIPPING, street: "123 Private Street" },
      storage,
      updatedAt,
      "buyer-a"
    )

    expect(pruneExpiredCheckoutShippingSession(storage, updatedAt + 1)).toBe(
      false
    )
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        updatedAt + 1,
        "buyer-a"
      ).value.street
    ).toBe("123 Private Street")
  })

  it("claims a valid guest draft without changing its value, timestamp, or expiry", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    const guestDraft = {
      ...DEFAULT_CHECKOUT_SHIPPING,
      firstName: "Alice",
      street: "123 Private Street",
    }
    writeCheckoutShippingSession(guestDraft, storage, updatedAt, null)

    expect(
      claimGuestCheckoutShippingSession("buyer-a", storage, updatedAt + 1)
    ).toBe(true)
    expect(
      JSON.parse(storage.getItem("conduit:checkout-shipping") ?? "{}")
    ).toEqual({
      ownerPubkey: "buyer-a",
      updatedAt,
      value: guestDraft,
    })
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS - 1,
        "buyer-a"
      )
    ).toEqual({ value: guestDraft, hasActiveDraft: true })
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS,
        "buyer-a"
      )
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })
    expect(storage.length).toBe(0)
  })

  it("does not claim another signed identity's draft", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      { ...DEFAULT_CHECKOUT_SHIPPING, street: "Private Street" },
      storage,
      updatedAt,
      "buyer-a"
    )
    const stored = storage.getItem("conduit:checkout-shipping")

    expect(
      claimGuestCheckoutShippingSession("buyer-b", storage, updatedAt + 1)
    ).toBe(false)
    expect(storage.getItem("conduit:checkout-shipping")).toBe(stored)
  })

  it("inspects valid draft ownership without returning contact data", () => {
    const storage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      {
        ...DEFAULT_CHECKOUT_SHIPPING,
        email: "private@example.test",
        street: "123 Private Street",
      },
      storage,
      updatedAt,
      "buyer-a"
    )

    const ownership = inspectCheckoutShippingDraftOwnership(
      storage,
      updatedAt + 1
    )
    expect(ownership).toEqual({ hasValidDraft: true, ownerPubkey: "buyer-a" })
    expect(Object.keys(ownership)).toEqual(["hasValidDraft", "ownerPubkey"])
  })

  it("uses the bounded parser to reject malformed and expired ownership records", () => {
    const malformedStorage = fakeStorage()
    malformedStorage.setItem("conduit:checkout-shipping", "not-json")
    expect(
      inspectCheckoutShippingDraftOwnership(malformedStorage, 1_000)
    ).toEqual({ hasValidDraft: false, ownerPubkey: null })
    expect(malformedStorage.length).toBe(0)

    const expiredStorage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      DEFAULT_CHECKOUT_SHIPPING,
      expiredStorage,
      updatedAt,
      "buyer-a"
    )
    expect(
      inspectCheckoutShippingDraftOwnership(
        expiredStorage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
      )
    ).toEqual({ hasValidDraft: false, ownerPubkey: null })
    expect(expiredStorage.length).toBe(0)
  })

  it("applies the pending, signed, and guest draft ownership matrix", () => {
    const validGuest = { hasValidDraft: true, ownerPubkey: null }
    const validSigned = { hasValidDraft: true, ownerPubkey: "buyer-a" }
    const noDraft = { hasValidDraft: false, ownerPubkey: null }

    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: "buyer-a",
        isRestorePending: true,
        ownership: validSigned,
      })
    ).toBe("defer")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: "buyer-a",
        isRestorePending: false,
        ownership: validSigned,
      })
    ).toBe("restore")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: "buyer-a",
        isRestorePending: false,
        ownership: validGuest,
      })
    ).toBe("claim")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: "buyer-b",
        isRestorePending: false,
        ownership: validSigned,
      })
    ).toBe("clear")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: null,
        isRestorePending: false,
        ownership: validGuest,
      })
    ).toBe("restore")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: null,
        isRestorePending: false,
        ownership: validSigned,
      })
    ).toBe("clear")
    expect(
      getCheckoutShippingDraftOwnershipAction({
        identityPubkey: null,
        isRestorePending: false,
        ownership: noDraft,
      })
    ).toBe("seed")
  })

  it("keeps malformed and expired draft cleanup when claiming", () => {
    const malformedStorage = fakeStorage()
    malformedStorage.setItem("conduit:checkout-shipping", "not-json")
    expect(
      claimGuestCheckoutShippingSession("buyer", malformedStorage, 1_000)
    ).toBe(false)
    expect(malformedStorage.length).toBe(0)

    const expiredStorage = fakeStorage()
    const updatedAt = 1_700_000_000_000
    writeCheckoutShippingSession(
      DEFAULT_CHECKOUT_SHIPPING,
      expiredStorage,
      updatedAt,
      null
    )
    expect(
      claimGuestCheckoutShippingSession(
        "buyer",
        expiredStorage,
        updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
      )
    ).toBe(false)
    expect(expiredStorage.length).toBe(0)
  })

  it("claims a guest draft for a connected identity even when its signer is unavailable or incompatible", () => {
    for (const signerReadiness of ["unavailable", "incompatible"]) {
      const storage = fakeStorage()
      const guestDraft = {
        ...DEFAULT_CHECKOUT_SHIPPING,
        street: `${signerReadiness} signer draft`,
      }
      writeCheckoutShippingSession(guestDraft, storage, 1_700_000_000_000)

      const initialized = initializeCheckoutShippingSession(
        null,
        "buyer-a",
        storage,
        1_700_000_000_001
      )

      expect(initialized).toEqual({ value: guestDraft, hasActiveDraft: true })
      expect(
        inspectCheckoutShippingDraftOwnership(storage, 1_700_000_000_001)
      ).toEqual({ hasValidDraft: true, ownerPubkey: "buyer-a" })
    }
  })

  it("retains a connected identity draft while signer readiness changes", () => {
    const storage = fakeStorage()
    const draft = { ...DEFAULT_CHECKOUT_SHIPPING, street: "Stable draft" }
    writeCheckoutShippingSession(draft, storage, 1_700_000_000_000, "buyer-a")

    const initializedForEachSignerState = ["ready", "unavailable", "ready"].map(
      () =>
        initializeCheckoutShippingSession(
          null,
          "buyer-a",
          storage,
          1_700_000_000_001
        )
    )

    expect(initializedForEachSignerState).toEqual([
      { value: draft, hasActiveDraft: true },
      { value: draft, hasActiveDraft: true },
      { value: draft, hasActiveDraft: true },
    ])
  })
})
