import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { db } from "../packages/core/src/db"
import { projectSignedProductListingForLocalCommit } from "../packages/core/src/protocol/commerce"
import { computeEventMarketAssignmentDTag } from "../packages/core/src/protocol/event-market-assignment"
import {
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
} from "../packages/core/src/protocol/merchant-inventory"
import { commitLocalProductWrite } from "../packages/core/src/protocol/local-product-write"
import { prepareProductListingDeliveryJob } from "../packages/core/src/protocol/product-listing-delivery"
import { admitFixture } from "./helpers/public-event"

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

async function ordinaryStockTwoToOne(allocation: 1 | 2) {
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const organizerPubkey = getPublicKey(generateSecretKey())
  const productDTag = `ordinary-floor-${allocation}`
  const productCoordinate = `30402:${merchantPubkey}:${productDTag}`
  const marketCoordinate = `30409:${organizerPubkey}:market-${allocation}`
  const occurrenceCoordinate = `31923:${organizerPubkey}:day-${allocation}`
  const assignmentCoordinate = `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag(
    { marketCoordinate, occurrenceCoordinate, productCoordinate }
  )}`
  const source = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", productDTag],
        ["title", "Ordinary stock fixture"],
        ["type", "simple", "physical"],
        ["price", "1", "SAT"],
        ["stock", "2"],
      ],
    },
    merchantSecret
  )
  const updated = finalizeEvent(
    {
      kind: source.kind,
      created_at: 101,
      content: source.content,
      tags: source.tags.map((tag) =>
        tag[0] === "stock" ? ["stock", "1"] : [...tag]
      ),
    },
    merchantSecret
  )
  await db.products.put(
    projectSignedProductListingForLocalCommit(await admitFixture(source))
  )
  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey,
    productCoordinate,
    stock: 2,
    signedProductEvent: source,
  })
  await commitMerchantInventoryAssignment({
    db,
    merchantPubkey,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory: { mode: "tracked", quantity: allocation },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: `allocation-${allocation}`,
    nowMs: 1_000,
    context: {
      kind: "validated-event-market-assignment",
      productEventId: source.id,
      marketEventId: "a".repeat(64),
      occurrenceEventId: "b".repeat(64),
      grantEventId: "c".repeat(64),
      occurrenceEndMs: Date.now() + 60_000,
      terminal: false,
    },
  })
  const orderId = `ordinary-order-${allocation}`
  const listingJob = prepareProductListingDeliveryJob({
    merchantPubkey,
    signedEvents: [updated],
    relayTargets: [
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelected: false,
        appRelay: true,
      },
    ],
    readyForDelivery: false,
  })
  return {
    productCoordinate,
    listingJob,
    commit: () =>
      commitLocalProductWrite({
        intentId: `ordinary-intent-${allocation}`,
        merchantPubkey,
        expectedRevisions: [
          { addressId: productCoordinate, eventId: source.id },
        ],
        listingJob,
        stock: {
          orderId,
          adjustment: {
            key: `${encodeURIComponent(orderId)}:${encodeURIComponent(productCoordinate)}`,
            addressId: productCoordinate,
            sourceEventId: source.id,
            title: "Ordinary stock fixture",
            quantity: 1,
            currentStock: 2,
            nextStock: 1,
            shortfall: 0,
          },
        },
      }),
  }
}

describe("ordinary order stock allocation guard", () => {
  it("queues the exact 2 to 1 update when one unit remains reserved", async () => {
    const scenario = await ordinaryStockTwoToOne(1)

    const intent = await scenario.commit()

    expect(intent.stockCheckpointId).toBeTruthy()
    expect(
      (await db.merchantInventoryProducts.get(scenario.productCoordinate))
        ?.stock
    ).toBe(1)
    expect(await db.localProductStockCheckpoints.count()).toBe(1)
    expect(
      await db.productListingOutbox.get(scenario.listingJob.id)
    ).toBeTruthy()
  })

  it("rejects the exact 2 to 1 update before queueing when two units remain reserved", async () => {
    const scenario = await ordinaryStockTwoToOne(2)

    await expect(scenario.commit()).rejects.toThrow(
      "Reconcile occurrence allocations before changing stock"
    )

    expect(
      (await db.merchantInventoryProducts.get(scenario.productCoordinate))
        ?.stock
    ).toBe(2)
    expect(await db.localProductStockCheckpoints.count()).toBe(0)
    expect(await db.productListingOutbox.count()).toBe(0)
  })
})
