import { readMerchantOrderStockHistory } from "../apps/merchant/src/lib/order-stock-history"
import {
  ProductStockDecisionStore,
  PendingProductStockDeliveryStore,
} from "../apps/merchant/src/lib/productStock"
import { getLegacyNumericStockOrderId } from "../packages/core/src/protocol/order-stock-history"
import { parseOrderMessageRumorEvent } from "../packages/core/src/protocol/orders"
import { encodeOpenMarketsBuyerMessage } from "../packages/core/src/protocol/commerce-wire"
import { createPrivateMessageRumor } from "../packages/core/src/protocol/private-message-primitives"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { admitFixture } from "./helpers/public-event"
import { IDBFactory as FakeIDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { db } from "../packages/core/src/db"
import { projectSignedProductListingForLocalCommit } from "../packages/core/src/protocol/commerce"
import { commitLocalProductWrite } from "../packages/core/src/protocol/local-product-write"
import { prepareProductListingDeliveryJob } from "../packages/core/src/protocol/product-listing-delivery"
import {
  confirmLocalProductStockRecovery,
  getLocalProductStockRecoveryForOrder,
  settleLocalProductStockRecovery,
} from "../packages/core/src/protocol/local-product-stock"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const otherMerchant = getPublicKey(generateSecretKey())
const addressId = `30402:${merchant}:stock-fixture`
const orderId = "synthetic-stock-order"
const createdAt = 1_800_000_000

function signedProduct(stock: number, at: number) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: at,
      tags: [
        ["d", "stock-fixture"],
        ["title", "Synthetic stock product"],
        ["price", "10", "SAT"],
        ["type", "simple", "digital"],
        ["stock", String(stock)],
      ],
      content: "",
    },
    secret
  )
}

async function committedStock() {
  const source = signedProduct(5, createdAt)
  const signedEvent = signedProduct(4, createdAt + 1)
  await db.products.put(
    projectSignedProductListingForLocalCommit(await admitFixture(source))
  )
  const listingJob = prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: [signedEvent],
    relayTargets: [
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelected: false,
        appRelay: true,
      },
    ],
    readyForDelivery: false,
  })
  const intent = await commitLocalProductWrite({
    intentId: "synthetic-stock-intent",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId, eventId: source.id }],
    listingJob,
    stock: {
      orderId,
      adjustment: {
        key: `${encodeURIComponent(orderId)}:${encodeURIComponent(addressId)}`,
        addressId,
        sourceEventId: source.id,
        title: "Synthetic stock product",
        quantity: 1,
        currentStock: 5,
        nextStock: 4,
        shortfall: 0,
      },
    },
  })
  return {
    source,
    signedEvent,
    listingJob,
    intent,
    input: {
      merchantPubkey: merchant,
      orderId,
      addressId,
      signedEventId: signedEvent.id,
    },
  }
}

async function recordDelivery(jobId: string, status: "acked" | "rejected") {
  const job = await db.productListingOutbox.get(jobId)
  if (!job) throw new Error("Missing synthetic listing job")
  await db.productListingOutbox.put({
    ...job,
    state: status === "acked" ? "delivered" : "failed",
    deliveryAttemptCount: 1,
    relayDelivery: job.relayDelivery.map((delivery) => ({
      ...delivery,
      status,
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

describe("committed local stock recovery", () => {
  it("returns the exact committed decision without decrementing stock again", async () => {
    const committed = await committedStock()
    const first = await confirmLocalProductStockRecovery(committed.input)
    const second = await confirmLocalProductStockRecovery(committed.input)

    expect(first.signedEvent).toEqual(
      JSON.parse(JSON.stringify(committed.signedEvent))
    )
    expect(second).toEqual(first)
    expect(first.checkpoint.sourceEventId).toBe(committed.source.id)
    expect(first.checkpoint.adjustment.nextStock).toBe(4)
    expect((await db.products.get(addressId))?.stock).toBe(4)
    expect(await db.localProductStockCheckpoints.count()).toBe(1)
  })

  it("isolates recovery by merchant, order, and exact signed revision", async () => {
    const committed = await committedStock()
    expect(
      await getLocalProductStockRecoveryForOrder(otherMerchant, orderId)
    ).toEqual([])
    expect(
      await getLocalProductStockRecoveryForOrder(merchant, "another-order")
    ).toEqual([])
    await expect(
      confirmLocalProductStockRecovery({
        ...committed.input,
        signedEventId: committed.source.id,
      })
    ).rejects.toThrow("no longer pending")
    expect((await db.products.get(addressId))?.stock).toBe(4)
  })

  it("keeps an orphaned checkpoint from authorizing a retry", async () => {
    const committed = await committedStock()
    await db.localProductWriteIntents.delete(committed.intent.id)
    await expect(
      getLocalProductStockRecoveryForOrder(merchant, orderId)
    ).rejects.toThrow("evidence is incomplete")
  })

  it("requires actual exact-family ACK evidence before finalizing applied", async () => {
    const committed = await committedStock()
    await db.productListingOutbox.update(committed.listingJob.id, {
      state: "delivered",
    })
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("stale")
    await recordDelivery(committed.listingJob.id, "acked")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("saved")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("stale")
    await expect(
      confirmLocalProductStockRecovery(committed.input)
    ).rejects.toThrow("no longer pending")
    const rows = await getLocalProductStockRecoveryForOrder(merchant, orderId)
    expect(rows[0]?.checkpoint.state).toBe("applied")
    expect((await db.products.get(addressId))?.stock).toBe(4)
  })

  it("requires terminal rejection before marking a stock decision unpublished", async () => {
    const committed = await committedStock()
    await db.productListingOutbox.update(committed.listingJob.id, {
      state: "failed",
    })
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "unpublished",
      })
    ).toBe("stale")
    await recordDelivery(committed.listingJob.id, "rejected")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "unpublished",
      })
    ).toBe("saved")
    const rows = await getLocalProductStockRecoveryForOrder(merchant, orderId)
    expect(rows[0]?.checkpoint.state).toBe("unpublished")
    expect((await db.products.get(addressId))?.stock).toBe(4)
  })

  it("retains history but refuses replay or finalization after a newer observed revision", async () => {
    const committed = await committedStock()
    const newer = signedProduct(8, createdAt + 2)
    await db.products.put(
      projectSignedProductListingForLocalCommit(await admitFixture(newer))
    )
    const history = await getLocalProductStockRecoveryForOrder(
      merchant,
      orderId
    )
    expect(history[0]?.signedEvent.id).toBe(committed.signedEvent.id)
    await expect(
      confirmLocalProductStockRecovery(committed.input)
    ).rejects.toThrow("no longer pending")
    await recordDelivery(committed.listingJob.id, "acked")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("stale")
    expect((await db.products.get(addressId))?.stock).toBe(8)
  })

  it("does not revive an explicitly superseded stock replay", async () => {
    const committed = await committedStock()
    await db.productListingOutbox.update(committed.listingJob.id, {
      localReplaySupersededBy: {
        [committed.signedEvent.id]: "successor-intent",
      },
    })
    await expect(
      confirmLocalProductStockRecovery(committed.input)
    ).rejects.toThrow("no longer pending")
    await recordDelivery(committed.listingJob.id, "acked")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("stale")
    expect(await db.localProductStockCheckpoints.count()).toBe(1)
  })

  it("preserves pending stock when a known address deletion covers its revision", async () => {
    const committed = await committedStock()
    await db.localProductWriteFrontiers.update(addressId, {
      deletionCreatedAt: committed.signedEvent.created_at,
      deletionEventId: "f".repeat(64),
    })
    await expect(
      confirmLocalProductStockRecovery(committed.input)
    ).rejects.toThrow("no longer pending")
    const rows = await getLocalProductStockRecoveryForOrder(merchant, orderId)
    expect(rows[0]?.checkpoint.state).toBe("pending")
  })
})

function upgradedNumericOriginal(buyerPubkey = "a".repeat(64)) {
  const purchase = {
    id: orderId,
    buyerPubkey,
    merchantPubkey: merchant,
    items: [
      {
        productId: addressId,
        title: "Synthetic stock product",
        quantity: 1,
        format: "digital",
        fulfillment: { type: "digital" },
        priceAtPurchase: 10,
        currency: "SATS",
      },
    ],
    subtotal: 10,
    currency: "SATS",
    createdAt: createdAt * 1000,
  }
  const draft = createPrivateMessageRumor({
    kind: 16,
    pubkey: buyerPubkey,
    created_at: createdAt,
    tags: [
      ["p", merchant],
      ["type", "order"],
      ["order", orderId],
    ],
    content: JSON.stringify(purchase),
  })
  const original = parseOrderMessageRumorEvent(
    createPrivateMessageRumor(
      encodeOpenMarketsBuyerMessage(
        draft,
        { buyerPubkey, merchantPubkey: merchant, orderId },
        1
      )
    )
  )
  if (original.type !== "order") throw new Error("Missing fixture order")
  return original
}
function stockStores() {
  const rows = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return rows.size
    },
    clear: () => rows.clear(),
    key: (index) => [...rows.keys()][index] ?? null,
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value)
    },
    removeItem: (key) => {
      rows.delete(key)
    },
  }
  return {
    decisions: new ProductStockDecisionStore(storage),
    pending: new PendingProductStockDeliveryStore(storage),
    rows,
  }
}

describe("numeric legacy manual-stock history", () => {
  it("keeps pending exact recovery under the original key without crediting either buyer", async () => {
    const committed = await committedStock()
    const stores = stockStores()
    const before = await db.localProductStockCheckpoints.toArray()
    for (const buyer of ["a".repeat(64), "b".repeat(64)]) {
      const original = upgradedNumericOriginal(buyer)
      const history = await readMerchantOrderStockHistory({
        merchantPubkey: merchant,
        orderId: original.orderId,
        original,
        ...stores,
      })
      expect(history.current).toEqual([])
      expect(history.hasUnboundLegacyHistory).toBe(true)
      expect(history.legacyOrderId).toBe(orderId)
      expect(history.legacy).toHaveLength(1)
      expect(history.legacy[0]!.checkpoint.orderId).toBe(orderId)
      expect(history.legacy[0]!.signedEvent).toEqual(
        JSON.parse(JSON.stringify(committed.signedEvent))
      )
    }
    const exact = await confirmLocalProductStockRecovery(committed.input)
    expect(exact.signedEvent).toEqual(
      JSON.parse(JSON.stringify(committed.signedEvent))
    )
    await expect(
      confirmLocalProductStockRecovery({
        ...committed.input,
        orderId: upgradedNumericOriginal().orderId,
      })
    ).rejects.toThrow("no longer pending")
    expect(await db.localProductStockCheckpoints.toArray()).toEqual(before)
    expect((await db.products.get(addressId))?.stock).toBe(4)
  })

  it("finds older localStorage decisions without moving keys or applying them to the alias", async () => {
    const committed = await committedStock()
    const row = (await db.localProductStockCheckpoints.toArray())[0]!
    await db.localProductStockCheckpoints.clear()
    const stores = stockStores()
    const original = upgradedNumericOriginal()
    stores.decisions.set(
      merchant,
      orderId,
      addressId,
      "applied",
      row.adjustment
    )
    const saved = [...stores.rows]
    const history = await readMerchantOrderStockHistory({
      merchantPubkey: merchant,
      orderId: original.orderId,
      original,
      ...stores,
    })
    expect(history.hasUnboundLegacyHistory).toBe(true)
    expect(history.current).toEqual([])
    expect(history.legacy).toEqual([])
    expect(
      stores.decisions.get(merchant, original.orderId, addressId)
    ).toBeNull()
    expect([...stores.rows]).toEqual(saved)
    const pending = stockStores()
    pending.pending.set(merchant, {
      orderId,
      adjustment: row.adjustment,
      signedEvent: committed.signedEvent,
    })
    const retry = await readMerchantOrderStockHistory({
      merchantPubkey: merchant,
      orderId: original.orderId,
      original,
      ...pending,
    })
    expect(JSON.stringify(retry.legacyPending[0]!.signedEvent)).toBe(
      JSON.stringify(committed.signedEvent)
    )
    expect(retry.legacyPending[0]!.orderId).toBe(orderId)
    expect(retry.hasUnboundLegacyHistory).toBe(true)
  })

  it("requires the exact participant-qualified original to locate old history", () => {
    const original = upgradedNumericOriginal()
    expect(getLegacyNumericStockOrderId(merchant, original)).toBe(orderId)
    for (const changed of [
      { ...original, senderPubkey: otherMerchant },
      { ...original, recipientPubkey: otherMerchant },
      { ...original, orderId },
      { ...original, wireOrderId: "different-order" },
    ])
      expect(() => getLegacyNumericStockOrderId(merchant, changed)).toThrow(
        "authenticated original"
      )
    expect(() => getLegacyNumericStockOrderId(otherMerchant, original)).toThrow(
      "authenticated original"
    )
    expect(
      getLegacyNumericStockOrderId(merchant, {
        ...original,
        conduitExtension: false,
      })
    ).toBeNull()
    expect(
      getLegacyNumericStockOrderId(merchant, {
        ...original,
        wireFormat: "conduit",
      })
    ).toBeNull()
  })

  it("fences an alias stock write atomically against a raw checkpoint without changing signed bytes", async () => {
    const committed = await committedStock()
    await recordDelivery(committed.listingJob.id, "acked")
    expect(
      await settleLocalProductStockRecovery({
        ...committed.input,
        kind: "applied",
      })
    ).toBe("saved")
    const original = upgradedNumericOriginal()
    const before = await db.localProductStockCheckpoints.toArray()
    const signedEvent = signedProduct(3, createdAt + 2)
    await expect(
      commitLocalProductWrite({
        intentId: "alias-stock-write",
        merchantPubkey: merchant,
        expectedRevisions: [{ addressId, eventId: committed.signedEvent.id }],
        listingJob: prepareProductListingDeliveryJob({
          merchantPubkey: merchant,
          signedEvents: [signedEvent],
          relayTargets: [
            {
              relayUrl: "wss://relay.conduit.market",
              ownerSelected: false,
              appRelay: true,
            },
          ],
          readyForDelivery: false,
        }),
        stock: {
          orderId: original.orderId,
          legacyOrderId: orderId,
          adjustment: {
            ...before[0]!.adjustment,
            key: `${encodeURIComponent(original.orderId)}:${encodeURIComponent(addressId)}`,
            sourceEventId: committed.signedEvent.id,
            currentStock: 4,
            nextStock: 3,
          },
        },
      })
    ).rejects.toThrow("Older stock history")
    expect(await db.localProductStockCheckpoints.toArray()).toEqual(before)
    expect((await db.products.get(addressId))?.stock).toBe(4)
    expect(
      (await getLocalProductStockRecoveryForOrder(merchant, orderId))[0]!
        .signedEvent
    ).toEqual(JSON.parse(JSON.stringify(committed.signedEvent)))
  })
})
