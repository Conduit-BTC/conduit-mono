import { afterAll, describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

let restoreDatabaseDependencies: (() => void) | undefined
afterAll(() => restoreDatabaseDependencies?.())

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const buyer = getPublicKey(generateSecretKey())

describe("merchant occurrence acceptance composed with signed evidence and durable state", () => {
  it("accepts two pickup orders despite failed publication, survives reopen, and rejects replay drift and known revocation", async () => {
    const [
      { db },
      { orderSchema },
      { buildEventMarketRosterDraft },
      { buildEventMarketAuthorizationDraft },
      { buildEventMarketAssignmentDraft, computeEventMarketAssignmentDTag },
      { buildEventMarketCalendarDraft, parseEventMarketCalendarEvent },
      { parseProductEvent },
      {
        initializeMerchantInventoryProduct,
        commitMerchantInventoryAssignment,
        readMerchantInventoryAvailability,
        resumeMerchantInventoryPublication,
      },
      { retainSignedEventMarketEvidence, retainEventMarketCommerceEvidence },
      { acceptMerchantOccurrenceOrder },
    ] = await Promise.all([
      import("@conduit/core/db"),
      import("@conduit/core/schemas"),
      import("@conduit/core/protocol/event-market-roster"),
      import("@conduit/core/protocol/event-market-authorization"),
      import("@conduit/core/protocol/event-market-assignment"),
      import("@conduit/core/protocol/event-market"),
      import("@conduit/core/protocol/products"),
      import("@conduit/core/protocol/merchant-inventory"),
      import("@conduit/core/protocol/event-market-roster-read"),
      import("@conduit/core/protocol/merchant-occurrence-workflow"),
    ])
    // Another test may have imported the singleton before this file installed fake IndexedDB.
    const dependencies = (
      db as unknown as {
        _deps: Record<string, unknown>
      }
    )._deps
    const previousDependencies = {
      indexedDB: dependencies.indexedDB,
      IDBKeyRange: dependencies.IDBKeyRange,
    }
    restoreDatabaseDependencies = () => {
      db.close()
      Object.assign(dependencies, previousDependencies)
    }
    db.close()
    Object.assign(dependencies, { indexedDB, IDBKeyRange })
    await db.open()
    await Promise.all([
      db.merchantInventoryProducts.clear(),
      db.merchantInventoryAssignments.clear(),
      db.merchantInventoryAcceptedOrders.clear(),
      db.eventMarketRosterEvidence.clear(),
    ])

    const nowSeconds = Math.floor(Date.now() / 1000)
    const marketCoordinate = "30409:" + organizer + ":composed-fair"
    const occurrenceCoordinate = "31923:" + organizer + ":composed-day"
    const productCoordinate = "30402:" + merchant + ":composed-soap"
    const market = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "composed-fair",
          organizerPubkey: organizer,
          calendarCoordinate: occurrenceCoordinate,
          state: "open",
          merchants: [
            {
              pubkey: merchant,
              mode: "merchant_present",
              assignment: "Booth 4",
            },
          ],
        }),
        created_at: nowSeconds - 5,
      },
      organizerSecret
    )
    const calendar = finalizeEvent(
      {
        ...buildEventMarketCalendarDraft({
          kind: 31923,
          dTag: "composed-day",
          title: "Composed market",
          start: nowSeconds + 3_600,
          end: nowSeconds + 7_200,
          locations: ["100 Public Square"],
        }),
        created_at: nowSeconds - 4,
      },
      organizerSecret
    )
    const parsedCalendar = parseEventMarketCalendarEvent(calendar)
    expect(parsedCalendar).not.toBeNull()
    const grant = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          sequence: 0,
          parentIds: [],
        }),
        created_at: nowSeconds - 3,
      },
      organizerSecret
    )
    const productEvent = finalizeEvent(
      {
        kind: 30402,
        tags: [
          ["d", "composed-soap"],
          ["title", "Soap"],
          ["price", "100", "SATS"],
          ["type", "simple", "physical"],
          ["stock", "4"],
        ],
        content: "Soap",
        created_at: nowSeconds - 2,
      },
      merchantSecret
    )
    const product = parseProductEvent(productEvent)
    const assignmentEvent = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          marketCoordinate,
          occurrenceCoordinate,
          productCoordinate,
          merchantPubkey: merchant,
          state: "active",
          inventory: { mode: "tracked", quantity: 2 },
          fulfillmentMethods: ["pickup"],
        }),
        created_at: nowSeconds - 1,
      },
      merchantSecret
    )
    const assignmentCoordinate =
      "30410:" +
      merchant +
      ":" +
      computeEventMarketAssignmentDTag({
        marketCoordinate,
        occurrenceCoordinate,
        productCoordinate,
      })
    const fulfillment = {
      type: "event_market_pickup" as const,
      organizerPubkey: organizer,
      merchantPubkey: merchant,
      payeePubkey: merchant,
      market: {
        coordinate: marketCoordinate,
        eventId: market.id,
        createdAt: market.created_at * 1_000,
        signedEvent: market,
      },
      calendar: {
        coordinate: occurrenceCoordinate,
        eventId: calendar.id,
        createdAt: calendar.created_at * 1_000,
        start: parsedCalendar!.start,
        end: parsedCalendar!.end,
        signedEvent: calendar,
      },
      grant: {
        kind: 3841 as const,
        pubkey: organizer,
        eventId: grant.id,
        createdAt: grant.created_at * 1_000,
        ancestryEventIds: [grant.id],
        observedDeletionEventIds: [],
        signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
      },
      product: {
        coordinate: productCoordinate,
        eventId: productEvent.id,
        createdAt: productEvent.created_at * 1_000,
        signedEvent: productEvent,
      },
      occurrenceAssignment: {
        coordinate: assignmentCoordinate,
        eventId: assignmentEvent.id,
        createdAt: assignmentEvent.created_at * 1_000,
        signedEvent: assignmentEvent,
      },
      mode: "merchant_present" as const,
      assignment: "Booth 4",
    }
    const makeOrder = (id: string) =>
      orderSchema.parse({
        id,
        buyerPubkey: buyer,
        merchantPubkey: merchant,
        items: [
          {
            productId: productCoordinate,
            title: "Soap",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 100,
            currency: "SATS",
            sourcePrice: {
              amount: 100,
              currency: "SATS",
              normalizedCurrency: "SATS",
            },
            shippingCostSats: 0,
            fulfillment,
          },
        ],
        subtotal: 100,
        currency: "SATS",
        shippingCostSats: 0,
        createdAt: Date.now(),
      })
    const makeOrderWithAssignment = (
      id: string,
      signedAssignment: typeof assignmentEvent
    ) => {
      const order = makeOrder(id)
      const pickup = order.items[0]!.fulfillment
      if (pickup?.type !== "event_market_pickup")
        throw new Error("Pickup test fixture missing")
      return orderSchema.parse({
        ...order,
        createdAt: signedAssignment.created_at * 1_000 + 1,
        items: [
          {
            ...order.items[0],
            fulfillment: {
              ...pickup,
              occurrenceAssignment: {
                coordinate: assignmentCoordinate,
                eventId: signedAssignment.id,
                createdAt: signedAssignment.created_at * 1_000,
                signedEvent: signedAssignment,
              },
            },
          },
        ],
      })
    }
    const first = makeOrder("composed-order-1")
    const second = makeOrder("composed-order-2")
    const session = {
      merchantPubkey: merchant,
      authenticatedPubkey: merchant,
      shouldContinue: () => true,
    }
    await initializeMerchantInventoryProduct({
      db,
      productCoordinate,
      merchantPubkey: merchant,
      stock: 4,
      signedProductEvent: productEvent,
    })
    await commitMerchantInventoryAssignment({
      db,
      productCoordinate,
      assignmentCoordinate,
      marketCoordinate,
      occurrenceCoordinate,
      inventory: { mode: "tracked", quantity: 2 },
      state: "active",
      fulfillmentMethods: ["pickup"],
      expectedRevision: null,
      mutationId: "composed-allocation",
      context: {
        kind: "validated-event-market-assignment",
        productEventId: productEvent.id,
        marketEventId: market.id,
        occurrenceEventId: calendar.id,
        grantEventId: grant.id,
        occurrenceEndMs: parsedCalendar!.end,
        terminal: false,
      },
    })
    for (const signed of [market, calendar, grant])
      await retainSignedEventMarketEvidence(marketCoordinate, signed)

    expect(
      (
        await acceptMerchantOccurrenceOrder({
          ...session,
          order: first,
          products: [product],
        })
      ).replayed
    ).toBe(false)
    const incomingBeforeOwnSignature = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          marketCoordinate,
          occurrenceCoordinate,
          productCoordinate,
          merchantPubkey: merchant,
          state: "active",
          inventory: { mode: "tracked", quantity: 2 },
          fulfillmentMethods: ["pickup"],
          previousEventId: assignmentEvent.id,
        }),
        created_at: nowSeconds + 4,
      },
      merchantSecret
    )
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrderWithAssignment(
          "incoming-before-own-signature",
          incomingBeforeOwnSignature
        ),
        products: [product],
      })
    ).rejects.toThrow("newer independent assignment")
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
    const removal = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          marketCoordinate,
          occurrenceCoordinate,
          productCoordinate,
          merchantPubkey: merchant,
          state: "removed",
          inventory: { mode: "tracked", quantity: 0 },
          fulfillmentMethods: [],
          previousEventId: assignmentEvent.id,
        }),
        created_at: nowSeconds + 1,
      },
      merchantSecret
    )
    await retainEventMarketCommerceEvidence(marketCoordinate, [removal])
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrder("known-removal"),
        products: [product],
      })
    ).rejects.toThrow("newer independent assignment")
    expect(
      (
        await acceptMerchantOccurrenceOrder({
          ...session,
          order: first,
          products: [product],
        })
      ).replayed
    ).toBe(true)
    await db.eventMarketRosterEvidence.delete(
      `${marketCoordinate}:${removal.id}`
    )

    const conflicting = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          marketCoordinate,
          occurrenceCoordinate,
          productCoordinate,
          merchantPubkey: merchant,
          state: "active",
          inventory: { mode: "tracked", quantity: 2 },
          fulfillmentMethods: ["pickup"],
        }),
        created_at: nowSeconds + 2,
      },
      merchantSecret
    )
    await retainEventMarketCommerceEvidence(marketCoordinate, [conflicting])
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrder("known-conflict"),
        products: [product],
      })
    ).rejects.toThrow("newer independent assignment")
    await db.eventMarketRosterEvidence.delete(
      `${marketCoordinate}:${conflicting.id}`
    )

    const deletion = finalizeEvent(
      {
        kind: 5,
        tags: [["e", assignmentEvent.id]],
        content: "",
        created_at: nowSeconds + 3,
      },
      merchantSecret
    )
    await retainEventMarketCommerceEvidence(marketCoordinate, [deletion])
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrder("known-deletion"),
        products: [product],
      })
    ).rejects.toThrow("Known assignment deletion")
    await db.eventMarketRosterEvidence.delete(
      `${marketCoordinate}:${deletion.id}`
    )
    const attempted = await resumeMerchantInventoryPublication({
      db,
      merchantPubkey: merchant,
      sign: async (draft) => {
        const { pubkey: _pubkey, ...unsigned } = draft
        return finalizeEvent(unsigned, merchantSecret)
      },
      publish: async () => false,
    })
    expect(attempted.delivered).toBe(0)
    expect(attempted.pending).toBeGreaterThan(0)
    const ownAssignment =
      await db.merchantInventoryAssignments.get(assignmentCoordinate)
    const pendingOwnSigned = ownAssignment?.publicationJobs.find(
      (job) => job.signedEvent?.kind === 30410
    )?.signedEvent
    if (!pendingOwnSigned)
      throw new Error("Own signed assignment update missing")
    await retainEventMarketCommerceEvidence(marketCoordinate, [
      pendingOwnSigned,
    ])
    const incomingIndependent = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          marketCoordinate,
          occurrenceCoordinate,
          productCoordinate,
          merchantPubkey: merchant,
          state: "active",
          inventory: { mode: "tracked", quantity: 2 },
          fulfillmentMethods: ["pickup"],
          previousEventId: pendingOwnSigned.id,
        }),
        created_at: pendingOwnSigned.created_at + 10,
      },
      merchantSecret
    )
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrderWithAssignment(
          "incoming-independent",
          incomingIndependent
        ),
        products: [product],
      })
    ).rejects.toThrow("newer independent assignment")
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
    expect(
      (
        await acceptMerchantOccurrenceOrder({
          ...session,
          order: second,
          products: [product],
        })
      ).replayed
    ).toBe(false)
    expect(
      (await readMerchantInventoryAvailability(db, productCoordinate))
        .ordinaryAvailable
    ).toBe(2)
    expect(
      (await db.merchantInventoryAssignments.get(assignmentCoordinate))
        ?.inventory
    ).toEqual({
      mode: "tracked",
      quantity: 0,
    })

    db.close()
    await db.open()
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(2)
    expect(
      (
        await acceptMerchantOccurrenceOrder({
          ...session,
          order: first,
          products: [product],
        })
      ).replayed
    ).toBe(true)
    const changedTerms = orderSchema.parse({
      ...first,
      items: [{ ...first.items[0]!, quantity: 2 }],
      subtotal: 200,
    })
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: changedTerms,
        products: [product],
      })
    ).rejects.toThrow("conflicting accepted terms")

    const revoke = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "revoked",
          sequence: 1,
          parentIds: [grant.id],
        }),
        created_at: nowSeconds + 1,
      },
      organizerSecret
    )
    await retainSignedEventMarketEvidence(marketCoordinate, revoke)
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: makeOrder("composed-order-3"),
        products: [product],
      })
    ).rejects.toThrow("Known event authority")
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(2)
    db.close()
  }, 20_000)
})
