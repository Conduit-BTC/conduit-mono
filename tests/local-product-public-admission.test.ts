import { afterEach, beforeEach, expect, it } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { hexToBytes } from "../packages/core/node_modules/@noble/curves/utils.js"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure"
import { db } from "../packages/core/src/db"
import { commitLocalProductWrite } from "../packages/core/src/protocol/local-product-write"
import { prepareProductListingDeliveryJob } from "../packages/core/src/protocol/product-listing-delivery"
import {
  isDeliveredCompanionListingForDeletion,
  prepareProductDeletionDeliveryJob,
  readProductDeletionAcknowledgedSourceRelayUrls,
} from "../packages/core/src/protocol/product-deletion-delivery"
import {
  __resetPublicEventVerificationForTests,
  isVerifiedNostrEvent,
} from "../packages/core/src/protocol/verified-public-event"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const address = `30402:${merchant}:local-public-admission`
let workerChecks = 0
let verificationInsideTransaction = false
let restore: () => void

beforeEach(() => {
  __resetPublicEventVerificationForTests()
  workerChecks = 0
  verificationInsideTransaction = false
  const dependencies = (
    db as unknown as {
      _deps: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }
    }
  )._deps
  const priorIndexedDB = dependencies.indexedDB
  const priorKeyRange = dependencies.IDBKeyRange
  const priorWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker")
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const priorNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  db.close({ disableAutoOpen: false })
  dependencies.indexedDB = new IDBFactory()
  dependencies.IDBKeyRange = IDBKeyRange
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  })
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
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class {
      onmessage?: (event: { data: unknown }) => void
      onerror?: () => void
      postMessage(batch: {
        reqId: number
        items: ReturnType<typeof listing>[]
      }) {
        verificationInsideTransaction ||= !!Dexie.currentTransaction
        const valid = batch.items.map((event) => {
          workerChecks++
          return (
            getEventHash(event) === event.id &&
            schnorr.verify(
              hexToBytes(event.sig),
              hexToBytes(event.id),
              hexToBytes(event.pubkey)
            )
          )
        })
        queueMicrotask(() =>
          this.onmessage?.({ data: { reqId: batch.reqId, valid } })
        )
      }
      terminate() {}
    },
  })
  restore = () => {
    __resetPublicEventVerificationForTests()
    db.close({ disableAutoOpen: false })
    dependencies.indexedDB = priorIndexedDB
    dependencies.IDBKeyRange = priorKeyRange
    for (const [name, descriptor] of [
      ["Worker", priorWorker],
      ["window", priorWindow],
      ["navigator", priorNavigator],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

afterEach(() => restore())

function listing() {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 1_800_000_000,
      tags: [
        ["d", "local-public-admission"],
        ["title", "Synthetic local listing"],
        ["price", "10", "SATS"],
        ["stock", "3"],
      ],
      content: "Offline fixture",
    },
    secret
  )
}

function listingJob(event = listing()) {
  return prepareProductListingDeliveryJob({
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
}

it("admits raw local listing bytes before the atomic product commit", async () => {
  const job = listingJob()
  expect(isVerifiedNostrEvent(job.signedEvents[0])).toBe(false)
  await commitLocalProductWrite({
    intentId: "listing-admission",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address, eventId: null }],
    listingJob: job,
  })
  expect(workerChecks).toBe(1)
  expect(verificationInsideTransaction).toBe(false)
  expect(
    (await db.products.get(address))?.eventId === job.signedEvents[0].id
  ).toBe(true)
  expect((await db.productListingOutbox.get(job.id))?.readyForDelivery).toBe(
    true
  )
})

it("readmits exact deletion job bytes before atomic tombstone projection", async () => {
  const event = finalizeEvent(
    {
      kind: 5,
      created_at: 1_800_000_001,
      tags: [["a", address]],
      content: "",
    },
    secret
  )
  const job = await prepareProductDeletionDeliveryJob({
    signedEvent: event,
    currentWriteRelayUrls: ["wss://relay.conduit.market"],
    sourceRelayUrls: [],
    canonicalConduitRelayUrl: "wss://relay.conduit.market",
  })
  expect(isVerifiedNostrEvent(job.signedEvent)).toBe(false)
  await commitLocalProductWrite({
    intentId: "deletion-admission",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: address, eventId: null }],
    deletionJob: job,
  })
  expect(workerChecks).toBe(1)
  expect(verificationInsideTransaction).toBe(false)
  expect(
    (await db.productTombstones.get(`a:${address}`))?.observedLocally
  ).toBe(true)
  expect(await db.productDeletionOutbox.count()).toBe(1)
})

it("rejects altered persisted listing bytes without a projection or outbox commit", async () => {
  const job = listingJob()
  job.signedEvents[0].content = "Changed offline fixture"
  await expect(
    commitLocalProductWrite({
      intentId: "invalid-admission",
      merchantPubkey: merchant,
      expectedRevisions: [{ addressId: address, eventId: null }],
      listingJob: job,
    })
  ).rejects.toThrow()
  expect(await db.products.count()).toBe(0)
  expect(await db.productListingOutbox.count()).toBe(0)
  expect(await db.localProductWriteIntents.count()).toBe(0)
})

it("admits raw deletion bytes when reading durable historical listing ACKs", async () => {
  const job = listingJob()
  await db.productListingOutbox.put({
    ...job,
    state: "delivered",
    relayDelivery: job.relayDelivery.map((pair) => ({
      ...pair,
      status: "acked",
      attemptCount: 1,
    })),
  })
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 1_800_000_001,
      tags: [["a", address]],
      content: "",
    },
    secret
  )
  expect(
    await readProductDeletionAcknowledgedSourceRelayUrls(deletion)
  ).toEqual(["wss://relay.conduit.market"])
  expect(verificationInsideTransaction).toBe(false)
})

it("readmits persisted companion bytes and rejects a copied tampered deletion", async () => {
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 1_800_000_001,
      tags: [["a", address]],
      content: "",
    },
    secret
  )
  const listing = listingJob()
  const job = await prepareProductDeletionDeliveryJob({
    signedEvent: deletion,
    currentWriteRelayUrls: ["wss://relay.conduit.market"],
    sourceRelayUrls: [],
    canonicalConduitRelayUrl: "wss://relay.conduit.market",
    companionListingJobId: listing.id,
  })
  const delivered = {
    ...listing,
    state: "delivered" as const,
    readyForDelivery: true,
    companionDeletionJobId: job.id,
    relayDelivery: listing.relayDelivery.map((pair) => ({
      ...pair,
      status: "acked" as const,
      attemptCount: 1,
    })),
  }
  expect(await isDeliveredCompanionListingForDeletion(delivered, job)).toBe(
    true
  )
  expect(
    await isDeliveredCompanionListingForDeletion(delivered, {
      ...job,
      signedEvent: { ...job.signedEvent, content: "Changed offline fixture" },
    })
  ).toBe(false)
  expect(verificationInsideTransaction).toBe(false)
})
