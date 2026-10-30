import { afterEach, beforeEach, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent } from "nostr-tools/pure"
import {
  acceptMerchantOccurrenceOrder,
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
  parseProductEvent,
  readMerchantInventoryAvailability,
  readMerchantOccurrenceAcceptedOrder,
  resumeMerchantInventoryPublication,
  retainEventMarketCommerceEvidence,
} from "@conduit/core"
import { db } from "@conduit/core/db"
import { getMerchantEventInventoryPolicy } from "../apps/merchant/src/lib/order-action-view"
import { __resetProtectedReadSigner } from "../packages/core/src/protocol/protected-read-authorization"
import { admitFixtureEvent } from "./helpers/admit-event"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { installMerchantAcceptanceTestSession } from "./helpers/merchant-acceptance-session"

let restoreEnvironment: (() => void) | undefined

beforeEach(async () => {
  const dependencies = (db as unknown as { _deps: Record<string, unknown> })
    ._deps
  const previousDependencies = { ...dependencies }
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          name: string,
          operation: (lock: { name: string }) => Promise<unknown>
        ) => operation({ name }),
      },
    },
  })
  db.close({ disableAutoOpen: false })
  Object.assign(dependencies, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  restoreEnvironment = () => {
    db.close({ disableAutoOpen: false })
    Object.assign(dependencies, previousDependencies)
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
  await db.open()
})

afterEach(() => {
  restoreEnvironment?.()
  restoreEnvironment = undefined
  __resetProtectedReadSigner()
})

it("paid merchant-present Event reconciliation consumes its allocation once and resumes exact publication bytes", async () => {
  const fixture = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const assignmentSnapshot = fixture.fulfillment.occurrenceAssignment!
  const signedProduct = await admitFixtureEvent(
    fixture.fulfillment.product.signedEvent
  )
  const product = parseProductEvent(signedProduct)
  installMerchantAcceptanceTestSession(fixture.merchant)

  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey: fixture.merchant,
    productCoordinate: product.id,
    stock: product.stock,
    signedProductEvent: signedProduct,
  })
  await commitMerchantInventoryAssignment({
    db,
    productCoordinate: product.id,
    assignmentCoordinate: assignmentSnapshot.coordinate,
    marketCoordinate: fixture.fulfillment.market.coordinate,
    occurrenceCoordinate: fixture.fulfillment.calendar.coordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: crypto.randomUUID(),
    nowMs: 102_000,
    context: {
      kind: "validated-event-market-assignment",
      productEventId: fixture.fulfillment.product.eventId,
      assignmentEventId: assignmentSnapshot.eventId,
      marketEventId: fixture.fulfillment.market.eventId,
      occurrenceEventId: fixture.fulfillment.calendar.eventId,
      grantEventId: fixture.fulfillment.grant.eventId,
      occurrenceEndMs: fixture.fulfillment.calendar.end,
      terminal: false,
    },
  })
  await retainEventMarketCommerceEvidence(
    fixture.fulfillment.market.coordinate,
    fixture.events
  )

  const policy = getMerchantEventInventoryPolicy({
    order: fixture.order,
    acceptanceReadReady: true,
    acceptedInventorySaved: false,
    goodsPaymentVerified: true,
  })
  expect(policy.canReconcilePaidMerchantPickup).toBe(true)

  const session = {
    merchantPubkey: fixture.merchant,
    authenticatedPubkey: fixture.merchant,
    shouldContinue: () => true,
  }
  const accepted = await acceptMerchantOccurrenceOrder({
    ...session,
    order: fixture.order,
    products: [product],
    purpose: "payment-confirmation",
  })
  expect(accepted.replayed).toBe(false)

  const saved = await readMerchantOccurrenceAcceptedOrder({
    merchantPubkey: fixture.merchant,
    orderId: fixture.order.id,
    order: fixture.order,
  })
  expect(saved?.items).toEqual([
    {
      productCoordinate: product.id,
      assignmentCoordinate: assignmentSnapshot.coordinate,
      method: "pickup",
      quantity: 1,
      remainingStock: 5,
      remainingAllocation: 5,
    },
  ])
  expect(
    getMerchantEventInventoryPolicy({
      order: fixture.order,
      acceptanceReadReady: true,
      acceptedInventorySaved: true,
      goodsPaymentVerified: true,
    }).canReconcilePaidMerchantPickup
  ).toBe(false)
  const afterAcceptance = await readMerchantInventoryAvailability(
    db,
    product.id
  )
  expect(afterAcceptance.product.stock).toBe(5)
  expect(afterAcceptance.ordinaryAvailable).toBe(0)
  expect(
    afterAcceptance.assignments.find(
      (assignment) => assignment.coordinate === assignmentSnapshot.coordinate
    )?.inventory
  ).toEqual({ mode: "tracked", quantity: 5 })

  const firstAttemptIds: string[] = []
  const held = await resumeMerchantInventoryPublication({
    db,
    merchantPubkey: fixture.merchant,
    sign: async (draft) => finalizeEvent(draft, fixture.merchantSecret),
    publish: async (event) => {
      firstAttemptIds.push(event.id)
      return false
    },
  })
  expect(held.signed).toBeGreaterThan(0)
  expect(held.delivered).toBe(0)
  expect(held.pending).toBe(firstAttemptIds.length)

  const replay = await acceptMerchantOccurrenceOrder({
    ...session,
    order: fixture.order,
    products: [product],
    purpose: "payment-confirmation",
  })
  expect(replay.replayed).toBe(true)
  const afterReplay = await readMerchantInventoryAvailability(db, product.id)
  expect(afterReplay.product.stock).toBe(5)
  expect(
    afterReplay.assignments.find(
      (assignment) => assignment.coordinate === assignmentSnapshot.coordinate
    )?.inventory
  ).toEqual({ mode: "tracked", quantity: 5 })

  const retryIds: string[] = []
  const resumed = await resumeMerchantInventoryPublication({
    db,
    merchantPubkey: fixture.merchant,
    sign: async (draft) => finalizeEvent(draft, fixture.merchantSecret),
    publish: async (event) => {
      retryIds.push(event.id)
      return true
    },
  })
  expect(resumed.signed).toBe(0)
  expect(resumed.delivered).toBe(retryIds.length)
  expect(resumed.pending).toBe(0)
  expect(retryIds.toSorted()).toEqual(firstAttemptIds.toSorted())

  const settled = await resumeMerchantInventoryPublication({
    db,
    merchantPubkey: fixture.merchant,
    sign: async (draft) => finalizeEvent(draft, fixture.merchantSecret),
    publish: async () => {
      throw new Error("Delivered publication work must not run again")
    },
  })
  expect(settled).toEqual({ signed: 0, delivered: 0, pending: 0 })
})
