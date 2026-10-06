import { afterAll, describe, expect, it, spyOn } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import { computeEventMarketAssignmentDTag } from "@conduit/core/protocol/event-market-assignment"
import {
  acceptMerchantInventoryOrder,
  commitMerchantInventoryAssignment,
  commitMerchantInventoryStockEdit,
  getMerchantInventoryAcceptedOrder,
  initializeMerchantInventoryProduct,
  readMerchantInventoryAvailability,
  resumeMerchantInventoryPublication,
} from "@conduit/core/protocol/merchant-inventory"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { plainTestSigner } from "./helpers/plain-signer"

const databaseName = `merchant-inventory-${crypto.randomUUID()}`
const db = new ConduitDB(databaseName, { indexedDB, IDBKeyRange })
afterAll(() => db.delete())

async function signed(
  signer: NDKPrivateKeySigner,
  draft: {
    pubkey: string
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }
): Promise<SignedPublicNostrEvent> {
  const event = new NDKEvent()
  event.pubkey = draft.pubkey
  event.kind = draft.kind
  event.created_at = draft.created_at
  event.tags = draft.tags
  event.content = draft.content
  await event.sign(signer)
  return event.rawEvent() as SignedPublicNostrEvent
}

describe("durable merchant inventory", () => {
  it("commits pickup and ordinary stock atomically while all publications fail, then resumes exact bytes", async () => {
    const signer = plainTestSigner(NDKPrivateKeySigner.generate())
    const merchantPubkey = (await signer.user()).pubkey
    const organizer = "1".repeat(64)
    const productCoordinate = `30402:${merchantPubkey}:soap`
    const marketCoordinate = `30409:${organizer}:fair`
    const occurrenceCoordinate = `31923:${organizer}:day-1`
    const assignmentCoordinate = `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag(
      {
        marketCoordinate,
        occurrenceCoordinate,
        productCoordinate,
      }
    )}`
    const product = await signed(signer, {
      pubkey: merchantPubkey,
      kind: 30402,
      created_at: 100,
      tags: [
        ["d", "soap"],
        ["type", "simple", "physical"],
        ["title", "Soap"],
        ["stock", "20"],
      ],
      content: "soap listing",
    })
    await initializeMerchantInventoryProduct({
      db,
      productCoordinate,
      merchantPubkey,
      stock: 20,
      signedProductEvent: product,
    })
    await commitMerchantInventoryAssignment({
      db,
      productCoordinate,
      assignmentCoordinate,
      marketCoordinate,
      occurrenceCoordinate,
      inventory: { mode: "tracked", quantity: 6 },
      state: "active",
      fulfillmentMethods: ["pickup", "shipping"],
      context: {
        kind: "validated-event-market-assignment",
        productEventId: product.id,
        marketEventId: "a".repeat(64),
        occurrenceEventId: "b".repeat(64),
        grantEventId: "c".repeat(64),
        occurrenceEndMs: Date.now() + 86_400_000,
        terminal: false,
      },
      expectedRevision: null,
      mutationId: "assign-1",
    })
    expect(
      (await readMerchantInventoryAvailability(db, productCoordinate))
        .ordinaryAvailable
    ).toBe(14)
    await expect(
      acceptMerchantInventoryOrder({
        db,
        orderId: "bad-bundle",
        merchantPubkey,
        identityBinding: "buyer",
        termsBinding: "terms",
        evidence: "signed-evidence",
        items: [
          {
            productCoordinate,
            method: "ordinary",
            quantity: 1,
            admission: {
              kind: "validated-ordinary-product",
              productEventId: product.id,
            },
          },
          {
            productCoordinate,
            method: "ordinary",
            quantity: 100,
            admission: {
              kind: "validated-ordinary-product",
              productEventId: product.id,
            },
          },
        ],
      })
    ).rejects.toThrow("Insufficient ordinary stock")
    expect(
      await db.merchantInventoryAcceptedOrders.get("bad-bundle")
    ).toBeUndefined()
    expect(
      (await db.merchantInventoryProducts.get(productCoordinate))?.stock
    ).toBe(20)
    await expect(
      commitMerchantInventoryStockEdit({
        db,
        productCoordinate,
        expectedRevision: 0,
        stock: 2,
        mutationId: "below-allocation",
      })
    ).rejects.toThrow("below current allocations")
    const pickup = (orderId: string, quantity: number) => ({
      db,
      orderId,
      merchantPubkey,
      identityBinding: `buyer:${orderId}`,
      termsBinding: `terms:${orderId}`,
      evidence: `signed-order-evidence:${orderId}`,
      items: [
        {
          productCoordinate,
          assignmentCoordinate,
          method: "pickup" as const,
          quantity,
          admission: {
            kind: "validated-event-market-order" as const,
            productEventId: product.id,
            assignmentCoordinate,
            marketEventId: "a".repeat(64),
            occurrenceEventId: "b".repeat(64),
            grantEventId: "c".repeat(64),
          },
        },
      ],
    })
    expect(
      (await acceptMerchantInventoryOrder(pickup("order-1", 2))).replayed
    ).toBe(false)
    expect(
      (await acceptMerchantInventoryOrder(pickup("order-1", 2))).replayed
    ).toBe(true)
    await expect(
      acceptMerchantInventoryOrder({
        ...pickup("order-1", 2),
        termsBinding: "changed",
      })
    ).rejects.toThrow("different identity or terms")
    expect(
      await resumeMerchantInventoryPublication({
        db,
        merchantPubkey,
        sign: (draft) => signed(signer, draft),
        publish: async () => false,
      })
    ).toMatchObject({ delivered: 0 })
    expect(
      (await acceptMerchantInventoryOrder(pickup("order-2", 1))).replayed
    ).toBe(false)
    const after = await readMerchantInventoryAvailability(db, productCoordinate)
    expect(after.product.stock).toBe(17)
    expect(after.assignments[0].inventory).toEqual({
      mode: "tracked",
      quantity: 3,
    })
    expect(after.ordinaryAvailable).toBe(14)
    const known = await getMerchantInventoryAcceptedOrder(
      db,
      merchantPubkey,
      "order-2"
    )
    expect(known?.items[0].remainingStock).toBe(17)
    const deliveredIds: string[] = []
    const result = await resumeMerchantInventoryPublication({
      db,
      merchantPubkey,
      sign: (draft) => signed(signer, draft),
      publish: async (event) => {
        deliveredIds.push(event.id)
        return true
      },
    })
    expect(result.pending).toBe(0)
    expect(result.delivered).toBeGreaterThanOrEqual(4)
    expect(new Set(deliveredIds).size).toBe(deliveredIds.length)
    const assignment =
      await db.merchantInventoryAssignments.get(assignmentCoordinate)
    if (!assignment) throw new Error("Committed assignment missing")
    expect(assignment?.publicationJobs[1].signedEvent?.tags).toContainEqual([
      "prev",
      assignment.publicationJobs[0].signedEvent!.id,
    ])
    const original = await db.merchantInventoryProducts.get(productCoordinate)
    expect(original?.sourceProductEvent).toEqual(product)
    const peer = new ConduitDB(databaseName, { indexedDB, IDBKeyRange })
    const sameOrder = await Promise.allSettled([
      acceptMerchantInventoryOrder(pickup("same-order", 1)),
      acceptMerchantInventoryOrder({ ...pickup("same-order", 1), db: peer }),
    ])
    expect(sameOrder.every((result) => result.status === "fulfilled")).toBe(
      true
    )
    expect(
      sameOrder.filter(
        (result) => result.status === "fulfilled" && result.value.replayed
      )
    ).toHaveLength(1)
    const contenders = await Promise.allSettled([
      acceptMerchantInventoryOrder(pickup("race-1", 2)),
      acceptMerchantInventoryOrder({ ...pickup("race-2", 2), db: peer }),
    ])
    peer.close()
    expect(
      contenders.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      contenders.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    expect(
      (await readMerchantInventoryAvailability(db, productCoordinate))
        .assignments[0].inventory
    ).toEqual({ mode: "tracked", quantity: 0 })
    const beforeUnsigned =
      await db.merchantInventoryProducts.get(productCoordinate)
    let published = 0
    const table = db.merchantInventoryProducts
    const realPut = table.put.bind(table)
    const putSpy = spyOn(table, "put").mockImplementation((record) => {
      if (
        record.publicationJobs.some(
          (work) =>
            work.state === "signed" &&
            work.signedEvent?.id !== beforeUnsigned?.signedProductEvent.id
        )
      )
        throw new Error("simulated signed save failure")
      return realPut(record)
    })
    try {
      await expect(
        resumeMerchantInventoryPublication({
          db,
          merchantPubkey,
          sign: (draft) => signed(signer, draft),
          publish: async () => {
            published += 1
            return true
          },
        })
      ).rejects.toThrow("simulated signed save failure")
      expect(published).toBe(0)
    } finally {
      putSpy.mockRestore()
    }
    expect(
      (
        await db.merchantInventoryProducts.get(productCoordinate)
      )?.publicationJobs.some((work) => work.state === "awaiting_signature")
    ).toBe(true)
    await resumeMerchantInventoryPublication({
      db,
      merchantPubkey,
      sign: (draft) => signed(signer, draft),
      publish: async () => true,
    })
    const beforeFailure = await readMerchantInventoryAvailability(
      db,
      productCoordinate
    )
    db.merchantInventoryAcceptedOrders.hook("creating", () => {
      throw new Error("simulated accepted-order save failure")
    })
    await expect(
      acceptMerchantInventoryOrder({
        db,
        orderId: "failed-local-save",
        merchantPubkey,
        identityBinding: "buyer",
        termsBinding: "terms",
        evidence: "signed-evidence",
        items: [
          {
            productCoordinate,
            method: "ordinary",
            quantity: 1,
            admission: {
              kind: "validated-ordinary-product",
              productEventId: product.id,
            },
          },
        ],
      })
    ).rejects.toThrow("simulated accepted-order save failure")
    expect(
      (await readMerchantInventoryAvailability(db, productCoordinate)).product
        .stock
    ).toBe(beforeFailure.product.stock)
    expect(
      await db.merchantInventoryAcceptedOrders.get("failed-local-save")
    ).toBeUndefined()
  })

  it("keeps untracked commitments and committed records across cache clearing and reload", async () => {
    const name = `merchant-untracked-${crypto.randomUUID()}`
    const local = new ConduitDB(name, { indexedDB, IDBKeyRange })
    const signer = plainTestSigner(NDKPrivateKeySigner.generate())
    const merchantPubkey = (await signer.user()).pubkey
    const organizer = "1".repeat(64)
    const productCoordinate = `30402:${merchantPubkey}:digital`
    const marketCoordinate = `30409:${organizer}:market`
    const occurrenceCoordinate = `31923:${organizer}:day`
    const assignmentCoordinate = `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag(
      {
        marketCoordinate,
        occurrenceCoordinate,
        productCoordinate,
      }
    )}`
    const source = await signed(signer, {
      pubkey: merchantPubkey,
      kind: 30402,
      created_at: 100,
      tags: [
        ["d", "digital"],
        ["type", "simple", "digital"],
      ],
      content: "digital listing",
    })
    try {
      await expect(
        initializeMerchantInventoryProduct({
          db: local,
          productCoordinate,
          merchantPubkey,
          stock: 0,
          signedProductEvent: source,
        })
      ).rejects.toThrow("exact signed product")
      await initializeMerchantInventoryProduct({
        db: local,
        productCoordinate,
        merchantPubkey,
        signedProductEvent: source,
      })
      await commitMerchantInventoryAssignment({
        db: local,
        productCoordinate,
        assignmentCoordinate,
        marketCoordinate,
        occurrenceCoordinate,
        inventory: { mode: "untracked" },
        state: "active",
        fulfillmentMethods: ["digital"],
        expectedRevision: null,
        mutationId: "untracked-assignment",
        context: {
          kind: "validated-event-market-assignment",
          productEventId: source.id,
          marketEventId: "a".repeat(64),
          occurrenceEventId: "b".repeat(64),
          grantEventId: "c".repeat(64),
          occurrenceEndMs: Date.now() + 86_400_000,
          terminal: false,
        },
      })
      await acceptMerchantInventoryOrder({
        db: local,
        orderId: "untracked-order",
        merchantPubkey,
        identityBinding: "buyer",
        termsBinding: "terms",
        evidence: "signed-evidence",
        items: [
          {
            productCoordinate,
            assignmentCoordinate,
            method: "digital",
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
      expect(
        (await readMerchantInventoryAvailability(local, productCoordinate))
          .ordinaryAvailable
      ).toBeUndefined()
      await local.products.clear()
      local.close()
      const reopened = new ConduitDB(name, { indexedDB, IDBKeyRange })
      try {
        expect(
          (await readMerchantInventoryAvailability(reopened, productCoordinate))
            .ordinaryAvailable
        ).toBeUndefined()
        expect(
          await getMerchantInventoryAcceptedOrder(
            reopened,
            merchantPubkey,
            "untracked-order"
          )
        ).toMatchObject({ orderId: "untracked-order" })
        const assignment =
          await reopened.merchantInventoryAssignments.get(assignmentCoordinate)
        expect(assignment?.inventory).toEqual({ mode: "untracked" })
      } finally {
        await reopened.delete()
      }
    } finally {
      local.close()
    }
  })
})
