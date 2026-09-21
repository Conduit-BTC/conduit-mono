import { afterEach, describe, expect, it } from "bun:test"
import {
  createPendingEventPickupFulfillment,
  groupCartPurchases,
  type CartItemInput,
  type CartPickupFulfillment,
} from "../apps/market/src/lib/cart-model"
import {
  addCartRepositoryItem,
  clearCartRepository,
  getCartRepositorySnapshot,
  incrementCartRepositoryItem,
  upgradePendingEventPickupCartRepositoryItem,
} from "../apps/market/src/lib/cart-repository"

const ORGANIZER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const PRODUCT = `30402:${MERCHANT}:product-a`
const COLLECTION = `30405:${ORGANIZER}:market-a`

function exactPickupFulfillment(): CartPickupFulfillment {
  return {
    type: "pickup",
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: PRODUCT,
      eventId: "1".repeat(64),
      createdAt: 100,
      merchantPubkey: MERCHANT,
    },
    calendar: {
      coordinate: `31922:${ORGANIZER}:event-a`,
      eventId: "2".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: COLLECTION,
      eventId: "3".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: `30406:${ORGANIZER}:pickup-a`,
      eventId: "4".repeat(64),
      createdAt: 103,
      title: "Main entrance",
      location: "Fixture Hall",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: ORGANIZER,
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
  }
}

function cartInput(fulfillment: CartItemInput["fulfillment"]): CartItemInput {
  return {
    productId: PRODUCT,
    merchantPubkey: MERCHANT,
    title: "Event notebook",
    price: 1_000,
    currency: "SATS",
    format: "physical",
    fulfillment,
    productUpdatedAt: 100,
    productEventId: "1".repeat(64),
    stock: 10,
  }
}

describe("pending event pickup cart repository", () => {
  afterEach(async () => {
    await clearCartRepository()
  })

  it("upgrades one pending line without losing quantities added meanwhile", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!
    await addCartRepositoryItem(cartInput(pending))
    const pendingLine = getCartRepositorySnapshot().items[0]!
    await incrementCartRepositoryItem(pendingLine)

    const result = await upgradePendingEventPickupCartRepositoryItem(
      pendingLine,
      cartInput(exactPickupFulfillment())
    )
    const upgraded = result.after[0]!

    expect(result.changed).toBe(true)
    expect(upgraded.cartLineId).toBe(pendingLine.cartLineId)
    expect(upgraded.quantity).toBe(2)
    expect(upgraded.fulfillment?.type).toBe("pickup")
    expect(upgraded).toMatchObject({
      shippingCostSats: 0,
      sourceShippingCost: {
        amount: 0,
        currency: "SAT",
        normalizedCurrency: "SAT",
      },
      shippingOptionId: `30406:${ORGANIZER}:pickup-a`,
      shippingOptionDTag: "pickup-a",
      canonicalShippingResolved: false,
    })
    expect(groupCartPurchases(result.after)).toHaveLength(1)
    expect(groupCartPurchases(result.after)[0]?.kind).toBe("pickup")
  })

  it("refuses pending event pickup for digital products", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!

    const result = await addCartRepositoryItem({
      ...cartInput(pending),
      format: "digital",
    })

    expect(result.changed).toBe(false)
    expect(result.after).toEqual([])
  })

  it("merges a concurrently added exact line during the pending upgrade", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!
    const exact = cartInput(exactPickupFulfillment())
    await addCartRepositoryItem(cartInput(pending), 2)
    const pendingLine = getCartRepositorySnapshot().items[0]!
    await addCartRepositoryItem(exact, 1)

    const result = await upgradePendingEventPickupCartRepositoryItem(
      pendingLine,
      exact
    )

    expect(result.changed).toBe(true)
    expect(result.after).toHaveLength(1)
    expect(result.after[0]?.quantity).toBe(3)
    expect(result.after[0]?.fulfillment?.type).toBe("pickup")
  })

  it("keeps the intent pending when product and fulfillment revisions disagree", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!
    await addCartRepositoryItem(cartInput(pending))
    const pendingLine = getCartRepositorySnapshot().items[0]!
    const mismatched = {
      ...cartInput(exactPickupFulfillment()),
      productEventId: "9".repeat(64),
    }

    const result = await upgradePendingEventPickupCartRepositoryItem(
      pendingLine,
      mismatched
    )

    expect(result.changed).toBe(false)
    expect(result.after[0]?.fulfillment).toEqual(pending)
    expect(groupCartPurchases(result.after)).toEqual([])
  })

  it("keeps the intent pending when exact evidence belongs to another collection", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!
    await addCartRepositoryItem(cartInput(pending))
    const pendingLine = getCartRepositorySnapshot().items[0]!
    const fulfillment = exactPickupFulfillment()
    fulfillment.collection.coordinate = `30405:${ORGANIZER}:market-b`

    const result = await upgradePendingEventPickupCartRepositoryItem(
      pendingLine,
      cartInput(fulfillment)
    )

    expect(result.changed).toBe(false)
    expect(result.after[0]?.fulfillment).toEqual(pending)
  })

  it("keeps concurrent quantities pending when the exact snapshot cannot cover them", async () => {
    await clearCartRepository()
    const pending = createPendingEventPickupFulfillment(COLLECTION)!
    const pendingInput = { ...cartInput(pending), stock: 2 }
    const exactInput = {
      ...cartInput(exactPickupFulfillment()),
      stock: 2,
    }
    await addCartRepositoryItem(pendingInput, 2)
    const pendingLine = getCartRepositorySnapshot().items[0]!
    await addCartRepositoryItem(exactInput)

    const result = await upgradePendingEventPickupCartRepositoryItem(
      pendingLine,
      exactInput
    )

    expect(result.changed).toBe(false)
    expect(result.after).toHaveLength(2)
    expect(result.after.reduce((sum, item) => sum + item.quantity, 0)).toBe(3)
    expect(groupCartPurchases(result.after)[0]?.totalItems).toBe(1)
  })
})
