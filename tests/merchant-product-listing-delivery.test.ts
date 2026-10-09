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
  config,
  createInMemoryAccountNetworkLocalStateRepository,
  applyAccountNetworkRelayExclusion,
  db,
  getProductListingDelivery,
  prepareProductListingDeliveryJob,
} from "@conduit/core"
import { createInMemoryOwnerRelayListEvidenceRepository } from "../packages/core/src/protocol/owner-relay-list-evidence"
import { admitFixture } from "./helpers/public-event"
import { deliverQueuedProductListings } from "../apps/merchant/src/lib/product-listing-delivery"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const createdAt = 1_800_000_000
const relayUrl = "wss://relay.conduit.market"
const originalCommerceRelayUrls = [...config.commerceRelayUrls]
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

function job(
  events: ReturnType<typeof product>[],
  target = { relayUrl, ownerSelected: false, personalRelay: true }
) {
  return prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: events,
    relayTargets: [target],
    readyForDelivery: false,
  })
}

let restore: (() => void) | undefined
beforeEach(() => {
  config.commerceRelayUrls = [
    ...new Set([...originalCommerceRelayUrls, relayUrl]),
  ]
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
  config.commerceRelayUrls = [...originalCommerceRelayUrls]
  __resetCommerceTestOverrides()
  __resetRelayPublishTestOverrides()
  restore?.()
})

async function retainOwnerWriteSelection(
  evidence: ReturnType<typeof createInMemoryOwnerRelayListEvidenceRepository>,
  urls: string[],
  timestamp = createdAt
) {
  const signedEvent = await admitFixture(
    finalizeEvent(
      {
        kind: 10002,
        created_at: timestamp,
        tags: urls.map((url) => ["r", url, "write"]),
        content: "",
      },
      secret
    )
  )
  await evidence.reconcile({
    pubkey: merchant,
    observations: [{ signedEvent }],
    lookup: {
      observedAt: timestamp * 1000,
      coverage: "complete",
      hadEvent: true,
      eventId: signedEvent.id,
    },
  })
}

it("rechecks the exact secure owner target against current signed write evidence", async () => {
  const ownerUrl = "wss://owner-listing.example"
  const evidence = createInMemoryOwnerRelayListEvidenceRepository()
  await retainOwnerWriteSelection(evidence, [ownerUrl])
  const signedEvent = product("owner-current", createdAt)
  const original = job([signedEvent], {
    relayUrl: ownerUrl,
    ownerSelected: false,
    personalRelay: true,
  })
  await commitLocalProductWrite({
    intentId: "owner-current",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("owner-current"), eventId: null }],
    listingJob: original,
  })
  const published: unknown[] = []
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async ({ signedEvent: wire }) => {
      published.push(JSON.parse(JSON.stringify(wire)))
      return "timed_out"
    },
  })
  const options = {
    ...deliveryOptions,
    ownerRelayListEvidenceRepository: evidence,
  }
  await deliverQueuedProductListings(original.id, options)
  expect(published).toEqual([JSON.parse(JSON.stringify(signedEvent))])
  await retainOwnerWriteSelection(evidence, [], createdAt + 1)
  await deliverQueuedProductListings(original.id, options)
  expect(published).toHaveLength(1)
  const retained = await getProductListingDelivery(original.id)
  expect(retained?.signedEvents).toEqual(original.signedEvents)
  expect(retained?.relayTargets).toEqual(original.relayTargets)
  expect(retained?.relayDelivery[0]?.attemptCount).toBe(1)
  expect(retained?.relayDelivery[0]?.status).toBe("timed_out")
})

it("does not turn an unproved historical independent URL into publication authority", async () => {
  const signedEvent = product("unproved-authority", createdAt)
  const original = prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: [signedEvent],
    relayTargets: [
      {
        relayUrl: "wss://unproved-listing.example",
        ownerSelected: false,
        independentRelay: true,
      },
    ],
    readyForDelivery: false,
  })
  await commitLocalProductWrite({
    intentId: "unproved-authority",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("unproved-authority"), eventId: null },
    ],
    listingJob: original,
  })
  let writes = 0
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async () => {
      writes++
      return "acked"
    },
  })
  await deliverQueuedProductListings(original.id, deliveryOptions)
  expect(writes).toBe(0)
  const retained = await getProductListingDelivery(original.id)
  expect(retained?.signedEvents).toEqual(original.signedEvents)
  expect(retained?.relayTargets).toEqual(original.relayTargets)
  expect(retained?.relayDelivery[0]?.attemptCount).toBe(0)
})

it("rechecks whole-relay exclusion at final I/O and retains the exact retry after re-add", async () => {
  const signedEvent = product("last-mile-exclusion", createdAt)
  const original = job([signedEvent])
  await commitLocalProductWrite({
    intentId: "last-mile-exclusion",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("last-mile-exclusion"), eventId: null },
    ],
    listingJob: original,
  })
  const state = createInMemoryAccountNetworkLocalStateRepository()
  let reads = 0
  const repository = {
    async get(pubkey: string) {
      if (++reads === 2) {
        await state.update(pubkey, (current) =>
          applyAccountNetworkRelayExclusion(current, {
            relayUrl,
            committedAt: createdAt * 1000,
          })
        )
      }
      return state.get(pubkey)
    },
  }
  const published: unknown[] = []
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async ({ signedEvent: wire }) => {
      published.push(JSON.parse(JSON.stringify(wire)))
      return "acked"
    },
  })
  await deliverQueuedProductListings(original.id, {
    ...deliveryOptions,
    accountNetworkLocalStateRepository: repository,
  })
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(published).toEqual([])
  expect((await getProductListingDelivery(original.id))?.relayTargets).toEqual(
    original.relayTargets
  )
  await deliverQueuedProductListings(original.id, deliveryOptions)
  expect(published).toEqual([JSON.parse(JSON.stringify(signedEvent))])
  const retained = await getProductListingDelivery(original.id)
  expect(retained?.signedEvents).toEqual(original.signedEvents)
  expect(retained?.relayTargets).toEqual(original.relayTargets)
  expect(retained?.relayDelivery[0]?.status).toBe("acked")
})

it("revokes secure owner-only publication across final signed-evidence awaits", async () => {
  const ownerUrl = "wss://revocable-owner-listing.example"
  const evidence = createInMemoryOwnerRelayListEvidenceRepository()
  await retainOwnerWriteSelection(evidence, [ownerUrl])
  const signedEvent = product("owner-revoked", createdAt)
  const original = job([signedEvent], {
    relayUrl: ownerUrl,
    ownerSelected: false,
    personalRelay: true,
  })
  await commitLocalProductWrite({
    intentId: "owner-revoked",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("owner-revoked"), eventId: null }],
    listingJob: original,
  })
  let current = true
  let reads = 0
  let writes = 0
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async () => {
      writes++
      return "acked"
    },
  })
  await deliverQueuedProductListings(original.id, {
    ...deliveryOptions,
    isAuthenticatedPubkeyCurrent: () => current,
    ownerRelayListEvidenceRepository: {
      async get(pubkey) {
        const retained = await evidence.get(pubkey)
        if (++reads === 2) current = false
        return retained
      },
    },
  })
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(writes).toBe(0)
  const retained = await getProductListingDelivery(original.id)
  expect(retained?.signedEvents).toEqual(original.signedEvents)
  expect(retained?.relayTargets).toEqual(original.relayTargets)
  expect(retained?.relayDelivery[0]?.status).not.toBe("acked")
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
