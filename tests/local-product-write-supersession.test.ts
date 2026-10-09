import { afterEach, beforeEach, expect, it } from "bun:test"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { db } from "../packages/core/src/db"
import { config } from "../packages/core/src/config"
import { buildProductListingEventDraft } from "../packages/core/src/protocol/products"
import {
  commitLocalProductWrite,
  withLocalLegacyProductWriteStage,
  getRequiredProductListingRecoveryRelayUrls,
} from "../packages/core/src/protocol/local-product-write"
import {
  cacheSignedProductListingEvent,
  cacheSignedProductDeletionEvent,
} from "../packages/core/src/protocol/commerce"
import {
  deliverProductListingJob,
  getProductListingDelivery,
  getPendingProductListingDeliveries,
  persistProductListingDelivery,
  prepareProductListingDeliveryJob,
} from "../packages/core/src/protocol/product-listing-delivery"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const createdAt = 1_800_000_000
const originalCommerceRelayUrls = [...config.commerceRelayUrls]
const address = (dTag: string) => `30402:${merchant}:${dTag}`
const target = (name: string) => {
  const relayUrl = `wss://${name}.example`
  // Register the injected route as current App authority without changing its
  // retained personal-layer provenance or bypassing shared admission.
  config.commerceRelayUrls = [
    ...new Set([...config.commerceRelayUrls, relayUrl]),
  ]
  return { relayUrl, ownerSelected: false, personalRelay: true }
}

it("accepts an ordinary edit after exact legacy recovery without ancestral relay coverage", async () => {
  const first = product("recovered", createdAt)
  const old = await persistProductListingDelivery({
    merchantPubkey: merchant,
    signedEvents: [first],
    relayTargets: [target("old")],
  })
  await cacheSignedProductListingEvent(new NDKEvent(undefined, first))
  await deliverProductListingJob(
    old.id,
    async () => ({ status: "rejected" }),
    deliveryOptions
  )
  const recovered = product("recovered", createdAt + 1)
  const recoveredJob = job([recovered], ["new"])
  // Simulate persisted pre-migration lineage and its exact signed selected tip.
  await db.productListingOutbox.update(old.id, {
    replacedByListingJobId: recoveredJob.id,
  })
  await db.productListingOutbox.add({
    ...recoveredJob,
    readyForDelivery: true,
    replacesRejectedListingJobId: old.id,
  })
  await cacheSignedProductListingEvent(new NDKEvent(undefined, recovered))
  await deliverProductListingJob(
    recoveredJob.id,
    async () => ({ status: "acked" }),
    deliveryOptions
  )
  const newer = product("recovered", createdAt + 2)
  await commitLocalProductWrite({
    intentId: "ordinary-after-recovery",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("recovered"), eventId: recovered.id },
    ],
    listingJob: job([newer], ["current"]),
  })
  const retained = await getProductListingDelivery(old.id)
  expect(retained?.localReplaySupersededBy?.[first.id]).toBe(
    "ordinary-after-recovery"
  )
  expect(retained?.relayDelivery[0]?.status).toBe("rejected")
})

it("preserves unfinished sibling delivery when only one coordinate is superseded", async () => {
  const first = product("changed", createdAt)
  const sibling = product("unchanged", createdAt)
  const original = job([first, sibling])
  await commitLocalProductWrite({
    intentId: "family",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("changed"), eventId: null },
      { addressId: address("unchanged"), eventId: null },
    ],
    listingJob: original,
  })
  const next = product("changed", createdAt + 1)
  await commitLocalProductWrite({
    intentId: "one-coordinate",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("changed"), eventId: first.id }],
    listingJob: job([next]),
    reconcileListingJobIds: [original.id],
  })
  // A restart must not erase the selected per-event replay disposition.
  db.close({ disableAutoOpen: false })
  expect(
    (await getPendingProductListingDeliveries()).some(
      (candidate) => candidate.id === original.id
    )
  ).toBe(true)
  const published: string[] = []
  await deliverProductListingJob(
    original.id,
    async ({ signedEvent }) => {
      published.push(signedEvent.id)
      return { status: "acked" }
    },
    deliveryOptions
  )
  expect(published).toEqual([sibling.id])
  const history = await getProductListingDelivery(original.id)
  expect(history?.localReplaySupersededBy).toEqual({
    [first.id]: "one-coordinate",
  })
  expect(history?.signedEvents).toEqual(original.signedEvents)
  expect(
    history?.relayDelivery.find((pair) => pair.eventId === first.id)
      ?.attemptCount
  ).toBe(0)
  expect(
    (await getPendingProductListingDeliveries()).some(
      (candidate) => candidate.id === original.id
    )
  ).toBe(false)
})

function product(dTag: string, timestamp: number) {
  const draft = buildProductListingEventDraft({
    product: {
      id: address(dTag),
      pubkey: merchant,
      title: "Synthetic listing",
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

function job(events: ReturnType<typeof product>[], relayNames = ["first"]) {
  return prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: events,
    relayTargets: relayNames.map(target),
    readyForDelivery: false,
  })
}

const deliveryOptions = {
  authenticatedPubkey: merchant,
  accountNetworkLocalStateRepository: { get: async () => undefined },
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
  db.close({ disableAutoOpen: false })
  dependencies.indexedDB = new FakeIDBFactory()
  dependencies.IDBKeyRange = IDBKeyRange
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async <T>(
          name: string,
          operation: (lock: { name: string }) => Promise<T>
        ) => operation({ name }),
      },
    },
  })
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
  restore?.()
})

it("keeps an ordinary newer listing authoritative after an older in-flight ACK", async () => {
  const first = product("late-ack", createdAt)
  const olderJob = job([first], ["first", "second"])
  await commitLocalProductWrite({
    intentId: "first",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("late-ack"), eventId: null }],
    listingJob: olderJob,
  })
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivery = deliverProductListingJob(
    olderJob.id,
    async ({ relayUrl }) => {
      if (relayUrl === target("first").relayUrl) {
        enter()
        await held
        return { status: "acked" }
      }
      return { status: "timed_out" }
    },
    deliveryOptions
  )
  await entered
  const next = product("late-ack", createdAt + 1)
  const nextJob = job([next], ["current"])
  try {
    const intent = await commitLocalProductWrite({
      intentId: "ordinary-edit",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("late-ack"), eventId: first.id },
      ],
      listingJob: nextJob,
      reconcileListingJobIds: [olderJob.id],
    })
    expect(intent.sourceRevisions).toEqual([
      { addressId: address("late-ack"), eventId: first.id },
    ])
  } finally {
    release()
    await delivery
  }
  const history = await getProductListingDelivery(olderJob.id)
  expect(history?.signedEvents).toEqual(olderJob.signedEvents)
  expect(history?.relayTargets).toEqual(olderJob.relayTargets)
  expect(
    history?.relayDelivery.find(
      (pair) => pair.relayUrl === target("first").relayUrl
    )?.status
  ).toBe("acked")
  expect(history?.localReplaySupersededBy?.[first.id]).toBe("ordinary-edit")
  const replayed: string[] = []
  await deliverProductListingJob(
    olderJob.id,
    async ({ signedEvent }) => {
      replayed.push(signedEvent.id)
      return { status: "acked" }
    },
    deliveryOptions
  )
  expect(replayed).toEqual([])
  const later = product("late-ack", createdAt + 2)
  await commitLocalProductWrite({
    intentId: "next-edit",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("late-ack"), eventId: next.id }],
    listingJob: job([later]),
    reconcileListingJobIds: [nextJob.id],
  })
})

it("refuses a family save when an unchanged captured sibling advanced", async () => {
  const changed = product("family-change", createdAt)
  const sibling = product("family-sibling", createdAt)
  const initial = job([changed, sibling])
  await commitLocalProductWrite({
    intentId: "family-source",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("family-change"), eventId: null },
      { addressId: address("family-sibling"), eventId: null },
    ],
    listingJob: initial,
  })
  await deliverProductListingJob(
    initial.id,
    async () => ({ status: "acked" }),
    deliveryOptions
  )
  const advancedSibling = product("family-sibling", createdAt + 1)
  await commitLocalProductWrite({
    intentId: "sibling-change",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("family-sibling"), eventId: sibling.id },
    ],
    listingJob: job([advancedSibling]),
  })
  const attempted = job([product("family-change", createdAt + 2)])
  await expect(
    commitLocalProductWrite({
      intentId: "captured-family-save",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("family-change"), eventId: changed.id },
      ],
      additionalExpectedRevisions: [
        { addressId: address("family-sibling"), eventId: sibling.id },
      ],
      listingJob: attempted,
    })
  ).rejects.toThrow("Product changed before the signed local commit")
  expect(await getProductListingDelivery(attempted.id)).toBeUndefined()
})

it("repairs an exact rejected listing on a new plan without requiring old relay coverage", async () => {
  const first = product("explicit-recovery", createdAt)
  const older = job([first], ["unavailable-old"])
  await commitLocalProductWrite({
    intentId: "before-recovery",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("explicit-recovery"), eventId: null },
    ],
    listingJob: older,
  })
  await deliverProductListingJob(
    older.id,
    async () => ({ status: "rejected" }),
    deliveryOptions
  )
  expect(await getRequiredProductListingRecoveryRelayUrls(older.id)).toEqual([])
  const recovered = product("explicit-recovery", createdAt + 1)
  let recoveredId = ""
  await withLocalLegacyProductWriteStage(
    {
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("explicit-recovery"), eventId: first.id },
      ],
      signedListings: [recovered],
      recovery: { kind: "listing_republish", previousListingJobId: older.id },
    },
    async () => {
      const staged = await persistProductListingDelivery({
        merchantPubkey: merchant,
        signedEvents: [recovered],
        relayTargets: [target("current-only")],
        readyForDelivery: false,
        replacesRejectedListingJobId: older.id,
      })
      recoveredId = staged.id
      await cacheSignedProductListingEvent(new NDKEvent(undefined, recovered))
    }
  )
  expect((await getProductListingDelivery(recoveredId))?.readyForDelivery).toBe(
    true
  )
  expect(
    (await getProductListingDelivery(older.id))?.localReplaySupersededBy?.[
      first.id
    ]
  ).toBe(`listing-recovery:${recoveredId}`)
  await deliverProductListingJob(
    recoveredId,
    async () => ({ status: "acked" }),
    deliveryOptions
  )
  await commitLocalProductWrite({
    intentId: "edit-after-repair",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("explicit-recovery"), eventId: recovered.id },
    ],
    listingJob: job([product("explicit-recovery", createdAt + 2)]),
  })
})

it("does not replay an old local listing after a newer signed relay observation", async () => {
  const first = product("observed-newer", createdAt)
  const original = job([first])
  await commitLocalProductWrite({
    intentId: "before-observation",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("observed-newer"), eventId: null },
    ],
    listingJob: original,
  })
  await cacheSignedProductListingEvent(
    new NDKEvent(undefined, product("observed-newer", createdAt + 1))
  )
  const replayed: string[] = []
  await deliverProductListingJob(
    original.id,
    async ({ signedEvent }) => {
      replayed.push(signedEvent.id)
      return { status: "acked" }
    },
    deliveryOptions
  )
  expect(replayed).toEqual([])
  expect(
    (await getProductListingDelivery(original.id))?.relayDelivery[0]
      ?.attemptCount
  ).toBe(0)
})

it("requires informed reconciliation for an unfinished listing before admitting its successor", async () => {
  const first = product("explicit-only", createdAt)
  const original = job([first])
  await commitLocalProductWrite({
    intentId: "unfinished",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("explicit-only"), eventId: null }],
    listingJob: original,
  })
  const next = job([product("explicit-only", createdAt + 1)])
  await expect(
    commitLocalProductWrite({
      intentId: "not-reconciled",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("explicit-only"), eventId: first.id },
      ],
      listingJob: next,
    })
  ).rejects.toThrow("still needs reconciliation")
  expect(await getProductListingDelivery(next.id)).toBeUndefined()
  expect(
    (await getProductListingDelivery(original.id))?.localReplaySupersededBy
  ).toBeUndefined()
})

it("rolls back replay suppression if the account session changes before commit", async () => {
  const first = product("cancelled-commit", createdAt)
  const original = job([first])
  await commitLocalProductWrite({
    intentId: "original-session",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("cancelled-commit"), eventId: null },
    ],
    listingJob: original,
  })
  const next = job([product("cancelled-commit", createdAt + 1)])
  let checks = 0
  await expect(
    commitLocalProductWrite({
      intentId: "switched-session",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("cancelled-commit"), eventId: first.id },
      ],
      listingJob: next,
      reconcileListingJobIds: [original.id],
      shouldContinue: () => ++checks === 1,
    })
  ).rejects.toThrow("account session changed")
  expect(await getProductListingDelivery(next.id)).toBeUndefined()
  expect(
    (await getProductListingDelivery(original.id))?.localReplaySupersededBy
  ).toBeUndefined()
  const retried: string[] = []
  await deliverProductListingJob(
    original.id,
    async ({ signedEvent }) => {
      retried.push(signedEvent.id)
      return { status: "acked" }
    },
    deliveryOptions
  )
  expect(retried).toEqual([first.id])
})

it("refuses equal-second replacements even when the old job is explicitly reconciled", async () => {
  const first = product("equal-second", createdAt)
  const original = job([first])
  await commitLocalProductWrite({
    intentId: "equal-source",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address("equal-second"), eventId: null }],
    listingJob: original,
  })
  await expect(
    commitLocalProductWrite({
      intentId: "equal-successor",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("equal-second"), eventId: first.id },
      ],
      listingJob: original,
      reconcileListingJobIds: [original.id],
    })
  ).rejects.toThrow("does not advance its source")
  expect(
    (await getProductListingDelivery(original.id))?.localReplaySupersededBy
  ).toBeUndefined()
})

it("refuses a family save when a captured unchanged sibling was deleted", async () => {
  const changed = product("deletion-family-change", createdAt)
  const sibling = product("deleted-sibling", createdAt)
  const initial = job([changed, sibling])
  await commitLocalProductWrite({
    intentId: "before-sibling-deletion",
    merchantPubkey: merchant,
    expectedRevisions: [
      { addressId: address("deletion-family-change"), eventId: null },
      { addressId: address("deleted-sibling"), eventId: null },
    ],
    listingJob: initial,
  })
  await deliverProductListingJob(
    initial.id,
    async () => ({ status: "acked" }),
    deliveryOptions
  )
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: createdAt + 1,
      tags: [
        ["a", address("deleted-sibling")],
        ["e", sibling.id],
      ],
      content: "",
    },
    secret
  )
  await cacheSignedProductDeletionEvent(new NDKEvent(undefined, deletion))
  const next = job([product("deletion-family-change", createdAt + 2)])
  await expect(
    commitLocalProductWrite({
      intentId: "stale-family-after-deletion",
      merchantPubkey: merchant,
      expectedRevisions: [
        { addressId: address("deletion-family-change"), eventId: changed.id },
      ],
      additionalExpectedRevisions: [
        { addressId: address("deleted-sibling"), eventId: sibling.id },
      ],
      listingJob: next,
    })
  ).rejects.toThrow("family member was deleted")
  expect(await getProductListingDelivery(next.id)).toBeUndefined()
})
