import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { db } from "../packages/core/src/db"
import { orderSchema } from "../packages/core/src/schemas"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import {
  initializeMerchantInventoryProduct,
  commitMerchantInventoryAssignment,
} from "../packages/core/src/protocol/merchant-inventory"
import { acceptMerchantOccurrenceOrder } from "../packages/core/src/protocol/merchant-occurrence-workflow"
import { retainSignedEventMarketEvidence } from "../packages/core/src/protocol/event-market-roster-read"
import { confirmMerchantPayment } from "../apps/merchant/src/lib/order-payment-release"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { admitFixtureEvent } from "./helpers/admit-event"

let restore: () => void
beforeEach(async () => {
  const deps = (db as unknown as { _deps: Record<string, unknown> })._deps
  const previous = { ...deps }
  db.close({ disableAutoOpen: false })
  Object.assign(deps, { indexedDB: new IDBFactory(), IDBKeyRange })
  restore = () => {
    db.close({ disableAutoOpen: false })
    Object.assign(deps, previous)
  }
  await db.open()
})
afterEach(() => restore())

async function setup() {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const signed = await admitFixtureEvent(f.fulfillment.product.signedEvent)
  const product = parseProductEvent(signed)
  const assignmentCoordinate = f.fulfillment.occurrenceAssignment!.coordinate
  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey: f.merchant,
    productCoordinate: product.id,
    stock: 6,
    signedProductEvent: signed,
  })
  await commitMerchantInventoryAssignment({
    db,
    productCoordinate: product.id,
    assignmentCoordinate,
    marketCoordinate: f.fulfillment.market.coordinate,
    occurrenceCoordinate: f.fulfillment.calendar.coordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: "initial-allocation",
    context: {
      kind: "validated-event-market-assignment",
      productEventId: signed.id,
      marketEventId: f.fulfillment.market.eventId,
      occurrenceEventId: f.fulfillment.calendar.eventId,
      grantEventId: f.fulfillment.grant.eventId,
      occurrenceEndMs: f.fulfillment.calendar.end,
      terminal: false,
    },
  })
  for (const event of f.events.filter((event) =>
    [30409, 31923, 3841].includes(event.kind)
  ))
    await retainSignedEventMarketEvidence(
      f.fulfillment.market.coordinate,
      event
    )
  const session = {
    merchantPubkey: f.merchant,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
  }
  let publications = 0
  const confirm = async (order = f.order, failPublication = false) => {
    await acceptMerchantOccurrenceOrder({
      ...session,
      order,
      products: [product],
      purpose: "payment-confirmation",
    })
    return confirmMerchantPayment(
      {
        ...session,
        buyerPubkey: order.buyerPubkey,
        orderId: order.id,
        order,
        delivery: "buyer_and_self",
      },
      {
        publishPaid: async () => {
          if (failPublication) throw new Error("delivery interrupted")
          publications++
        },
      }
    )
  }
  return {
    ...f,
    product,
    session,
    assignmentCoordinate,
    confirm,
    publications: () => publications,
  }
}

for (const rescheduled of [false, true]) {
  it(`first payment confirmation after ${rescheduled ? "revised" : "original"} end preserves terms and consumes stock once across retry/reopen`, async () => {
    const f = await setup()
    let end = f.fulfillment.calendar.end
    if (rescheduled) {
      const revised = createEventMarketOrderFixture({
        mode: "merchant_present",
        newAssignment: true,
        calendarEnd: 1_900_001_000,
        calendarCreatedAt: 103,
      })
      await retainSignedEventMarketEvidence(
        f.fulfillment.market.coordinate,
        revised.fulfillment.calendar.signedEvent
      )
      end = revised.fulfillment.calendar.end
    }
    const time = spyOn(Date, "now").mockReturnValue(end + 1)
    try {
      await expect(
        acceptMerchantOccurrenceOrder({
          ...f.session,
          order: f.order,
          products: [f.product],
        })
      ).rejects.toThrow("no longer permits new acceptance")
      await expect(f.confirm(f.order, true)).rejects.toThrow(
        "delivery interrupted"
      )
      expect(f.publications()).toBe(0)
      const saved = await db.merchantInventoryAcceptedOrders.get(f.order.id)
      expect(saved!.termsBinding).toBe(
        JSON.stringify(orderSchema.parse(f.order))
      )
      expect(
        (await db.merchantInventoryProducts.get(f.product.id))!.stock
      ).toBe(5)
      expect(
        (await db.merchantInventoryAssignments.get(f.assignmentCoordinate))!
          .inventory
      ).toEqual({ mode: "tracked", quantity: 5 })
      db.close({ disableAutoOpen: false })
      await db.open()
      await f.confirm()
      await f.confirm()
      expect(f.publications()).toBe(2)
      expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
      expect(
        (await db.merchantInventoryProducts.get(f.product.id))!.stock
      ).toBe(5)
      expect(
        (await db.merchantInventoryAssignments.get(f.assignmentCoordinate))!
          .inventory
      ).toEqual({ mode: "tracked", quantity: 5 })
      await expect(
        f.confirm({ ...f.order, buyerPubkey: "d".repeat(64) })
      ).rejects.toThrow("conflicting accepted terms")
      await expect(
        f.confirm({
          ...f.order,
          subtotal: 200,
          items: [{ ...f.order.items[0]!, quantity: 2 }],
        })
      ).rejects.toThrow("conflicting accepted terms")
      expect(f.publications()).toBe(2)
    } finally {
      time.mockRestore()
    }
  })
}

it("expired settlement cannot consume stock reserved for another active occurrence", async () => {
  const f = await setup()
  const time = spyOn(Date, "now").mockReturnValue(
    f.fulfillment.calendar.end + 1
  )
  try {
    const assignment = (await db.merchantInventoryAssignments.get(
      f.assignmentCoordinate
    ))!
    await db.merchantInventoryAssignments.add({
      ...assignment,
      coordinate: `${assignment.coordinate}-other`,
      occurrenceCoordinate: `${assignment.occurrenceCoordinate}-other`,
      occurrenceEndMs: Date.now() + 3600000,
    })
    await expect(f.confirm()).rejects.toThrow("Insufficient unallocated stock")
    expect(f.publications()).toBe(0)
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
    expect((await db.merchantInventoryProducts.get(f.product.id))!.stock).toBe(
      6
    )
    expect(
      (await db.merchantInventoryAssignments.get(f.assignmentCoordinate))!
        .inventory
    ).toEqual({ mode: "tracked", quantity: 6 })
  } finally {
    time.mockRestore()
  }
})

it("payment intent does not admit an order created after its signed occurrence end", async () => {
  const f = await setup()
  const time = spyOn(Date, "now").mockReturnValue(
    f.fulfillment.calendar.end + 2
  )
  try {
    await expect(
      f.confirm({ ...f.order, createdAt: f.fulfillment.calendar.end + 1 })
    ).rejects.toThrow("created before")
    expect(f.publications()).toBe(0)
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
  } finally {
    time.mockRestore()
  }
})

it("two concurrent expired confirmations cannot take the same last unallocated unit", async () => {
  const f = await setup()
  const time = spyOn(Date, "now").mockReturnValue(
    f.fulfillment.calendar.end + 1
  )
  try {
    const assignment = (await db.merchantInventoryAssignments.get(
      f.assignmentCoordinate
    ))!
    await db.merchantInventoryAssignments.add({
      ...assignment,
      coordinate: `${assignment.coordinate}-other`,
      occurrenceCoordinate: `${assignment.occurrenceCoordinate}-other`,
      occurrenceEndMs: Date.now() + 3600000,
      inventory: { mode: "tracked", quantity: 5 },
    })
    const results = await Promise.allSettled([
      f.confirm(),
      f.confirm({ ...f.order, id: "second-order" }),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(f.publications()).toBe(1)
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
    expect((await db.merchantInventoryProducts.get(f.product.id))!.stock).toBe(
      5
    )
    expect(
      (await db.merchantInventoryAssignments.get(
        `${f.assignmentCoordinate}-other`
      ))!.inventory
    ).toEqual({ mode: "tracked", quantity: 5 })
  } finally {
    time.mockRestore()
  }
})

it("expiry preserves same-order stock credit without a second debit", async () => {
  const f = await setup()
  const time = spyOn(Date, "now").mockReturnValue(
    f.fulfillment.calendar.end + 1
  )
  try {
    // The same order's earlier stock action already consumed the final unit.
    await db.merchantInventoryProducts.update(f.product.id, { stock: 0 })
    const result = await acceptMerchantOccurrenceOrder({
      ...f.session,
      order: f.order,
      products: [f.product],
      purpose: "payment-confirmation",
      priorStockAdjustments: [
        { productCoordinate: f.product.id, quantity: 1, shortfall: 0 },
      ],
    })
    expect(result.replayed).toBe(false)
    await f.confirm()
    expect((await db.merchantInventoryProducts.get(f.product.id))!.stock).toBe(
      0
    )
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
  } finally {
    time.mockRestore()
  }
})

it("payment intent does not bypass terminal assignment or signed evidence checks", async () => {
  const f = await setup()
  const time = spyOn(Date, "now").mockReturnValue(
    f.fulfillment.calendar.end + 1
  )
  try {
    await db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
      terminal: true,
    })
    await expect(f.confirm()).rejects.toThrow("Assignment is not available")
    const changed = structuredClone(f.order)
    const fulfillment = changed.items[0]!.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing pickup fixture")
    fulfillment.calendar.signedEvent.content = "Changed signed content"
    await expect(f.confirm(changed)).rejects.toThrow(
      "Signed evidence must be valid"
    )
    expect(f.publications()).toBe(0)
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
  } finally {
    time.mockRestore()
  }
})
