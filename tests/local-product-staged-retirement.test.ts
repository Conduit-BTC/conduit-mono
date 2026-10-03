import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildProductListingEventDraft,
  commitLocalProductWrite,
  db,
  deliverProductDeletionJob,
  deliverProductListingJob,
  EVENT_KINDS,
  getPendingProductDeletionDeliveries,
  markProductListingDeliveryReady,
  prepareProductDeletionDeliveryJob,
  prepareProductListingDeliveryJob,
  projectSignedProductDeletionForLocalCommit,
  retireSupersededStagedProductWrite,
  retireSupersededStagedProductWriteFromLocalEvidence,
} from "@conduit/core"

const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const CREATED_AT = 1_800_000_000
const NOW = CREATED_AT * 1_000

function signedProduct(dTag: string, createdAt: number, version: string) {
  const draft = buildProductListingEventDraft({
    product: {
      id: addressId(dTag),
      pubkey: MERCHANT,
      title: version,
      price: 10,
      currency: "SATS",
      type: "simple",
      specifications: [],
      format: "physical",
      visibility: "public",
      images: [{ url: "https://example.com/product.png" }],
      tags: ["test"],
      publicZapEnabled: false,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: createdAt * 1_000,
      updatedAt: createdAt * 1_000,
    },
    dTag,
    clientAppId: "merchant",
  })
  return finalizeEvent(
    {
      kind: draft.kind,
      created_at: createdAt,
      tags: draft.tags,
      content: draft.content,
    },
    SECRET
  )
}

function addressId(dTag: string): string {
  return `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${dTag}`
}

function signedDeletion(dTag: string, createdAt = CREATED_AT) {
  return finalizeEvent(
    {
      kind: 5,
      created_at: createdAt,
      tags: [["a", addressId(dTag)]],
      content: "",
    },
    SECRET
  )
}

function setSelectedProduct(
  dTag: string,
  event: ReturnType<typeof signedProduct>
) {
  return db.products.put({
    id: addressId(dTag),
    pubkey: MERCHANT,
    dTag,
    title: "Selected signed product",
    price: 10,
    currency: "SATS",
    images: [],
    tags: [],
    eventId: event.id,
    eventCreatedAt: event.created_at,
    cachedAt: NOW,
  })
}

async function storeAcknowledgedProducts(
  signedEvents: ReturnType<typeof signedProduct>[]
) {
  const prepared = prepareProductListingDeliveryJob({
    merchantPubkey: MERCHANT,
    signedEvents,
    relayTargets: [
      {
        relayUrl: "wss://relay.example",
        ownerSelected: false,
        personalRelay: true,
      },
    ],
  })
  await db.productListingOutbox.add({
    ...prepared,
    state: "delivered",
    deliveryAttemptCount: 1,
    relayDelivery: prepared.relayDelivery.map((row) => ({
      ...row,
      status: "acked" as const,
      attemptCount: 1,
    })),
  })
}

let restoreBrowser: (() => void) | undefined

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
        ): Promise<T> => operation({ name }),
      },
    },
  })
  restoreBrowser = () => {
    db.close({ disableAutoOpen: false })
    dependencies.indexedDB = priorIndexedDB
    dependencies.IDBKeyRange = priorKeyRange
    if (priorNavigator) {
      Object.defineProperty(globalThis, "navigator", priorNavigator)
    } else {
      Reflect.deleteProperty(globalThis, "navigator")
    }
  }
})

afterEach(() => {
  restoreBrowser?.()
  restoreBrowser = undefined
})

describe("stale signed product staging", () => {
  it("offers an explicit repair only when a delivered local job holds the selected signed winner", async () => {
    const dTag = "explicit-repair"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const target = {
      relayUrl: "wss://relay.example",
      ownerSelected: false,
      personalRelay: true,
    }
    const staged = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [target],
      readyForDelivery: false,
    })
    await db.productListingOutbox.add(staged)
    await setSelectedProduct(dTag, winner)
    await expect(
      retireSupersededStagedProductWriteFromLocalEvidence({
        merchantPubkey: MERCHANT,
        listingJobId: staged.id,
      })
    ).rejects.toThrow("No delivered signed replacement")
    const delivered = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [winner],
      relayTargets: [target],
    })
    await db.productListingOutbox.add({
      ...delivered,
      state: "delivered",
    })
    await expect(
      retireSupersededStagedProductWriteFromLocalEvidence({
        merchantPubkey: MERCHANT,
        listingJobId: staged.id,
      })
    ).rejects.toThrow("No delivered signed replacement")
    await db.productListingOutbox.delete(delivered.id)
    await db.productListingOutbox.add({
      ...delivered,
      state: "delivered",
      deliveryAttemptCount: 1,
      relayDelivery: delivered.relayDelivery.map((row) => ({
        ...row,
        status: "acked" as const,
        attemptCount: 1,
      })),
    })
    await retireSupersededStagedProductWriteFromLocalEvidence({
      merchantPubkey: MERCHANT,
      listingJobId: staged.id,
    })
    expect((await db.productListingOutbox.get(staged.id))?.state).toBe(
      "superseded_unpublished"
    )
  })

  it("retires a provably superseded, unattempted standalone job without replaying its signed frame", async () => {
    const dTag = "stale-single"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const staged = prepareProductListingDeliveryJob(
      {
        merchantPubkey: MERCHANT,
        signedEvents: [loser],
        relayTargets: [
          {
            relayUrl: "wss://relay.example",
            ownerSelected: false,
            personalRelay: true,
          },
        ],
        readyForDelivery: false,
      },
      { now: () => NOW }
    )
    await db.productListingOutbox.add(staged)
    await setSelectedProduct(dTag, winner)

    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: staged.id,
        winningSignedEvents: [winner],
      })
    ).rejects.toThrow("No acknowledged signed replacement")
    await storeAcknowledgedProducts([winner])

    await retireSupersededStagedProductWrite({
      listingJobId: staged.id,
      winningSignedEvents: [winner],
      now: () => NOW + 1,
    })

    const retired = await db.productListingOutbox.get(staged.id)
    expect(retired?.state).toBe("superseded_unpublished")
    expect(retired?.signedEvents).toEqual(staged.signedEvents)
    expect(retired?.relayDelivery).toEqual(staged.relayDelivery)
    await expect(markProductListingDeliveryReady(staged.id)).rejects.toThrow()
    let published = 0
    await deliverProductListingJob(
      staged.id,
      async () => {
        published += 1
        return { status: "acked" }
      },
      { authenticatedPubkey: MERCHANT }
    )
    expect(published).toBe(0)

    const successor = signedProduct(dTag, CREATED_AT + 1, "successor")
    const successorJob = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [successor],
      readyForDelivery: false,
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
    })
    await commitLocalProductWrite({
      intentId: crypto.randomUUID(),
      merchantPubkey: MERCHANT,
      expectedRevisions: [{ addressId: addressId(dTag), eventId: winner.id }],
      listingJob: successorJob,
      now: () => NOW + 2_000,
    })
    expect((await db.productListingOutbox.get(successorJob.id))?.id).toBe(
      successorJob.id
    )
  })

  it("refuses an exact-deleted winner even if the deletion predates that event", async () => {
    const dTag = "exact-deleted-winner"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const staged = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
      readyForDelivery: false,
    })
    const exactDeletion = finalizeEvent(
      {
        kind: EVENT_KINDS.DELETION,
        created_at: CREATED_AT - 1,
        tags: [["e", winner.id]],
        content: "",
      },
      SECRET
    )
    await db.productListingOutbox.add(staged)
    await setSelectedProduct(dTag, winner)
    await storeAcknowledgedProducts([winner])
    await db.productTombstones.bulkPut(
      projectSignedProductDeletionForLocalCommit(exactDeletion)
    )

    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: staged.id,
        winningSignedEvents: [winner],
      })
    ).rejects.toThrow("Signed replacement is not the selected product revision")
    expect((await db.productListingOutbox.get(staged.id))?.state).toBe(
      "pending"
    )
  })

  it("refuses a paired listing/deletion even with selected acknowledged winners", async () => {
    const listingDTag = "mixed-new"
    const deletionDTag = "mixed-old"
    const first = signedProduct(listingDTag, CREATED_AT, "first")
    const second = signedProduct(listingDTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const deletedSource = signedProduct(
      deletionDTag,
      CREATED_AT - 1,
      "old source"
    )
    const deletion = finalizeEvent(
      {
        kind: EVENT_KINDS.DELETION,
        created_at: CREATED_AT,
        tags: [
          ["e", deletedSource.id],
          ["a", addressId(deletionDTag)],
        ],
        content: "",
      },
      SECRET
    )
    const replacementForDeleted = signedProduct(
      deletionDTag,
      CREATED_AT + 1,
      "after-deletion"
    )
    const listingJob = prepareProductListingDeliveryJob(
      {
        merchantPubkey: MERCHANT,
        signedEvents: [loser],
        relayTargets: [
          {
            relayUrl: "wss://relay.example",
            ownerSelected: false,
            personalRelay: true,
          },
        ],
        companionDeletionJobId: deletion.id,
        readyForDelivery: false,
      },
      { now: () => NOW }
    )
    const deletionJob = prepareProductDeletionDeliveryJob(
      {
        signedEvent: deletion,
        companionListingJobId: listingJob.id,
        currentWriteRelayUrls: ["wss://relay.example"],
        currentPersonalRelayUrls: ["wss://relay.example"],
        sourceRelayUrls: ["wss://source.example"],
        canonicalConduitRelayUrl: "wss://relay.conduit.market",
      },
      { now: () => NOW }
    )
    await db.productListingOutbox.add(listingJob)
    await db.productDeletionOutbox.add(deletionJob)
    await setSelectedProduct(listingDTag, winner)
    await setSelectedProduct(deletionDTag, replacementForDeleted)
    await storeAcknowledgedProducts([winner, replacementForDeleted])
    await db.productTombstones.bulkPut(
      projectSignedProductDeletionForLocalCommit(deletion)
    )

    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: listingJob.id,
        winningSignedEvents: [winner, replacementForDeleted],
        now: () => NOW + 1,
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")
    await expect(
      retireSupersededStagedProductWriteFromLocalEvidence({
        merchantPubkey: MERCHANT,
        listingJobId: listingJob.id,
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")

    const retainedListing = await db.productListingOutbox.get(listingJob.id)
    const retainedDeletion = await db.productDeletionOutbox.get(deletionJob.id)
    expect(retainedListing?.state).toBe("pending")
    expect(retainedDeletion?.state).toBe("pending")
    expect(retainedListing?.signedEvents).toEqual(listingJob.signedEvents)
    expect(retainedDeletion?.signedEvent).toEqual(deletionJob.signedEvent)
    expect(retainedDeletion?.relayPlan).toEqual(deletionJob.relayPlan)
    expect(
      (await getPendingProductDeletionDeliveries()).some(
        (job) => job.id === deletionJob.id
      )
    ).toBe(true)
  })

  it("keeps a preloaded worker from arming a listing retired after its read", async () => {
    const dTag = "preloaded-worker"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const staged = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
      readyForDelivery: false,
    })
    await db.productListingOutbox.add(staged)
    await setSelectedProduct(dTag, winner)
    await storeAcknowledgedProducts([winner])
    let releaseWorker!: () => void
    let enteredWorker!: () => void
    const workerHold = new Promise<void>((resolve) => {
      releaseWorker = resolve
    })
    const workerEntered = new Promise<void>((resolve) => {
      enteredWorker = resolve
    })
    const preloadedWorker = markProductListingDeliveryReady(staged.id, {
      repository: {
        async add() {
          throw new Error("Not used")
        },
        async get() {
          enteredWorker()
          await workerHold
          return structuredClone(staged)
        },
        async listUndelivered() {
          return []
        },
        async update(id, updater) {
          return db.transaction("rw", db.productListingOutbox, async () => {
            const current = await db.productListingOutbox.get(id)
            if (!current) throw new Error("Staged job was not found")
            const updated = updater(current)
            await db.productListingOutbox.put(updated)
            return updated
          })
        },
      },
    })
    await workerEntered

    await retireSupersededStagedProductWrite({
      listingJobId: staged.id,
      winningSignedEvents: [winner],
    })
    releaseWorker()
    await expect(preloadedWorker).rejects.toThrow(
      "Superseded product delivery cannot be armed"
    )
  })

  it("excludes a locally retained retired deletion from pending retry discovery", async () => {
    const deletion = signedDeletion("retired-selector")
    const prepared = prepareProductDeletionDeliveryJob({
      signedEvent: deletion,
      currentWriteRelayUrls: ["wss://relay.example"],
      currentPersonalRelayUrls: ["wss://relay.example"],
      sourceRelayUrls: [],
      canonicalConduitRelayUrl: "wss://relay.conduit.market",
    })
    await db.productDeletionOutbox.add({
      ...prepared,
      state: "superseded_unpublished",
    })
    expect(
      (await getPendingProductDeletionDeliveries()).some(
        (job) => job.id === deletion.id
      )
    ).toBe(false)
    let published = 0
    await deliverProductDeletionJob(
      deletion.id,
      async () => {
        published += 1
        return { status: "acked" }
      },
      { authenticatedPubkey: MERCHANT }
    )
    expect(published).toBe(0)
  })

  it("refuses attempted timeout, partial ACK, and shipping-prerequisite stages", async () => {
    for (const scenario of ["timed_out", "acked", "shipping"] as const) {
      const dTag = `blocked-${scenario}`
      const first = signedProduct(dTag, CREATED_AT, "first")
      const second = signedProduct(dTag, CREATED_AT, "second")
      const [loser, winner] =
        first.id > second.id ? [first, second] : [second, first]
      const prepared = prepareProductListingDeliveryJob({
        merchantPubkey: MERCHANT,
        signedEvents: [loser],
        relayTargets: [
          {
            relayUrl: "wss://relay.example",
            ownerSelected: false,
            personalRelay: true,
          },
        ],
        readyForDelivery: false,
        ...(scenario === "shipping"
          ? { prerequisiteShippingEventIds: ["a".repeat(64)] }
          : {}),
      })
      const job =
        scenario === "shipping"
          ? prepared
          : {
              ...prepared,
              deliveryAttemptCount: 1,
              relayDelivery: prepared.relayDelivery.map((delivery) => ({
                ...delivery,
                status: scenario,
                attemptCount: 1,
                lastAttemptAt: NOW,
              })),
            }
      await db.productListingOutbox.add(job)
      await setSelectedProduct(dTag, winner)
      await expect(
        retireSupersededStagedProductWrite({
          listingJobId: job.id,
          winningSignedEvents: [winner],
        })
      ).rejects.toThrow()
      expect((await db.productListingOutbox.get(job.id))?.state).not.toBe(
        "superseded_unpublished"
      )
    }
  })

  it("refuses an orphaned reciprocal deletion even when the listing omits its pointer", async () => {
    const dTag = "orphaned-reciprocal"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const staged = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
      readyForDelivery: false,
    })
    const deletion = signedDeletion("orphaned-source")
    const deletionJob = prepareProductDeletionDeliveryJob({
      signedEvent: deletion,
      companionListingJobId: staged.id,
      currentWriteRelayUrls: ["wss://relay.example"],
      currentPersonalRelayUrls: ["wss://relay.example"],
      sourceRelayUrls: ["wss://source.example"],
      canonicalConduitRelayUrl: "wss://relay.conduit.market",
    })
    await db.productListingOutbox.add(staged)
    await db.productDeletionOutbox.add(deletionJob)
    await setSelectedProduct(dTag, winner)
    await storeAcknowledgedProducts([winner])

    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: staged.id,
        winningSignedEvents: [winner],
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")
    expect((await db.productListingOutbox.get(staged.id))?.state).toBe(
      "pending"
    )
    expect((await db.productDeletionOutbox.get(deletion.id))?.state).toBe(
      "pending"
    )
  })

  it("refuses an attempted companion deletion even when both replacements are acknowledged", async () => {
    const listingDTag = "blocked-deletion-listing"
    const deletionDTag = "blocked-deletion-target"
    const first = signedProduct(listingDTag, CREATED_AT, "first")
    const second = signedProduct(listingDTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const deletion = signedDeletion(deletionDTag)
    const replacement = signedProduct(
      deletionDTag,
      CREATED_AT + 1,
      "replacement"
    )
    const listingJob = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
      companionDeletionJobId: deletion.id,
      readyForDelivery: false,
    })
    const preparedDeletion = prepareProductDeletionDeliveryJob({
      signedEvent: deletion,
      companionListingJobId: listingJob.id,
      currentWriteRelayUrls: ["wss://relay.example"],
      currentPersonalRelayUrls: ["wss://relay.example"],
      sourceRelayUrls: [],
      canonicalConduitRelayUrl: "wss://relay.conduit.market",
    })
    const attemptedDeletion = {
      ...preparedDeletion,
      deliveryAttemptCount: 1,
      lastAttemptAt: NOW,
      relayDelivery: preparedDeletion.relayDelivery.map((row) => ({
        ...row,
        status: "timed_out" as const,
        attemptCount: 1,
        lastAttemptAt: NOW,
      })),
    }
    await db.productListingOutbox.add(listingJob)
    await db.productDeletionOutbox.add(attemptedDeletion)
    await setSelectedProduct(listingDTag, winner)
    await setSelectedProduct(deletionDTag, replacement)
    await db.productTombstones.bulkPut(
      projectSignedProductDeletionForLocalCommit(deletion)
    )
    await storeAcknowledgedProducts([winner, replacement])

    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: listingJob.id,
        winningSignedEvents: [winner, replacement],
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")
    expect((await db.productListingOutbox.get(listingJob.id))?.state).toBe(
      "pending"
    )
    expect((await db.productDeletionOutbox.get(deletion.id))?.state).toBe(
      "pending"
    )
  })

  it("refuses a missing or nonreciprocal companion without changing either signed job", async () => {
    const dTag = "broken-companion"
    const first = signedProduct(dTag, CREATED_AT, "first")
    const second = signedProduct(dTag, CREATED_AT, "second")
    const [loser, winner] =
      first.id > second.id ? [first, second] : [second, first]
    const deletion = signedDeletion("other-coordinate")
    const listingJob = prepareProductListingDeliveryJob({
      merchantPubkey: MERCHANT,
      signedEvents: [loser],
      relayTargets: [
        {
          relayUrl: "wss://relay.example",
          ownerSelected: false,
          personalRelay: true,
        },
      ],
      companionDeletionJobId: deletion.id,
      readyForDelivery: false,
    })
    await db.productListingOutbox.add(listingJob)
    await setSelectedProduct(dTag, winner)
    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: listingJob.id,
        winningSignedEvents: [winner],
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")

    const deletionJob = prepareProductDeletionDeliveryJob({
      signedEvent: deletion,
      companionListingJobId: `product-listing:${"f".repeat(64)}`,
      currentWriteRelayUrls: ["wss://relay.example"],
      currentPersonalRelayUrls: ["wss://relay.example"],
      sourceRelayUrls: [],
      canonicalConduitRelayUrl: "wss://relay.conduit.market",
    })
    await db.productDeletionOutbox.add(deletionJob)
    await setSelectedProduct(
      "other-coordinate",
      signedProduct("other-coordinate", CREATED_AT + 1, "replacement")
    )
    await expect(
      retireSupersededStagedProductWrite({
        listingJobId: listingJob.id,
        winningSignedEvents: [
          winner,
          signedProduct("other-coordinate", CREATED_AT + 1, "replacement"),
        ],
      })
    ).rejects.toThrow("Paired product deletion needs manual reconciliation")
    expect(
      (await db.productListingOutbox.get(listingJob.id))?.signedEvents
    ).toEqual(listingJob.signedEvents)
    expect(
      (await db.productDeletionOutbox.get(deletionJob.id))?.signedEvent
    ).toEqual(deletionJob.signedEvent)
  })
})
