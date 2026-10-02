import { afterEach, beforeEach, expect, it } from "bun:test"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductListingEventDraft,
  commitLocalProductWrite,
  db,
  getProductListingDelivery,
  prepareProductListingDeliveryJob,
} from "@conduit/core"
import { deliverQueuedProductListings } from "../apps/merchant/src/lib/product-listing-delivery"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const createdAt = 1_800_000_000
const relayUrl = "wss://relay.conduit.market"
const address = (dTag: string) => `30402:${merchant}:${dTag}`
const deliveryOptions = {
  authenticatedPubkey: merchant,
  accountNetworkLocalStateRepository: { get: async () => undefined },
}

function product(dTag: string, timestamp: number) {
  const draft = buildProductListingEventDraft({
    product: {
      id: address(dTag),
      pubkey: merchant,
      title: "Offline listing",
      price: 10,
      currency: "SATS",
      type: "simple",
      specifications: [],
      format: "digital",
      visibility: "public",
      images: [],
      tags: [],
      createdAt: timestamp * 1000,
      updatedAt: timestamp * 1000,
    },
    dTag,
    clientAppId: "merchant",
  })
  return finalizeEvent({ ...draft, created_at: timestamp }, secret)
}

function job(events: ReturnType<typeof product>[]) {
  return prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: events,
    relayTargets: [{ relayUrl, ownerSelected: false, personalRelay: true }],
    readyForDelivery: false,
  })
}

let restore: (() => void) | undefined
beforeEach(() => {
  const dependencies = (
    db as unknown as {
      _deps: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }
    }
  )._deps
  const priorIndexedDB = dependencies.indexedDB
  const priorKeyRange = dependencies.IDBKeyRange
  const priorNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  const locks = new Map<string, Promise<unknown>>()
  db.close({ disableAutoOpen: false })
  dependencies.indexedDB = new FakeIDBFactory()
  dependencies.IDBKeyRange = IDBKeyRange
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: <T>(
          name: string,
          operation: (lock: { name: string }) => Promise<T>
        ) => {
          const next = (locks.get(name) ?? Promise.resolve()).then(() =>
            operation({ name })
          )
          locks.set(
            name,
            next.catch(() => undefined)
          )
          return next
        },
      },
    },
  })
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  restore = () => {
    db.close({ disableAutoOpen: false })
    dependencies.indexedDB = priorIndexedDB
    dependencies.IDBKeyRange = priorKeyRange
    if (priorNavigator)
      Object.defineProperty(globalThis, "navigator", priorNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})
afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  restore?.()
})

for (const pruneChangedCache of [true, false]) {
  it(
    pruneChangedCache
      ? "records a late ACK without recreating a superseded product after cache pruning"
      : "preserves the successor and unchanged sibling while retaining late ACK provenance",
    async () => {
      const first = product("changed", createdAt)
      const sibling = product("sibling", createdAt)
      const original = job([first, sibling])
      await commitLocalProductWrite({
        intentId: "original-family",
        merchantPubkey: merchant,
        expectedRevisions: [
          { addressId: address("changed"), eventId: null },
          { addressId: address("sibling"), eventId: null },
        ],
        listingJob: original,
      })
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const published: string[] = []
      __setRelayPublishTestOverrides({
        accountNetworkLocalStateRepository:
          deliveryOptions.accountNetworkLocalStateRepository,
        publishSignedEventFrameToRelay: async ({ signedEvent }) => {
          published.push(signedEvent.id)
          if (published.length === 2) enter()
          await held
          return "acked"
        },
      })
      const delivery = deliverQueuedProductListings(
        original.id,
        deliveryOptions
      )
      await entered
      const successor = product("changed", createdAt + 1)
      const successorProjection = await (async () => {
        try {
          await commitLocalProductWrite({
            intentId: "newer-edit",
            merchantPubkey: merchant,
            expectedRevisions: [
              { addressId: address("changed"), eventId: first.id },
            ],
            additionalExpectedRevisions: [
              { addressId: address("sibling"), eventId: sibling.id },
            ],
            listingJob: job([successor]),
            reconcileListingJobIds: [original.id],
          })
          const projection = await db.products.get(address("changed"))
          if (pruneChangedCache) await db.products.delete(address("changed"))
          return projection
        } finally {
          release()
          await delivery
        }
      })()
      const history = await getProductListingDelivery(original.id)
      expect(history?.signedEvents).toEqual(original.signedEvents)
      expect(history?.relayTargets).toEqual(original.relayTargets)
      expect(history?.relayDelivery.map((pair) => pair.status)).toEqual([
        "acked",
        "acked",
      ])
      expect(history?.localReplaySupersededBy).toEqual({
        [first.id]: "newer-edit",
      })
      const current = await db.products.get(address("changed"))
      if (pruneChangedCache) {
        expect(current).toBeUndefined()
      } else {
        expect(current).toEqual({
          ...successorProjection,
          sourceRelayUrls: [relayUrl],
        })
        expect(current?.eventId).toBe(successor.id)
      }
      expect((await db.products.get(address("sibling")))?.eventId).toBe(
        sibling.id
      )
      expect(
        (await db.products.get(address("sibling")))?.sourceRelayUrls
      ).toEqual([relayUrl])
      await deliverQueuedProductListings(original.id, deliveryOptions)
      expect(published.sort()).toEqual([first.id, sibling.id].sort())
      expect((await db.products.get(address("changed")))?.eventId).toBe(
        pruneChangedCache ? undefined : successor.id
      )
    }
  )
}
