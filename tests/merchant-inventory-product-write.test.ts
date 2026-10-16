import { config } from "../packages/core/src/config"
import { publishMerchantInventoryProduct } from "../apps/merchant/src/lib/merchant-occurrence-publication"
import { deliverQueuedProductListings } from "../apps/merchant/src/lib/product-listing-delivery"
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { db } from "../packages/core/src/db"
import { admitPublicEvent } from "../packages/core/src/protocol/verified-public-event"
import { projectSignedProductListingForLocalCommit } from "../packages/core/src/protocol/commerce"
import { commitLocalProductWrite } from "../packages/core/src/protocol/local-product-write"
import { prepareProductListingDeliveryJob } from "../packages/core/src/protocol/product-listing-delivery"
import {
  commitMerchantInventoryStockEdit,
  acceptMerchantInventoryOrder,
  resumeMerchantInventoryPublication,
  initializeMerchantInventoryProduct,
  commitMerchantInventoryAssignment,
  readMerchantInventoryAvailability,
} from "../packages/core/src/protocol/merchant-inventory"
import { computeEventMarketAssignmentDTag } from "../packages/core/src/protocol/event-market-assignment"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const organizer = getPublicKey(generateSecretKey())
const coordinate = `30402:${merchant}:shared-writer`
let restore: () => void
beforeEach(async () => {
  const deps = (
    db as unknown as {
      _deps: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }
    }
  )._deps
  const previous = { ...deps }
  const priorNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async <T>(
          name: string,
          task: (lock: { name: string }) => Promise<T>
        ) => task({ name }),
      },
    },
  })
  db.close({ disableAutoOpen: false })
  Object.assign(deps, { indexedDB: new IDBFactory(), IDBKeyRange })
  restore = () => {
    db.close({ disableAutoOpen: false })
    Object.assign(deps, previous)
    if (priorNavigator)
      Object.defineProperty(globalThis, "navigator", priorNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
  await db.open()
})
afterEach(() => restore())
function listing(stock: number, created_at: number) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at,
      content: "",
      tags: [
        ["d", "shared-writer"],
        ["title", "Product"],
        ["type", "simple", "physical"],
        ["price", "1", "SAT"],
        ["stock", String(stock)],
      ],
    },
    secret
  )
}
async function setup() {
  const source = listing(20, 100)
  const admission = await admitPublicEvent(source)
  if (admission.status !== "verified") throw new Error("Invalid fixture")
  await db.products.put(
    projectSignedProductListingForLocalCommit(admission.event)
  )
  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey: merchant,
    productCoordinate: coordinate,
    stock: 20,
    signedProductEvent: source,
  })
  const marketCoordinate = `30409:${organizer}:market`
  const occurrenceCoordinate = `31923:${organizer}:day`
  const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate: coordinate })}`
  await commitMerchantInventoryAssignment({
    db,
    productCoordinate: coordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: "allocate",
    context: {
      kind: "validated-event-market-assignment",
      productEventId: source.id,
      marketEventId: "a".repeat(64),
      occurrenceEventId: "b".repeat(64),
      grantEventId: "c".repeat(64),
      occurrenceEndMs: Date.now() + 3600000,
      terminal: false,
    },
  })
  return { source, assignmentCoordinate }
}
function write(event: ReturnType<typeof listing>) {
  const listingJob = prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: [event],
    relayTargets: [
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelected: false,
        personalRelay: true,
      },
    ],
    readyForDelivery: false,
  })
  return {
    intentId: `write:${event.id}`,
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: coordinate, eventId: listing(20, 100).id },
    ],
    listingJob,
  }
}
it("commits ordinary edits and allocated inventory in the existing product-write transaction", async () => {
  await setup()
  const event = listing(18, 101)
  await commitLocalProductWrite(write(event))
  const current = await readMerchantInventoryAvailability(db, coordinate)
  expect(current.product.stock).toBe(18)
  expect(current.ordinaryAvailable).toBe(12)
  expect(current.product.signedProductEvent.id === event.id).toBe(true)
  expect(current.product.publicationJobs).toHaveLength(0)
  expect((await db.products.get(coordinate))?.eventId === event.id).toBe(true)
})
it("rejects edits below live allocations without advancing product or outbox", async () => {
  await setup()
  await expect(
    commitLocalProductWrite(write(listing(5, 101)))
  ).rejects.toThrow()
  expect((await db.merchantInventoryProducts.get(coordinate))?.stock).toBe(20)
  expect(await db.localProductWriteIntents.count()).toBe(0)
  expect(await db.productListingOutbox.count()).toBe(0)
  expect(
    (await db.products.get(coordinate))?.eventId === listing(20, 100).id
  ).toBe(true)
})
it("rolls inventory back when the shared product-write persistence fails", async () => {
  await setup()
  const failure = spyOn(
    db.localProductWriteIntents,
    "add"
  ).mockRejectedValueOnce(new Error("Synthetic storage failure"))
  try {
    await expect(
      commitLocalProductWrite(write(listing(18, 101)))
    ).rejects.toThrow()
  } finally {
    failure.mockRestore()
  }
  expect((await db.merchantInventoryProducts.get(coordinate))?.stock).toBe(20)
  expect(await db.productListingOutbox.count()).toBe(0)
  expect(
    (await db.products.get(coordinate))?.eventId === listing(20, 100).id
  ).toBe(true)
})

it("resumes retained acceptance bytes through the shared product outbox without signing or debiting twice", async () => {
  const { source, assignmentCoordinate } = await setup()
  const session = {
    merchantPubkey: merchant,
    authenticatedPubkey: merchant,
    shouldContinue: () => true,
  }
  const pickup = (orderId: string, quantity: number) => ({
    db,
    orderId,
    merchantPubkey: merchant,
    identityBinding: orderId,
    termsBinding: orderId,
    evidence: orderId,
    items: [
      {
        productCoordinate: coordinate,
        assignmentCoordinate,
        method: "pickup" as const,
        quantity,
        admission: {
          kind: "validated-event-market-order" as const,
          productEventId: source.id,
          assignmentCoordinate,
          marketEventId: "a".repeat(64),
          occurrenceEventId: "b".repeat(64),
          grantEventId: "c".repeat(64),
        },
      },
    ],
  })
  const original = pickup("first", 2)
  await acceptMerchantInventoryOrder(original)
  let signs = 0
  const attempted: string[] = []
  const deps = {
    plan: async () => [
      {
        relayUrl: config.appBackplaneRelayUrls[0]!,
        ownerSelected: false,
        appRelay: true,
      },
    ],
    deliver: (
      id: string,
      options: Parameters<typeof deliverQueuedProductListings>[1]
    ) =>
      deliverQueuedProductListings(id, {
        ...options,
        retryDelayMs: 0,
        publisher: async ({ signedEvent }) => {
          attempted.push(signedEvent.id)
          return { status: "timed_out" as const }
        },
      }),
  }
  const resume = () =>
    resumeMerchantInventoryPublication({
      db,
      merchantPubkey: merchant,
      sign: async (draft) => {
        signs++
        return finalizeEvent(
          { ...draft, tags: draft.tags.map((tag) => [...tag]) },
          secret
        )
      },
      publish: async (event) =>
        event.kind === 30402
          ? publishMerchantInventoryProduct(session, event, deps)
          : false,
    })
  await resume()
  const firstSigns = signs
  const saved = await db.merchantInventoryProducts.get(coordinate)
  const signedId = saved!.publicationJobs[0]!.signedEvent!.id
  await publishMerchantInventoryProduct(
    session,
    saved!.publicationJobs[0]!.signedEvent!,
    deps
  )
  expect((await db.products.get(coordinate))?.eventId === signedId).toBe(true)
  expect(await db.productListingOutbox.count()).toBe(1)
  await resume()
  expect(signs).toBe(firstSigns)
  expect(attempted.length).toBeGreaterThan(0)
  expect(attempted.every((id) => id === signedId)).toBe(true)
  expect((await acceptMerchantInventoryOrder(original)).replayed).toBe(true)
  await acceptMerchantInventoryOrder(pickup("second", 1))
  expect(
    (await readMerchantInventoryAvailability(db, coordinate)).product.stock
  ).toBe(17)
  expect(
    (await readMerchantInventoryAvailability(db, coordinate)).ordinaryAvailable
  ).toBe(14)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(2)
  await resume()
  expect(await db.productListingOutbox.count()).toBe(2)
  expect((await db.merchantInventoryProducts.get(coordinate))?.stock).toBe(17)
})

it("uses an ordinary edit's current signed metadata for the next stock projection", async () => {
  const { source, assignmentCoordinate } = await setup()
  const edited = finalizeEvent(
    {
      ...listing(18, 101),
      tags: listing(18, 101).tags.map((tag) =>
        tag[0] === "title" ? ["title", "Edited title"] : tag
      ),
    },
    secret
  )
  await commitLocalProductWrite(write(edited))
  await acceptMerchantInventoryOrder({
    db,
    orderId: "after-edit",
    merchantPubkey: merchant,
    identityBinding: "same",
    termsBinding: "same",
    evidence: "same",
    items: [
      {
        productCoordinate: coordinate,
        assignmentCoordinate,
        method: "pickup",
        quantity: 1,
        admission: {
          kind: "validated-event-market-order",
          productEventId: source.id,
          assignmentCoordinate,
          marketEventId: "a".repeat(64),
          occurrenceEventId: "b".repeat(64),
          grantEventId: "c".repeat(64),
        },
      },
    ],
  })
  const publications: Array<ReturnType<typeof listing>> = []
  await resumeMerchantInventoryPublication({
    db,
    merchantPubkey: merchant,
    sign: async (draft) =>
      finalizeEvent(
        { ...draft, tags: draft.tags.map((tag) => [...tag]) },
        secret
      ),
    publish: async (event) => {
      if (event.kind === 30402)
        publications.push(event as ReturnType<typeof listing>)
      return false
    },
  })
  expect(publications.length).toBe(1)
  expect(
    publications[0]!.tags.some(
      (tag) => tag[0] === "title" && tag[1] === "Edited title"
    )
  ).toBe(true)
  expect(
    publications[0]!.tags.some((tag) => tag[0] === "stock" && tag[1] === "17")
  ).toBe(true)
})

it("adopts an installed-preview projection once and retains superseded bytes after a newer ordinary edit", async () => {
  await setup()
  await commitMerchantInventoryStockEdit({
    db,
    productCoordinate: coordinate,
    expectedRevision: 0,
    stock: 18,
    mutationId: "preview-stock",
  })
  await resumeMerchantInventoryPublication({
    db,
    merchantPubkey: merchant,
    sign: async (draft) =>
      finalizeEvent(
        { ...draft, tags: draft.tags.map((tag) => [...tag]) },
        secret
      ),
    publish: async () => false,
  })
  const retained = (await db.merchantInventoryProducts.get(coordinate))!
  const event = retained.publicationJobs[0]!.signedEvent!
  const admitted = await admitPublicEvent(event)
  if (admitted.status !== "verified") throw new Error("Invalid fixture")
  // The installed v25 writer cached its projection without the current intent/outbox.
  await db.products.put(
    projectSignedProductListingForLocalCommit(admitted.event)
  )
  const session = {
    merchantPubkey: merchant,
    authenticatedPubkey: merchant,
    shouldContinue: () => true,
  }
  const dependencies = {
    plan: async () => [
      {
        relayUrl: config.appBackplaneRelayUrls[0]!,
        ownerSelected: false,
        appRelay: true,
      },
    ],
    deliver: (
      id: string,
      options: Parameters<typeof deliverQueuedProductListings>[1]
    ) =>
      deliverQueuedProductListings(id, {
        ...options,
        retryDelayMs: 0,
        publisher: async () => ({ status: "timed_out" as const }),
      }),
  }
  expect(
    await publishMerchantInventoryProduct(session, event, dependencies)
  ).toBe(false)
  expect(await db.localProductWriteIntents.count()).toBe(1)
  expect((await db.merchantInventoryProducts.get(coordinate))?.stock).toBe(18)
  const queued = (await db.productListingOutbox.toArray())[0]!
  const newer = listing(19, event.created_at + 1)
  await commitLocalProductWrite({
    ...write(newer),
    expectedRevisions: [{ addressId: coordinate, eventId: event.id }],
    reconcileListingJobIds: [queued.id],
  })
  expect(
    await publishMerchantInventoryProduct(session, event, dependencies)
  ).toBe("superseded")
  expect((await db.products.get(coordinate))?.eventId === newer.id).toBe(true)
  expect((await db.merchantInventoryProducts.get(coordinate))?.stock).toBe(19)
  expect(
    (await db.merchantInventoryProducts.get(coordinate))?.publicationJobs[0]
      ?.signedEvent?.id === event.id
  ).toBe(true)
})
