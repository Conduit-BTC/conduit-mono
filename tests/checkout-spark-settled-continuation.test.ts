import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  clearCheckoutSparkSettledContinuation,
  listCheckoutSparkSettledContinuations,
  pruneExpiredCheckoutSparkSettledContinuations,
  saveCheckoutSparkSettledContinuation,
  type CheckoutSparkSettledContinuation,
} from "../apps/market/src/lib/checkout-spark-settled-continuation"

const NOW = 1_800_000_000_000
const BUYER = getPublicKey(generateSecretKey())
const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const PRODUCT = finalizeEvent(
  {
    kind: 30402,
    created_at: NOW / 1_000,
    tags: [["d", "synthetic"]],
    content: "",
  },
  SECRET
)

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function fixture(): CheckoutSparkSettledContinuation {
  return {
    schemaVersion: 1,
    checkoutId: "original-checkout",
    planDigest: "a".repeat(64),
    buyerPubkey: BUYER,
    identityKind: "signed_in",
    createdAt: NOW,
    expiresAt: NOW + 24 * 60 * 60_000,
    order: {
      id: "original-order",
      buyerPubkey: BUYER,
      buyerIdentityKind: "signed_in",
      merchantPubkey: MERCHANT,
      createdAt: NOW,
      note: "Synthetic private original note",
      items: [
        {
          productId: `30402:${MERCHANT}:synthetic`,
          format: "digital",
          fulfillment: { type: "digital" },
          quantity: 1,
          priceAtPurchase: 100,
          currency: "SATS",
          shippingCostSats: 0,
        },
      ],
      subtotal: 100,
      currency: "SATS",
      shippingCostSats: 0,
      shippingCostStatus: "not_required",
    },
    sourceEvents: [PRODUCT],
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
  }
}

describe("same-tab original checkout continuation", () => {
  it("detaches the original private draft and strips extra unapproved fields", () => {
    const storage = new MemoryStorage()
    const row = fixture()
    saveCheckoutSparkSettledContinuation(
      {
        ...row,
        unapproved: "not retained",
      } as CheckoutSparkSettledContinuation,
      storage
    )
    row.order.note = "Changed cart note"
    row.order.items[0]!.quantity = 7
    const saved = listCheckoutSparkSettledContinuations(BUYER, NOW, storage)[0]!
    expect(saved.order.note === "Synthetic private original note").toBe(true)
    expect(saved.order.items[0]!.quantity).toBe(1)
    expect("unapproved" in saved).toBe(false)
    expect(
      listCheckoutSparkSettledContinuations(
        getPublicKey(generateSecretKey()),
        NOW,
        storage
      )
    ).toHaveLength(0)
    expect(() => saveCheckoutSparkSettledContinuation(row, storage)).toThrow(
      "cannot be replaced"
    )
  })

  it("purges the exact expired guest draft even after its signer registry is gone", () => {
    const storage = new MemoryStorage()
    const original = fixture()
    const row = {
      ...original,
      identityKind: "guest_ephemeral" as const,
      order: {
        ...original.order,
        buyerIdentityKind: "guest_ephemeral" as const,
        guestContact: { email: "guest@example.test", phone: "+12025550123" },
      },
    }
    saveCheckoutSparkSettledContinuation(row, storage)
    expect(
      pruneExpiredCheckoutSparkSettledContinuations(row.expiresAt - 1, storage)
    ).toHaveLength(1)
    expect(
      pruneExpiredCheckoutSparkSettledContinuations(row.expiresAt, storage)
    ).toHaveLength(0)
    expect(
      [...storage.values.values()].some((raw) =>
        raw.includes("Synthetic private original note")
      )
    ).toBe(false)
  })

  it("cannot extend the original retention, change its buyer, or clear a different plan", () => {
    const storage = new MemoryStorage()
    const row = fixture()
    expect(() =>
      saveCheckoutSparkSettledContinuation(
        { ...row, expiresAt: row.expiresAt + 1 },
        storage
      )
    ).toThrow("unreadable")
    expect(() =>
      saveCheckoutSparkSettledContinuation(
        { ...row, buyerPubkey: getPublicKey(generateSecretKey()) },
        storage
      )
    ).toThrow("unreadable")
    saveCheckoutSparkSettledContinuation(row, storage)
    expect(() =>
      clearCheckoutSparkSettledContinuation(
        row.checkoutId,
        "b".repeat(64),
        storage
      )
    ).toThrow("changed")
    expect(
      listCheckoutSparkSettledContinuations(BUYER, NOW, storage)
    ).toHaveLength(1)
    clearCheckoutSparkSettledContinuation(
      row.checkoutId,
      row.planDigest,
      storage
    )
    expect(
      listCheckoutSparkSettledContinuations(BUYER, NOW, storage)
    ).toHaveLength(0)
  })

  it("does not treat unreadable storage, dropped writes, or invalid clocks as absence", () => {
    const storage = new MemoryStorage()
    storage.setItem = () => undefined
    expect(() =>
      saveCheckoutSparkSettledContinuation(fixture(), storage)
    ).toThrow("durably saved")
    expect(() =>
      pruneExpiredCheckoutSparkSettledContinuations(Number.NaN, storage)
    ).toThrow("clock")
    const unreadable = new MemoryStorage()
    unreadable.getItem = () => "not json"
    expect(() =>
      listCheckoutSparkSettledContinuations(BUYER, NOW, unreadable)
    ).toThrow("unreadable")
  })
})
